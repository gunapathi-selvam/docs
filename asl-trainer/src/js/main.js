// Orchestrator: render loop, DOM wiring, camera, storage, URL state. SPEC §12.
// Not pure — the only module that touches the DOM, localStorage, and rAF.

import { HandTracker, HAND_BONES } from './handTracker.js';
import { classifyLetter, LATCH_MIN_CONFIDENCE } from './letters.js';
import { LatchMachine, QuizState, pickWord, WORD_LIST, HOLD_MS, RELEASE_MS } from './quiz.js';
import {
  makeMatrix, recordLatch, drawMatrix, serializeMatrix, deserializeMatrix,
  STORAGE_KEY, SCHEMA_VERSION, LETTERS, MATRIX_SIZE,
} from './confusion.js';

// SAVE_DEBOUNCE_MS: confusion matrix writes are debounced. SPEC §11.5, §15.
const SAVE_DEBOUNCE_MS = 1000;

// ---------------------------------------------------------------- helpers

function el(id) { return document.getElementById(id); }
function show(id) { const e = el(id); if (e) e.hidden = false; }
function hide(id) { const e = el(id); if (e) e.hidden = true; }
function setStatus(text) { const e = el('status-chip'); if (e) e.textContent = text; }

// Brief descriptions for the hint panel.  SPEC §10.2, §13.1
const LETTER_HINTS = {
  A: 'Closed fist, thumb straight up the radial edge',
  B: 'Four fingers extended together, thumb folded across the palm',
  C: 'All five curved, opposed, wide aperture',
  D: 'Index up; middle, ring, pinky curled to meet the thumb',
  E: 'All four curled to mid-height, fingertips resting on a folded thumb',
  F: 'Thumb and index tips form a loop; middle, ring, pinky extended',
  G: 'Index and thumb extended, nearly parallel, pointing sideways',
  H: 'Index and middle extended together, pointing sideways',
  I: 'Pinky extended, rest closed',
  K: 'Index and middle in a V, thumb between them, pointing up',
  L: 'Index up, thumb out at roughly a right angle',
  M: 'Fist, thumb tucked under index, middle and ring',
  N: 'Fist, thumb tucked under index and middle',
  O: 'All five curved and meeting, aperture closed',
  P: 'K handshape pointing down',
  Q: 'G handshape pointing down',
  R: 'Index and middle extended and crossed',
  S: 'Fist, thumb crossed over the front of the folded fingers',
  T: 'Fist, thumb inserted between index and middle',
  U: 'Index and middle extended together, pointing up',
  V: 'Index and middle extended apart, pointing up',
  W: 'Index, middle and ring extended',
  X: 'Index hooked, rest closed',
  Y: 'Thumb and pinky extended',
};

// ---------------------------------------------------------------- init

/**
 * Top-level entry point. Wires the DOM, starts the camera, and enters the
 * render loop. Every failure path renders text — there is no silent failure.
 * SPEC §12, §16.
 */
