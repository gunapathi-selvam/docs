// Orchestrator. Wires recorder, transcriber, stitcher, and summariser together.
// Manages the UI state machine and the transcript / summary panes.

import { startRecording } from './recorder.js';
import { loadModel, transcribeWindow } from './transcriber.js';
import { stitchWindows } from './stitch.js';
import { summarise, estimateTokens } from './summarize.js';

// Constants used by tests
export const SEEK_LEAD_S = 0.75; // SPEC §7.3

// Published rates for claude-opus-5-5, the model server.js pins. An earlier
// draft hardcoded $15/$75 inline, overstating the figure by roughly 3.75x in a
// panel the user reads *before* deciding to send — an estimate that is wrong in
// the expensive direction is worse than no estimate at all.
//
// These are named and exported so the value the UI shows and the value a test
// can assert are the same one, and so a price change is a single edit. If the
// pinned model in server.js changes, change these with it.
export const USD_PER_MTOK_INPUT = 4.0;
export const USD_PER_MTOK_OUTPUT = 20.0;

// The summary schema is a fixed shape, so output length barely varies with
// input length; a flat figure is honest here in a way a ratio would not be.
export const TYPICAL_OUTPUT_TOKENS = 2000;

/**
 * Return the `mm:ss` display format for a time in seconds.
 * Never renders sub-second precision. SPEC §7.3
 */
