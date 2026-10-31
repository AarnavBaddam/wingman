'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createTypingPlan, applyPlan, DEFAULTS, qwertyNeighbor } = require('../src/typing-plan');

// Seeded PRNG so plans are reproducible in tests.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const quiet = { typoRate: 0, uncorrectedTypoRate: 0, stutterRate: 0, gapChance: 0 };

test('DEFAULTS are a less-skilled-typist baseline', () => {
  assert.ok(DEFAULTS.wpm < 51, 'slower than the 51.6 WPM average');
  assert.ok(DEFAULTS.typoRate > 0.06, 'more corrections than the ~6% human average');
  assert.ok(DEFAULTS.uncorrectedTypoRate > 0, 'leaves a few typos in');
  assert.ok(DEFAULTS.gapMaxMs === 600000 && DEFAULTS.gapMinMs === 20000, 'composing gaps span 20s..10min');
});

test('quiet config types the exact text, one key each, no edits', () => {
  const text = 'The quick brown fox.';
  const { events } = createTypingPlan(text, quiet, mulberry32(1));
  assert.strictEqual(applyPlan(events), text);
  assert.ok(events.every(e => e.type === 'key'));
  assert.strictEqual(events.length, text.length);
  assert.ok(events.every(e => e.delayMs >= DEFAULTS.minKeyMs));
});

test('deterministic for a fixed seed', () => {
  const a = createTypingPlan('hello world', {}, mulberry32(42));
  const b = createTypingPlan('hello world', {}, mulberry32(42));
  assert.deepStrictEqual(a.events, b.events);
});

test('corrected typos self-heal: result still equals the target', () => {
  const text = 'the quick brown fox jumps';
  const { events } = createTypingPlan(text, { ...quiet, typoRate: 1 }, mulberry32(7));
  assert.strictEqual(applyPlan(events), text);
  assert.ok(events.some(e => e.type === 'backspace'), 'a corrected typo backspaces');
});

test('uncorrected typos stay in: same length, differs at letters, no backspaces', () => {
  const text = 'the quick brown fox';
  const { events } = createTypingPlan(text, { ...quiet, uncorrectedTypoRate: 1 }, mulberry32(3));
  const out = applyPlan(events);
  assert.strictEqual(out.length, text.length);
  assert.notStrictEqual(out, text);
  assert.ok(events.every(e => e.type === 'key'), 'left-in typos never backspace');
  for (let i = 0; i < text.length; i++) {
    if (!/[a-z]/i.test(text[i])) assert.strictEqual(out[i], text[i], 'non-letters untouched');
  }
});

test('composing gaps are long-tail within bounds', () => {
  const text = 'One. Two. Three. Four. Five. Six.';
  const { events } = createTypingPlan(text, { ...quiet, gapChance: 1 }, mulberry32(9));
  const gaps = events.filter(e => e.type === 'gap');
  assert.ok(gaps.length > 0, 'gaps appear at sentence boundaries');
  assert.ok(gaps.every(g => g.delayMs >= DEFAULTS.gapMinMs && g.delayMs <= DEFAULTS.gapMaxMs));
});

test('every typed key is printable ASCII (Marionette-safe)', () => {
  const text = 'Mix 123 of, letters; and! punctuation?';
  const { events } = createTypingPlan(text, DEFAULTS, mulberry32(5));
  for (const e of events) {
    if (e.type === 'key') assert.ok(/^[\x20-\x7e]$/.test(e.value), `bad key ${JSON.stringify(e.value)}`);
  }
});

test('qwertyNeighbor returns a different adjacent letter', () => {
  for (const c of 'abcdefghijklmnopqrstuvwxyz') {
    const n = qwertyNeighbor(c, mulberry32(c.charCodeAt(0)));
    assert.ok(/[a-z]/.test(n) && n !== c, `neighbor of ${c} was ${n}`);
  }
});
