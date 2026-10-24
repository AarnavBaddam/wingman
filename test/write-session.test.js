'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createWriteSession } = require('../src/write-session');

// Fakes for every injected port, with spies.
function harness(overrides = {}) {
  const calls = { llm: 0, humanize: 0, detect: 0, released: 0, typer: 0 };
  const sink = { buf: [], async key(v) { sink.buf.push(v); }, async backspace() { sink.buf.pop(); } };
  const deps = {
    getSettings: () => ({}),
    getCodexHome: () => null,
    createLLM: () => { calls.llm++; return { ready: true, stream: async () => 'DRAFTED ESSAY.' }; },
    humanize: async (text) => { calls.humanize++; return { text: text.replace('DRAFTED', 'humanised') }; },
    detect: async () => { calls.detect++; return { aiScore: 0.21, pass: true, detail: 'local-gpt2' }; },
    releaseModel: () => { calls.released++; },
    createTyper: () => { calls.typer++; return sink; },
    onUpdate: () => {},
    onEnd: () => {},
    ...overrides,
  };
  return { deps, calls, sink, session: createWriteSession(deps) };
}

test('prepare drafts from a prompt, humanises, runs the detector', async () => {
  const { session, calls } = harness();
  const review = await session.prepare({ prompt: 'write about foxes', humanizeOpts: {}, detectOpts: {} });
  assert.strictEqual(calls.llm, 1);
  assert.strictEqual(calls.humanize, 1);
  assert.strictEqual(calls.detect, 1);
  assert.match(review.text, /humanised/);
  assert.strictEqual(review.aiScore, 0.21);
  assert.strictEqual(review.pass, true);
  assert.strictEqual(session.stage, 'review');
});

test('pasted text skips the drafting model but still humanises + detects', async () => {
  const { session, calls } = harness();
  await session.prepare({ pasted: 'my own words here.', humanizeOpts: {}, detectOpts: {} });
  assert.strictEqual(calls.llm, 0, 'no model call for pasted text');
  assert.strictEqual(calls.humanize, 1);
  assert.strictEqual(calls.detect, 1);
});

test('approve releases the model and arms the chosen text', async () => {
  const { session, calls } = harness();
  await session.prepare({ pasted: 'draft text.' });
  session.approve('final approved text.');
  assert.strictEqual(session.stage, 'armed');
  assert.strictEqual(calls.released, 1, 'model disengaged on approve');
});

test('typeInto never touches the model and types the armed text', async () => {
  const { session, calls, sink } = harness();
  await session.prepare({ prompt: 'x' });      // one model call here
  session.approve('hello world.');
  const llmBefore = calls.llm;
  await session.typeInto('tab-1', { typoRate: 0, uncorrectedTypoRate: 0, gapChance: 0, stutterRate: 0 }, instant());
  assert.strictEqual(calls.llm, llmBefore, 'no model call during typing');
  assert.strictEqual(calls.typer, 1);
  assert.strictEqual(sink.buf.join(''), 'hello world.');
  assert.strictEqual(session.stage, 'idle');
});

test('typeInto refuses before approval', async () => {
  const { session } = harness();
  await session.prepare({ pasted: 'text.' });
  await assert.rejects(() => session.typeInto('tab-1', {}, instant()), /approve/i);
});

test('stop during typing halts keystrokes', async () => {
  const { deps, session } = harness();
  await session.prepare({ pasted: 'the quick brown fox jumps over.' });
  session.approve('the quick brown fox jumps over.');
  let n = 0;
  const slowWait = (ms, signal) => new Promise((res, rej) => {
    if (signal.aborted) return rej(new Error('Write stopped.'));
    signal.addEventListener('abort', () => rej(new Error('Write stopped.')), { once: true });
    if (++n === 4) session.stop();
    res();
  });
  await session.typeInto('tab-1', { typoRate: 0, gapChance: 0, stutterRate: 0 }, slowWait).catch(() => {});
  assert.ok(session.lastTypedCount < 30, 'typing halted early');
});

// A wait() that resolves immediately (no real delays in tests).
function instant() { return () => Promise.resolve(); }

test('the user prompt is the spec: no hardcoded voice in the system prompt', () => {
  const { WRITE_SYSTEM } = require('../src/write-session');
  assert.doesNotMatch(WRITE_SYSTEM, /student voice|first-person/i);
  assert.match(WRITE_SYSTEM, /instructions override every default/i);
});

test('links in the prompt are opened, fed to the model, and failures + invented quotes are reported', async () => {
  let sent;
  const { session } = harness({
    createLLM: () => ({ ready: true, stream: async ({ turns }) => { sent = turns[0].text; return 'He wrote "the quick brown fox jumps" and "a sentence nobody ever wrote".'; } }),
    openLinks: async () => ({ sources: [{ number: 1, title: 'Fox', url: 'https://good.com', content: 'The quick brown fox jumps over.' }], failures: [{ url: 'https://bad.com', reason: 'HTTP 403' }] }),
    humanize: async t => ({ text: t }),
  });
  const review = await session.prepare({ prompt: 'quote https://good.com and https://bad.com' });
  assert.match(sent, /The quick brown fox jumps over\./);
  assert.match(sent, /could not be opened: https:\/\/bad\.com \(HTTP 403\)\. Still write the piece/);
  assert.deepStrictEqual(review.unverifiedQuotes, ['a sentence nobody ever wrote']);
  assert.deepStrictEqual(review.linkFailures, [{ url: 'https://bad.com', reason: 'HTTP 403' }]);
  assert.ok(review.notes.some(n => /Could not open: https:\/\/bad\.com/.test(n)));
});

test('a humaniser that alters a quotation is overruled: the draft is kept', async () => {
  const { session } = harness({
    humanize: async () => ({ text: 'She said "the fast brown fox leaps" today.' }),
  });
  const review = await session.prepare({ pasted: 'She said "the quick brown fox jumps" today.' });
  assert.strictEqual(review.text, 'She said "the quick brown fox jumps" today.');
  assert.ok(review.notes.some(n => /changed a quotation/.test(n)));
});
