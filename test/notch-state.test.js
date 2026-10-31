'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SIZE, SHEET, SPRING, stepSpring, settled, initial, reduce, targetSize, radiusFor, clampSheet, canAutoHide } = require('../renderer/notch-state');
const { describe } = require('../renderer/status-line');

const run = (s, ...events) => events.reduce((state, type) => reduce(state, typeof type === 'string' ? { type } : type), s);
const simulate = (from, to, spring, seconds = 2, dt = 1 / 60) => {
  let s = { x: from, v: 0 }, peak = from, at = null;
  for (let t = 0; t < seconds; t += dt) {
    s = stepSpring(s, to, dt, spring);
    peak = to > from ? Math.max(peak, s.x) : Math.min(peak, s.x);
    if (at === null && settled(s, to)) at = t;
  }
  return { s, peak, at };
};

test('hover dwell opens a peek; leaving tucks it', () => {
  const s = run(initial(), 'enter', 'dwell');
  assert.equal(s.view, 'peek');
  assert.equal(run(s, 'leave', 'tuck').view, 'rest');
});

test('a dwell that outlives the pointer does nothing', () => {
  assert.equal(run(initial(), 'enter', 'leave', 'dwell').view, 'rest');
});

test('a sheet opened by shortcut survives until the user has pointed at it', () => {
  let s = run(initial(), 'open', 'tuck');
  assert.equal(s.view, 'sheet', 'pointer never entered, so tuck must not fire');
  s = run(s, 'enter', 'leave', 'tuck');
  assert.equal(s.view, 'rest');
});

test('holds and pin keep the sheet open; releasing them lets it tuck', () => {
  let s = run(initial(), 'enter', 'dwell', 'expand', { type: 'holds', value: 1 }, 'leave', 'tuck');
  assert.equal(s.view, 'sheet');
  s = run(s, { type: 'holds', value: 0 }, { type: 'pin', value: true }, 'tuck');
  assert.equal(s.view, 'sheet');
  assert.equal(run(s, { type: 'pin', value: false }, 'tuck').view, 'rest');
});

test('auto-hide is allowed only for an idle, unpinned sheet', () => {
  const sheet = run(initial(), 'open');
  assert.equal(canAutoHide(sheet), true);
  assert.equal(canAutoHide({ ...sheet, pinned: true }), false);
  assert.equal(canAutoHide({ ...sheet, holds: 1 }), false);
  assert.equal(canAutoHide({ ...sheet, busy: true }), false);
  assert.equal(canAutoHide({ ...sheet, live: true }), false);
  assert.equal(canAutoHide(initial()), true);
});

test('Escape closes and stays closed until the pointer leaves', () => {
  let s = run(initial(), 'enter', 'dwell', 'escape');
  assert.equal(s.view, 'rest');
  assert.equal(run(s, 'dwell').view, 'rest', 'still hovering must not reopen');
  s = run(s, 'leave', 'enter', 'dwell');
  assert.equal(s.view, 'peek');
});

test('hover never opens over a running Auto or Write', () => {
  const s = run(initial(), { type: 'live', live: true, busy: true }, 'enter', 'dwell');
  assert.equal(s.view, 'rest');
  assert.deepEqual(targetSize(s, SHEET, true, 300), { w: 300, h: SIZE.live.h });
});

test('target sizes follow the view', () => {
  const sheet = { w: 700, h: 640 };
  assert.deepEqual(targetSize(initial(), sheet, false), SIZE.rest);
  assert.deepEqual(targetSize(initial(), sheet, true), SIZE.near);
  assert.deepEqual(targetSize({ ...initial(), view: 'peek' }, sheet), SIZE.peek);
  assert.deepEqual(targetSize({ ...initial(), view: 'sheet' }, sheet), sheet);
});

