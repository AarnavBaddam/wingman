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

test('prepare shows the finished draft without humanising it', async () => {
  const { session, calls } = harness();
  const review = await session.prepare({ prompt: 'write about foxes' });
  assert.strictEqual(calls.llm, 1);
  assert.strictEqual(calls.humanize, 0, 'humanising waits for the Humanize button');
  assert.strictEqual(calls.detect, 1);
  assert.strictEqual(review.text, 'DRAFTED ESSAY.');
  assert.strictEqual(review.aiScore, 0.21);
  assert.strictEqual(session.stage, 'review');
});

test('pasted text skips the drafting model and is only scored', async () => {
  const { session, calls } = harness();
  const review = await session.prepare({ pasted: 'my own words here.' });
  assert.strictEqual(calls.llm, 0);
  assert.strictEqual(calls.humanize, 0);
  assert.strictEqual(review.text, 'my own words here.');
});

// Detector fake: AI% is read from a "[ai=NN]" tag in the text; meaning/facts are fine unless tagged.
const tagDetect = async (text, opts = {}) => {
  const ai = Number((/\[ai=(\d+)\]/.exec(text) || [])[1] ?? 90);
  return { aiScore: ai, pass: ai < 20, detail: `local ${ai}%`, meaning: /\[drift\]/.test(text) ? 0.4 : opts.source ? 0.97 : null, factScore: opts.source ? 1 : null };
};

test('Humanize runs rounds on the best text until the score is under 20%', async () => {
  const inputs = [];
  const replies = ['Essay A [ai=60]', 'Essay B [ai=35]', 'Essay C [ai=12]', 'never used'];
  const { session } = harness({ detect: tagDetect, humanize: async t => { inputs.push(t); return { text: replies.shift() }; } });
  await session.prepare({ pasted: 'Essay [ai=90]' });
  const review = await session.humanizeLoop({ text: 'Essay [ai=90]' });
  assert.strictEqual(review.text, 'Essay C [ai=12]');
  assert.strictEqual(review.runs, 3);
  assert.strictEqual(review.reached, true);
  assert.deepStrictEqual(inputs, ['Essay [ai=90]', 'Essay A [ai=60]', 'Essay B [ai=35]'], 'each round rewrites the best so far');
  assert.strictEqual(session.stage, 'review');
});

test('Humanize discards rounds that change a quote or drift, judged against the starting text', async () => {
  const start = 'He said "keep this exact now" [ai=90]';
  const replies = ['He said "keep this changed now" [ai=5]', 'Off topic [drift] "keep this exact now" [ai=5]', 'He noted "keep this exact now" [ai=15]'];
  const sources = [];
  const { session } = harness({ detect: async (t, o) => { sources.push(o.source); return tagDetect(t, o); }, humanize: async () => ({ text: replies.shift() }) });
  await session.prepare({ pasted: start });
  const review = await session.humanizeLoop({ text: start });
  assert.strictEqual(review.text, 'He noted "keep this exact now" [ai=15]');
  assert.ok(sources.filter(Boolean).every(s => s === start), 'meaning is always checked against the starting text');
  assert.ok(review.notes.some(n => /round 1: a quotation changed/.test(n) && /round 2: drifted/.test(n)));
});

test('Humanize stops at the round cap and says it missed the target', async () => {
  let n = 0;
  const { session } = harness({ detect: tagDetect, humanize: async () => ({ text: `Try ${++n} [ai=${60 - n}]` }) });
  await session.prepare({ pasted: 'Essay [ai=90]' });
  const review = await session.humanizeLoop({ text: 'Essay [ai=90]', maxRuns: 3 });
  assert.strictEqual(review.runs, 3);
  assert.strictEqual(review.reached, false);
  assert.strictEqual(review.text, 'Try 3 [ai=57]');
  assert.ok(review.notes.some(n => /Stopped after 3 rounds at 57\.0% AI/.test(n)));
});

test('a text already under target is not rewritten', async () => {
  const { session, calls } = harness({ detect: tagDetect });
  await session.prepare({ pasted: 'Fine [ai=10]' });
  const review = await session.humanizeLoop({ text: 'Fine [ai=10]' });
  assert.strictEqual(calls.humanize, 0);
  assert.strictEqual(review.runs, 0);
  assert.strictEqual(review.text, 'Fine [ai=10]');
});

test('Stop during Humanize aborts, keeps the review stage, and reports a clean stop', async () => {
  let release;
  const { session } = harness({ detect: tagDetect, humanize: (t, o, signal) => new Promise((_, reject) => { release = () => reject(new Error('aborted')); signal.addEventListener('abort', release); }) });
  await session.prepare({ pasted: 'Essay [ai=90]' });
  const run = session.humanizeLoop({ text: 'Essay [ai=90]' });
  await new Promise(r => setTimeout(r, 5));
  session.stop();
  await assert.rejects(run, /Humanize stopped/);
  assert.strictEqual(session.stage, 'review');
});
