// Quiz state: word selection, latch state machine, scoring.
// Pure — no DOM, no globals, no Math.random, no performance.now. SPEC §12.

// ---------------------------------------------------------------- constants

export const HOLD_MS    = 320;  // pose-hold required before a latch commits. SPEC §9.2
export const RELEASE_MS = 180;  // neutral-hold required before next letter.   SPEC §9.2
export const MAX_ATTEMPTS = 5;  // wrong latches before hint+advance.           SPEC §10.2

// LATCH_MIN_CONFIDENCE is defined in letters.js; quiz.js receives it as a
// parameter to stay pure and avoid a circular dependency.

// ---------------------------------------------------------------- word list

// Words over the 24-letter alphabet (no J, Z). Length 3–7.
// Every static letter appears at least twice; at least four words contain
// adjacent identical letters so §9 is exercised early. SPEC §10.1
export const WORD_LIST = [
  'BOOK',   'SPELL',   'LETTER', 'COFFEE',
  'CAT',    'DOG',     'FISH',   'BIRD',    'FROG',
  'HAND',   'SIGN',    'WORD',   'PALM',
  'BLUE',   'PINK',    'FIVE',   'NINE',
  'RAIN',   'SNOW',    'TREE',
  'SWIM',   'WALK',    'MOVE',
  'OVER',   'WITH',    'FROM',
  'EXAM',   'FLEX',    'VIBE',
  'MILK',   'CORN',    'QUICK',  'BOX',
  'YAM',    'WHY',     'HAPPY',  'WILL',
];

// ---------------------------------------------------------------- word selector

/**
 * Pick a word from WORD_LIST using the supplied RNG.
 *
 * rng() must return a uniform float in [0,1). Injected so sessions are
 * reproducible in tests — calling Math.random directly would not be. SPEC §10.1.
 *
 * @param {() => number} rng
 * @param {{ letters?: string, word?: string }} opts
 *   opts.word   forces a specific word (from ?word= URL param)
 *   opts.letters if provided, only words whose letters are a subset of this string
 * @returns {string}
 */
export function pickWord(rng, opts = {}) {
  if (opts.word) return opts.word.toUpperCase();
  let pool = WORD_LIST;
  if (opts.letters) {
    const allowed = new Set(opts.letters.toUpperCase().split(''));
    const filtered = pool.filter((w) => [...w].every((c) => allowed.has(c)));
    if (filtered.length > 0) pool = filtered;
  }
  return pool[Math.floor(rng() * pool.length)];
}

// ---------------------------------------------------------------- latch machine

/**
 * Three-phase latch state machine, one instance per session.
 *
 * Phases:
 *   SEEKING  — waiting for a stable candidate held HOLD_MS at confidence ≥ minConf
 *   HELD     — letter committed; waiting for RELEASE_MS of neutral
 *
 * The machine is pure: `tick(letter, confidence, isNeutral, nowMs)` returns an
 * event object if anything changed, or null. All state is inside this instance.
 * Time is a parameter, not `performance.now()`. SPEC §9.2
 */
export class LatchMachine {
  /**
   * @param {{ holdMs?: number, releaseMs?: number, minConfidence?: number }} opts
   */
  constructor(opts = {}) {
    this._holdMs    = opts.holdMs      ?? HOLD_MS;
    this._releaseMs = opts.releaseMs   ?? RELEASE_MS;
    this._minConf   = opts.minConfidence ?? 0.55;
    this._phase     = 'SEEKING'; // 'SEEKING' | 'HELD'
    this._candidate = null;      // current candidate letter
    this._since     = null;      // timestamp when candidate / neutral phase started
    this._progress  = 0;         // 0–1, filled during SEEKING, draining during HELD
  }

