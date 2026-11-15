const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const storePath = require.resolve('../src/store');

function fixture(t, { initial, available = true, backend = 'gnome_libsecret', renameFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-store-'));
  const file = path.join(dir, 'wingman-data.json');
  if (initial !== undefined) fs.writeFileSync(file, JSON.stringify(initial));
  t.after(() => { delete require.cache[storePath]; fs.rmSync(dir, { recursive: true, force: true }); });

  const secrets = new Map();
  const safeStorage = {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(value) {
      const token = `cipher-${secrets.size + 1}`;
      secrets.set(token, value);
      return Buffer.from(token);
    },
    decryptString(value) {
      const secret = secrets.get(value.toString());
      if (secret === undefined) throw new Error('Unable to decrypt API keys');
      return secret;
    }
  };
  const fileSystem = renameFails ? { ...fs, renameSync: () => { throw new Error('write failed'); } } : fs;

  function open() {
    delete require.cache[storePath];
    const original = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return { app: { getPath: () => dir }, safeStorage };
      if (request === 'fs' && parent.filename === storePath) return fileSystem;
      return original.call(this, request, parent, isMain);
    };
    try { return require('../src/store'); }
    finally { Module._load = original; }
  }

  return { file, open, safeStorage };
}

test('migrates legacy plaintext keys and restores them from ciphertext', (t) => {
  const { file, open } = fixture(t, { initial: { provider: 'anthropic', apiKeys: { anthropic: 'secret-123' } } });
  const store = open();
  assert.equal(store.getSettings().apiKeys.anthropic, 'secret-123');
  const disk = fs.readFileSync(file, 'utf8');
  assert.ok(!disk.includes('secret-123'));
  assert.ok(!Object.hasOwn(JSON.parse(disk), 'apiKeys'));
  assert.equal(open().getSettings().apiKeys.anthropic, 'secret-123');
});

test('saves key changes and deletions without plaintext on disk', (t) => {
  const { file, open } = fixture(t);
  const store = open();
  store.setSettings({ apiKeys: { openai: 'secret-456' } });
  assert.equal(open().getSettings().apiKeys.openai, 'secret-456');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('secret-456'));
  store.setSettings({ apiKeys: { openai: '' } });
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!Object.hasOwn(disk, 'apiKeys'));
  assert.ok(!Object.hasOwn(disk, 'encryptedApiKeys'));
});

test('saves preferences without keys when credential storage is unavailable', (t) => {
  const { file, open } = fixture(t, { available: false });
  const store = open();
  store.setSettings({ smart: true });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).smart, true);
  assert.throws(() => store.setSettings({ apiKeys: { openai: 'secret' } }), /credential storage is unavailable/);
  assert.equal(store.getSettings().apiKeys.openai, '');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('secret'));
});

test('keeps a selected local provider without an API key', (t) => {
  const { open } = fixture(t, { initial: { provider: 'ollama' } });
  assert.equal(open().getSettings().provider, 'ollama');
});

test('rejects Linux basic_text and preserves legacy plaintext for later migration',
  { skip: process.platform !== 'linux' }, (t) => {
    const initial = { apiKeys: { openai: 'legacy-secret' } };
    const { file, open } = fixture(t, { initial, backend: 'basic_text' });
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => open().getSettings(), /credential storage is unavailable/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

test('does not overwrite settings when encrypted keys cannot be decrypted', (t) => {
  const initial = { encryptedApiKeys: Buffer.from('unknown').toString('base64'), smart: true };
  const { file, open } = fixture(t, { initial });
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => open().getSettings(), /Unable to decrypt API keys/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('failed atomic replacement preserves the original file and in-memory settings', (t) => {
  const initial = { smart: false };
  const { file, open } = fixture(t, { initial, renameFails: true });
  const store = open();
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.setSettings({ smart: true }), /write failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(store.getSettings().smart, false);
});

test('failed migration leaves the legacy file intact', (t) => {
  const { file, open } = fixture(t, { initial: { apiKeys: { openai: 'legacy-secret' } }, renameFails: true });
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => open().getSettings(), /write failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