test('open springs arrive fast with restrained overshoot; close never overshoots', () => {
  const w = simulate(SIZE.rest.w, SIZE.peek.w, SPRING.open.w), h = simulate(SIZE.rest.h, SIZE.peek.h, SPRING.open.h);
  assert.ok(w.at < 0.6 && h.at < 0.7, `settled ${w.at} ${h.at}`);
  assert.ok(w.peak - SIZE.peek.w < 8 && h.peak - SIZE.peek.h < 8, `overshoot ${w.peak} ${h.peak}`);
  const c = simulate(SIZE.peek.h, SIZE.rest.h, SPRING.close.h);
  assert.ok(c.peak >= SIZE.rest.h - 0.01, `undershot to ${c.peak}`);
  assert.ok(c.at < 0.45, `close settled ${c.at}`);
});

test('springs stay stable through a stalled frame and keep velocity when retargeted', () => {
  const stalled = stepSpring({ x: 8, v: 0 }, 212, 2, SPRING.open.h);
  assert.ok(Number.isFinite(stalled.x) && Math.abs(stalled.x) < 1000);
  let s = { x: 8, v: 0 };
  for (let i = 0; i < 6; i++) s = stepSpring(s, 212, 1 / 60, SPRING.open.h);
  const moving = s.v;
  s = stepSpring(s, 8, 1 / 240, SPRING.close.h);
  assert.ok(moving > 0 && s.v > 0, 'interrupted spring must carry velocity, not snap');
});

test('corner radius scales with the shape; sheet sizes clamp', () => {
  assert.equal(radiusFor(8), 4);
  assert.equal(radiusFor(600), 26);
  assert.deepEqual(clampSheet({ w: 100, h: 5000 }, { w: 1000, h: 900 }), { w: SHEET.minW, h: 900 });
});

test('every stage of an answer shows; ANSWERED expires and old finished states cannot return', () => {
  const clock = () => '00:00', now = 1000000;
  const thinking = describe({ answer: { status: 'working', message: 'Reading your screen…', at: now } }, clock, now);
  assert.deepEqual([thinking.text, thinking.live, thinking.sweep, thinking.busy], ['Reading your screen', true, true, false]);
  const done = describe({ answer: { status: 'done', at: now } }, clock, now + 4000);
  assert.deepEqual([done.text, done.key, done.expires, done.clear], ['ANSWERED', 'OPEN', 6000, 'answer']);
  assert.equal(describe({ answer: { status: 'done', at: now } }, clock, now + 10001).live, false);
  assert.equal(describe({ auto: { status: 'done', message: 'All set', at: now } }, clock, now + 8001).live, false, 'a stale DONE must not reappear on the next update');
  assert.equal(describe({ auto: { status: 'error', message: 'Failed', at: now } }, clock, now + 20001).live, false);
  assert.equal(describe({ auto: { status: 'paused', message: 'Need you', at: now } }, clock, now + 600000).live, true, 'paused waits for the user');
  const failed = describe({ answer: { status: 'error', message: 'Error: no key', at: now } }, clock, now);
  assert.deepEqual([failed.text, failed.led], ['Error: no key', 'led need']);
});

test('an answer outranks listening; a running Auto outranks an answer', () => {
  const clock = () => '00:03', answer = { status: 'working', message: 'Answering' };
  assert.equal(describe({ listening: true, answer }, clock).text, 'Answering');
  assert.equal(describe({ auto: { active: true, message: 'Clicking' }, answer }, clock).text, 'Clicking');
  assert.equal(describe({ listening: true, answer: { status: 'done', at: 1 } }, clock, 100000).text, 'LISTEN 00:03');
});

test('status line: idle is not live, Auto is live and busy, expiring states say when', () => {
  const clock = () => '00:03';
  assert.equal(describe({ toggleLabel: 'Ctrl' }, clock).live, false);
  const a = describe({ auto: { active: true, step: 3, message: 'Clicking next.', target: 'zen' } }, clock);
  assert.deepEqual([a.live, a.busy, a.step, a.text, a.sub, a.key], [true, true, '03', 'Clicking next', 'ZEN', 'ESC']);
  const d = describe({ auto: { status: 'done', message: 'All set.' } }, clock);
  assert.deepEqual([d.text, d.expires, d.clear, d.busy], ['DONE · All set', 8000, 'auto', false]);
  assert.equal(describe({ listening: true }, clock).text, 'LISTEN 00:03');
});
