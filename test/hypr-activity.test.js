const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHyprActivityWatcher } = require('../src/hypr-activity');

function harness(overrides = {}) {
  const calls = [], sockets = [], activity = [], errors = [];
  const watcher = createHyprActivityWatcher({
    env: { XDG_RUNTIME_DIR: '/run/user/1000', HYPRLAND_INSTANCE_SIGNATURE: 'test_123' }, pid: 123,
    onActivity: point => activity.push(point), onError: error => errors.push(error),
    callSync(args) { calls.push(args); return 'ok\n'; },
    connect(path) {
      const socket = new EventEmitter();
      socket.path = path;
      socket.setEncoding = () => {};
      socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
      sockets.push(socket);
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    }, ...overrides
  });
  return { watcher, calls, sockets, activity, errors };
}

test('connects before installing five non-consuming mouse-only bindings; cleanup owns handles', async () => {
  const h = harness();
  await Promise.all([h.watcher.start(), h.watcher.start()]);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].path, '/run/user/1000/hypr/test_123/.socket2.sock');
  const lua = h.calls[0][1];
  assert.equal((lua.match(/hl.bind\(/g) || []).length, 5);
  for (const key of ['mouse:272', 'mouse_up', 'mouse_down', 'mouse_left', 'mouse_right']) assert(lua.includes('"' + key + '"'));
  assert(lua.includes('release = true'));
  assert(lua.includes('non_consuming = true, ignore_mods = true'));
  assert(lua.includes('w.pid == 123'));
  assert(lua.includes('dev.prahladv.aether'));
  assert(lua.includes('hl.get_cursor_pos()'));
  assert(lua.includes('w.at.x'));
  assert(lua.includes('string.format("aether-activity:123:%d:%d"'));
  assert(lua.includes('math.floor(cursor.x), math.floor(cursor.y)'));
  assert(!/hl\.unbind|locked|keyboard|allow_input_capture/.test(lua));
  h.watcher.stop(); h.watcher.stop();
  assert.equal(h.calls.length, 2);
  assert(h.calls[1][1].includes('handle:remove()'));
  assert(h.sockets[0].destroyed);
});

test('parses split frames, ignores other PIDs and oversize lines, and permits a later valid frame', async () => {
  const h = harness(); await h.watcher.start();
  const socket = h.sockets[0];
  socket.emit('data', 'custom>>aether-act');
  socket.emit('data', 'ivity:123:-1920:400\ncustom>>aether-activity:456:1:2\nactivewindow>>Aether\n');
  assert.deepEqual(h.activity, [{ x: -1920, y: 400 }]);
  socket.emit('data', 'x'.repeat(70000));
  socket.emit('data', 'custom>>aether-activity:123:0:0\ncustom>>aether-activity:123:0:0\n');
  assert.equal(h.activity.length, 2);
  h.watcher.stop();
  socket.emit('data', 'custom>>aether-activity:123:0:0\n');
  assert.equal(h.activity.length, 2);
});

test('unexpected socket error removes bindings and reports once; restart is possible', async () => {
  const h = harness(); await h.watcher.start();
  h.sockets[0].emit('error', new Error('socket failed'));
  assert.equal(h.errors.length, 1);
  assert.equal(h.calls.length, 2);
  await h.watcher.start();
  assert.equal(h.sockets.length, 2);
  h.sockets[1].emit('close');
  assert.equal(h.errors.length, 2);
  assert.equal(h.calls.length, 4);
});

test('rejects invalid environment and PID before touching sockets or bindings', async () => {
  for (const overrides of [{ pid: '1); bad()' }, { pid: 0 }, { env: {} }, { env: { XDG_RUNTIME_DIR: '/run/user/1000', HYPRLAND_INSTANCE_SIGNATURE: '../bad' } }]) {
    const h = harness(overrides);
    await assert.rejects(h.watcher.start(), /Hyprland/);
    assert.equal(h.sockets.length, 0); assert.equal(h.calls.length, 0);
  }
});

test('failed installation cleans partial handles and closes the socket', async () => {
  let count = 0;
  const h = harness({ callSync: () => ++count === 1 ? 'Lua error: failed' : 'ok' });
  await assert.rejects(h.watcher.start(), /activity bindings/);
  assert.equal(count, 2); assert(h.sockets[0].destroyed);
});

