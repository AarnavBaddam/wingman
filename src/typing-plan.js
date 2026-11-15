'use strict';
// Pure, deterministic typing-plan engine for Write mode.
//
// Turns a finished piece of text into a human-paced keystroke plan: one key at a
// time, Gaussian inter-key delays, QWERTY typos that backspace-correct, a few
// typos left in, mid-word stutters, and occasional long "composing" gaps. The
// output is executor-agnostic — a Zen Marionette driver or the InkSplash
// extension both just walk the events, sleep delayMs, then send the key.
//
// Defaults model the *less-skilled* end of typists (user decision 2026-10-22):
// slower than the 51.6 WPM / ~6%-correction average (Dhakal et al., CHI 2018),
// more stutters and pauses, and a few spelling errors left uncorrected. Every
// value is overridable from Write mode settings.

const DEFAULTS = {
  wpm: 38,                    // avg is 51.6; this is the slow end
  speedVariance: 0.5,         // per-key delay stddev as a fraction of the mean
  minKeyMs: 45,               // floor on any single keystroke
  maxKeyMult: 4,              // cap a key delay at mean * this
  typoRate: 0.09,             // corrected typos per letter (> ~6% human avg)
  uncorrectedTypoRate: 0.006, // typos left in per letter (a few)
  stutterRate: 0.06,          // mid-word hesitation chance per key
  stutterMs: [140, 650],      // hesitation length
  realizeMs: [180, 520],      // pause between a wrong key and noticing it
  // Long composing pauses, weighted small (user: "less large and more small").
  gapChance: 0.14,            // chance of a big pause at a sentence boundary
  gapMinMs: 20000,            // 20s
  gapMaxMs: 600000,           // 10 min
  gapBias: 3.2,               // >1 biases toward the small end of the range
  // Punctuation micro-pauses, as multipliers on the base per-key delay.
  sentencePauseMult: [6, 14], // after . ! ?
  clausePauseMult: [2.5, 6],  // after , ; : —
};

// QWERTY neighbour map, built once from grid coordinates (distance < 1.25).
const ROWS = [
  { y: 0, x0: 0, keys: 'qwertyuiop' },
  { y: 1, x0: 0.5, keys: 'asdfghjkl' },
  { y: 2, x0: 1, keys: 'zxcvbnm' },
];
const POS = {};
for (const r of ROWS) [...r.keys].forEach((k, i) => { POS[k] = [r.x0 + i, r.y]; });
const NEIGHBORS = {};
for (const a of Object.keys(POS)) {
  NEIGHBORS[a] = Object.keys(POS).filter(b => b !== a &&
    Math.hypot(POS[a][0] - POS[b][0], POS[a][1] - POS[b][1]) < 1.25);
}

// Pick an adjacent key for a letter, preserving case. rng() in [0,1).
function qwertyNeighbor(ch, rng) {
  const lower = ch.toLowerCase();
  const near = NEIGHBORS[lower];
  if (!near || !near.length) return ch;
  const pick = near[Math.floor(rng() * near.length)];
  return ch === lower ? pick : pick.toUpperCase();
}

// Truncated Gaussian via Box-Muller, floored and capped.
function gaussDelay(mean, variance, floor, cap, rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.min(cap, Math.max(floor, Math.round(mean + z * mean * variance)));
}

const between = (lo, hi, rng) => lo + (hi - lo) * rng();
const isLetter = c => /[a-z]/i.test(c);

function createTypingPlan(text, config = {}, rng = Math.random) {
  const cfg = { ...DEFAULTS, ...config };
  const meanKey = 60000 / (cfg.wpm * 5); // same WPM->ms model as InkSplash
  const floor = Math.min(cfg.minKeyMs, meanKey);
  const cap = meanKey * cfg.maxKeyMult;
  const events = [];
  const stats = { keys: 0, correctedTypos: 0, leftInTypos: 0, gaps: 0, stutters: 0 };

  const keyDelay = () => gaussDelay(meanKey, cfg.speedVariance, floor, cap, rng);
  const emit = (type, value, delayMs) => events.push(value === undefined ? { type, delayMs } : { type, value, delayMs });

  let carryPause = 0; // a punctuation micro-pause owed to the next keystroke
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    let delay = keyDelay() + carryPause;
    carryPause = 0;

    // Mid-word stutter: a brief hesitation folded into this key's delay.
    if (isLetter(ch) && rng() < cfg.stutterRate) {
      delay += Math.round(between(cfg.stutterMs[0], cfg.stutterMs[1], rng));
      stats.stutters++;
    }

    if (isLetter(ch) && rng() < cfg.typoRate) {
      // Corrected typo: wrong neighbour, notice, backspace, type the right one.
      emit('key', qwertyNeighbor(ch, rng), delay);
      emit('backspace', undefined, Math.round(between(cfg.realizeMs[0], cfg.realizeMs[1], rng)));
      emit('key', ch, keyDelay());
      stats.correctedTypos++; stats.keys += 2;
    } else if (isLetter(ch) && rng() < cfg.uncorrectedTypoRate) {
      // Typo left in: a wrong neighbour, never fixed.
      emit('key', qwertyNeighbor(ch, rng), delay);
      stats.leftInTypos++; stats.keys++;
    } else {
      emit('key', ch, delay);
      stats.keys++;
    }

    // Punctuation micro-pause is owed to the next keystroke.
    if ('.!?'.includes(ch)) carryPause += Math.round(meanKey * between(cfg.sentencePauseMult[0], cfg.sentencePauseMult[1], rng));
    else if (',;:—'.includes(ch)) carryPause += Math.round(meanKey * between(cfg.clausePauseMult[0], cfg.clausePauseMult[1], rng));

    // Long composing gap at a sentence boundary (sentence punctuation + space/end).
    if ('.!?'.includes(ch) && (next === ' ' || next === undefined) && rng() < cfg.gapChance) {
      const dur = Math.round(cfg.gapMinMs + (cfg.gapMaxMs - cfg.gapMinMs) * Math.pow(rng(), cfg.gapBias));
      emit('gap', undefined, dur);
      stats.gaps++;
    }
  }
  return { events, stats, config: cfg };
}

// Simulate a plan into the text it would produce (ignores gaps; honours backspace).
function applyPlan(events) {
  const out = [];
  for (const e of events) {
    if (e.type === 'key') out.push(e.value);
    else if (e.type === 'backspace') out.pop();
  }
  return out.join('');
}

module.exports = { createTypingPlan, applyPlan, DEFAULTS, qwertyNeighbor };
