const DEFAULT_SETTINGS = {
  includeTimestamps: true,
  filenameFormat: "{title}-{date}.{ext}"
};

const MIME_TYPES = {
  txt: "text/plain",
  srt: "application/x-subrip",
  vtt: "text/vtt",
  json: "application/json"
};

let activeTab = null;
let analysis = null;
let transcript = null;
let settings = { ...DEFAULT_SETTINGS };

const dom = {
  lessonTitle: document.getElementById("lessonTitle"),
  videoStatus: document.getElementById("videoStatus"),
  videoMessage: document.getElementById("videoMessage"),
  transcriptStatus: document.getElementById("transcriptStatus"),
  transcriptMessage: document.getElementById("transcriptMessage"),
  refreshButton: document.getElementById("refreshButton"),
  downloadVideoButton: document.getElementById("downloadVideoButton"),
  extractTranscriptButton: document.getElementById("extractTranscriptButton"),
  copyTranscriptButton: document.getElementById("copyTranscriptButton"),
  includeTimestamps: document.getElementById("includeTimestamps"),
  filenameFormat: document.getElementById("filenameFormat"),
  progress: document.getElementById("progress"),
  progressBar: document.getElementById("progressBar"),
  progressPercent: document.getElementById("progressPercent"),
  progressText: document.getElementById("progressText"),
  errorBox: document.getElementById("errorBox")
};

function setError(message) {
  dom.errorBox.hidden = !message;
  dom.errorBox.textContent = message || "";
}

function setProgress(message, percent = null) {
  dom.progress.hidden = !message;
  dom.progressText.textContent = message || "";
  const normalized = percent == null ? null : Math.max(0, Math.min(100, Math.round(percent)));
  dom.progressBar.style.width = normalized == null ? "0%" : `${normalized}%`;
  dom.progressPercent.textContent = normalized == null ? "" : `${normalized}%`;
}

function sendToTab(type, payload = {}, frameId = analysis?.frameId ?? 0) {
  return sendToBackground("RELAY_TO_FRAME", {
    tabId: activeTab.id,
    frameId,
    command: type,
    payload
  });
}

function sendToBackground(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function safeFilenamePart(input, fallback = "skool-lesson") {
  return String(input || fallback)
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/\s/g, "-")
    .toLowerCase() || fallback;
}

function filenameFor(ext, title = analysis?.lessonTitle || "skool-lesson") {
  const date = new Date().toISOString().slice(0, 10);
  const format = settings.filenameFormat || DEFAULT_SETTINGS.filenameFormat;
  const withExt = format.includes("{ext}") ? format : `${format}.{ext}`;
  return withExt
    .replace(/\{title\}/g, safeFilenamePart(title))
    .replace(/\{date\}/g, date)
    .replace(/\{ext\}/g, ext)
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-")
    .replace(/-+/g, "-");
}

function renderAnalysis() {
  const videoState = (analysis?.videoStatus || "missing").toLowerCase();
  const transcriptState = (transcript?.ok ? "available" : analysis?.transcriptStatus || "missing").toLowerCase();
  const videoLabels = {
    downloadable: "Ready",
    conditional: "Ready to combine",
    unsupported: "Unsupported",
    missing: "Not found",
    unknown: "Unknown"
  };
  const transcriptLabels = {
    available: "Available",
    missing: "Not found",
    unknown: "Unknown"
  };

  dom.lessonTitle.textContent = analysis?.lessonTitle || "No Skool lesson detected";
  dom.videoStatus.textContent = videoLabels[videoState] || analysis?.videoStatus || "Not found";
  dom.videoMessage.textContent = `${analysis?.videoMessage || ""}${analysis?.frameCount ? ` Checked ${analysis.frameCount} frame(s).` : ""}`;
  dom.transcriptStatus.textContent = transcript?.ok ? "Extracted" : transcriptLabels[transcriptState] || "Not found";
  dom.transcriptMessage.textContent = transcript?.message || analysis?.transcriptMessage || "";
  dom.videoStatus.dataset.state = videoState;
  dom.transcriptStatus.dataset.state = transcriptState;

  const source = analysis?.video?.source;
  dom.downloadVideoButton.disabled = !source || !["downloadable", "conditional"].includes(source.status);
  dom.extractTranscriptButton.disabled = !analysis;
  dom.copyTranscriptButton.disabled = !analysis;
}

