// JSON settings; API keys are encrypted with the OS credential store before writing.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

const FILE = path.join(app.getPath('userData'), 'wingman-data.json');

const DEFAULTS = {
  provider: 'openai',
  smart: false,
  resumeContext: '',
  shortcuts: { assist: 'CommandOrControl+Return' },
  apiKeys: { openai: '', anthropic: '', gemini: '', deepgram: '', nvidia: '', groq: '', tavily: '' },
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
    gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' },
    nvidia: { fast: 'meta/llama-3.2-11b-vision-instruct', smart: 'meta/llama-3.2-90b-vision-instruct' },
    groq: { fast: 'llama-3.3-70b-versatile', smart: 'llama-3.3-70b-versatile' },
    ollama: { fast: '', smart: '' },
    'claude-cli': { fast: '', smart: '' },
    'codex-cli': { fast: '', smart: '' }
  }
};

let data = null;

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

function checkKeys(keys) {
  if (!keys || typeof keys !== 'object' || Array.isArray(keys) ||
      Object.values(keys).some(key => typeof key !== 'string')) {
    throw new Error('Invalid API key settings');
  }
  return Object.values(keys).some(Boolean);
}

function requireSecureStorage() {
  if (!safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('OS credential storage is unavailable; API keys were not saved');
  }
}

function save(next) {
  const { apiKeys, ...stored } = next;
  if (checkKeys(apiKeys)) {
    requireSecureStorage();
    stored.encryptedApiKeys = safeStorage.encryptString(JSON.stringify(apiKeys)).toString('base64');
  }
  const temp = `${FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(stored, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, FILE);
  } finally {
    try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function load() {
  if (data) return data;
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Invalid settings file');
  if (Object.hasOwn(stored, 'apiKeys') && Object.hasOwn(stored, 'encryptedApiKeys')) {
    throw new Error('Conflicting API key settings');
  }

  const { apiKeys, encryptedApiKeys, ...preferences } = stored;
  let keys = apiKeys || DEFAULTS.apiKeys;
  if (Object.hasOwn(stored, 'encryptedApiKeys')) {
    if (typeof encryptedApiKeys !== 'string' || !encryptedApiKeys) throw new Error('Invalid encrypted API keys');
    requireSecureStorage();
    keys = JSON.parse(safeStorage.decryptString(Buffer.from(encryptedApiKeys, 'base64')));
  }
  checkKeys(keys);
  const next = deepMerge(DEFAULTS, { ...preferences, apiKeys: keys });
  if (Object.hasOwn(stored, 'apiKeys')) save(next); // Migrate legacy plaintext before exposing it.

  // Auto-switch provider if the current one has no key, but another one does.
  if (!['ollama', 'claude-cli', 'codex-cli'].includes(next.provider) && !next.apiKeys[next.provider]) {
    const validProviders = ['openai', 'anthropic', 'gemini', 'nvidia', 'groq'];
    const active = validProviders.find(p => next.apiKeys[p]);
    if (active) {
      next.provider = active;
      // We don't save() here so we don't spam disk, it will persist on next save.
    }
  }

  data = next;
  return data;
}

module.exports = {
  getSettings() { return load(); },
  setSettings(patch) {
    load();
    if (patch && Object.hasOwn(patch, 'encryptedApiKeys')) throw new Error('Invalid settings patch');
    const next = deepMerge(data, patch || {});
    save(next);
    data = next;
    return data;
  }
};
