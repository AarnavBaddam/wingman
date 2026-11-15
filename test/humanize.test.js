'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHumanizer, CONFIG_C_ENV } = require('../src/humanize');

// A stub "python" (really /bin/sh) that uppercases input and prefixes the
// HUMANIZE_MODE env, so we can assert Config C env propagated and output is read.
function stubDir(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-hz-stub-'));
  fs.writeFileSync(path.join(dir, 'humanize_cli.py'), body);
  return dir;
}

test('Config C env is set', () => {
  assert.strictEqual(CONFIG_C_ENV.HUMANIZE_MODE, 'stealth');
  assert.strictEqual(CONFIG_C_ENV.HUMANIZE_STEALTH_ENGINE, 'rule');
});

test('runs the subprocess, passes Config C env, returns transformed text', async () => {
  const dir = stubDir('printf "%s:" "$HUMANIZE_MODE" > "$2"\ntr a-z A-Z < "$1" >> "$2"\n');
  const { humanize } = createHumanizer({ pythonPath: '/bin/sh', scriptDir: dir });
  const { text } = await humanize('hello essay', {}, new AbortController().signal);
  assert.strictEqual(text, 'stealth:HELLO ESSAY');
});

test('per-run opts override Config C knobs', async () => {
  const dir = stubDir('printf "%s/%s" "$INKSPLASH_CANDIDATES" "$INKSPLASH_REFINE" > "$2"\n');
  const { humanize } = createHumanizer({ pythonPath: '/bin/sh', scriptDir: dir });
  const { text } = await humanize('x', { candidates: 20, refine: 5 }, new AbortController().signal);
  assert.strictEqual(text, '20/5');
});

test('nonzero exit rejects with stderr tail', async () => {
  const dir = stubDir('echo "boom detail" 1>&2\nexit 3\n');
  const { humanize } = createHumanizer({ pythonPath: '/bin/sh', scriptDir: dir });
  await assert.rejects(() => humanize('x', {}, new AbortController().signal), /exited 3.*boom detail/s);
});

test('abort kills the process and rejects', async () => {
  const dir = stubDir('sleep 5\nprintf done > "$2"\n');
  const { humanize } = createHumanizer({ pythonPath: '/bin/sh', scriptDir: dir });
  const ctrl = new AbortController();
  const p = humanize('x', {}, ctrl.signal);
  setTimeout(() => ctrl.abort(), 60);
  await assert.rejects(() => p, /Write stopped/);
});

test('isolated:true runs python with -I (no env/cwd import injection)', async () => {
  const { EventEmitter } = require('node:events');
  let argv;
  const fakeSpawn = (file, args) => {
    argv = args;
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => { fs.writeFileSync(args[args.length - 1], 'done'); child.emit('close', 0); });
    return child;
  };
  const { humanize } = createHumanizer({ pythonPath: 'python3', scriptDir: '/x', spawn: fakeSpawn, isolated: true });
  await humanize('hi', {}, new AbortController().signal);
  assert.strictEqual(argv[0], '-I');
});

test('empty input rejects without spawning', async () => {
  const { humanize } = createHumanizer({ pythonPath: '/bin/false', scriptDir: '/nonexistent' });
  await assert.rejects(() => humanize('   ', {}, new AbortController().signal), /Nothing to humanise/);
});

test('exit 5 (a quotation changed) resolves with the original text and a note', async () => {
  const dir = stubDir('cat "$1" > "$2"\necho "quotes-changed" 1>&2\nexit 5\n');
  const { humanize } = createHumanizer({ pythonPath: '/bin/sh', scriptDir: dir });
  const r = await humanize('He said "keep me exact please".', {}, new AbortController().signal);
  assert.strictEqual(r.text, 'He said "keep me exact please".');
  assert.match(r.note, /quotation/);
});

const { createModelHumanizer, freezeQuotes, thawQuotes, HUMANIZE_SYSTEM } = require('../src/humanize');
const fakeLLM = reply => ({ ready: true, sent: null, async stream(a) { this.sent = a; return typeof reply === 'function' ? reply(a) : reply; } });

test('model humaniser: quotes reach the model as markers and come back byte-exact', async () => {
  const llm = fakeLLM(({ turns }) => turns[0].text.replace('Orwell wrote', 'Orwell, famously, put it as').replace(' — ', ' — '));
  const src = 'Orwell wrote “All animals are equal — but some are more equal.” in 1945.';
  const { text, note } = await createModelHumanizer({ llm }).humanize(src);
  assert.match(llm.sent.turns[0].text, /\[\[Q1: All animals are equal — but some are more equal\.\]\]/);
  assert.strictEqual(llm.sent.system, HUMANIZE_SYSTEM);
  assert.strictEqual(text, 'Orwell, famously, put it as “All animals are equal — but some are more equal.” in 1945.');
  assert.strictEqual(note, undefined);
});