async function init() {
  // ---- 1. Load or discard the confusion matrix from localStorage. SPEC §11.5 ----
  let matrix = makeMatrix();
  let storageAvailable = true;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = deserializeMatrix(stored);
      if (parsed) {
        matrix = parsed;
      } else {
        // Version mismatch or corrupt — discard and note it.
        localStorage.removeItem(STORAGE_KEY);
        console.info('[asl-trainer] Stored confusion matrix discarded (version mismatch).');
      }
    }
  } catch {
    storageAvailable = false;
    console.warn('[asl-trainer] localStorage unavailable — matrix will not persist.');
  }

  // ---- 2. Show intro. ----
  show('intro');

  // ---- DOM refs ----
  const videoEl         = el('camera-preview');
  const overlayEl       = el('overlay');
  const overlayCtx      = overlayEl.getContext('2d');
  const confusionCanvas = el('confusion-canvas');
  const confusionCtx    = confusionCanvas.getContext('2d');

  // ---- 3. Parse URL params. ----
  const params      = new URLSearchParams(location.search || location.hash.replace(/^#\??/, ''));
  const wordParam   = params.get('word')    || null;
  const lettersParam= params.get('letters') || null;

  // ---- Session state ----
  let quiz        = null;
  let latch       = null;
  let keyboardMode = false;

  // ---- Save helpers ----
  let saveTimer = null;
  function scheduleMatrixSave() {
    if (!storageAvailable) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushMatrixSave, SAVE_DEBOUNCE_MS);
  }
  function flushMatrixSave() {
    if (!storageAvailable) return;
    try { localStorage.setItem(STORAGE_KEY, serializeMatrix(matrix)); } catch { /* ignore */ }
    saveTimer = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && saveTimer) {
      clearTimeout(saveTimer);
      flushMatrixSave();
    }
  });

  // ---------------------------------------------------------------- rendering helpers

  function renderTargetWord() {
    const wordEl = el('target-word');
    // Build using createElement/textContent — no innerHTML. Bug #6.
    wordEl.textContent = '';
    if (!quiz) return;
    const word = quiz.word;
    for (let i = 0; i < word.length; i++) {
      const span = document.createElement('span');
      span.textContent = word[i];
      const cls = ['letter'];
      if (i < quiz.position) {
        cls.push(quiz.assistedPositions[i] ? 'assisted' : 'done');
      } else if (i === quiz.position) {
        cls.push('active');
      }
      // Adjacent repeat marker. SPEC §9.5
      if (i > 0 && word[i] === word[i - 1]) {
        cls.push('repeat-marker');
        span.setAttribute('aria-label', word[i] + ', double letter, release between');
      }
      span.className = cls.join(' ');
      wordEl.appendChild(span);
    }
  }

  function updateScorePanel() {
    if (!quiz) return;
    const acc = quiz.accuracy;
    el('score-accuracy').textContent = acc !== null ? Math.round(acc * 100) + ' %' : '—';
    el('score-correct').textContent  = String(quiz.firstAttemptCorrect);
    el('score-attempts').textContent = String(quiz.positionsAttempted);
    el('score-streak').textContent   = String(quiz.streak);
  }

  function updateProgressBar(progress) {
    const bar    = el('progress-bar');
    const abs    = Math.abs(progress);
    const pct    = Math.round(abs * 100);
    bar.style.setProperty('--pct', pct + '%');
    bar.setAttribute('aria-valuenow', String(pct));
    if (progress < 0) {
      bar.classList.add('draining');
      bar.setAttribute('aria-valuetext', 'release to continue');
    } else {
      bar.classList.remove('draining');
      bar.setAttribute('aria-valuetext', abs > 0.01 ? 'holding' : 'waiting');
    }
  }

  function drawSkeleton(ctx, landmarks, W, H) {
    ctx.clearRect(0, 0, W, H);
    if (!landmarks || landmarks.length === 0) return;
    ctx.strokeStyle = '#6ea8ff';
    ctx.lineWidth   = 2;
    for (const [a, b] of HAND_BONES) {
      ctx.beginPath();
      ctx.moveTo(landmarks[a].x * W, landmarks[a].y * H);
      ctx.lineTo(landmarks[b].x * W, landmarks[b].y * H);
      ctx.stroke();
    }
    ctx.fillStyle = '#6ea8ff';
    for (const lm of landmarks) {
      ctx.beginPath();
      ctx.arc(lm.x * W, lm.y * H, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawHeatmap() {
    const w = confusionCanvas.width  || 520;
    const h = confusionCanvas.height || 520;
    drawMatrix(confusionCtx, matrix, { width: w, height: h });
  }

  function ensureCanvasSize() {
    // Size confusion canvas from its CSS display size.
    const cw = confusionCanvas.clientWidth || 520;
    if (confusionCanvas.width !== cw) {
      confusionCanvas.width  = cw;
      confusionCanvas.height = cw; // square
      drawHeatmap();
    }
  }

  // ---------------------------------------------------------------- quiz management

  function startWord() {
    const word = pickWord(Math.random.bind(Math), { word: wordParam, letters: lettersParam });
    quiz  = new QuizState(word);
    latch = new LatchMachine({ minConfidence: LATCH_MIN_CONFIDENCE });
    hide('hint');
    renderTargetWord();
    updateScorePanel();
    updateProgressBar(0);
    // Mirror word to hash for linkability. SPEC §15.
    try { history.replaceState(null, '', '?word=' + encodeURIComponent(word)); } catch { /* ignore */ }
    ensureCanvasSize();
    show('matrix-section');
    drawHeatmap();
  }

  function onLatch(letter) {
    const latchedEl = el('latched-letter');
    latchedEl.textContent = letter;

    const result = quiz.recordLatch(letter, (target, latched) => {
      matrix = recordLatch(matrix, target, latched);
    });

    renderTargetWord();
    updateScorePanel();
    scheduleMatrixSave();
    drawHeatmap();

    if (result.advanced) {
      hide('hint');
      if (quiz.complete) {
        setTimeout(startWord, 1200);
        return;
      }
    } else {
      // Wrong but not yet assisted — show hint after 3rd wrong try.
      const wrong = quiz.wrongAttempts[quiz.position];
      if (wrong >= 3) {
        const target    = quiz.currentLetter;
        const hintText  = el('hint-text');
        const hintDesc  = LETTER_HINTS[target] ?? target;
        hintText.textContent = target + ': ' + hintDesc;
        show('hint');
      }
    }

    if (result.assisted) {
      // Show hint for the letter that was just assisted past.
      const assistedLetter = quiz.word[quiz.position - 1];
      const hintText = el('hint-text');
      hintText.textContent = 'Assisted past ' + assistedLetter + ': ' + (LETTER_HINTS[assistedLetter] ?? '');
      show('hint');
    }
  }

  // ---------------------------------------------------------------- wiring

  // Reset confusion matrix. SPEC §11.5
  el('reset-matrix').addEventListener('click', () => {
    if (!window.confirm('Reset the confusion matrix? This erases all recorded history.')) return;
    matrix = makeMatrix();
    drawHeatmap();
    scheduleMatrixSave();
  });

  // Accessible table toggle. SPEC §13.2
  el('matrix-table-toggle').addEventListener('click', () => {
    const btn     = el('matrix-table-toggle');
    const tableDiv= el('matrix-table');
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!expanded));
    if (!expanded) {
      tableDiv.hidden = false;
      renderMatrixTable();
    } else {
      tableDiv.hidden = true;
    }
  });

  function renderMatrixTable() {
    const tableDiv = el('matrix-table');
    tableDiv.textContent = '';
    const table = document.createElement('table');
    // Header row
    const thead = document.createElement('thead');
    const hRow  = document.createElement('tr');
    hRow.appendChild(document.createElement('th')); // empty corner
    for (const L of LETTERS) {
      const th = document.createElement('th');
      th.textContent = L;
      hRow.appendChild(th);
    }
    thead.appendChild(hRow);
    table.appendChild(thead);
    // Data rows
    const tbody = document.createElement('tbody');
    for (let r = 0; r < MATRIX_SIZE; r++) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = LETTERS[r];
      tr.appendChild(th);
      for (let c = 0; c < MATRIX_SIZE; c++) {
        const td = document.createElement('td');
        td.textContent = matrix[r][c] > 0 ? String(matrix[r][c]) : '';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableDiv.appendChild(table);
  }

  // Keyboard fallback: letter keys latch directly. SPEC §13.2
  document.addEventListener('keydown', (e) => {
    if (!quiz || quiz.complete) return;
    const key = e.key.toUpperCase();
    if (key.length === 1 && key >= 'A' && key <= 'Z') {
      onLatch(key);
      if (latch) latch = new LatchMachine({ minConfidence: LATCH_MIN_CONFIDENCE });
    }
  });

  // ---- Begin-keyboard button ----
  el('begin-keyboard').addEventListener('click', () => {
    keyboardMode = true;
    hide('intro');
    show('quiz');
    setStatus('Keyboard mode — press a letter key to latch');
    startWord();
  });

  // ---- Begin-camera button ----
  el('begin').addEventListener('click', async () => {
    hide('intro');
    show('quiz');
    await startCamera();
  });

  // ---------------------------------------------------------------- camera + frame loop

  async function startCamera() {
    setStatus('Loading MediaPipe model (~8 MB) — please wait...');

    const tracker = new HandTracker({
      onStatus: (msg) => setStatus(msg),
    });

    try {
      await tracker.start(videoEl);
    } catch (err) {
      // Distinct messages per failure mode. Bug #2.
      let title, body;
      if (err.name === 'NotAllowedError') {
        title = 'Camera permission denied';
        body  = 'Allow camera access in your browser settings and reload the page.';
      } else if (err.name === 'NotFoundError') {
        body  = 'No camera found on this device. You can still use keyboard mode.';
        title = 'No camera found';
      } else if (err.name === 'NotReadableError') {
        title = 'Camera in use';
        body  = 'The camera is already in use by another app. Close it and try again.';
      } else if (err.name === 'MediaPipeError') {
        title = 'MediaPipe unavailable';
        body  = err.message + ' — check your internet connection and reload.';
      } else {
        title = 'Camera error';
        body  = err.message || String(err);
      }
      // Render visible error — no silent failure. SPEC §16, Bug #2.
      el('failure-title').textContent = title;
      el('failure-body').textContent  = body;
      show('failure');
      hide('quiz');
      return;
    }

    startWord();

    // FPS tracking
    let frameCount = 0, fpsStart = performance.now(), displayedFps = 0;
    let firstFrame = true;

    // Frame loop wrapped so the first throw shows a visible error. Bug #1.
    let loopAlive = true;

    function frame(nowMs) {
      if (!loopAlive) return;

      try {
        // Detect
        const hands = tracker.detect(nowMs);

        // Size overlay canvas to video.
        const W = videoEl.videoWidth  || videoEl.clientWidth  || 640;
        const H = videoEl.videoHeight || videoEl.clientHeight || 480;
        if (overlayEl.width !== W || overlayEl.height !== H) {
          overlayEl.width  = W;
          overlayEl.height = H;
        }
        ensureCanvasSize();

        // FPS counter.
        frameCount++;
        const now = performance.now();
        if (now - fpsStart >= 1000) {
          displayedFps = Math.round(frameCount * 1000 / (now - fpsStart));
          el('score-fps').textContent = String(displayedFps);
          frameCount = 0;
          fpsStart   = now;
        }

        let letter = null, confidence = 0, isNeutral = false, bucket = null;

        if (hands.length > 0) {
          const hand = hands[0];
          el('score-hand').textContent = hand.handedness;

          // Classify.
          let classResult;
          try {
            classResult = classifyLetter(hand.landmarks, hand.handedness, hand.handednessConfidence);
          } catch (classErr) {
            setStatus('Classifier error: ' + classErr.message);
            classResult = { letter: null, reason: 'error', confidence: 0 };
          }

          letter     = classResult.letter;
          confidence = classResult.confidence ?? 0;
          isNeutral  = classResult.reason === 'neutral';
          bucket     = classResult.bucket ?? null;

          if (bucket !== null) el('score-bucket').textContent = String(bucket);

          // Status chip.
          if (letter) {
            setStatus(letter + ' (' + Math.round(confidence * 100) + ' %)');
          } else if (isNeutral) {
            setStatus('open hand — release to continue');
          } else {
            const reasonMap = {
              handedness:  'Turn your palm toward the camera',
              mask:        'No letter recognised',
              aperture:    'Aperture unclear (C or O)',
              crossing:    'Crossing unclear (R)',
              thumb:       'Thumb position unclear',
              confidence:  'Low confidence',
              neutral:     'open hand — release to continue',
            };
            setStatus(reasonMap[classResult.reason] ?? classResult.reason ?? 'no letter');
          }

          drawSkeleton(overlayCtx, hand.landmarks, W, H);
        } else {
          overlayCtx.clearRect(0, 0, W, H);
          el('score-hand').textContent   = '—';
          el('score-bucket').textContent = '—';
          if (!keyboardMode) setStatus('No hand in frame');
        }

        // Diagnostics on first frame only. Bug #7.
        if (firstFrame) {
          firstFrame = false;
          console.log('[asl-trainer] first frame — hands:', hands.length,
            'video:', W + 'x' + H);
        }

        // Latch machine tick.
        if (latch && quiz && !quiz.complete) {
          const noHand = hands.length === 0;
          const event  = latch.tick(letter, confidence, isNeutral || noHand, nowMs);
          updateProgressBar(latch.progress);

          if (event && event.type === 'latch') {
            onLatch(event.letter);
          }
        }

      } catch (err) {
        // First throw: render visible error; stop the loop. Bug #1.
        loopAlive = false;
        el('failure-title').textContent = 'Runtime error';
        el('failure-body').textContent  = err.message
          + '\n' + (err.stack || '').split('\n').slice(1, 5).join('\n');
        show('failure');
        console.error('[asl-trainer] frame loop error:', err);
        return;
      }

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }

  // ---- Expose live state. SPEC §15 ----
  window.aslTrainer = {
    get matrix() { return matrix; },
    get quiz()   { return quiz;   },
    get latch()  { return latch;  },
  };
}

// Expose the live state for console inspection. SPEC §15.
if (typeof window !== 'undefined') {
  window.aslTrainer = null;
}

init().catch((err) => {
  // Surfaces NotImplemented during development; also handles real runtime errors.
  const title = el('failure-title');
  const body  = el('failure-body');
  if (title) title.textContent = 'Startup error';
  if (body)  body.textContent  = String(err);
  show('failure');
  hide('intro');
  hide('quiz');
});