export function formatTime(seconds) {
  const s = Math.floor(seconds);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

/**
 * Read transcribe-only status from the server and update the banner
 * and Summarise button accordingly. SPEC §13.2
 */
export async function checkApiStatus(doc, fetchFn = fetch) {
  const banner = doc.getElementById('transcribe-only-banner');
  const reason = doc.getElementById('transcribe-only-reason');
  const summariseBtn = doc.getElementById('summarise-btn');

  let available = false;
  let reasonText = '';
  try {
    const resp = await fetchFn('/api/claude/status');
    const data = await resp.json();
    available = data.available === true;
    reasonText = data.reason ?? '';
  } catch (err) {
    reasonText = String(err.message ?? err);
  }

  if (available) {
    if (banner) banner.hidden = true;
    if (summariseBtn) {
      summariseBtn.removeAttribute('aria-disabled');
      summariseBtn.disabled = false;
    }
  } else {
    if (banner) {
      banner.hidden = false;
      if (reason) {
        const cause = reasonText || 'Summarisation is unavailable.';
        // Recording and transcription are fully functional — only summarisation needs the key.
        reason.textContent = `${cause} Recording and transcription are fully functional and never leave this device.`;
      }
    }
    if (summariseBtn) {
      summariseBtn.setAttribute('aria-disabled', 'true');
      summariseBtn.setAttribute('aria-describedby', 'transcribe-only-banner');
    }
  }
}

/**
 * Build the DOM row for one transcript segment.
 * Returns an element with a click handler that seeks the audio. SPEC §14.2
 */
export function buildTranscriptRow(doc, segment, onSeek) {
  const row = doc.createElement('div');
  row.setAttribute('role', 'listitem');
  row.className = 'transcript-row';
  row.dataset.t = String(segment.t);

  const stamp = doc.createElement('button');
  stamp.type = 'button';
  stamp.className = 'transcript-ts';
  stamp.setAttribute('aria-label', `Seek to ${formatTime(segment.t)}`);
  stamp.textContent = formatTime(segment.t);
  stamp.addEventListener('click', () => {
    // Remove aria-current from all rows, set on this one
    const list = row.parentElement;
    if (list) {
      const rows = list.querySelectorAll('[aria-current="true"]');
      rows.forEach((r) => r.removeAttribute('aria-current'));
    }
    row.setAttribute('aria-current', 'true');
    onSeek?.(segment.t);
  });

  const text = doc.createElement('span');
  text.className = 'transcript-text';
  // textContent prevents XSS — transcript text is user audio, not trusted HTML.
  text.textContent = segment.text;

  row.appendChild(stamp);
  row.appendChild(text);
  return row;
}

/**
 * Insert a low-confidence seam marker into the transcript list. SPEC §6.5
 */
export function insertSeamMarker(doc, containerEl, seam) {
  const hr = doc.createElement('hr');
  hr.className = 'seam-marker';
  const atTime = seam.at != null ? formatTime(seam.at) : '';
  const method = seam.method ?? 'time';
  const label = `Low-confidence seam at ${atTime} (${method} cut — timestamps approximate)`;
  hr.setAttribute('aria-label', label);
  hr.title = label;
  containerEl.appendChild(hr);
}

/**
 * Render the summary object into the summary pane. Each item with anchored != false
 * becomes a button that seeks the audio. Items with anchored: false are plain text. SPEC §14.3
 */
export function renderSummary(doc, summary, onSeek) {
  const titleEl = doc.getElementById('summary-title');
  const keyPointsEl = doc.getElementById('summary-key-points');
  const actionItemsEl = doc.getElementById('summary-action-items');
  const openQuestionsEl = doc.getElementById('summary-open-questions');

  if (titleEl) {
    // textContent prevents XSS — model output is untrusted.
    titleEl.textContent = summary.title ?? '';
  }

  function renderItems(containerEl, items) {
    if (!containerEl) return;
    // Clear existing content
    while (containerEl.firstChild) containerEl.removeChild(containerEl.firstChild);

    (items ?? []).forEach((item) => {
      const li = doc.createElement('li');
      li.className = 'summary-item';

      if (item.anchored !== false && typeof item.t === 'number') {
        // Seekable item — render as a button
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'summary-seek-btn';
        btn.setAttribute('aria-label', `Go to ${formatTime(item.t)}: ${item.text}`);

        const ts = doc.createElement('span');
        ts.className = 'summary-ts';
        ts.textContent = formatTime(item.t);

        const txt = doc.createElement('span');
        txt.className = 'summary-item-text';
        // textContent prevents XSS — model output is untrusted.
        txt.textContent = item.text;

        if (item.owner) {
          const owner = doc.createElement('span');
          owner.className = 'summary-owner';
          owner.textContent = ` (${item.owner})`;
          txt.appendChild(owner);
        }

        btn.appendChild(ts);
        btn.appendChild(txt);
        btn.addEventListener('click', () => onSeek?.(item.t));
        li.appendChild(btn);
      } else {
        // Non-anchored item — plain text
        const txt = doc.createElement('span');
        txt.className = 'summary-item-text';
        txt.textContent = item.text;
        if (item.owner) {
          const owner = doc.createElement('span');
          owner.className = 'summary-owner';
          owner.textContent = ` (${item.owner})`;
          txt.appendChild(owner);
        }
        li.appendChild(txt);
      }

      containerEl.appendChild(li);
    });
  }

  renderItems(keyPointsEl, summary.key_points);
  renderItems(actionItemsEl, summary.action_items);
  renderItems(openQuestionsEl, summary.open_questions);
}

/**
 * Show the confirmation panel before sending the transcript to Claude. SPEC §14.4
 * Returns a Promise that resolves true (send) or false (cancel).
 */
export function showConfirmPanel(doc, transcript, mode) {
  const panel = doc.getElementById('confirm-panel');
  const charsEl = doc.getElementById('confirm-chars');
  const tokensEl = doc.getElementById('confirm-tokens');
  const costEl = doc.getElementById('confirm-cost');
  const modeEl = doc.getElementById('confirm-mode');
  const previewEl = doc.getElementById('confirm-preview');
  const sendBtn = doc.getElementById('confirm-send-btn');
  const cancelBtn = doc.getElementById('confirm-cancel-btn');

  const totalChars = transcript.reduce((n, s) => n + (s.text ? s.text.length : 0), 0);
  const estTokens = estimateTokens(transcript);

  const inputCostUsd = (estTokens / 1_000_000) * USD_PER_MTOK_INPUT;
  const outputCostUsd = (TYPICAL_OUTPUT_TOKENS / 1_000_000) * USD_PER_MTOK_OUTPUT;
  const totalCostUsd = inputCostUsd + outputCostUsd;
  const costStr = totalCostUsd < 0.01
    ? '< $0.01'
    : `~$${totalCostUsd.toFixed(3)} (estimate)`;

  if (charsEl) charsEl.textContent = totalChars.toLocaleString();
  if (tokensEl) tokensEl.textContent = `~${estTokens.toLocaleString()} (estimate)`;
  if (costEl) costEl.textContent = costStr;
  if (modeEl) modeEl.textContent = mode ?? 'standard';

  // Request preview — use textContent to avoid XSS
  if (previewEl) {
    const preview = {
      mode: estTokens > 12000 ? 'map_reduce' : 'single',
      length: mode ?? 'standard',
      transcript: transcript.slice(0, 3).map((s) => ({ t: s.t, text: s.text })),
      // (truncated for preview — full transcript is sent)
    };
    previewEl.textContent = JSON.stringify(preview, null, 2) +
      (transcript.length > 3 ? '\n// ... (truncated)' : '');
  }

  if (panel) panel.hidden = false;

  return new Promise((resolve) => {
    function cleanup() {
      if (panel) panel.hidden = true;
      sendBtn?.removeEventListener('click', onSend);
      cancelBtn?.removeEventListener('click', onCancel);
    }
    function onSend() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    sendBtn?.addEventListener('click', onSend);
    cancelBtn?.addEventListener('click', onCancel);
  });
}

/**
 * Update the level meter from a { peak, rms } reading. SPEC §4.4
 */
export function updateLevelMeter(doc, peak) {
  const fill = doc.getElementById('level-fill');
  const pct = doc.getElementById('level-pct');
  const bar = doc.getElementById('level-bar');

  const pctVal = Math.round(Math.min(1, Math.max(0, peak)) * 100);

  if (fill) fill.style.width = `${pctVal}%`;
  if (pct) pct.textContent = `${pctVal} %`;
  if (bar) bar.setAttribute('aria-valuenow', String(pctVal));
}

/**
 * Update the record timer display.
 */
export function updateRecordTime(doc, frames) {
  const el = doc.getElementById('record-time');
  if (el) el.textContent = formatTime(frames / 16000);
}

// ---- VTT time format helper (HH:MM:SS.mmm) ----------------------------------
function toVTTTime(sec) {
  const t = Math.max(0, sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t % 1) * 1000);
  return (
    String(h).padStart(2, '0') + ':' +
    String(m).padStart(2, '0') + ':' +
    String(s).padStart(2, '0') + '.' +
    String(ms).padStart(3, '0')
  );
}

