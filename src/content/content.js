(() => {
  const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i;
  const HLS_EXTENSION = /\.m3u8(\?|#|$)/i;
  const DASH_EXTENSION = /\.mpd(\?|#|$)/i;
  const CAPTION_EXTENSIONS = /\.(vtt|srt|json)(\?|#|$)/i;

  const state = {
    lastAnalysis: null,
    lastTranscript: null,
    pageCaptionResponses: [],
    pageNetworkResponses: [],
    pageHlsResponses: [],
    pageDashConfigs: [],
    pageBridgeAvailable: false
  };
  const pendingResourceRequests = new Map();
  const mediaFetchPreferences = new Map();
  let mediaToolkitPromise = null;

  function isSkoolUrl(value) {
    try {
      const host = new URL(value).hostname.toLowerCase();
      return host === "skool.com" || host.endsWith(".skool.com");
    } catch {
      return false;
    }
  }

  function hasMediaOrTranscriptSurface() {
    return Boolean(
      document.querySelector(
        "video, audio, track, [data-testid*='transcript' i], [aria-label*='transcript' i], [class*='transcript' i], [class*='caption' i], [class*='subtitle' i]"
      )
    );
  }

  function shouldRunInThisFrame() {
    return isSkoolUrl(location.href) || isSkoolUrl(document.referrer) || hasMediaOrTranscriptSurface();
  }

  function visibleElement(element) {
    if (!element || !(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function absoluteUrl(url) {
    if (!url) return "";
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return "";
    }
  }

  function isLikelyCaptionUrl(url) {
    const lower = String(url || "").toLowerCase();
    return (
      CAPTION_EXTENSIONS.test(lower) ||
      /(^|[/?&=_-])(caption|captions|subtitle|subtitles|transcript|texttrack|text-track)([/?&=_-]|$)/.test(lower)
    );
  }

  function parseCaptionText(rawText, url = "", contentType = "") {
    const text = String(rawText || "").trim();
    const type = String(contentType || "").toLowerCase();
    const lowerUrl = String(url || "").toLowerCase();
    if (!text) return [];
    if (/json/.test(type) || /\.json(\?|#|$)/.test(lowerUrl) || /^[\[{]/.test(text)) {
      const jsonCues = parseJsonCaptions(text);
      if (jsonCues.length) return jsonCues;
    }
    if (/WEBVTT/i.test(text) || /-->\s*\d/.test(text) || /\.(vtt|srt)(\?|#|$)/.test(lowerUrl)) {
      const timedCues = parseVttOrSrt(text);
      if (timedCues.length) return timedCues;
    }
    const bracketedCues = parseBracketedTranscript(text);
    if (bracketedCues.length) return bracketedCues;
    return dedupeCues(
      text
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(
          (line) =>
            line.length < 1000 &&
            !/^[\[{]/.test(line) &&
            !/^https?:\/\//i.test(line) &&
            !/"(?:base_url|init_segment|segments|provider_name)"\s*:/.test(line)
        )
        .map((line) => ({ start: null, end: null, text: line }))
        .filter((cue) => cleanText(cue.text))
    );
  }

  function parseBracketedTranscript(rawText) {
    const cues = [];
    for (const line of String(rawText || "").split(/\r?\n/)) {
      const match = line.trim().match(/^\[((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\]\s+(.+)$/);
      if (!match) continue;
      const start = parseTimestamp(match[1]);
      const text = cleanText(match[2]);
      if (start != null && text) cues.push({ start, end: null, text });
    }

    for (let index = 0; index < cues.length; index += 1) {
      cues[index].end = cues[index + 1]?.start ?? cues[index].start + 2;
    }
    return dedupeCues(cues);
  }

  function textContent(selector) {
    const element = document.querySelector(selector);
    return element?.textContent?.replace(/\s+/g, " ").trim() || "";
  }

  function lessonTitle() {
    const title =
      textContent("h1") ||
      textContent("[data-testid*='title' i]") ||
      textContent("[class*='title' i]") ||
      document.title ||
      "Skool lesson";

    return title.replace(/\s+-\s+Skool\s*$/i, "").trim() || "Skool lesson";
  }

  function cleanText(text) {
    return String(text || "")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  }

  function secondsToTimestamp(seconds, srt = false) {
    const value = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = Math.floor(value % 60);
    const millis = Math.floor((value - Math.floor(value)) * 1000);
    const separator = srt ? "," : ".";
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
  }

  function parseTimestamp(value) {
    const match = String(value || "").trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?/);
    if (!match) return null;
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2] || 0);
    const seconds = Number(match[3] || 0);
    const millis = Number(String(match[4] || "0").padEnd(3, "0"));
    return hours * 3600 + minutes * 60 + seconds + millis / 1000;
  }

  function dedupeCues(cues) {
    const seen = new Set();
    return cues
      .map((cue) => ({
        start: Number.isFinite(cue.start) ? cue.start : null,
        end: Number.isFinite(cue.end) ? cue.end : null,
        text: cleanText(cue.text)
      }))
      .filter((cue) => cue.text)
      .filter((cue) => {
        const key = `${cue.start ?? ""}|${cue.end ?? ""}|${cue.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER));
  }

  function parseVttOrSrt(rawText) {
    const text = String(rawText || "").replace(/\r/g, "");
    const blocks = text.split(/\n{2,}/);
    const cues = [];

    for (const block of blocks) {
      const lines = block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^WEBVTT($|\s)/i.test(line) && !/^NOTE($|\s)/i.test(line));

      const timeIndex = lines.findIndex((line) => line.includes("-->"));
      if (timeIndex === -1) continue;

      const [startRaw, endRaw] = lines[timeIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
      const start = parseTimestamp(startRaw);
      const end = parseTimestamp(endRaw);
      const cueText = lines.slice(timeIndex + 1).join(" ");
      if (start != null && end != null && cueText) {
        cues.push({ start, end, text: cueText });
      }
    }

    return dedupeCues(cues);
  }

  function parseJsonCaptions(rawText) {
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return [];
    }

    const cues = [];
    const visit = (node) => {
      if (!node) return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (typeof node !== "object") return;

      const text = node.text || node.caption || node.transcript || node.body || node.value || node.word;
      const start = node.start ?? node.startTime ?? node.from ?? node.offset ?? node.t;
      const end = node.end ?? node.endTime ?? node.to;
      const duration = node.duration ?? node.dur;

      if (typeof text === "string") {
        const startSeconds = typeof start === "number" ? start : parseTimestamp(start);
        const endSeconds =
          typeof end === "number"
            ? end
            : parseTimestamp(end) ?? (typeof duration === "number" && typeof startSeconds === "number" ? startSeconds + duration : null);
        cues.push({ start: startSeconds, end: endSeconds, text });
      }

      for (const value of Object.values(node)) {
        if (value && typeof value === "object") visit(value);
      }
    };

    visit(data);
    return dedupeCues(cues);
  }

  function isVimeoDashTrack(track) {
    return Boolean(
      track &&
        typeof track === "object" &&
        track.format === "dash" &&
        typeof track.init_segment === "string" &&
        Array.isArray(track.segments) &&
        track.segments.length &&
        track.segments.every((segment) => typeof segment?.url === "string")
    );
  }

  function findVimeoDashConfig(root) {
    const seen = new Set();
    let visited = 0;

    function visit(node, depth) {
      if (!node || typeof node !== "object" || depth > 8 || seen.has(node) || visited++ > 1500) return null;
      seen.add(node);

      if (
        typeof node.base_url === "string" &&
        Array.isArray(node.video) &&
        Array.isArray(node.audio) &&
        node.video.some(isVimeoDashTrack) &&
        node.audio.some(isVimeoDashTrack)
      ) {
        return node;
      }

      for (const value of Object.values(node)) {
        const match = visit(value, depth + 1);
        if (match) return match;
      }
      return null;
    }

    return visit(root, 0);
  }

  function vimeoDashConfigsFromText(rawText) {
    const text = String(rawText || "");
    if (!text.includes('"init_segment"')) return [];

    const configs = [];
    const candidates = Array.from(
      new Set([text, ...text.split(/\r?\n/).filter((line) => line.includes('"base_url"'))])
    );
    for (const candidate of candidates) {
      try {
        const config = findVimeoDashConfig(JSON.parse(candidate));
        if (config && !configs.includes(config)) configs.push(config);
      } catch {
        // A captured response may contain several newline-delimited JSON documents.
      }
    }
    return configs;
  }

  function rememberVimeoDashConfig(config, responseUrl, timestamp = Date.now()) {
    if (!findVimeoDashConfig(config)) return false;
    let url;
    try {
      url = new URL(responseUrl, document.baseURI).href;
      new URL(config.base_url, url);
    } catch {
      return false;
    }

    const key = `${config.clip_id || ""}|${url}`;
    state.pageDashConfigs = [
      ...state.pageDashConfigs.filter((entry) => entry.key !== key),
      { key, config, url, timestamp }
    ].slice(-3);
    return true;
  }

  function latestVimeoDashConfig() {
    return [...state.pageDashConfigs].sort((a, b) => b.timestamp - a.timestamp)[0] || null;
  }

  function requestPageResource(url, responseType = "binary", range = "") {
    if (!state.pageBridgeAvailable) {
      return Promise.reject(new Error("The lesson page media bridge is unavailable."));
    }

    const requestId =
      globalThis.crypto?.randomUUID?.() || `resource-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingResourceRequests.delete(requestId);
        reject(new Error("The lesson page timed out while fetching media."));
      }, 45_000);

      pendingResourceRequests.set(requestId, {
        resolve: (payload) => {
          window.clearTimeout(timer);
          resolve(payload);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        }
      });

      window.postMessage(
        {
          source: "skool-video-transcript-exporter-content",
          type: "RESOURCE_REQUEST",
          payload: { requestId, url, responseType, range }
        },
        "*"
      );
    });
  }

  async function fetchText(url) {
    if (state.pageBridgeAvailable) {
      try {
        const bridged = await requestPageResource(url, "text");
        if (bridged?.ok) return bridged.text || "";
      } catch {
        // Fall through to the extension fetch paths.
      }
    }

    try {
      const response = await fetch(url, {
        credentials: "include",
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`Request failed (${response.status}).`);
      return response.text();
    } catch (error) {
      const fallback = await chrome.runtime.sendMessage({ type: "FETCH_TEXT_URL", url });
      if (!fallback?.ok) throw new Error(fallback?.error || error.message || "The resource could not be fetched.");
      return fallback.text;
    }
  }

  function cuesFromTextTracks(video) {
    const cues = [];
    for (const track of Array.from(video.textTracks || [])) {
      try {
        track.mode = "hidden";
        const trackCues = Array.from(track.cues || track.activeCues || []);
        for (const cue of trackCues) {
          cues.push({
            start: cue.startTime,
            end: cue.endTime,
            text: cue.text
          });
        }
      } catch {
        // Some players expose text tracks but prevent script access to cues.
      }
    }
    return dedupeCues(cues);
  }

  function trackElements(video) {
    return Array.from(video?.querySelectorAll?.("track") || []).map((track, index) => ({
      index,
      label: track.label || track.srclang || track.kind || `Track ${index + 1}`,
      kind: track.kind || "subtitles",
      language: track.srclang || "",
      src: absoluteUrl(track.getAttribute("src") || "")
    }));
  }

  function renderedTranscriptCues() {
    const selectors = [
      "[data-testid*='transcript' i]",
      "[aria-label*='transcript' i]",
      "[class*='transcript' i]",
      "[data-testid*='caption' i]",
      "[class*='caption' i]",
      "[class*='subtitle' i]"
    ];
    const roots = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(visibleElement);
    const lines = [];

    for (const root of roots.slice(0, 8)) {
      const candidates = Array.from(root.querySelectorAll("p, li, div, span")).filter(visibleElement);
      const source = candidates.length ? candidates : [root];
      for (const element of source) {
        const text = cleanText(element.textContent);
        if (text && text.length > 1 && text.length < 600) lines.push(text);
      }
    }

    return dedupeCues(lines.slice(0, 2000).map((text) => ({ start: null, end: null, text })));
  }

  function sourceFromVideo(video) {
    const urls = [];
    const current = absoluteUrl(video.currentSrc || video.src || video.getAttribute("src"));
    if (current) urls.push(current);

    for (const source of Array.from(video.querySelectorAll("source"))) {
      const src = absoluteUrl(source.src || source.getAttribute("src"));
      if (src) urls.push(src);
    }

    const unique = Array.from(new Set(urls));
    const hls = unique.find((url) => HLS_EXTENSION.test(url));
    const direct = unique.find((url) => VIDEO_EXTENSIONS.test(url) && !isLikelyMediaFragment(url));
    const dash = unique.find((url) => DASH_EXTENSION.test(url));
    const blob = unique.find((url) => /^blob:/i.test(url));
    const captured = bestPageMediaRequest();
    const vimeoDash = latestVimeoDashConfig();

    if (blob) {
      if (vimeoDash) {
        return {
          status: "conditional",
          kind: "vimeo-dash",
          url: "",
          message: "The authorized Vimeo player exposed unencrypted DASH video and audio tracks that can be combined into MP4."
        };
      }

      if (captured?.kind === "hls") {
        return {
          status: "conditional",
          kind: "hls",
          url: captured.url,
          message: "The video element uses a blob URL, but an HLS playlist request was captured from the page."
        };
      }

      if (captured?.kind === "direct") {
        return {
          status: "downloadable",
          kind: "direct",
          url: captured.url,
          message: "The video element uses a blob URL, but a direct media request was captured from the page."
        };
      }

      if (captured?.kind === "segment") {
        return {
          status: "unsupported",
          kind: "segment",
          url: captured.url,
          message:
            "Only fragmented media segments were captured, not the stream metadata needed to combine them. Reload the lesson, play from the beginning for 5-10 seconds, then refresh."
        };
      }

      return {
        status: "downloadable",
        kind: "blob",
        url: blob,
        message: "Blob media URL detected. The extension will try a normal browser fetch and download only if it succeeds."
      };
    }

    if (vimeoDash) {
      return {
        status: "conditional",
        kind: "vimeo-dash",
        url: "",
        message: "Unencrypted Vimeo DASH metadata was captured and can be combined into MP4."
      };
    }

    if (hls) {
      return {
        status: "conditional",
        kind: "hls",
        url: hls,
        message: "HLS playlist detected. Download is available only when the playlist and segments are unencrypted and directly fetchable."
      };
    }

    if (direct) {
      return {
        status: "downloadable",
        kind: "direct",
        url: direct,
        message: "Direct HTML5 media URL detected."
      };
    }

    if (dash) {
      if (vimeoDash) {
        return {
          status: "conditional",
          kind: "vimeo-dash",
          url: "",
          message: "Unencrypted Vimeo DASH metadata was captured and can be combined into MP4."
        };
      }
      return {
        status: "unsupported",
        kind: "dash",
        url: dash,
        message: "DASH manifests are detected but not downloaded. Protected or packaged streams are unsupported."
      };
    }

    if (unique.length) {
      return {
        status: "unknown",
        kind: "unknown",
        url: unique[0],
        message: "A media source was found, but it is not a normal downloadable file, safe blob, or supported unencrypted HLS playlist."
      };
    }

    return {
      status: "missing",
      kind: "none",
      url: "",
      message: "No active HTML5 media source was found on this page."
    };
  }

  function mediaKindFromUrl(url, contentType = "") {
    const lower = String(url || "").toLowerCase();
    const type = String(contentType || "").toLowerCase();
    if (/\.m3u8(\?|#|$)/.test(lower) || /mpegurl/.test(type)) return "hls";
    if (/\.mpd(\?|#|$)/.test(lower) || /dash\+xml/.test(type)) return "dash";
    if (isLikelyMediaFragment(url)) return "segment";
    if (VIDEO_EXTENSIONS.test(lower) || /^video\//.test(type)) return "direct";
    return "unknown";
  }

  function isLikelyMediaFragment(url) {
    const lower = String(url || "").toLowerCase();
    return (
      /\.(m4s|cmfv|cmfa|ts)(\?|#|$)/.test(lower) ||
      /(^|[/?&=_-])(seg|segment|fragment|frag|chunk|part|init)(\d*|[/?&=_-]|$)/.test(lower) ||
      /(^|[/?&=_-])(moof|m4s|fmp4)([/?&=_-]|$)/.test(lower)
    );
  }

  function bestPageMediaRequest() {
    const priority = { hls: 90, direct: 75, dash: 20, segment: 5, unknown: 1 };
    return [...state.pageNetworkResponses]
      .map((entry) => ({
        ...entry,
        kind: entry.kind || mediaKindFromUrl(entry.url, entry.contentType)
      }))
      .filter((entry) => ["direct", "hls", "dash", "segment"].includes(entry.kind))
      .sort((a, b) => (priority[b.kind] || 0) - (priority[a.kind] || 0) || b.timestamp - a.timestamp)[0];
  }

  function detectVideos() {
    const videos = Array.from(document.querySelectorAll("video")).filter(visibleElement);
    const sorted = videos.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return bRect.width * bRect.height - aRect.width * aRect.height;
    });

    return sorted.map((video, index) => ({
      index,
      elementId: ensureVideoElementId(video),
      paused: video.paused,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
      tracks: trackElements(video),
      textTrackCueCount: Array.from(video.textTracks || []).reduce((count, track) => count + (track.cues?.length || 0), 0),
      source: sourceFromVideo(video)
    }));
  }

  function ensureVideoElementId(video) {
    if (!video.dataset.skoolExporterVideoId) {
      video.dataset.skoolExporterVideoId =
        globalThis.crypto?.randomUUID?.() || `skool-exporter-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return video.dataset.skoolExporterVideoId;
  }

  function analyzePage() {
    const videos = detectVideos();
    const activeVideo = videos[0] || null;
    const renderedTranscript = renderedTranscriptCues();
    const captionTracks = activeVideo?.tracks || [];

    const analysis = {
      ok: true,
      pageUrl: location.href,
      referrer: document.referrer || "",
      isTopFrame: window.top === window,
      lessonTitle: lessonTitle(),
      video: activeVideo,
      videoStatus: activeVideo?.source?.status || "missing",
      videoMessage: activeVideo?.source?.message || "No active HTML5 video element was found.",
      transcriptStatus:
        captionTracks.length || activeVideo?.textTrackCueCount || state.pageCaptionResponses.length || renderedTranscript.length
          ? "available"
          : "missing",
      transcriptMessage: captionTracks.length
        ? `${captionTracks.length} caption/subtitle track(s) found.`
        : activeVideo?.textTrackCueCount
          ? "Loaded browser text-track cues found."
          : state.pageCaptionResponses.length
            ? `${state.pageCaptionResponses.length} captured caption response(s) found.`
          : renderedTranscript.length
            ? "Rendered transcript text found on the page."
            : "No captions, subtitles, or rendered transcript text found yet.",
      captionTracks,
      capturedCaptionResponseCount: state.pageCaptionResponses.length,
      capturedNetworkResponseCount: state.pageNetworkResponses.length,
      capturedDashConfigCount: state.pageDashConfigs.length,
      renderedTranscriptCount: renderedTranscript.length,
      detectedVideoCount: videos.length
    };

    state.lastAnalysis = analysis;
    return analysis;
  }

  function reportAnalysis() {
    if (!shouldRunInThisFrame()) return;
    try {
      chrome.runtime.sendMessage({ type: "FRAME_ANALYSIS", analysis: analyzePage() }).catch(() => {});
    } catch {
      // The extension context can disappear during reloads.
    }
  }

  function debounce(fn, delay) {
    let timer = 0;
    return () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(fn, delay);
    };
  }

  async function transcriptFromTrackUrls(urls) {
    const collected = [];
    const errors = [];

    for (const url of Array.from(new Set(urls.filter(Boolean)))) {
      try {
        const raw = await fetchText(url);
        const parsed = /\.json(\?|#|$)/i.test(url) ? parseJsonCaptions(raw) : parseVttOrSrt(raw);
        if (parsed.length) collected.push(...parsed);
      } catch (error) {
        errors.push(`${url}: ${error.message}`);
      }
    }

    return { cues: dedupeCues(collected), errors };
  }

  async function extractTranscript(capturedUrls = []) {
    const analysis = state.lastAnalysis || analyzePage();
    const videoElement = analysis.video?.elementId
      ? document.querySelector(`video[data-skool-exporter-video-id="${CSS.escape(analysis.video.elementId)}"]`)
      : document.querySelector("video");
    const errors = [];
    const cues = [];

    if (videoElement) {
      cues.push(...cuesFromTextTracks(videoElement));
    }

    for (const captured of state.pageCaptionResponses) {
      cues.push(...parseCaptionText(captured.text, captured.url, captured.contentType));
    }

    const trackUrls = [
      ...(analysis.captionTracks || []).map((track) => track.src).filter((src) => src && isLikelyCaptionUrl(src)),
      ...capturedUrls.filter((item) => isLikelyCaptionUrl(item.url || item)).map((item) => item.url || item)
    ];

    const fromUrls = await transcriptFromTrackUrls(trackUrls);
    cues.push(...fromUrls.cues);
    errors.push(...fromUrls.errors);

    if (!cues.length) {
      cues.push(...renderedTranscriptCues());
    }

    const transcript = {
      ok: cues.length > 0,
      lessonTitle: analysis.lessonTitle,
      cues: dedupeCues(cues),
      sourceCount: trackUrls.length + state.pageCaptionResponses.length,
      errors,
      message: cues.length
        ? `Extracted ${dedupeCues(cues).length} transcript segment(s).`
        : "No transcript data could be extracted from tracks, caption requests, or rendered page text."
    };

    state.lastTranscript = transcript;
    return transcript;
  }

  function progress(step, detail = {}) {
    chrome.runtime.sendMessage({ type: "CONTENT_PROGRESS", step, detail }).catch(() => {});
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  }

  async function downloadBlobUrl(url, filename) {
    progress("video", { message: "Fetching browser-accessible blob media..." });
    let response;
    try {
      response = await fetch(url);
    } catch {
      throw new Error(
        "This blob URL cannot be fetched as a normal file. Reload the lesson, play the video for a few seconds, click Refresh, then try again so the extension can use the underlying media URL if it is directly accessible."
      );
    }
    if (!response.ok) throw new Error(`Blob fetch failed (${response.status}).`);
    const blob = await response.blob();
    if (!blob.size) throw new Error("Blob media was empty.");
    triggerBlobDownload(blob, filename);
    return { ok: true, message: "Blob media download started." };
  }

  function isEncryptedHls(text) {
    return /^#EXT-X-(SESSION-)?KEY:.*METHOD\s*=\s*(?!NONE(?:,|$))/im.test(text);
  }

  function assertSafeHlsPlaylist(text) {
    if (!/^#EXTM3U/m.test(text)) {
      throw new Error("The media URL did not return a valid HLS playlist.");
    }
    if (isEncryptedHls(text) || /KEYFORMAT\s*=\s*"(?!identity")/i.test(text)) {
      throw new Error(
        "Encrypted or DRM-protected HLS is unsupported. This extension never fetches decryption keys or bypasses protection."
      );
    }
    if (/^#EXTINF:/m.test(text) && !/^#EXT-X-ENDLIST/m.test(text)) {
      throw new Error("Live or incomplete HLS playlists are unsupported. Only completed lesson videos can be exported.");
    }
  }

  function mediaRequestUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function directoryForUrl(url) {
    const parsed = new URL(url);
    return parsed.pathname.slice(0, parsed.pathname.lastIndexOf("/") + 1);
  }

  function addAuthContext(contexts, url) {
    try {
      const parsed = new URL(url);
      const key = `${parsed.origin}${directoryForUrl(parsed)}?${parsed.searchParams.toString()}`;
      if (!contexts.some((entry) => entry.key === key)) {
        contexts.push({
          key,
          origin: parsed.origin,
          directory: directoryForUrl(parsed),
          searchParams: new URLSearchParams(parsed.search)
        });
      }
    } catch {
      // Ignore malformed context URLs.
    }
  }

  function inheritSignedQuery(url, contexts) {
    const parsed = new URL(url);
    const context = contexts
      .filter((entry) => entry.origin === parsed.origin && parsed.pathname.startsWith(entry.directory))
      .sort((a, b) => b.directory.length - a.directory.length)[0];
    if (!context) return parsed.href;

    for (const [key, value] of context.searchParams) {
      if (!parsed.searchParams.has(key)) parsed.searchParams.append(key, value);
    }
    return parsed.href;
  }

  function cachedHlsResponse(url) {
    return [...state.pageHlsResponses]
      .reverse()
      .find((entry) => entry.url === url || entry.requestedUrl === url);
  }

  async function responseFromPageContext(url, init = {}) {
    const headers = new Headers(init.headers || {});
    const range = headers.get("range") || "";
    const payload = await requestPageResource(url, "binary", range);
    if (!payload?.ok) {
      throw new Error(payload?.error || `Media request failed (${payload?.status || "unknown"}).`);
    }

    const responseHeaders = new Headers();
    if (payload.contentType) responseHeaders.set("content-type", payload.contentType);
    if (payload.contentLength) responseHeaders.set("content-length", payload.contentLength);
    if (payload.contentRange) responseHeaders.set("content-range", payload.contentRange);
    if (payload.acceptRanges) responseHeaders.set("accept-ranges", payload.acceptRanges);

    return new Response(payload.buffer || new ArrayBuffer(0), {
      status: payload.status || 200,
      statusText: payload.statusText || "OK",
      headers: responseHeaders
    });
  }

  async function responseFromExtensionContext(url, init = {}) {
    const headers = new Headers(init.headers || {});
    const payload = await chrome.runtime.sendMessage({
      type: "FETCH_BINARY_BASE64",
      url,
      range: headers.get("range") || ""
    });
    if (!payload?.ok || !payload.base64) {
      throw new Error(payload?.error || "The extension could not fetch this directly accessible media fragment.");
    }

    const bytes = decodeBase64(payload.base64, "media");
    const responseHeaders = new Headers();
    if (payload.contentType) responseHeaders.set("content-type", payload.contentType);
    if (payload.contentRange) responseHeaders.set("content-range", payload.contentRange);
    if (payload.acceptRanges) responseHeaders.set("accept-ranges", payload.acceptRanges);
    return new Response(bytes, {
      status: payload.status || 200,
      headers: responseHeaders
    });
  }

  function rememberMediaFetchPreference(origin, routeName) {
    mediaFetchPreferences.delete(origin);
    mediaFetchPreferences.set(origin, routeName);
    while (mediaFetchPreferences.size > 20) {
      mediaFetchPreferences.delete(mediaFetchPreferences.keys().next().value);
    }
  }

  async function authorizedMediaFetch(url, init = {}) {
    const origin = new URL(url).origin;
    const errors = [];
    const routes = [
      {
        name: "direct",
        run: async () => {
          const credentials = origin === location.origin ? "same-origin" : "omit";
          return fetch(url, {
            ...init,
            credentials,
            cache: "default"
          });
        }
      },
      ...(state.pageBridgeAvailable
        ? [
            {
              name: "player",
              run: () => responseFromPageContext(url, init)
            }
          ]
        : []),
      {
        name: "extension",
        run: () => responseFromExtensionContext(url, init)
      }
    ];

    const preferredRoute = mediaFetchPreferences.get(origin);
    routes.sort((a, b) => Number(b.name === preferredRoute) - Number(a.name === preferredRoute));

    for (const route of routes) {
      try {
        const response = await route.run();
        if (!response.ok) {
          errors.push(`${route.name} request returned ${response.status}`);
          continue;
        }
        rememberMediaFetchPreference(origin, route.name);
        return response;
      } catch (error) {
        errors.push(error?.message || `${route.name} request failed`);
        if (route.name === preferredRoute) mediaFetchPreferences.delete(origin);
      }
    }

    throw new Error(
      `The directly accessible media fragment was blocked by every normal fetch path. ${errors.slice(-2).join("; ")}`
    );
  }

  function createSafeHlsFetch(rootUrl) {
    const authContexts = [];
    addAuthContext(authContexts, rootUrl);

    return async (input, init = {}) => {
      const requested = mediaRequestUrl(input);
      const normalizedUrl = inheritSignedQuery(requested, authContexts);
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      const range = headers.get("range");
      const cached = !range ? cachedHlsResponse(normalizedUrl) || cachedHlsResponse(requested) : null;

      let response;
      if (cached) {
        response = new Response(cached.text, {
          status: 200,
          headers: {
            "content-type": cached.contentType || "application/vnd.apple.mpegurl"
          }
        });
      } else {
        response = await authorizedMediaFetch(normalizedUrl, { ...init, headers });
      }

      if (!response.ok) {
        throw new Error(
          `Media request failed (${response.status}). The signed link may have expired; reload the lesson and play it again.`
        );
      }

      const contentType = response.headers.get("content-type") || "";
      if (/\.m3u8(\?|#|$)/i.test(normalizedUrl) || /mpegurl/i.test(contentType)) {
        const text = await response.clone().text();
        assertSafeHlsPlaylist(text);
        addAuthContext(authContexts, normalizedUrl);
      }

      return response;
    };
  }

  async function loadMediaToolkit() {
    if (!mediaToolkitPromise) {
      mediaToolkitPromise = import(chrome.runtime.getURL("vendor/mediabunny.min.mjs"));
    }
    try {
      return await mediaToolkitPromise;
    } catch {
      mediaToolkitPromise = null;
      throw new Error("The packaged MP4 remuxer could not be loaded. Reload the extension and try again.");
    }
  }

  async function downloadHls(url, filenameBase) {
    progress("video", { message: "Opening the authorized HLS lesson stream...", completed: 2, total: 100 });
    const toolkit = await loadMediaToolkit();
    const safeFetch = createSafeHlsFetch(url);
    const source = new toolkit.UrlSource(url, {
      requestInit: {
        credentials: "include",
        cache: "no-store"
      },
      fetchFn: safeFetch,
      parallelism: 6,
      maxCacheSize: 96 * 1024 * 1024,
      getRetryDelay: (attempt) => (attempt < 2 ? 0.5 * 2 ** attempt : null)
    });
    const input = new toolkit.Input({
      source,
      formats: toolkit.HLS_FORMATS
    });

    try {
      const videoTracks = await input.getVideoTracks();
      if (!videoTracks.length) {
        throw new Error("The HLS playlist did not expose a usable video track.");
      }

      const scoredVideoTracks = await Promise.all(
        videoTracks.map(async (track) => ({
          track,
          height: (await track.getDisplayHeight().catch(() => 0)) || 0,
          width: (await track.getDisplayWidth().catch(() => 0)) || 0
        }))
      );
      scoredVideoTracks.sort((a, b) => b.height - a.height || b.width - a.width);
      const selectedVideo = scoredVideoTracks[0].track;

      const audioTracks = await input.getAudioTracks();
      const selectedAudio =
        (await selectedVideo.getPrimaryPairableAudioTrack().catch(() => null)) || audioTracks[0] || null;

      progress("video", {
        message: `Preparing ${scoredVideoTracks[0].height || "best"}p video${selectedAudio ? " with audio" : ""}...`,
        completed: 8,
        total: 100
      });

      const target = new toolkit.BufferTarget();
      const output = new toolkit.Output({
        format: new toolkit.Mp4OutputFormat({ fastStart: "in-memory" }),
        target
      });
      const conversion = await toolkit.Conversion.init({
        input,
        output,
        tracks: "all",
        video: (track) => ({ discard: track !== selectedVideo }),
        audio: (track) => ({ discard: selectedAudio ? track !== selectedAudio : true }),
        tags: {}
      });

      if (!conversion.isValid) {
        const reasons = Array.from(new Set(conversion.discardedTracks.map((entry) => entry.reason))).join(", ");
        throw new Error(`The selected HLS tracks could not be remuxed into MP4${reasons ? ` (${reasons})` : ""}.`);
      }

      conversion.onProgress = (value) => {
        const percent = Math.max(10, Math.min(96, Math.round(10 + value * 86)));
        progress("video", {
          message: "Downloading and remuxing video and audio...",
          completed: percent,
          total: 100
        });
      };

      await conversion.execute();
      const buffer = target.buffer;
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 1024) {
        throw new Error("The remuxer produced an empty or incomplete MP4.");
      }

      const header = new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength));
      const box = String.fromCharCode(...header.slice(4, 8));
      if (box !== "ftyp") {
        throw new Error("The remuxer did not produce a valid MP4 file header.");
      }

      progress("video", { message: "Starting the completed MP4 download...", completed: 99, total: 100 });
      triggerBlobDownload(new Blob([buffer], { type: "video/mp4" }), `${filenameBase}.mp4`);
      return {
        ok: true,
        message: `Complete MP4 download started (${Math.round(buffer.byteLength / 1024 / 1024)} MB).`
      };
    } finally {
      input.dispose?.();
    }
  }

  function decodeBase64(value, label) {
    try {
      const normalized = String(value || "")
        .replace(/^data:[^,]+,/, "")
        .replace(/\s+/g, "");
      const binary = atob(normalized);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      if (!bytes.byteLength) throw new Error("empty");
      return bytes;
    } catch {
      throw new Error(`The Vimeo ${label} initialization data is invalid.`);
    }
  }

  function containsProtectedMp4Boxes(bytes) {
    let ascii = "";
    for (let index = 0; index < bytes.byteLength; index += 1) {
      const value = bytes[index];
      ascii += value >= 32 && value <= 126 ? String.fromCharCode(value) : " ";
    }
    return /(?:^|\s)(?:encv|enca|pssh|sinf|schm|tenc)(?:\s|$)/i.test(ascii);
  }

  function hasExplicitProtectionMetadata(root) {
    const seen = new Set();
    let visited = 0;

    function visit(node, depth) {
      if (!node || typeof node !== "object" || depth > 6 || seen.has(node) || visited++ > 1200) return false;
      seen.add(node);
      for (const [key, value] of Object.entries(node)) {
        if (/^(?:drm|widevine|fairplay|playready|encryption|encrypted|key_system|keysystems|pssh)$/i.test(key) && value) {
          return true;
        }
        if (value && typeof value === "object" && visit(value, depth + 1)) return true;
      }
      return false;
    }

    return visit(root, 0);
  }

  function selectVimeoDashTracks(config) {
    if (hasExplicitProtectionMetadata(config)) {
      throw new Error("DRM-protected Vimeo media is unsupported. This extension does not request keys or bypass protection.");
    }

    const videoTracks = config.video
      .filter(
        (track) =>
          isVimeoDashTrack(track) &&
          /^video\/mp4/i.test(track.mime_type || "") &&
          /^avc1/i.test(track.codecs || "") &&
          track.segments.length <= 10_000
      )
      .sort(
        (a, b) =>
          Number(b.height || 0) - Number(a.height || 0) ||
          Number(b.width || 0) - Number(a.width || 0) ||
          Number(b.bitrate || 0) - Number(a.bitrate || 0)
      );
    const audioTracks = config.audio
      .filter(
        (track) =>
          isVimeoDashTrack(track) &&
          /^audio\/mp4/i.test(track.mime_type || "") &&
          /^mp4a/i.test(track.codecs || "") &&
          track.segments.length <= 10_000
      )
      .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));

    if (!videoTracks.length) throw new Error("No supported unencrypted H.264 Vimeo video track was found.");
    if (!audioTracks.length) throw new Error("No supported unencrypted AAC Vimeo audio track was found.");

    const video = videoTracks[0];
    const audio = audioTracks[0];
    const videoInit = decodeBase64(video.init_segment, "video");
    const audioInit = decodeBase64(audio.init_segment, "audio");
    if (containsProtectedMp4Boxes(videoInit) || containsProtectedMp4Boxes(audioInit)) {
      throw new Error("Encrypted or DRM-protected Vimeo media is unsupported.");
    }

    return { video, audio, videoInit, audioInit };
  }

  function resolveVimeoDashSegmentUrl(entry, track, segment) {
    const configBase = new URL(entry.config.base_url, entry.url);
    const trackBase = track.base_url ? new URL(track.base_url, configBase) : configBase;
    return new URL(segment.url, trackBase).href;
  }

  async function fetchDashFragment(url, label, position, total) {
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await authorizedMediaFetch(url);
        if (!response.ok) throw new Error(`request failed (${response.status})`);
        const buffer = await response.arrayBuffer();
        if (!buffer.byteLength) throw new Error("empty response");
        return buffer;
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          const delay = 1200 * 2 ** attempt + ((position * 137) % 500);
          await new Promise((resolve) => window.setTimeout(resolve, delay));
        }
      }
    }
    throw new Error(
      `Vimeo ${label} fragment ${position + 1} of ${total} could not be fetched. Reload the lesson so its signed media links are fresh, then play and retry. (${lastError?.message || "request failed"})`
    );
  }

  async function downloadDashTrack(entry, track, initBytes, label, counter) {
    const segments = track.segments;
    const buffers = new Array(segments.length);
    let nextIndex = 0;
    const workerCount = Math.min(3, segments.length);

    async function worker() {
      while (nextIndex < segments.length) {
        const index = nextIndex++;
        const url = resolveVimeoDashSegmentUrl(entry, track, segments[index]);
        buffers[index] = await fetchDashFragment(url, label, index, segments.length);
        counter.completed += 1;
        progress("video", {
          message: `Downloading Vimeo video and audio (${counter.completed}/${counter.total} fragments)...`,
          completed: counter.completed,
          total: counter.total
        });
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    // The optional DASH index is not needed when all ordered media fragments are present.
    const parts = [initBytes, ...buffers];
    return new Blob(parts, { type: "video/mp4" });
  }

  async function remuxSeparateMp4Tracks(videoBlob, audioBlob, toolkit) {
    const videoInput = new toolkit.Input({
      source: new toolkit.BlobSource(videoBlob),
      formats: toolkit.ALL_FORMATS
    });
    const audioInput = new toolkit.Input({
      source: new toolkit.BlobSource(audioBlob),
      formats: toolkit.ALL_FORMATS
    });

    try {
      const videoTracks = await videoInput.getVideoTracks();
      const audioTracks = await audioInput.getAudioTracks();
      if (!videoTracks.length || !audioTracks.length) {
        throw new Error("The Vimeo fragments did not form complete video and audio tracks.");
      }

      const target = new toolkit.BufferTarget();
      const output = new toolkit.Output({
        format: new toolkit.Mp4OutputFormat({ fastStart: "in-memory" }),
        target
      });
      const videoConversion = await toolkit.Conversion.init({
        input: videoInput,
        output,
        composable: true,
        tracks: "all",
        video: {},
        audio: { discard: true }
      });
      const audioConversion = await toolkit.Conversion.init({
        input: audioInput,
        output,
        composable: true,
        tracks: "all",
        video: { discard: true },
        audio: {}
      });

      if (!videoConversion.utilizedTracks.length || !audioConversion.utilizedTracks.length) {
        throw new Error("The selected Vimeo tracks could not be remuxed into MP4.");
      }

      progress("video", { message: "Combining Vimeo video and audio into MP4...", completed: 92, total: 100 });
      await output.start();
      await Promise.all([videoConversion.execute(), audioConversion.execute()]);
      await output.finalize();

      const buffer = target.buffer;
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 1024) {
        throw new Error("The remuxer produced an empty or incomplete MP4.");
      }
      const header = new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength));
      if (String.fromCharCode(...header.slice(4, 8)) !== "ftyp") {
        throw new Error("The remuxer did not produce a valid MP4 file header.");
      }
      return buffer;
    } finally {
      videoInput.dispose?.();
      audioInput.dispose?.();
    }
  }

  async function downloadVimeoDash(filenameBase) {
    const entry = latestVimeoDashConfig();
    if (!entry) {
      throw new Error(
        "The Vimeo DASH metadata has not been captured yet. Reload the lesson, play from the beginning for 5-10 seconds, then click Refresh."
      );
    }

    const { video, audio, videoInit, audioInit } = selectVimeoDashTracks(entry.config);
    const total = video.segments.length + audio.segments.length;
    const counter = { completed: 0, total };
    progress("video", {
      message: `Preparing ${video.height || "best"}p Vimeo video with audio...`,
      completed: 1,
      total: 100
    });

    const [videoBlob, audioBlob] = await Promise.all([
      downloadDashTrack(entry, video, videoInit, "video", counter),
      downloadDashTrack(entry, audio, audioInit, "audio", counter)
    ]);
    const toolkit = await loadMediaToolkit();
    const buffer = await remuxSeparateMp4Tracks(videoBlob, audioBlob, toolkit);
    progress("video", { message: "Starting the completed MP4 download...", completed: 99, total: 100 });
    triggerBlobDownload(new Blob([buffer], { type: "video/mp4" }), `${filenameBase}.mp4`);
    return {
      ok: true,
      message: `Complete Vimeo MP4 download started (${Math.round(buffer.byteLength / 1024 / 1024)} MB).`
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      if (message?.type === "ANALYZE_PAGE") {
        sendResponse(analyzePage());
        return;
      }

      if (message?.type === "ANALYZE_PAGE_BROADCAST") {
        reportAnalysis();
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "EXTRACT_TRANSCRIPT") {
        sendResponse(await extractTranscript(message.capturedUrls || []));
        return;
      }

      if (message?.type === "DOWNLOAD_BLOB") {
        sendResponse(await downloadBlobUrl(message.url, message.filename));
        return;
      }

      if (message?.type === "DOWNLOAD_HLS") {
        sendResponse(await downloadHls(message.url, message.filenameBase));
        return;
      }

      if (message?.type === "DOWNLOAD_VIMEO_DASH") {
        sendResponse(await downloadVimeoDash(message.filenameBase));
        return;
      }

      sendResponse({ ok: false, error: "Unknown content command." });
    })().catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });

    return true;
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "skool-video-transcript-exporter") return;
    const { type, payload } = event.data;

    if (type === "PAGE_HOOK_READY") {
      state.pageBridgeAvailable = true;
      return;
    }

    if (type === "RESOURCE_RESPONSE" && payload?.requestId) {
      const pending = pendingResourceRequests.get(payload.requestId);
      if (!pending) return;
      pendingResourceRequests.delete(payload.requestId);
      if (payload.ok) {
        pending.resolve(payload);
      } else {
        pending.reject(new Error(payload.error || "The lesson page could not fetch the media resource."));
      }
      return;
    }

    if (type === "HLS_PLAYLIST_RESPONSE" && payload?.text && /^#EXTM3U/m.test(payload.text)) {
      const url = absoluteUrl(payload.url) || payload.url;
      const requestedUrl = absoluteUrl(payload.requestedUrl) || payload.requestedUrl || url;
      state.pageHlsResponses = [
        ...state.pageHlsResponses.filter((entry) => entry.url !== url && entry.requestedUrl !== requestedUrl),
        {
          url,
          requestedUrl,
          contentType: payload.contentType || "",
          text: payload.text,
          timestamp: payload.timestamp || Date.now()
        }
      ].slice(-20);
      reportAnalysis();
      return;
    }

    if (type === "VIMEO_DASH_CONFIG_RESPONSE" && payload?.config && payload?.url) {
      if (rememberVimeoDashConfig(payload.config, payload.url, payload.timestamp || Date.now())) {
        reportAnalysis();
      }
      return;
    }

    if (type === "CAPTION_RESPONSE" && payload?.text && isLikelyCaptionUrl(payload.url)) {
      for (const config of vimeoDashConfigsFromText(payload.text)) {
        rememberVimeoDashConfig(config, payload.url, payload.timestamp || Date.now());
      }
      state.pageCaptionResponses = [
        ...state.pageCaptionResponses.filter((entry) => entry.url !== payload.url),
        {
          url: absoluteUrl(payload.url) || payload.url,
          contentType: payload.contentType || "",
          text: payload.text,
          timestamp: payload.timestamp || Date.now()
        }
      ].slice(-20);
      reportAnalysis();
    }

    if (type === "NETWORK_RESPONSE" && payload?.url) {
      const url = absoluteUrl(payload.url) || payload.url;
      state.pageNetworkResponses = [
        ...state.pageNetworkResponses.filter((entry) => entry.url !== url),
        {
          url,
          status: payload.status,
          contentType: payload.contentType || "",
          timestamp: payload.timestamp || Date.now(),
          kind: mediaKindFromUrl(url, payload.contentType)
        }
      ].slice(-40);
      reportAnalysis();
    }
  });

  window.postMessage(
    {
      source: "skool-video-transcript-exporter-content",
      type: "BRIDGE_PING"
    },
    "*"
  );

  reportAnalysis();
  window.setTimeout(reportAnalysis, 1000);
  window.setTimeout(reportAnalysis, 3000);

  const observer = new MutationObserver(debounce(reportAnalysis, 800));
  if (document.documentElement) {
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "href", "style", "class"]
    });
  }
})();
