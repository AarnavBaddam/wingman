'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createPythonEnv, DEFAULT_REQUIRES } = require('../src/python-env');

// exec stub: map pythonPath -> {code, stdout}. stdout lists missing modules.
function execFrom(table) {
  return async (file) => table[file] || { code: 127, stdout: '', stderr: 'not found' };
}

test('probe flags missing modules', async () => {
  const env = createPythonEnv({ candidates: ['/py'], exec: execFrom({ '/py': { code: 0, stdout: 'torch\nspacy\n' } }) });
  const r = await env.probe('/py');
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.missing, ['torch', 'spacy']);
  assert.strictEqual(r.runnable, true);
});

test('probe passes when nothing is missing', async () => {
  const env = createPythonEnv({ exec: execFrom({ '/good': { code: 0, stdout: '' } }) });
  const r = await env.probe('/good');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.missing, []);
});

test('probe marks an unrunnable interpreter', async () => {
  const env = createPythonEnv({ exec: execFrom({ '/bad': { code: 127, stdout: '', stderr: 'No such file' } }) });
  const r = await env.probe('/bad');
  assert.strictEqual(r.runnable, false);
  assert.strictEqual(r.ok, false);
});

test('detect returns the first fully-working interpreter', async () => {
  const env = createPythonEnv({
    candidates: ['/partial', '/good', '/also'],
    exec: execFrom({ '/partial': { code: 0, stdout: 'torch\n' }, '/good': { code: 0, stdout: '' }, '/also': { code: 0, stdout: '' } }),
  });
  const r = await env.detect();
  assert.strictEqual(r.pythonPath, '/good');
  assert.strictEqual(r.ok, true);
});

test('detect falls back to the most-complete partial when none fully work', async () => {
  const env = createPythonEnv({
    candidates: ['/a', '/b'],
    requires: ['torch', 'spacy', 'nltk'],
    exec: execFrom({ '/a': { code: 0, stdout: 'torch\nspacy\nnltk\n' }, '/b': { code: 0, stdout: 'nltk\n' } }),
  });
  const r = await env.detect();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.pythonPath, '/b', 'fewest missing wins');
});

test('setupCommand builds a safe pip arg array', () => {
  const env = createPythonEnv({});
  const cmd = env.setupCommand('/py');
  assert.strictEqual(cmd.file, '/py');
  assert.ok(cmd.args.slice(0, 4).join(' ') === '-m pip install --upgrade');
  for (const m of DEFAULT_REQUIRES) assert.ok(cmd.args.includes(m));
});
