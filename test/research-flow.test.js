const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function runResearch({ drafts = ['The local sources are insufficient.', 'The answer is supported [1].'], modelError, mode = 'research', question = 'Question' } = {}) {
  const events = [], requests = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, data) => events.push({ channel, data }) } };
  const local = [{ number: 1, title: 'Local', url: 'https://example.org/local', content: 'Local text', origin: 'library' }];
  const web = [{ number: 1, title: 'Web', url: 'https://example.org/web', content: 'Web text', origin: 'web' }];
  let searches = 0, retrievals = 0;
  const deps = {
    electron: { app: { whenReady: () => new Promise(() => {}), on: () => {} }, BrowserWindow: {}, ipcMain: { handle: () => {}, on: () => {} }, globalShortcut: {}, screen: {}, session: {}, desktopCapturer: {}, shell: {} },
    './src/store': { getSettings: () => ({ provider: 'openai', apiKeys: { tavily: 'test' } }) },
    './src/screen': { captureScreenshot: async () => 'data:image/png;base64,screen' },
    './src/stt': { createSTT: () => ({}) },
    './src/llm': { createLLM: () => ({ ready: true, stream: async args => { requests.push(args); if (modelError) throw modelError; args.onToken(drafts[requests.length - 1]); return drafts[requests.length - 1]; } }) },
    './src/research': { ...require('../src/research'), getEvidence: async () => { retrievals++; return local; }, searchWeb: async () => { searches++; return web; }, researchPrompt: sources => sources[0].origin, needsWebFollowup: (text, sources) => sources[0]?.origin === 'library' && text.includes('insufficient') },
    './src/prompts': { ...require('../src/prompts'), MODES: Object.fromEntries(['research','ask'].map(mode => [mode,{ needsScreen: mode==='ask', userBubble: null, system: mode, build: ({ userText }) => userText }])) },
    './src/profile-context': { appendResumeContext: system => system },
    './src/wav': { rms16: () => 0 }
  };
  const context = vm.createContext({ require: name => deps[name] || require(name), process, console, Buffer, setInterval, clearInterval });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), context);
  context.testWindow = win;
  vm.runInContext('win = testWindow', context);
  context.question = question; context.mode = mode;
  await vm.runInContext('runFeature(mode, question)', context);
  return { events, requests, searches, retrievals, local, web };
}

test('main retries web research when local evidence cannot answer', async () => {
  const { events, requests, searches, local, web } = await runResearch();
  assert.equal(searches, 1);
  assert.equal(requests.length, 2);
  assert.match(requests[0].turns[0].text, /library/);
  assert.match(requests[1].turns[0].text, /web/);
  const sourceEvents = events.filter(event => event.channel === 'llm:sources');
  assert.equal(sourceEvents.length, 2);
  assert.equal(sourceEvents[0].data.sources[0].url, local[0].url);
  assert.equal(sourceEvents[1].data.sources[0].url, web[0].url);
  assert.equal(events.at(-1).channel, 'llm:done');
});

test('rejected citations retain retrieved sources without displaying the invalid draft', async () => {
  const { events, local } = await runResearch({ drafts: ['A claim [1]. Invented reference [1, 99].'] });
  assert.equal(events.at(-1).channel, 'llm:error');
  assert.equal(events.find(event => event.channel === 'llm:sources')?.data.sources[0].url, local[0].url);
  assert.equal(events.some(event => event.channel === 'llm:token'), false);
});

test('provider failure keeps the retrieved evidence available', async () => {
  const { events, local } = await runResearch({ modelError: new Error('Provider unavailable') });
  assert.equal(events.at(-1).channel, 'llm:error');
  assert.equal(events.find(event => event.channel === 'llm:sources')?.data.sources[0].url, local[0].url);
  assert.equal(events.some(event => event.channel === 'llm:token'), false);
});

test('explicit screen questions use the screenshot and stream without unrelated web retrieval', async () => {
  const result = await runResearch({mode:'ask',question:"What's on my screen?",drafts:['A settings window is visible.']});
  assert.equal(result.retrievals,0);
  assert.equal(result.searches,0);
  assert.equal(result.requests.length,1);
  assert.match(result.requests[0].imageDataUrl,/base64,screen/);
  assert.equal(result.events.filter(e=>e.channel==='llm:token').length,1);
  assert.equal(result.events.some(e=>e.channel==='llm:sources'),false);
});

test('general factual Ask questions still retrieve and validate their sources', async () => {
  const result=await runResearch({mode:'ask',question:'What is a Banach space?',drafts:['A complete normed vector space [1].']});
  assert.equal(result.retrievals,1);
  assert.equal(result.events.at(-1).channel,'llm:done');
  assert.equal(result.events.some(e=>e.channel==='llm:sources'),true);
});
