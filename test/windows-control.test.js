const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const childProcess = require('node:child_process');

const electron = { app: { isPackaged: false, getAppMetrics: () => [{ pid: 7 }, { pid: 8 }] }, nativeImage: {}, screen: { dipToScreenPoint: p => p, getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({}) } };
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electron : load.call(this, request, ...rest); };
const spawns = [];
let behave = () => ({});
childProcess.spawn = (command, args, options = {}) => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { child.killed = true; } });
  const call = { command, args, options, child };
  spawns.push(call);
  const { out = '', code = 0, hang = false } = behave(args) || {};
  options.signal?.addEventListener('abort', () => { child.killed = true; child.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })); });
  if (!hang) setImmediate(() => { if (out) child.stdout.emit('data', out); child.emit('close', code); });
  return child;
};
const { createWindowsControl, foregroundWindow, locateInputTool } = require('../src/windows-control');
Module._load = load;

const FG = JSON.stringify({ handle: 5, left: 0, top: 0, right: 1000, bottom: 800 });
function harness() {
  process.env.YDOTOOL_PATH = process.execPath;
  spawns.length = 0;
  behave = args => args[0] === 'fg' ? { out: FG } : {};
  const display = { bounds: { x: 0, y: 0, width: 1000, height: 800 }, size: { width: 1000, height: 800 }, scaleFactor: 1 };
  const control = createWindowsControl({ capture: async () => 'data:image/png;base64,AAAA', getSkipPids: () => [7, 8], getDisplay: () => display });
  const ready = async () => { const target = await control.lockTarget(); await control.capture(target); return target; };
  return { control, ready, args: () => spawns.map(s => s.args) };
}
const inputArgs = () => spawns.map(s => s.args).filter(a => a[0] !== 'fg');

test('locates the tool: env override wins, clear error when missing', () => {
  process.env.YDOTOOL_PATH = process.execPath;
  assert.equal(locateInputTool(), process.execPath);
  // packaged path points nowhere, so a dev build's tools/ydotool.exe cannot satisfy the lookup
  electron.app.isPackaged = true; process.resourcesPath = 'C:\\nowhere\\resources';
  try {
    process.env.YDOTOOL_PATH = 'C:\\definitely\\missing\\ydotool.exe';
    assert.throws(() => locateInputTool(), /ydotool\.exe was not found.*build:input.*YDOTOOL_PATH/);
    delete process.env.YDOTOOL_PATH;
    assert.throws(() => locateInputTool(), /ydotool\.exe was not found/);
  } finally { electron.app.isPackaged = false; delete process.env.YDOTOOL_PATH; }
});

test('maps lock, capture and actions to ydotool commands', async () => {
  const h = harness(); const t = await h.ready();
  assert.deepEqual(h.args(), [['fg', '7,8'], ['fg'], ['nudge']]);
  assert.equal(spawns[0].command, process.execPath);
  assert.deepEqual(t, { handle: 5, left: 0, top: 0, width: 1000, height: 800 });
  spawns.length = 0;
  await h.control.execute(t, { type: 'click', x: 100.4, y: 200 });
  await h.control.execute(t, { type: 'click', x: 10, y: 20, clicks: 2 });
  await h.control.execute(t, { type: 'scroll', x: 5, y: 6, amount: -3 });
  await h.control.execute(t, { type: 'drag', x: 1, y: 2, toX: 30, toY: 40 });
  await h.control.execute(t, { type: 'clear' });
  assert.deepEqual(inputArgs(), [['click-at', '100', '200', '1'], ['click-at', '10', '20', '2'], ['scroll', '5', '6', '-3'], ['drag', '1', '2', '30', '40'], ['clear']]);
  assert(spawns.every(s => s.options.windowsHide));
});

