'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { runTyping } = require('../src/write-typer');
const { createTypingPlan, applyPlan } = require('../src/typing-plan');

// A sink that records keystrokes into a buffer, plus an instant clock.
function fakeSink() {
  const buf = [];
  return {
    buf,
    text: () => buf.join(''),
    async key(v) { buf.push(v); },
    async backspace() { buf.pop(); },
    gaps: [],
  };
}
const instant = () => Promise.resolve();

test('executes a plan into the same text its events describe', async () => {
  const { events } = createTypingPlan('the quick brown fox', { typoRate: 0.3 }, Math.random);
  const sink = fakeSink();
  await runTyping(events, sink, { signal: new AbortController().signal, wait: instant });
  assert.strictEqual(sink.text(), applyPlan(events));
});

test('reports progress once per event', async () => {
  const events = [{ type: 'key', value: 'a', delayMs: 1 }, { type: 'backspace', delayMs: 1 }, { type: 'key', value: 'b', delayMs: 1 }];
  let seen = 0;
  await runTyping(events, fakeSink(), { signal: new AbortController().signal, wait: instant, onProgress: () => seen++ });
  assert.strictEqual(seen, 3);
});

test('stops and rejects when aborted mid-run, sending no more keys', async () => {
  const events = Array.from({ length: 20 }, (_, i) => ({ type: 'key', value: String(i % 10), delayMs: 1 }));
  const ctrl = new AbortController();
  const sink = fakeSink();
  // Abort after the 3rd keystroke by aborting from inside the sink.
  let n = 0;
  const watchSink = { ...sink, async key(v) { await sink.key(v); if (++n === 3) ctrl.abort(); } };
  const wait = (ms, signal) => new Promise((res, rej) => {
    if (signal.aborted) return rej(new Error('Auto stopped.'));
    signal.addEventListener('abort', () => rej(new Error('Auto stopped.')), { once: true });
    res();
  });
  await assert.rejects(() => runTyping(events, watchSink, { signal: ctrl.signal, wait }), /Auto stopped/);
  assert.strictEqual(sink.buf.length, 3, 'no keystrokes after the abort');
});

test('routes gaps to onProgress and optional sink.gap', async () => {
  const events = [{ type: 'key', value: 'x', delayMs: 1 }, { type: 'gap', delayMs: 30000 }, { type: 'key', value: 'y', delayMs: 1 }];
  const sink = fakeSink();
  sink.gap = async ms => sink.gaps.push(ms);
  const kinds = [];
  await runTyping(events, sink, { signal: new AbortController().signal, wait: instant, onProgress: e => kinds.push(e.type) });
  assert.deepStrictEqual(sink.gaps, [30000]);
  assert.deepStrictEqual(kinds, ['key', 'gap', 'key']);
  assert.strictEqual(sink.text(), 'xy');
});
