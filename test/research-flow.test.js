const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('main retries web research when local evidence cannot answer', async () => {
  const events = [], requests = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, data) => events.push({ channel, data }) } };
  const local = [{ number: 1, title: 'Local', url: 'https://example.org/local', content: 'Local text', origin: 'library' }];
  const web = [{ number: 1, title: 'Web', url: 'https://example.org/web', content: 'Web text', origin: 'web' }];
  let searches = 0;
  const deps = {
    electron: { app: { whenReady: () => new Promise(() => {}), on: () => {} }, BrowserWindow: {}, ipcMain: { handle: () => {}, on: () => {} }, globalShortcut: {}, screen: {}, session: {}, desktopCapturer: {}, shell: {} },
    './src/store': { getSettings: () => ({ provider: 'openai', apiKeys: { tavily: 'test' } }) },
    './src/screen': { captureScreenshot: async () => null },
    './src/stt': { createSTT: () => ({}) },
    './src/llm': { createLLM: () => ({ ready: true, stream: async args => { requests.push(args); return requests.length === 1 ? 'The local sources are insufficient.' : 'The answer is supported [1].'; } }) },
    './src/research': { getEvidence: async () => local, searchWeb: async () => { searches++; return web; }, researchPrompt: sources => sources[0].origin, validateGroundedAnswer: text => text, needsWebFollowup: (text, sources) => sources[0].origin === 'library' && text.includes('insufficient') },
    './src/prompts': { MODES: { research: { needsScreen: false, userBubble: null, system: 'Research', build: ({ userText }) => userText } } },
    './src/profile-context': { appendResumeContext: system => system },
    './src/wav': { rms16: () => 0 }
  };
  const context = vm.createContext({ require: name => deps[name] || require(name), process, console, Buffer, setInterval, clearInterval });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), context);
  context.testWindow = win;
  vm.runInContext('win = testWindow', context);
  await vm.runInContext('runFeature("research", "Question")', context);
  assert.equal(searches, 1);
  assert.equal(requests.length, 2);
  assert.match(requests[0].turns[0].text, /library/);
  assert.match(requests[1].turns[0].text, /web/);
  assert.equal(events.at(-2).channel, 'llm:sources');
  assert.equal(events.at(-2).data.sources[0].url, web[0].url);
  assert.equal(events.at(-1).channel, 'llm:done');
});
