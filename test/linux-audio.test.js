const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function harness() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const killed = [], chunks = [], timers = [];
  child.kill = signal => killed.push(signal);
  let ended = 0, invocation;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/linux-audio.js'), 'utf8'), {
    module, Buffer,
    require: () => ({ spawn: (...args) => { invocation = args; return child; } }),
    setTimeout: fn => { timers.push(fn); return { unref() {} }; }, clearTimeout() {}
  });
  const capture = module.exports.startLinuxAudio(chunk => chunks.push(chunk), () => ended++);
  return { child, capture, killed, chunks, timers, get ended() { return ended; }, get invocation() { return invocation; } };
}

test('Linux monitor waits for PCM and preserves samples across odd byte chunks', async () => {
  const h = harness();
  let ready = false;
  h.capture.ready.then(value => { ready = value; });
  h.child.stdout.emit('data', Buffer.from([1]));
  await Promise.resolve();
  assert.equal(ready, false);
  h.child.stdout.emit('data', Buffer.from([2, 3, 4]));
  assert.equal(await h.capture.ready, true);
  assert.deepEqual(Buffer.concat(h.chunks), Buffer.from([1, 2, 3, 4]));
  assert.equal(h.invocation[0], 'parec');
  assert(h.invocation[1].includes('--device=@DEFAULT_MONITOR@'));
  assert(h.invocation[1].includes('--format=s16le'));
  assert.equal(h.invocation[2].shell, undefined);
  h.capture.stop();
  h.child.emit('close', 0);
  assert.equal(h.ended, 0);
  assert.deepEqual(h.killed, ['SIGTERM']);
});

test('missing Linux helper fails readiness without hanging', async () => {
  const h = harness();
  h.child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
  h.child.emit('close', -2);
  assert.equal(await h.capture.ready, false);
  assert.equal(h.ended, 1);
});

test('stalled startup kills the helper and unexpected exit reports capture ended', async () => {
  const stalled = harness();
  stalled.timers[0]();
  assert.equal(await stalled.capture.ready, false);
  assert.deepEqual(stalled.killed, ['SIGTERM']);
  stalled.timers[1]();
  assert.deepEqual(stalled.killed, ['SIGTERM', 'SIGKILL']);
  stalled.child.emit('close', 0);
  assert.equal(stalled.ended, 0);
  const active = harness();
  active.child.stdout.emit('data', Buffer.from([0, 0]));
  assert.equal(await active.capture.ready, true);
  active.child.emit('close', 1);
  assert.equal(active.ended, 1);
});

test('main permits retry after failed native startup and clears PCM on stop', async () => {
  const handlers = {};
  let starts = 0, stops = 0, deliver;
  const electron = {
    app: { whenReady: () => new Promise(() => {}), on() {} },
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; }, on() {} }
  };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === './src/linux-audio' ? {
      startLinuxAudio: onData => { deliver = onData; return { ready: Promise.resolve(++starts > 1), stop: () => stops++ }; }
    } : name.startsWith('./src/') ? {} : require(name),
    process: { platform: 'linux' }, console, Buffer, setInterval: () => 1, clearInterval() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  assert.equal(await handlers['capture:system:start'](), false);
  assert.equal(await handlers['capture:system:start'](), true);
  assert.equal(starts, 2);
  vm.runInContext('setCapturing(true)', context);
  deliver(Buffer.from([0, 0]));
  assert.equal(vm.runInContext('buffers.them.length', context), 1);
  vm.runInContext('setCapturing(false)', context);
  assert.equal(vm.runInContext('buffers.them.length', context), 0);
  assert.equal(stops, 2);
});