function formatTxt(cues, includeTimestamps) {
  return cues
    .map((cue) => {
      if (includeTimestamps && cue.start != null) {
        return `[${timestamp(cue.start, false)}] ${cue.text}`;
      }
      return cue.text;
    })
    .join("\n");
}

function timestamp(seconds, srt) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  const millis = Math.floor((value - Math.floor(value)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${srt ? "," : "."}${String(millis).padStart(3, "0")}`;
}

function formatSrt(cues) {
  return cues
    .map((cue, index) => {
      const start = timestamp(cue.start ?? 0, true);
      const end = timestamp(cue.end ?? (cue.start ?? 0) + 2, true);
      return `${index + 1}\n${start} --> ${end}\n${cue.text}`;
    })
    .join("\n\n");
}

function formatVtt(cues) {
  const body = cues
    .map((cue) => {
      const start = timestamp(cue.start ?? 0, false);
      const end = timestamp(cue.end ?? (cue.start ?? 0) + 2, false);
      return `${start} --> ${end}\n${cue.text}`;
    })
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

function transcriptAs(ext) {
  const cues = transcript?.cues || [];
  if (ext === "txt") return formatTxt(cues, settings.includeTimestamps);
  if (ext === "srt") return formatSrt(cues);
  if (ext === "vtt") return formatVtt(cues);
  return JSON.stringify(
    {
      lessonTitle: transcript.lessonTitle,
      pageUrl: analysis?.pageUrl,
      cueCount: cues.length,
      cues
    },
    null,
    2
  );
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  settings = {
    includeTimestamps: Boolean(stored.includeTimestamps),
    filenameFormat: stored.filenameFormat || DEFAULT_SETTINGS.filenameFormat
  };
  dom.includeTimestamps.checked = settings.includeTimestamps;
  dom.filenameFormat.value = settings.filenameFormat;
}

async function saveSettings() {
  settings = {
    includeTimestamps: dom.includeTimestamps.checked,
    filenameFormat: dom.filenameFormat.value.trim() || DEFAULT_SETTINGS.filenameFormat
  };
  await chrome.storage.sync.set(settings);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  setError("");
  setProgress("Checking active Skool lesson...", 10);
  transcript = null;
  activeTab = await getActiveTab();

  if (!activeTab?.id || !/^https:\/\/([^/]+\.)?skool\.com\//i.test(activeTab.url || "")) {
    analysis = null;
    setProgress("");
    setError("Open a Skool classroom or lesson page where you are logged in and have permission to access the content.");
    renderAnalysis();
    return;
  }

  try {
    const response = await sendToBackground("GET_TAB_ANALYSIS", { tabId: activeTab.id });
    if (!response?.ok) throw new Error(response?.error || "Analysis failed.");
    analysis = response.analysis;
    setProgress("");
  } catch (error) {
    analysis = null;
    setProgress("");
    setError("Could not inspect this tab. Reload the Skool page, then open the extension again.");
  }

  renderAnalysis();
}

async function downloadVideo() {
  const source = analysis?.video?.source;
  if (!source) return;

  setError("");
  setProgress("Preparing video download...", 15);

  try {
    if (source.kind === "direct") {
      const extMatch = source.url.match(/\.(mp4|webm|mov|m4v|ogv)(?=\?|#|$)/i);
      const ext = (extMatch?.[1] || "mp4").toLowerCase();
      const probe = await sendToBackground("PROBE_MEDIA_URL", { url: source.url });
      if (probe?.kind === "segment") {
        const capturedHls = analysis?.capturedMedia?.kind === "hls" ? analysis.capturedMedia : null;
        if (capturedHls) {
          const fallback = await sendToTab(
            "DOWNLOAD_HLS",
            {
              url: capturedHls.url,
              filenameBase: filenameFor("").replace(/[.\s-]+$/, "")
            },
            capturedHls.frameId ?? analysis?.frameId ?? 0
          );
          if (!fallback?.ok) throw new Error(fallback?.error || "HLS fallback download failed.");
          setProgress(fallback.message || "Complete MP4 download started.", 100);
          return;
        }
        const fallback = await sendToTab(
          "DOWNLOAD_VIMEO_DASH",
          {
            filenameBase: filenameFor("").replace(/[.\s-]+$/, "")
          },
          source.frameId ?? analysis?.frameId ?? 0
        );
        if (!fallback?.ok) {
          throw new Error(
            fallback?.error ||
              "Only one media fragment was captured. Reload the lesson, play from the beginning for 5-10 seconds, then click Refresh."
          );
        }
        setProgress(fallback.message || "Complete Vimeo MP4 download started.", 100);
        return;
      }
      const response = await sendToBackground("DOWNLOAD_URL", {
        payload: {
          url: source.url,
          filename: filenameFor(ext)
        }
      });
      if (!response?.ok) throw new Error(response?.error || "Download failed.");
      setProgress("Video download started.", 100);
      return;
    }

    if (source.kind === "blob") {
      const response = await sendToTab("DOWNLOAD_BLOB", {
        url: source.url,
        filename: filenameFor("mp4")
      }, source.frameId ?? analysis?.frameId ?? 0);
      if (!response?.ok) throw new Error(response?.error || "Blob download failed.");
      setProgress(response.message || "Video download started.", 100);
      return;
    }

    if (source.kind === "hls") {
      const response = await sendToTab("DOWNLOAD_HLS", {
        url: source.url,
        filenameBase: filenameFor("").replace(/[.\s-]+$/, "")
      }, source.frameId ?? analysis?.frameId ?? 0);
      if (!response?.ok) throw new Error(response?.error || "HLS download failed.");
      setProgress(response.message || "Video download started.", 100);
      return;
    }

    if (source.kind === "vimeo-dash") {
      const response = await sendToTab(
        "DOWNLOAD_VIMEO_DASH",
        {
          filenameBase: filenameFor("").replace(/[.\s-]+$/, "")
        },
        source.frameId ?? analysis?.frameId ?? 0
      );
      if (!response?.ok) throw new Error(response?.error || "Vimeo DASH download failed.");
      setProgress(response.message || "Complete Vimeo MP4 download started.", 100);
      return;
    }

    throw new Error(source.message || "This media source is unsupported.");
  } catch (error) {
    setProgress("");
    setError(error.message || String(error));
  }
}

async function loadTranscript() {
  const captured = await sendToBackground("GET_CAPTURED_CAPTIONS", { tabId: activeTab.id });
  const result = await sendToBackground("EXTRACT_TRANSCRIPT_FROM_TAB", {
    tabId: activeTab.id,
    capturedUrls: captured?.captions || []
  });
  if (!result?.ok) {
    throw new Error(result?.message || "No transcript could be extracted.");
  }
  transcript = result;
  renderAnalysis();
  return result;
}

async function extractTranscript() {
  setError("");
  setProgress("Extracting transcript and preparing TXT...", 20);

  try {
    if (!transcript?.ok) await loadTranscript();
    const response = await sendToBackground("DOWNLOAD_TEXT", {
      payload: {
        filename: filenameFor("txt", transcript.lessonTitle),
        text: transcriptAs("txt"),
        mimeType: MIME_TYPES.txt
      }
    });
    if (!response?.ok) throw new Error(response?.error || "TXT export failed.");
    setProgress("TXT transcript export started.", 100);
  } catch (error) {
    transcript = null;
    setProgress("");
    setError(error.message || String(error));
  }

  renderAnalysis();
}

async function copyTranscript() {
  setError("");
  setProgress(transcript?.ok ? "Copying transcript..." : "Extracting transcript to copy...", 20);
  try {
    if (!transcript?.ok) await loadTranscript();
    await navigator.clipboard.writeText(transcriptAs("txt"));
    setProgress("Transcript copied to clipboard.", 100);
  } catch (error) {
    transcript = null;
    setProgress("");
    setError(error.message || String(error));
    renderAnalysis();
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "CONTENT_PROGRESS") return;
  const { message: text, completed, total } = message.detail || {};
  const percent = total ? Math.round((completed / total) * 100) : null;
  setProgress(text || "Working...", percent);
});

dom.refreshButton.addEventListener("click", refresh);
dom.downloadVideoButton.addEventListener("click", downloadVideo);
dom.extractTranscriptButton.addEventListener("click", extractTranscript);
dom.copyTranscriptButton.addEventListener("click", copyTranscript);
dom.includeTimestamps.addEventListener("change", saveSettings);
dom.filenameFormat.addEventListener("change", saveSettings);

loadSettings().then(refresh).catch((error) => {
  setError(error.message || String(error));
});
