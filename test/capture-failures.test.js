const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function runWithCapture(captureScreenshot, { mode = 'assist', text = '', answer = 'ok', research = {}, modes } = {}) {
  const events = [];
  const streams = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, data) => events.push({ channel, data }) } };
  const deps = {
    electron: { app: { whenReady: () => new Promise(() => {}), on: () => {} }, BrowserWindow: {}, ipcMain: { handle: () => {}, on: () => {} }, globalShortcut: {}, screen: {}, session: {}, desktopCapturer: {}, shell: {} },
    './src/store': { getSettings: () => ({ provider: 'openai' }) },
    './src/screen': { captureScreenshot },
    './src/stt': { createSTT: () => ({}) },
    './src/llm': { createLLM: () => ({ ready: true, stream: async (args) => { streams.push(args); return answer; } }) },
    './src/research': { ...require('../src/research'), getEvidence: async () => [], searchWeb: async () => [], researchPrompt: () => '', validateGroundedAnswer: text => text, needsWebFollowup: () => false, ...research },
    './src/prompts': { ...require('../src/prompts'), MODES: modes || { assist: { needsScreen: true, userBubble: null, system: '', build: () => '' } } },
    './src/profile-context': { appendResumeContext: (system) => system },
    './src/wav': { rms16: () => 0 }
  };
  const context = vm.createContext({
    require: (name) => deps[name] || require(name),
    process, console, Buffer, setInterval, clearInterval
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), context);
  context.testWindow = win;
  vm.runInContext('win = testWindow', context);
  context.testArgs = [mode, text];
  await vm.runInContext('runFeature(...testArgs)', context);
  return { events, streams, busy: vm.runInContext('state.busy', context) };
}

test('screen features stop before provider when screenshot is missing', async () => {
  for (const capture of [async () => null, async () => { throw new Error('capture denied'); }]) {
    const { events, streams, busy } = await runWithCapture(capture);
    assert.equal(streams.length, 0);
    assert.equal(busy, false);
    assert.equal(events.at(-1).channel, 'llm:error');
    assert.match(events.at(-1).data.message, /screen capture/i);
  }
});

test('screen features send a successful screenshot to provider', async () => {
  const { events, streams } = await runWithCapture(async () => 'data:image/png;base64,AA==');
  assert.equal(streams.length, 1);
  assert.equal(streams[0].imageDataUrl, 'data:image/png;base64,AA==');
  assert.equal(events.at(-1).channel, 'llm:done');
});

test('ask with a link opens it, reports failed links, and flags quotes not on the page', async () => {
  const page = { number: 1, title: 'Fox', url: 'https://good.com/a', content: 'The quick brown fox jumps over the lazy dog.', origin: 'page' };
  let searched = false;
  const { events, streams } = await runWithCapture(async () => 'data:image/png;base64,AA==', {
    mode: 'ask', text: 'quote https://good.com/a and https://bad.com/b',
    answer: 'It says "the quick brown fox jumps" [1] and "a fox that never existed here" [1].',
    research: {
      openLinks: async () => ({ sources: [page], failures: [{ url: 'https://bad.com/b', reason: 'HTTP 403' }] }),
      getEvidence: async () => { searched = true; return []; }
    },
    modes: { ask: { needsScreen: false, userBubble: null, system: '', build: c => c.userText } }
  });
  assert.equal(searched, false, 'pasted links are the evidence; no web search');
  assert.match(streams[0].turns[0].text, /could not open these links: https:\/\/bad\.com\/b \(HTTP 403\)/i);
  assert.ok(events.some(e => e.channel === 'status' && /Could not open: https:\/\/bad\.com\/b/.test(e.data.message)));
  const final = events.filter(e => e.channel === 'llm:token').map(e => e.data.text).join('');
  assert.match(final, /Not found word-for-word.*a fox that never existed here/s);
  assert.doesNotMatch(final, /unverified: “the quick brown fox jumps”/);
});
