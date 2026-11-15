const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codexLoginStatus, startCodexLogin, signedOutError } = require('../src/codex-login');
const { streamCLI } = require('../src/cli-provider');

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function withFakeCodex(script, fn) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-codex-login-'));
  const originalPath = process.env.PATH;
  try {
    fs.writeFileSync(path.join(bin, 'codex'), '#!/usr/bin/env node\n' + script, { mode: 0o755 });
    process.env.PATH = bin + path.delimiter + originalPath;
    await fn(bin);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

test('sign-in hands the OpenAI URL to the caller, suppresses the browser and reports status', async () => {
  await withFakeCodex(`
const fs = require('fs'), home = process.env.CODEX_HOME;
if (process.argv[3] === 'status') process.exit(fs.existsSync(home + '/auth.json') ? 0 : 1);
console.log('Starting local login server on http://localhost:1455.');
console.log('https://auth.openai.com/oauth/authorize?client_id=x&state=y browser=' + process.env.BROWSER);
setTimeout(() => { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(home + '/auth.json', '{}'); process.exit(0); }, 50);`, async bin => {
    const home = path.join(bin, 'profile');
    assert.equal(await codexLoginStatus(home), false);
    const urls = [];
    await startCodexLogin(home, url => urls.push(url));
    assert.deepEqual(urls, ['https://auth.openai.com/oauth/authorize?client_id=x&state=y']);
    assert.equal(await codexLoginStatus(home), true);
  });
});

test('an unfinished sign-in rejects', async () => {
  await withFakeCodex('process.exit(1);', async bin => {
    await assert.rejects(startCodexLogin(path.join(bin, 'profile'), () => {}), /did not finish/);
  });
});

test('a revoked ChatGPT session surfaces as "signed out" on the Aether profile', async () => {
  // Matches the real failure seen 2026-10-21: refresh_token_invalidated from the warm app-server.
  await withFakeCodex(`
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line), send = o => process.stdout.write(JSON.stringify(o) + '\\n');
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 't1' } } });
  if (m.method === 'turn/start') { send({ id: m.id, result: { turn: { id: 'u1' } } });
    send({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'u1', status: 'failed',
      error: { message: 'Your session has ended. Please log in again.' } } } }); }
});`, async bin => {
    const params = { system: 'Be brief', turns: [{ role: 'user', text: 'Hi' }], imageDataUrl: png, codexHome: path.join(bin, 'profile') };
    await assert.rejects(streamCLI('codex-cli', params), error => error.codexSignedOut === true && /Sign in to Codex/.test(error.message));
  });
});

test('only auth failures are rewritten', () => {
  const other = new Error('Provider timed out');
  assert.equal(signedOutError(other), other);
  assert.equal(signedOutError(new Error('unexpected status 401 Unauthorized')).codexSignedOut, true);
  assert.equal(signedOutError(new Error('max tokens reached')).codexSignedOut, undefined);
});
