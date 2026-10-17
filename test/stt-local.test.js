const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const sttPath = require.resolve('../src/stt');

function fixture(t, spawnImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-stt-test-'));
  const model = path.join(dir, 'model.bin');
  fs.writeFileSync(model, 'test model');
  t.after(() => { delete require.cache[sttPath]; fs.rmSync(dir, { recursive: true, force: true }); });

  delete require.cache[sttPath];
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'child_process' && parent.filename === sttPath) return { spawn: spawnImpl };
    return original.call(this, request, parent, isMain);
  };
  try { return { model, createSTT: require('../src/stt').createSTT }; }
  finally { Module._load = original; }
}

function child() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.kill = () => { setImmediate(() => proc.emit('close', null)); return true; };
  return proc;
}

test('local mode transcribes with whisper-cli, private WAV, and no cloud fallback', async (t) => {
  let wavFile;
  const { model, createSTT } = fixture(t, (command, args, options) => {
    assert.equal(command, 'whisper-cli');
    assert.equal(options.shell, false);
    assert.deepEqual(args.slice(0, 5), ['-np', '-nt', '-m', model, '-f']);
    wavFile = args[5];
    assert.equal(fs.statSync(wavFile).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(wavFile).toString('ascii', 0, 4), 'RIFF');
    const proc = child();
    setImmediate(() => { proc.stdout.emit('data', Buffer.from('  hello world\n')); proc.emit('close', 0); });
    return proc;
  });
  const stt = createSTT({ sttProvider: 'local', whisperModelPath: model, apiKeys: { openai: 'cloud-key' } });
  assert.deepEqual(stt.providers, ['local']);
  assert.equal(stt.available, true);
  assert.deepEqual(await stt.transcribe(Buffer.alloc(3200)), { text: 'hello world', provider: 'local' });
  assert.equal(fs.existsSync(wavFile), false);
  assert.equal(fs.existsSync(path.dirname(wavFile)), false);
});

test('local mode reports missing model without cloud fallback or leaking its path', async (t) => {
  const { createSTT } = fixture(t, () => { throw new Error('spawn should not run'); });
  const modelPath = '/private/sensitive/model.bin';
  const stt = createSTT({ sttProvider: 'local', whisperModelPath: modelPath, apiKeys: { openai: 'cloud-key' } });
  const result = await stt.transcribe(Buffer.alloc(3200));
  assert.equal(result.error.provider, 'local');
  assert.ok(!result.error.message.includes(modelPath));
  assert.ok(!JSON.stringify(result).includes('cloud-key'));
});

test('failed CLI invocation removes WAV and reports a bounded generic error', async (t) => {
  let wavFile;
  const { model, createSTT } = fixture(t, (_command, args) => {
    wavFile = args[5];
    const proc = child();
    setImmediate(() => { proc.stdout.emit('data', Buffer.alloc(64 * 1024 + 1, 65)); });
    return proc;
  });
  const result = await createSTT({ sttProvider: 'local', whisperModelPath: model }).transcribe(Buffer.alloc(3200));
  assert.equal(result.error.message, 'Local transcription output exceeded the limit');
  assert.equal(fs.existsSync(wavFile), false);
});

test('default mode keeps the existing cloud provider order', (t) => {
  const { createSTT } = fixture(t, () => { throw new Error('spawn should not run'); });
  const stt = createSTT({ apiKeys: { openai: 'first', gemini: 'second' } });
  assert.deepEqual(stt.providers, ['openai', 'gemini']);
});

test('Ollama forces local transcription even when cloud keys exist', (t) => {
  const { createSTT, model } = fixture(t, () => { throw new Error('spawn should not run'); });
  const stt = createSTT({ provider: 'ollama', whisperModelPath: model, apiKeys: { openai: 'cloud-key' } });
  assert.deepEqual(stt.providers, ['local']);
});
