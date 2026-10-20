const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { createDesktopControl } = require('../src/desktop-control');
const { createMacActivityWatcher } = require('../src/mac-activity');
const { createMacAutoStop } = require('../src/mac-auto-stop');
const { binaryPath } = require('../packages/macdotool');

function png(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer);
  buffer.writeUInt32BE(13, 8); buffer.write('IHDR', 12);
  buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20);
  return buffer;
}

function macHarness() {
  const h = { calls: [], window: { address: '0x1a2b', pid: 42, class: 'com.apple.Safari', mapped: true, at: [100, 50], size: [800, 600] }, clients: [] };
  h.control = createDesktopControl({ pid: 99, platform: 'darwin', macdotool: '/app/macdotool', env: {}, call: async (command, args, options) => {
    h.calls.push({ command, args, options });
    const stdout = args[0] === 'capture' ? png(800, 600) : args[0] === 'activewindow' ? JSON.stringify(h.window) : args[0] === 'clients' ? JSON.stringify(h.clients) : '';
    if (h.fail?.(args)) throw new Error('helper failed');
    return { stdout };
  } });
  return h;
}

test('macOS desktop control uses macdotool for window, capture, cursor and ydotool-style input', async () => {
  const h = macHarness();
  const target = await h.control.lockTarget();
  await h.control.capture(target);
  await h.control.execute(target, { type: 'click', x: 10, y: 20 });
  assert(h.calls.every(c => c.command === '/app/macdotool'));
  assert.deepEqual(h.calls.map(c => c.args), [
    ['activewindow'], ['activewindow'], ['capture', '-g', '100,50 800x600'], ['activewindow'],
    ['clients'], ['activewindow'], ['mousemove', '--absolute', '-x', '110', '-y', '70'], ['clients'], ['activewindow'],
    ['debug'], ['activewindow'], ['click', '0xC0']
  ]);
  await h.control.capture(target);
  await h.control.execute(target, { type: 'type', text: 'hi there' });
  const typed = h.calls.at(-1);
  assert.deepEqual(typed.args, ['type', '--key-delay', '2', '--key-hold', '2', '--file', '-']);
  assert.equal(typed.options.input, 'hi there');
});

test('macOS input failure releases only the mouse button and keycode 0, with Accessibility guidance', async () => {
  const h = macHarness();
  const target = await h.control.lockTarget();
  await h.control.capture(target);
  h.fail = args => args[0] === 'click' && args[1] === '0xC0';
  await assert.rejects(h.control.execute(target, { type: 'click', x: 1, y: 1 }), /Accessibility/);
  assert.deepEqual(h.calls.slice(-2).map(c => c.args), [['click', '0x80'], ['key', '--key-delay', '0', '0:0']]);
  // No ydotool socket is needed on macOS.
  assert(!h.calls.some(c => c.command === 'ydotool'));
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  return child;
}

test('macOS activity watcher waits for ready, parses split lines and drops points over Aether', async () => {
  const child = fakeChild(), points = [];
  const watcher = createMacActivityWatcher({ binary: 'x', start: () => child, onActivity: p => points.push(p), isOwnPoint: p => p.x < 0 });
  const started = watcher.start();
  child.stdout.write('12 34\nready\n');
  await started;
  child.stdout.write('5 6\n-3 4\n7 ');
  child.stdout.write('8\nbad line\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(points, [{ x: 5, y: 6 }, { x: 7, y: 8 }]);
  watcher.stop();
  assert(child.killed);
});

test('macOS activity watcher reports helper errors before and after ready', async () => {
  const early = fakeChild();
  const first = createMacActivityWatcher({ binary: 'x', start: () => early });
  const started = first.start();
  early.stderr.write('Allow Input Monitoring\n');
  await new Promise(resolve => setImmediate(resolve));
  early.emit('close', 1);
  await assert.rejects(started, /Input Monitoring/);

  const late = fakeChild(), errors = [];
  const second = createMacActivityWatcher({ binary: 'x', start: () => late, onError: e => errors.push(e.message) });
  const ready = second.start(); late.stdout.write('ready\n'); await ready;
  late.emit('close', 0);
  assert.equal(errors.length, 1);
});

test('macOS Auto stop owns Escape only while running', async () => {
  const keys = new Map(), reasons = [];
  const globalShortcut = { register: (k, cb) => { if (keys.has(k)) return false; keys.set(k, cb); return true; }, unregister: k => keys.delete(k) };
  const stopper = createMacAutoStop({ globalShortcut, onStop: r => reasons.push(r) });
  await stopper.start();
  keys.get('Escape')();
  assert.deepEqual(reasons, ['Auto stopped: Escape pressed.']);
  assert(!keys.has('Escape'));
  keys.set('Escape', () => {});
  await assert.rejects(createMacAutoStop({ globalShortcut }).start(), /Escape/);
});

const binary = binaryPath();
test('macdotool binary returns hyprctl-shaped JSON and exact-size PNG captures', { skip: process.platform !== 'darwin' || !fs.existsSync(binary) }, () => {
  const cursor = JSON.parse(execFileSync(binary, ['cursorpos'], { encoding: 'utf8' }));
  assert(Number.isInteger(cursor.x) && Number.isInteger(cursor.y));
  const clients = JSON.parse(execFileSync(binary, ['clients'], { encoding: 'utf8' }));
  assert(Array.isArray(clients));
  for (const w of clients) assert(/^0x[0-9a-f]+$/.test(w.address) && Number.isInteger(w.pid) && w.at.length === 2 && w.size.length === 2);
  assert.throws(() => execFileSync(binary, ['capture', '-g', 'nonsense'], { stdio: 'ignore' }));
  let image;
  try { image = execFileSync(binary, ['capture', '-g', '0,0 64x48'], { stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return; } // Screen Recording not granted to this terminal.
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(image.readUInt32BE(16), 64); assert.equal(image.readUInt32BE(20), 48);
});

test('macdotool watch exits when its parent closes stdin', { skip: process.platform !== 'darwin' || !fs.existsSync(binary) }, async () => {
  const { spawn } = require('node:child_process');
  const child = spawn(binary, ['watch'], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.end();
  const [code] = await once(child, 'close');
  assert.equal(code === 0 || code === 1, true);
});
