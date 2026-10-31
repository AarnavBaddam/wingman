const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHyprAutoStop } = require('../src/hypr-auto-stop');

function harness(overrides = {}) {
  const calls = [], sockets = [], stopped = [];
  const helper = createHyprAutoStop({
    env: { XDG_RUNTIME_DIR: '/run/user/1000', HYPRLAND_INSTANCE_SIGNATURE: 'test_123' }, pid: 123,
    onStop: reason => stopped.push(reason),
    callSync(args) { calls.push(args); return 'ok\n'; },
    connect(socketPath) {
      const socket = new EventEmitter();
      socket.path = socketPath;
      socket.setEncoding = () => {};
      socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
      sockets.push(socket);
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    }, ...overrides
  });
  return { helper, calls, sockets, stopped };
}

test('Auto installs one non-consuming Escape handle after connecting and removes only its own handle', async () => {
  const h = harness();
  await Promise.all([h.helper.start(), h.helper.start()]);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].path, '/run/user/1000/hypr/test_123/.socket2.sock');
  const lua = h.calls[0][1];
  assert.match(lua, /hl\.bind\("Escape"/);
  assert.match(lua, /non_consuming = true, ignore_mods = true/);
  assert.match(lua, /description = "Aether: Stop Auto"/);
  assert.match(lua, /aether-auto-stop:123/);
  assert.match(lua, /__aether_auto_stop_123/);
  assert(!/hl\.unbind|locked|allow_input_capture/.test(lua));
  h.helper.stop(); h.helper.stop();
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1][1], /handle:remove\(\)/);
  assert(h.sockets[0].destroyed);
  assert.deepEqual(h.stopped, []);
});

test('only an exact framed event for this PID stops Auto once and cleans up first', async () => {
  const h = harness(); await h.helper.start();
  const socket = h.sockets[0];
  socket.emit('data', 'custom>>aether-auto-stop:456\ncustom>>aether-auto-stop:123-extra\n');
  socket.emit('data', 'x'.repeat(70000));
  socket.emit('data', 'custom>>aether-auto-stop:123\n');
  assert.equal(h.stopped.length, 0);
  socket.emit('data', 'custom>>aether-auto-');
  socket.emit('data', 'stop:123\ncustom>>aether-auto-stop:123\n');
  assert.equal(h.stopped.length, 1);
  assert.match(h.stopped[0], /Escape/);
  assert(socket.destroyed);
  assert.equal(h.calls.length, 2);
});

test('socket errors, close, and config reload fail closed and allow a later start', async () => {
  for (const trigger of [socket => socket.emit('error', Error('disconnected')), socket => socket.emit('close'), socket => socket.emit('data', 'configreloaded>>\n')]) {
    const h = harness(); await h.helper.start(); trigger(h.sockets[0]);
    assert.equal(h.stopped.length, 1);
    assert.match(h.stopped[0], /Auto|Hyprland/);
    assert.equal(h.calls.length, 2);
    await h.helper.start(); assert.equal(h.sockets.length, 2);
    h.helper.stop();
  }
});

test('startup cancellation never installs a late Escape binding', async () => {
  const socket = new EventEmitter(); socket.setEncoding = () => {}; socket.destroy = () => socket.emit('close');
  const h = harness({ connect: () => socket });
  const pending = h.helper.start(); h.helper.stop();
  await assert.rejects(pending, /stopped/);
  socket.emit('connect');
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.stopped, []);
});

test('a socket closing immediately after connecting never installs a binding', async () => {
  const socket = new EventEmitter(); socket.setEncoding = () => {}; socket.destroy = () => {};
  const h = harness({ connect: () => {
    queueMicrotask(() => { socket.emit('connect'); socket.emit('close'); });
    return socket;
  } });
  await assert.rejects(h.helper.start(), /closed/);
  assert.equal(h.calls.length, 0);
});

test('invalid environments and startup failures reject without leaving bindings behind', async () => {
  for (const overrides of [{ pid: '123);bad()' }, { pid: 0 }, { env: {} }, { env: { XDG_RUNTIME_DIR: '/run/user/1000', HYPRLAND_INSTANCE_SIGNATURE: '../bad' } }]) {
    const h = harness(overrides); await assert.rejects(h.helper.start(), /Hyprland/);
    assert.equal(h.calls.length, 0); assert.equal(h.sockets.length, 0);
  }
  let count = 0;
  const h = harness({ callSync: () => ++count === 1 ? 'Lua error' : 'ok' });
  await assert.rejects(h.helper.start(), /install/);
  assert.equal(count, 2); assert(h.sockets[0].destroyed);
});

test('cleanup failure is reported as a stop reason without throwing or duplicate notifications', async () => {
  let count = 0;
  const h = harness({ callSync: () => { if (++count > 1) throw Error('cleanup unavailable'); return 'ok'; } });
  await h.helper.start();
  assert.doesNotThrow(() => h.helper.stop());
  assert.equal(h.stopped.length, 1);
  assert.match(h.stopped[0], /cleanup unavailable/);
  h.helper.stop(); assert.equal(h.stopped.length, 1);
});

test('Lua Escape callback emits only its stop event and removes the owned handle', async t => {
  const { spawnSync } = require('node:child_process');
  if (spawnSync('lua', ['-v']).error) return t.skip('Lua interpreter unavailable');
  const h = harness(); await h.helper.start(); h.helper.stop();
  const result = spawnSync('lua', ['-'], { encoding: 'utf8', input: `
local callback, events, removed = nil, 0, 0
hl = {
  dsp = { event = function(name) assert(name == "aether-auto-stop:123"); return name end },
  dispatch = function(event) assert(event == "aether-auto-stop:123"); events = events + 1 end,
  bind = function(key, cb, options)
    assert(key == "Escape" and options.non_consuming and options.ignore_mods)
    assert(options.description == "Aether: Stop Auto")
    callback = cb
    return {remove = function() removed = removed + 1 end}
  end
}
${h.calls[0][1]}
callback(); assert(events == 1)
${h.calls[1][1]}
assert(removed == 1 and _G.__aether_auto_stop_123 == nil)
` });
  assert.equal(result.status, 0, result.stderr);
});
