# Skool Video & Transcript Exporter

Production-ready Chrome Extension (Manifest V3) for exporting Skool lesson video and transcript data when the logged-in user already has legitimate access and permission to download the content.

Version 1.9 adds automatic recovery when Skool replaces the lesson player iframe, remembers the fastest successful media fetch route per CDN host, raises balanced Vimeo fragment concurrency from four to six total requests, and bundles Inter Variable for clearer popup typography.

## Safety boundary

This extension is for authorized content only. It does not implement DRM circumvention, encryption-key fetching, token stealing, cookie extraction, hidden API abuse, paywall bypassing, or authentication bypass.

Video download is offered only when the current Skool page exposes one of these browser-accessible sources:

- A normal direct HTML5 media URL such as `.mp4`, `.webm`, `.mov`, `.m4v`, or `.ogv`.
- A `blob:` URL that the page context can fetch normally.
- An HLS `.m3u8` playlist only when the playlist and all media segments are unencrypted and directly fetchable in the authorized lesson page.
- Vimeo DASH JSON only when it contains inline MP4 initialization data and directly fetchable, unencrypted H.264/AAC fragments already exposed to the authorized player.

Unsupported cases are reported in the popup. Encrypted HLS/DASH, DRM, protected streams, other DASH packaging, and signed resources that the authorized lesson page cannot fetch are not downloaded.

## Features

- Detects the active visible Skool lesson video.
- Checks same-tab frames because some Skool lessons render the player inside embedded frame content.
- Recovers automatically when lesson navigation replaces a previously detected player frame.
- Tracks recent browser-visible direct media, HLS, and caption requests for the active tab.
- Preserves an HLS playlist's existing signed query parameters when its relative child resources require the same parameters.
- Selects the best HLS video track and pairs a separate audio track when the stream uses split renditions.
- Remuxes unencrypted HLS into one valid, seekable MP4 without re-encoding.
- Captures structurally valid Vimeo DASH configuration responses without reading request headers or cookies.
- Selects the highest H.264 Vimeo video track and AAC audio track, then remuxes both into one MP4 without re-encoding.
- Retries directly accessible Vimeo fragments through three normal browser fetch paths without extracting cookies or request headers.
- Uses six balanced Vimeo fragment workers, remembers successful CDN fetch routes, and keeps exponential backoff for transient failures.
- Ignores optional provider index metadata and rebuilds MP4 indexing from the downloaded fragments.
- Captures page-visible caption/transcript fetch/XHR response text when the page itself receives it.
- Detects direct media, safe blob media, HLS, DASH, and unsupported media states.
- Extracts captions from `<track>` elements and loaded browser text tracks.
- Uses recent visible caption/subtitle/transcript requests observed in the active tab.
- Falls back to transcript/caption text already rendered in the page.
- Extracts transcripts and exports TXT directly from the main transcript button.
- Cleans newline-delimited diagnostics by extracting bracketed timestamp lines and excluding player JSON metadata.
- Extracts and copies clean transcript text in one click.
- Supports optional TXT/copy timestamps.
- Supports filename templates with `{title}`, `{date}`, and `{ext}`.

## Install locally

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `skool-video-transcript-exporter` folder.
5. Open a Skool classroom or lesson page where you are logged in and have permission to access the material.
6. Reload the Skool lesson page after installing or updating the extension.
7. Play the lesson video for a few seconds so the player loads its media/caption requests.
8. Click the extension icon.

## Test checklist

Use only courses/classes where you have legitimate access.

1. Open a Skool lesson with a regular HTML5 video.
2. Reload the lesson page, then play the video for a few seconds.
3. Click **Refresh** and confirm the lesson title and video status update.
4. If video status says direct, captured media, unencrypted HLS, or unencrypted Vimeo DASH, click **Download Video**.
5. Click **Export Transcript TXT**.
6. Try **Copy Transcript**.
7. Toggle **Include timestamps** and extract/copy TXT again.
8. Change the filename format, for example `{title}-{date}.{ext}`.
9. Open a second lesson without reloading the Skool tab, play it briefly, and verify **Download Video** targets the new lesson.

## If you still see "Failed to fetch"

1. Open `chrome://extensions`.
2. Click the reload icon on this extension.
3. Reload the Skool lesson page.
4. Start the video and let it play for 5-10 seconds.
5. Open the extension popup and click **Refresh**.

If the video reports that only fragmented media segments were captured, the extension will not save one segment as a fake MP4. Reload the lesson, play from the beginning for 5-10 seconds, and refresh the popup so it can capture fresh HLS or Vimeo DASH metadata. Version 1.9 then downloads the authorized unencrypted video/audio renditions and remuxes them into MP4. If the source is encrypted, DRM-protected, expired, or otherwise inaccessible to the lesson page, the extension reports it as unsupported.

## Expected limitations

- Some video providers intentionally expose only DRM, encrypted HLS/DASH, or short-lived protected resources. Those are reported as unsupported.
- Browser CORS rules can prevent isolated page fetching even when a video element can play media. Version 1.9 retries supported media through the active player and extension service worker using the signed URLs already exposed to the lesson, but protected resources still fail.
- MP4 output is memory-based. Very large lessons may take time or fail if Chrome cannot allocate enough memory.
- Generic DASH manifests remain unsupported. Version 1.9 supports only the validated unencrypted Vimeo H.264/AAC structure described above.
- Short-lived signed media URLs can expire. Reload and play the lesson again to capture a fresh playlist.

## Project structure

```text
manifest.json
src/background/service-worker.js
src/content/content.js
src/popup/popup.html
src/popup/popup.css
src/popup/popup.js
icons/
fonts/inter-latin-wght-normal.woff2
vendor/mediabunny.min.mjs
```

## Third-party software

The packaged MP4 remuxer is Mediabunny 1.51.0, distributed under the Mozilla Public License 2.0. Its license is included at `vendor/mediabunny-LICENSE.txt`.

Popup icons are from Lucide Static 1.27.0, distributed under the ISC License. Its license is included at `vendor/lucide-LICENSE.txt`.

Popup typography uses Inter Variable 5.3.0 from Fontsource, distributed under the SIL Open Font License 1.1. Its license is included at `vendor/inter-LICENSE.txt`.

## License

The extension's original source code is released under the [MIT License](LICENSE).
Bundled third-party components remain subject to their respective licenses in `vendor/`.

## Permissions

- `downloads`: starts user-visible downloads for video and transcript exports.
- `storage`: saves timestamp and filename settings.
- `webRequest`: observes likely caption/subtitle/transcript URLs for the active browser tab. It stores only URL/status metadata temporarily and never reads cookies or request headers.
- `http://*/*`, `https://*/*` host permissions: required because Skool lessons can serve media, captions, and embedded player frames from multiple CDN/provider domains. The popup only activates for Skool tabs, and unsupported protected content is reported rather than bypassed.