test('type passes human args after --, with no temp file, and scales the timeout', async () => {
  const h = harness(); const t = await h.ready(); spawns.length = 0;
  const delays = []; const realSet = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSet(fn, ms, ...rest); };
  try {
    await h.control.execute(t, { type: 'type', text: '-hello world' });
    await h.control.execute(t, { type: 'type', text: 'x'.repeat(1000) });
  } finally { global.setTimeout = realSet; }
  const typed = inputArgs();
  assert.deepEqual(typed[0], ['type', '--human', '--wpm', '180', '-e', '0', '--', '-hello world']);
  assert.equal(typed[1].at(-1).length, 1000);
  assert(delays.includes(10000)); assert(delays.includes(150000));
});

test('type and coordinate validation is kept', async () => {
  const h = harness(); const t = await h.ready(); spawns.length = 0;
  for (const text of ['', 'caf\u00e9', 'a\nb', 'x'.repeat(1001), 7]) await assert.rejects(h.control.execute(t, { type: 'type', text }), /ASCII/);
  await assert.rejects(h.control.execute(t, { type: 'click', x: NaN, y: 1 }), /coordinates/);
  await assert.rejects(h.control.execute(t, { type: 'wiggle', x: 1, y: 1 }), /Unsupported/);
  assert.deepEqual(inputArgs(), []);
});

test('focus drift activates the locked window once, then fails if it stays wrong', async () => {
  const h = harness(); const t = await h.ready(); spawns.length = 0;
  behave = args => args[0] === 'fg' ? { out: JSON.stringify({ handle: 9, left: 0, top: 0, right: 10, bottom: 10 }) } : {};
  await assert.rejects(h.control.execute(t, { type: 'clear' }), /Target window changed/);
  assert.deepEqual(inputArgs(), [['activate', '5']]);
});

test('abort of a held input runs release once, without a signal', async () => {
  for (const action of [{ type: 'type', text: 'hi' }, { type: 'drag', x: 1, y: 1, toX: 2, toY: 2 }, { type: 'clear' }, { type: 'click', x: 1, y: 1 }]) {
    const h = harness(); const t = await h.ready(); spawns.length = 0;
    behave = args => args[0] === 'fg' ? { out: FG } : args[0] === 'release' ? {} : { hang: true };
    const abort = new AbortController();
    const run = h.control.execute(t, action, abort.signal);
    await new Promise(resolve => setTimeout(resolve, 20));
    abort.abort();
    await assert.rejects(run, { name: 'AbortError' });
    const releases = spawns.filter(s => s.args[0] === 'release');
    assert.equal(releases.length, 1, action.type);
    assert.deepEqual(releases[0].args, ['release']);
    assert.equal(releases[0].options.signal, undefined);
    assert(spawns.at(-1) === releases[0]);
  }
});

test('timeout kills the child and runs release once', async () => {
  const h = harness(); const t = await h.ready(); spawns.length = 0;
  behave = args => args[0] === 'fg' ? { out: FG } : args[0] === 'release' ? {} : { hang: true };
  const realSet = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => realSet(fn, ms >= 10000 ? 1 : ms, ...rest);
  try { await assert.rejects(h.control.execute(t, { type: 'drag', x: 1, y: 1, toX: 2, toY: 2 }), /timed out/); }
  finally { global.setTimeout = realSet; }
  const drag = spawns.find(s => s.args[0] === 'drag');
  assert(drag.child.killed);
  assert.equal(spawns.filter(s => s.args[0] === 'release').length, 1);
});

test('no release for a failed command or an aborted query', async () => {
  const h = harness(); const t = await h.ready(); spawns.length = 0;
  behave = args => args[0] === 'fg' ? { out: FG } : { code: 5 };
  await assert.rejects(h.control.execute(t, { type: 'clear' }));
  assert.equal(spawns.filter(s => s.args[0] === 'release').length, 0);
  behave = () => ({ hang: true });
  const abort = new AbortController();
  const run = foregroundWindow(abort.signal, [], process.execPath);
  abort.abort();
  await assert.rejects(run, { name: 'AbortError' });
  assert.equal(spawns.filter(s => s.args[0] === 'release').length, 0);
});