test('stopping while connection is pending cancels startup without installing bindings', async () => {
  const socket = new EventEmitter(); socket.destroy = () => socket.emit('close'); socket.setEncoding = () => {};
  const h = harness({ connect: () => socket });
  const pending = h.watcher.start();
  h.watcher.stop();
  await assert.rejects(pending, /stopped/);
  socket.emit('connect');
  assert.equal(h.calls.length, 0);
});

test('Lua callback requires mapped exact PID and excludes every Aether rectangle', async t => {
  const { spawnSync } = require('node:child_process');
  if (spawnSync('lua', ['-v']).error) return t.skip('Lua interpreter unavailable');
  const h = harness(); await h.watcher.start();
  const result = spawnSync('lua', ['-'], { encoding: 'utf8', input: `
local callbacks, windows, cursor, events, removed, payload = {}, {}, {x=500.9,y=-500.2}, 0, 0, nil
hl = {
  get_windows = function() return windows end,
  get_cursor_pos = function() return cursor end,
  dsp = {event = function(name) return {name=name} end},
  dispatch = function(dispatcher) payload = dispatcher.name; events = events + 1 end,
  bind = function(key, cb, options)
    assert(options.non_consuming and options.ignore_mods)
    assert(options.release == (key == "mouse:272" and true or nil))
    callbacks[#callbacks+1] = cb
    return {remove=function() removed = removed+1 end}
  end
}
${h.calls[0][1]}
local function click(expected) callbacks[1](); assert(events == expected) end
click(0)
windows = {{class="other", pid=123, mapped=true, at={x=0,y=0},size={x=100,y=100}}}; click(0)
windows[1].class="dev.prahladv.aether"; windows[1].mapped=false; click(0)
windows[1].mapped=true; windows[1].pid=456; click(0)
windows[1].pid=123; click(1)
assert(payload == "aether-activity:123:500:-501")
cursor={x=0,y=0}; click(1)
cursor={x=99,y=99}; click(1)
cursor={x=100,y=100}; click(2)
windows[2]={class="dev.prahladv.aether",pid=456,mapped=true,at={x=100,y=100},size={x=100,y=100}}; click(2)
cursor={x=0/0,y=1}; click(2)
cursor={x=math.huge,y=1}; click(2)
cursor={x=1000001,y=1}; click(2)
cursor=nil; click(2)
${h.calls[0][1]}
assert(removed == 5)
` });
  assert.equal(result.status, 0, result.stderr);
  h.watcher.stop();
});

test('config reload reports disconnected watcher and cleans up without auto-reconnecting', async () => {
  const h = harness(); await h.watcher.start();
  h.sockets[0].emit('data', 'configreloaded>>\ncustom>>aether-activity:123:0:0\n');
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /configuration reloaded/);
  assert.equal(h.activity.length, 0);
  assert.equal(h.calls.length, 2);
  assert.equal(h.sockets.length, 1);
  assert(h.sockets[0].destroyed);
  h.watcher.stop();
});

test('stop reports cleanup failure instead of throwing during compositor shutdown', async () => {
  let calls = 0;
  const h = harness({ callSync() { if (++calls > 1) throw new Error('compositor unavailable'); return 'ok'; } });
  await h.watcher.start();
  assert.doesNotThrow(() => h.watcher.stop());
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /compositor unavailable/);
  h.watcher.stop();
});

test('coordinates reject malformed, nonfinite and extreme values and retain signed desktop positions', async () => {
  const h = harness(); await h.watcher.start();
  const invalid = ['123', '123:NaN:0', '123:Infinity:0', '123:1.5:0', '123:1e3:0', '123:1000001:0', '123:0:-1000001', '123:999999999999999999:0', '123:0:0:0', '123:+1:0', '0123:0:0', '456:0:0'];
  h.sockets[0].emit('data', invalid.map(value => `custom>>aether-activity:${value}\n`).join(''));
  assert.deepEqual(h.activity, []);
  h.sockets[0].emit('data', 'custom>>aether-activity:123:-1000000:1000000\n');
  assert.deepEqual(h.activity, [{x:-1000000,y:1000000}]);
  h.watcher.stop();
});