// ---- Download helper -------------------------------------------------------
function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Entry point. Called from the module script tag.
 */
export async function init(doc = document, fetchFn = fetch) {
  // ---- Check API status (non-fatal if server unreachable) -----------------
  try {
    await checkApiStatus(doc, fetchFn);
  } catch (err) {
    // Status check failure doesn't prevent local recording.
    console.warn('API status check failed:', err.message);
  }

  // ---- DOM references ------------------------------------------------------
  const recordBtn          = doc.getElementById('record-btn');
  const recordTimeEl       = doc.getElementById('record-time');
  const modelDownloadBtn   = doc.getElementById('model-download-btn');
  const modelIdle          = doc.getElementById('model-idle');
  const modelLoading       = doc.getElementById('model-loading');
  const modelWarmup        = doc.getElementById('model-warmup');
  const modelReady         = doc.getElementById('model-ready');
  const modelBackendLabel  = doc.getElementById('model-backend-label');
  const modelProgressFill  = doc.getElementById('model-progress-fill');
  const modelProgressText  = doc.getElementById('model-progress-text');
  const modelProgress      = doc.getElementById('model-progress');
  const transcriptList     = doc.getElementById('transcript-list');
  const summariseBtn       = doc.getElementById('summarise-btn');
  const summaryLength      = doc.getElementById('summary-length');
  const summaryLoading     = doc.getElementById('summary-loading');
  const summaryContent     = doc.getElementById('summary-content');
  const summaryError       = doc.getElementById('summary-error');
  const transcriptSearch   = doc.getElementById('transcript-search');
  const copyMarkdownBtn    = doc.getElementById('copy-markdown-btn');
  const exportTxtBtn       = doc.getElementById('export-txt-btn');
  const exportVttBtn       = doc.getElementById('export-vtt-btn');
  const saveBtn            = doc.getElementById('save-btn');
  const diagBackend        = doc.getElementById('diag-backend');
  const diagQueue          = doc.getElementById('diag-queue');
  const diagWindowTime     = doc.getElementById('diag-window-time');
  const diagSummarise      = doc.getElementById('diag-summarise');
  const playbackAudio      = doc.getElementById('playback-audio');

  // ---- Application state ---------------------------------------------------
  let recorder         = null;
  let modelLoaded      = false;
  let isRecording      = false;
  let transcript       = [];  // [ { t, text } ] — grouped segments for display and summarise
  let stitchedTokens   = [];
  let stitchedSeams    = [];
  let windowResults    = [];  // [ { windowStart, segments } ]
  let timerInterval    = null;

  // ---- Error display -------------------------------------------------------
  function showSummaryError(msg) {
    if (summaryError) {
      summaryError.hidden = false;
      summaryError.textContent = msg;
    }
  }

  function clearSummaryPanels() {
    // Exactly one of loading/content/error must be visible at a time.
    if (summaryLoading) summaryLoading.hidden = true;
    if (summaryContent) summaryContent.hidden = true;
    if (summaryError)   summaryError.hidden   = true;
  }

  // ---- Group stitch tokens into display/summarise segments ----------------
  // Whisper produces segments; stitching tokenises them. Re-group words that
  // are close in time so the transcript pane and the Claude prompt are readable.
  function tokensToSegments(tokens) {
    if (!tokens || tokens.length === 0) return [];
    const segs = [];
    let group = [tokens[0]];

    for (let i = 1; i < tokens.length; i++) {
      // Start a new group if gap between words > 0.8 s
      if (tokens[i].start - tokens[i - 1].end > 0.8) {
        segs.push({ t: group[0].start, text: group.map((w) => w.text).join(' ') });
        group = [];
      }
      group.push(tokens[i]);
    }
    if (group.length > 0) {
      segs.push({ t: group[0].start, text: group.map((w) => w.text).join(' ') });
    }
    return segs;
  }

  // ---- Seek helper ---------------------------------------------------------
  function seekTo(t) {
    if (playbackAudio && playbackAudio.src) {
      playbackAudio.currentTime = Math.max(0, t - SEEK_LEAD_S);
      playbackAudio.play().catch(() => {});
    }
  }

  // ---- Render transcript list ---------------------------------------------
  function renderTranscriptList() {
    if (!transcriptList) return;
    while (transcriptList.firstChild) transcriptList.removeChild(transcriptList.firstChild);

    if (transcript.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'transcript-empty';
      empty.textContent = isRecording ? 'Transcribing...' : 'No transcript yet. Press Record to begin.';
      transcriptList.appendChild(empty);
      return;
    }

    // Interleave seams and tokens. Seams carry absolute time in seconds.
    let si = 0;
    for (let i = 0; i < stitchedTokens.length; i++) {
      const tok = stitchedTokens[i];
      while (si < stitchedSeams.length && stitchedSeams[si].at <= (tok.start ?? 0)) {
        insertSeamMarker(doc, transcriptList, stitchedSeams[si]);
        si++;
      }
    }

    // Render grouped segments
    for (const seg of transcript) {
      const row = buildTranscriptRow(doc, seg, seekTo);
      transcriptList.appendChild(row);
    }
  }

  // ---- Window processing queue --------------------------------------------
  // Windows arrive ~every 25 s; transcription may take longer on slow hardware.
  // A queue ensures sequential processing without blocking the recorder.
  const windowQueue = [];
  let processingWindow = false;

  async function processNextWindow() {
    if (processingWindow || windowQueue.length === 0) return;
    processingWindow = true;

    if (diagQueue) diagQueue.textContent = String(windowQueue.length);

    const { windowStart, samples } = windowQueue.shift();

    try {
      const result = await transcribeWindow(samples, windowStart);
      // windowStart from transcribeWindow is already in seconds
      windowResults.push({ windowStart: result.windowStart, segments: result.segments });

      // Update backend label if it changed (wasm fallback)
      if (result.backend && modelBackendLabel) {
        modelBackendLabel.textContent = `Ready (${result.backend})`;
      }
      if (result.backend && diagBackend) {
        diagBackend.textContent = result.backend;
      }
      if (diagWindowTime) {
        diagWindowTime.textContent = formatTime(result.windowStart);
      }

      // Re-stitch from all windows
      const stitched = stitchWindows(windowResults);
      stitchedTokens = stitched.tokens;
      stitchedSeams  = stitched.seams;
      transcript     = tokensToSegments(stitchedTokens);

      renderTranscriptList();
    } catch (err) {
      // Transcription error for this window — log but do not crash the page.
      console.error('Transcription error for window at', windowStart, ':', err.message);
    } finally {
      processingWindow = false;
      if (diagQueue) diagQueue.textContent = String(windowQueue.length);
      // Drain next item from queue
      if (windowQueue.length > 0) processNextWindow();
    }
  }

  function enqueueWindow(windowStart, samples) {
    windowQueue.push({ windowStart, samples });
    if (diagQueue) diagQueue.textContent = String(windowQueue.length);
    processNextWindow().catch((err) => {
      // An unhandled error in the queue would silence all future windows.
      // Route it to visible UI rather than swallowing it.
      showSummaryError(`Window processing error: ${err.message}`);
    });
  }

  // ---- Model download ------------------------------------------------------
  if (modelDownloadBtn) {
    modelDownloadBtn.addEventListener('click', async () => {
      modelDownloadBtn.disabled = true;
      if (modelIdle) modelIdle.hidden = true;
      if (modelLoading) modelLoading.hidden = false;

      let lastFile = '';

      try {
        const result = await loadModel((progress) => {
          if (progress.status === 'warmup') {
            if (modelLoading) modelLoading.hidden = true;
            if (modelWarmup) modelWarmup.hidden = false;
            return;
          }
          if (progress.status === 'downloading' || progress.status === 'progress') {
            const file = progress.file ?? '';
            if (file && file !== lastFile) {
              lastFile = file;
              if (modelProgressText) {
                modelProgressText.textContent = `Downloading ${file}...`;
              }
            }
            if (progress.total > 0 && progress.loaded != null) {
              const pctVal = Math.round((progress.loaded / progress.total) * 100);
              if (modelProgressFill) modelProgressFill.style.width = `${pctVal}%`;
              if (modelProgress) modelProgress.setAttribute('aria-valuenow', String(pctVal));
            }
          }
          if (progress.status === 'initiate' && progress.file && progress.file !== lastFile) {
            lastFile = progress.file;
            if (modelProgressText) {
              modelProgressText.textContent = `Starting ${progress.file}...`;
            }
          }
        });

        if (modelLoading) modelLoading.hidden = true;
        if (modelWarmup) modelWarmup.hidden = true;
        if (modelReady) modelReady.hidden = false;
        if (modelBackendLabel) modelBackendLabel.textContent = `Ready (${result.backend})`;
        if (diagBackend) diagBackend.textContent = result.backend;

        modelLoaded = true;
      } catch (err) {
        // Real failure — route to visible UI, never swallow.
        if (modelLoading) modelLoading.hidden = true;
        if (modelWarmup) modelWarmup.hidden = true;
        if (modelIdle) modelIdle.hidden = false;
        modelDownloadBtn.disabled = false;

        // Show error inline in the model panel
        const errMsg = doc.createElement('p');
        errMsg.className = 'model-error';
        // textContent — model error may contain arbitrary strings from CDN
        errMsg.textContent = `Model load failed: ${err.message}. Check network connectivity and try again.`;
        if (modelIdle) modelIdle.appendChild(errMsg);
      }
    });
  }

  // ---- Record button -------------------------------------------------------
  if (recordBtn) {
    recordBtn.addEventListener('click', async () => {
      if (isRecording) {
        // ---- STOP ----
        isRecording = false;
        recordBtn.textContent = 'Record';
        recordBtn.setAttribute('aria-pressed', 'false');
        clearInterval(timerInterval);
        timerInterval = null;

        recorder?.stop();
        recorder = null;
      } else {
        // ---- START ----
        if (!modelLoaded) {
          showSummaryError('Please download the speech model first (click the download button above).');
          if (summaryError) summaryError.hidden = false;
          return;
        }

        isRecording = true;
        recordBtn.textContent = 'Stop';
        recordBtn.setAttribute('aria-pressed', 'true');

        // Reset state for new recording
        transcript     = [];
        stitchedTokens = [];
        stitchedSeams  = [];
        windowResults  = [];
        windowQueue.length = 0;
        processingWindow = false;

        clearSummaryPanels();
        renderTranscriptList();

        try {
          recorder = await startRecording({
            onLevel: ({ peak }) => {
              updateLevelMeter(doc, peak);
            },
            onWindow: ({ windowStart, samples }) => {
              enqueueWindow(windowStart, samples);
            },
            onWarning: (msg) => {
              // Show warning visibly — do not silently ignore 30-min boundary.
              const warn = doc.createElement('div');
              warn.className = 'record-warning';
              warn.setAttribute('role', 'alert');
              warn.textContent = msg;
              const recordBar = doc.querySelector('.record-bar');
              if (recordBar) recordBar.appendChild(warn);
            },
          });

          // Timer updates every 500 ms
          timerInterval = setInterval(() => {
            if (!isRecording || !recorder) {
              clearInterval(timerInterval);
              timerInterval = null;
              return;
            }
            updateRecordTime(doc, recorder.frameCount);
          }, 500);

        } catch (err) {
          // Mic failure — show specific message in visible UI. SPEC note (distinct messages).
          isRecording = false;
          recordBtn.textContent = 'Record';
          recordBtn.setAttribute('aria-pressed', 'false');

          showSummaryError(err.message);
          if (summaryError) summaryError.hidden = false;
        }
      }
    });
  }

  // ---- Summarise button ---------------------------------------------------
  if (summariseBtn) {
    summariseBtn.addEventListener('click', async () => {
      // Honour aria-disabled (keeps button focusable but non-functional).
      if (summariseBtn.getAttribute('aria-disabled') === 'true') return;

      if (transcript.length === 0) {
        clearSummaryPanels();
        showSummaryError('No transcript to summarise yet. Please record and transcribe first.');
        return;
      }

      const length = summaryLength?.value ?? 'standard';

      // Confirmation step — the project's thesis. SPEC §14.4
      const confirmed = await showConfirmPanel(doc, transcript, length);
      if (!confirmed) return;

      clearSummaryPanels();
      if (summaryLoading) summaryLoading.hidden = false;
      if (diagSummarise) diagSummarise.textContent = 'running';

      try {
        const summary = await summarise(transcript, length, fetchFn);
        clearSummaryPanels();
        if (summaryContent) summaryContent.hidden = false;
        renderSummary(doc, summary, seekTo);
        if (diagSummarise) diagSummarise.textContent = 'done';
      } catch (err) {
        clearSummaryPanels();
        showSummaryError(`Summarisation failed: ${err.message}`);
        if (diagSummarise) diagSummarise.textContent = `error: ${err.message.slice(0, 40)}`;
      }
    });
  }

  // ---- Transcript search --------------------------------------------------
  if (transcriptSearch) {
    transcriptSearch.addEventListener('input', () => {
      const q = transcriptSearch.value.toLowerCase();
      if (!transcriptList) return;
      const rows = transcriptList.querySelectorAll('.transcript-row');
      rows.forEach((row) => {
        const text = (row.textContent ?? '').toLowerCase();
        row.hidden = q.length > 0 && !text.includes(q);
      });
    });
  }

  // ---- Copy / export buttons ----------------------------------------------
  if (copyMarkdownBtn) {
    copyMarkdownBtn.addEventListener('click', () => {
      const md = transcript.map((s) => `[${formatTime(s.t)}] ${s.text}`).join('\n');
      navigator.clipboard.writeText(md).catch(() => {});
    });
  }

  if (exportTxtBtn) {
    exportTxtBtn.addEventListener('click', () => {
      const txt = transcript.map((s) => `${formatTime(s.t)} ${s.text}`).join('\n');
      downloadFile('transcript.txt', txt, 'text/plain');
    });
  }

  if (exportVttBtn) {
    exportVttBtn.addEventListener('click', () => {
      let vtt = 'WEBVTT\n\n';
      for (let i = 0; i < transcript.length; i++) {
        const seg = transcript[i];
        const nextT = transcript[i + 1]?.t ?? seg.t + 5;
        vtt += `${toVTTTime(seg.t)} --> ${toVTTTime(nextT)}\n${seg.text}\n\n`;
      }
      downloadFile('transcript.vtt', vtt, 'text/vtt');
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const key = `voice-notes-${Date.now()}`;
      try {
        localStorage.setItem(key, JSON.stringify(transcript));
        // Brief accessible confirmation
        const msg = doc.createElement('div');
        msg.setAttribute('role', 'status');
        msg.textContent = `Saved as "${key}"`;
        msg.style.cssText = 'position:fixed;bottom:1rem;right:1rem;background:#222;color:#fff;padding:.5rem 1rem;border-radius:4px;z-index:9999';
        doc.body.appendChild(msg);
        setTimeout(() => { if (msg.parentNode) msg.parentNode.removeChild(msg); }, 3000);
      } catch (err) {
        showSummaryError(`Save failed: ${err.message}`);
      }
    });
  }
}

// Only run in the real browser, not during tests (which import specific exports).
if (typeof document !== 'undefined' && !globalThis.__VN_TEST__) {
  init(document, fetch).catch((err) => {
    // Route boot failures to visible UI — never swallow them.
    const msg = document.createElement('div');
    msg.setAttribute('role', 'alert');
    msg.style.cssText =
      'position:fixed;top:0;left:0;right:0;padding:1rem;background:#c00;color:#fff;z-index:99999;font-family:monospace';
    msg.textContent = `Voice Notes failed to start: ${err.message}`;
    document.body.appendChild(msg);
    console.error('Voice Notes init failed:', err);
  });
}