  /**
   * Advance the state machine by one frame.
   *
   * @param {string|null} letter        classifier output, null if abstaining
   * @param {number}      confidence    classifier confidence 0–1
   * @param {boolean}     isNeutral     true when the mask is 31 or any abstention
   * @param {number}      nowMs         current time in milliseconds
   * @returns {{ type: 'latch', letter: string }|{ type: 'release' }|null}
   */
  tick(letter, confidence, isNeutral, nowMs) {
    if (this._phase === 'SEEKING') {
      if (letter !== null && confidence >= this._minConf) {
        if (letter !== this._candidate) {
          // New candidate — reset hold timer.
          this._candidate = letter;
          this._since     = nowMs;
        }
        const elapsed = nowMs - this._since;
        this._progress = Math.min(elapsed / this._holdMs, 1);
        if (elapsed >= this._holdMs) {
          // Latch committed. Transition to HELD.
          this._phase     = 'HELD';
          this._since     = null; // neutral timer starts on first neutral tick
          this._progress  = 1;
          return { type: 'latch', letter };
        }
      } else {
        // No valid letter — reset.
        this._candidate = null;
        this._since     = null;
        this._progress  = 0;
      }
    } else { // HELD — waiting for RELEASE_MS of neutral
      if (isNeutral) {
        if (this._since === null) this._since = nowMs;
        const elapsed = nowMs - this._since;
        this._progress = Math.max(1 - elapsed / this._releaseMs, 0);
        if (elapsed >= this._releaseMs) {
          // Release complete — back to SEEKING.
          this._phase     = 'SEEKING';
          this._candidate = null;
          this._since     = null;
          this._progress  = 0;
          return { type: 'release' };
        }
      } else {
        // Not neutral — reset the neutral timer, stay HELD.
        this._since    = null;
        this._progress = 1;
      }
    }
    return null;
  }

  /**
   * Progress fraction 0–1 for the progress bar. SPEC §9.5
   * Positive = filling (SEEKING), negative = draining (awaiting release).
   * During HELD: _progress goes 1→0 as neutral accumulates, so we return −_progress.
   */
  get progress() {
    if (this._phase === 'SEEKING') return this._progress;   // 0 → +1
    return -this._progress;                                  // −1 → 0
  }

  /** Phase string for aria-valuetext. SPEC §9.5 */
  get phase() {
    return this._phase === 'SEEKING' ? 'seeking' : 'held';
  }
}

// ---------------------------------------------------------------- quiz state

/**
 * Word-level quiz state: tracks position, attempts, score and streak.
 * Pure — no side effects. SPEC §10.2, §10.3
 */
export class QuizState {
  /**
   * @param {string} word  The target word (all caps, no J/Z)
   */
  constructor(word) {
    this._word        = word;
    this._position    = 0;
    this._wrongAttempts     = new Array(word.length).fill(0);
    this._assistedPositions = new Array(word.length).fill(false);
    this._firstAttemptCorrect = 0;
    this._positionsAttempted  = 0;
    this._streak = 0;
  }

  /** The letter at the current position. */
  get currentLetter() {
    if (this._position >= this._word.length) return null;
    return this._word[this._position];
  }

  /** True when all positions have been completed. */
  get complete() {
    return this._position >= this._word.length;
  }

  /**
   * Record a latch from the user.
   *
   * If latchedLetter === currentLetter: advance position, increment streak,
   * record diagonal in matrix.
   * If wrong: do not advance, reset streak, increment attempt counter for this
   * position, record off-diagonal. After MAX_ATTEMPTS, advance with assisted flag.
   *
   * @param {string}   latchedLetter
   * @param {Function} recordFn  (targetLetter, latchedLetter) => void — called to update the matrix
   * @returns {{ advanced: boolean, assisted: boolean }}
   */
  recordLatch(latchedLetter, recordFn) {
    if (this.complete) return { advanced: false, assisted: false };
    const target = this._word[this._position];
    recordFn(target, latchedLetter);

    if (latchedLetter === target) {
      const wasFirstAttempt = this._wrongAttempts[this._position] === 0;
      this._positionsAttempted++;
      if (wasFirstAttempt) {
        this._firstAttemptCorrect++;
        this._streak++;
      } else {
        this._streak = 0;
      }
      this._position++;
      return { advanced: true, assisted: false };
    } else {
      this._wrongAttempts[this._position]++;
      this._streak = 0;
      if (this._wrongAttempts[this._position] >= MAX_ATTEMPTS) {
        // Assisted advance — counts as incorrect. SPEC §10.2
        this._positionsAttempted++;
        this._assistedPositions[this._position] = true;
        this._position++;
        return { advanced: true, assisted: true };
      }
      return { advanced: false, assisted: false };
    }
  }

  /**
   * Session accuracy: first-attempt-correct / positionsAttempted. SPEC §10.3
   */
  get accuracy() {
    if (this._positionsAttempted === 0) return null;
    return this._firstAttemptCorrect / this._positionsAttempted;
  }

  /** Consecutive first-attempt-correct latches, across words. SPEC §10.3 */
  get streak() { return this._streak; }

  // Extra getters used by main.js for rendering.
  get word()               { return this._word; }
  get position()           { return this._position; }
  get wrongAttempts()      { return this._wrongAttempts; }
  get assistedPositions()  { return this._assistedPositions; }
  get firstAttemptCorrect(){ return this._firstAttemptCorrect; }
  get positionsAttempted() { return this._positionsAttempted; }
}
