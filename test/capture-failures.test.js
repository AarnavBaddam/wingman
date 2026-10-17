const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function runWithCapture(captureScreenshot) {
  const events = [];
  const streams = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, data) => events.push({ channel, data }) } };
  const deps = {
    electron: { app: { whenReady: () => new Promise(() => {}), on: () => {} }, BrowserWindow: {}, ipcMain: { handle: () => {}, on: () => {} }, globalShortcut: {}, screen: {}, session: {}, desktopCapturer: {}, shell: {} },
    './src/store': { getSettings: () => ({ provider: 'openai' }) },
    './src/screen': { captureScreenshot },
    './src/stt': { createSTT: () => ({}) },
    './src/llm': { createLLM: () => ({ ready: true, stream: async (args) => { streams.push(args); return 'ok'; } }) },
    './src/research': { getEvidence: async () => [], searchWeb: async () => [], researchPrompt: () => '', validateGroundedAnswer: text => text, needsWebFollowup: () => false },
    './src/prompts': { MODES: { assist: { needsScreen: true, userBubble: null, system: '', build: () => '' } } },
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
  await vm.runInContext('runFeature("assist", "")', context);
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