test('model humaniser keeps the original when a quote marker is lost or length balloons', async () => {
  const src = 'He said "keep me exact please" and left the room quietly.';
  let r = await createModelHumanizer({ llm: fakeLLM('He said something and left the room quietly, okay.') }).humanize(src);
  assert.strictEqual(r.text, src); assert.match(r.note, /quotation/);
  r = await createModelHumanizer({ llm: fakeLLM('x'.repeat(500)) }).humanize(src);
  assert.strictEqual(r.text, src); assert.match(r.note, /length/);
});

test('model humaniser strips em dashes outside quotes only', async () => {
  const src = 'It rained — a lot. She said "wait — stop" twice.';
  const { text } = await createModelHumanizer({ llm: fakeLLM(({ turns }) => turns[0].text) }).humanize(src);
  assert.strictEqual(text, 'It rained, a lot. She said "wait — stop" twice.');
});

test('the humaniser prompt keeps the author voice instead of imposing one', () => {
  assert.match(HUMANIZE_SYSTEM, /Keep the author's voice/);
  assert.doesNotMatch(HUMANIZE_SYSTEM, /college|student/i);
  const { masked, quotes } = freezeQuotes('a "b c" d');
  assert.strictEqual(thawQuotes(masked, quotes), 'a "b c" d');
  assert.strictEqual(thawQuotes('a d', quotes), null);
});
test('splitSentences round-trips text and keeps decimals and abbreviations whole', () => {
  const { splitSentences } = require('../src/humanize');
  const text = 'Mr. Jones paid 3.5 dollars. It was hot!\nNew line here? Yes.  End without stop';
  const parts = splitSentences(text);
  assert.equal(parts.join(''), text);
  assert.deepEqual(parts.map(p => p.trim()), ['Mr. Jones paid 3.5 dollars.', 'It was hot!', 'New line here?', 'Yes.', 'End without stop']);
  assert.deepEqual(splitSentences(''), []);
});
test('sentenceFacts keeps numbers and names, and a sentence-opening name the essay uses elsewhere', () => {
  const { sentenceFacts } = require('../src/humanize');
  assert.deepEqual(sentenceFacts('The war in Europe ended in 1945.'), ['Europe', '1945']);
  assert.deepEqual(sentenceFacts('Napoleon lost at Waterloo.', 'In 1815 the army of Napoleon fell.'), ['Napoleon', 'Waterloo']);
  assert.deepEqual(sentenceFacts('However I think so.'), []);
});
test('sentence humaniser rewrites only the most AI-like sentences and keeps the detector choice', async () => {
  const { createSentenceHumanizer } = require('../src/humanize');
  const text = 'The Industrial Revolution fundamentally transformed the economic landscape of Europe. It was hot. ' +
    'He said "this stays exactly as written" to the crowd today. Moreover, factories played a pivotal role in shaping society in 1850.';
  const calls = [];
  const scoreSegments = async (segments, options) => {
    calls.push({ segments: [...segments], options });
    return Object.keys(options).length ? { scores: segments.map(() => 0), choice: { 0: 1, 3: -1 } } : { scores: [90, 99, 95, 80] };
  };
  let prompt = '';
  const llm = { ready: true, stream: async ({ turns }) => { prompt = turns[0].text; return '```json\n' + JSON.stringify({
    0: ['The Industrial Revolution changed Europe — fast.', 'Europe\'s economy looked very different after the Industrial Revolution was done with it.', 'It changed things.'],
    3: ['Factories shaped society in 1850.', 'Factories mattered a lot.'] }) + '\n```'; } };
  const h = createSentenceHumanizer({ llm, scoreSegments });
  const out = await h.humanize(text);
  // Short sentence (It was hot.) and the quotation are never sent.
  assert.match(prompt, /"id":0/); assert.match(prompt, /"id":3/); assert.doesNotMatch(prompt, /"id":1|"id":2/);
  // Alternatives that drop a fact (Europe, 1850) or lose the sentence shape are filtered before scoring.
  assert.deepEqual(calls[1].options[0].map(a => a.trim()), ['The Industrial Revolution changed Europe, fast.', 'Europe\'s economy looked very different after the Industrial Revolution was done with it.']);
  assert.deepEqual(calls[1].options[3].map(a => a.trim()), ['Factories shaped society in 1850.']);
  assert.equal(out.changed, 1);
  assert.equal(out.text, text.replace('The Industrial Revolution fundamentally transformed the economic landscape of Europe. ',
    'Europe\'s economy looked very different after the Industrial Revolution was done with it. '));
  const none = await createSentenceHumanizer({ llm: { ready: true, stream: async () => 'no json' }, scoreSegments }).humanize(text);
  assert.equal(none.text, text); assert.match(none.note, /did not return/);
});
