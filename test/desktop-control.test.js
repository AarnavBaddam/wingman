const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopControl } = require('../src/desktop-control');

function png(width = 800, height = 600) {
  const buffer = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer);
  buffer.writeUInt32BE(13, 8); buffer.write('IHDR', 12);
  buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20);
  return buffer;
}
function harness() {
  const h = { calls: [], window: { address: '0x123abc', pid: 42, class: 'editor', mapped: true, at: [-900, 50], size: [800, 600] }, clients: [], image: png(), after: null };
  h.control = createDesktopControl({ pid: 99, env: { XDG_RUNTIME_DIR: '/run/user/1000' }, call: async (command, args, options) => {
    h.calls.push({ command, args, options });
    const stdout = command === 'grim' ? h.image : args[1] === 'activewindow' ? JSON.stringify(h.window) : args[1] === 'clients' ? JSON.stringify(h.clients) : 'ok';
    if (h.after) h.after(command, args);
    return { stdout };
  } });
  h.ready = async () => { h.target = await h.control.lockTarget(); await h.control.capture(h.target); return h.target; };
  return h;
}
test('locks immutable exact identity; captures binary scale-one window geometry', async () => {
  const h = harness(); const t = await h.ready();
  assert(Object.isFrozen(t)); assert(Object.isFrozen(t.at));
  const capture = h.calls.find(c => c.command === 'grim');
  assert.deepEqual(capture.args, ['-s', '1', '-g', '-900,50 800x600', '-t', 'png', '-']);
  assert.equal(capture.options.encoding, 'buffer'); assert.equal(capture.options.timeout, 10000);
  assert.equal(capture.options.maxBuffer, 40 * 1024 * 1024);
  assert.deepEqual(await h.control.capture(t), { imageDataUrl: 'data:image/png;base64,' + png().toString('base64'), width: 800, height: 600 });
});
test('rejects own, unmapped and malformed target windows', async () => {
  for (const patch of [{ class: 'dev.prahladv.aether' }, { class: 'Aether' }, { pid: 99 }, { mapped: false }, { address: '0x0' }, { address: '0x123;evil' }, { size: [0, 600] }, { at: [1.5, 2] }]) {
    const h = harness(); Object.assign(h.window, patch);
    await assert.rejects(h.control.lockTarget()); assert.equal(h.calls.length, 1);
  }
});
test('focus and geometry changes during capture invalidate image; PNG scaling mismatch blocks input', async () => {
  for (const patch of [{ pid: 43 }, { address: '0xabc' }, { class: 'other' }, { at: [0, 0] }, { size: [801, 600] }]) {
    const h = harness(); const t = await h.control.lockTarget();
    h.after = cmd => { if (cmd === 'grim') Object.assign(h.window, patch); };
    await assert.rejects(h.control.capture(t), /changed/);
    await assert.rejects(h.control.execute(t, { type: 'click', x: 1, y: 1 }), /Capture/);
  }
  const h = harness(); const t = await h.control.lockTarget(); h.image = png(1600, 1200);
  await assert.rejects(h.control.capture(t), /dimensions/);
  await assert.rejects(h.control.execute(t, { type: 'click', x: 1, y: 1 }), /Capture/);
});
test('click maps local pixels to global logical coordinates and scroll positive means down', async () => {
  const h = harness(); const t = await h.ready();
  await h.control.execute(t, { type: 'click', x: 10.4, y: 20.6 });
  assert.deepEqual(h.calls.find(c => c.args[0] === 'eval').args, ['eval', 'hl.dispatch(hl.dsp.cursor.move({x=-890,y=71}))']);
  assert.deepEqual(h.calls.find(c => c.command === 'ydotool').args, ['click', '0xC0']);
  await h.control.capture(t);
  await h.control.execute(t, { type: 'scroll', x: 799.9, y: 599.9, amount: 3 });
  assert.deepEqual(h.calls.at(-1).args, ['mousemove', '-w', '-x', '0', '-y', '-3']);
  assert(h.calls.some(c => c.args[1] === 'hl.dispatch(hl.dsp.cursor.move({x=-101,y=649}))'));
  assert.equal(h.calls.at(-1).options.env.YDOTOOL_SOCKET, '/run/user/1000/.ydotool_socket');
});
test('focus loss after cursor motion prevents click and type never focuses a window', async () => {
  const h = harness(); const t = await h.ready();
  h.after = (cmd, args) => { if (args[0] === 'eval') h.window.pid = 43; };
  await assert.rejects(h.control.execute(t, { type: 'click', x: 1, y: 1 }), /changed/);
  assert(!h.calls.some(c => c.command === 'ydotool'));
  await assert.rejects(h.control.execute(t, { type: 'type', text: 'hello' }), /Capture/);
  assert(!h.calls.some(c => c.command === 'ydotool'));
});
test('refuses clicks and scrolling beneath Aether, including overlay appearing after cursor move', async () => {
  for (const later of [false, true]) {
    const h = harness(); const t = await h.ready();
    const overlay = { class: 'dev.prahladv.aether', mapped: true, at: [-900, 50], size: [20, 20] };
    if (later) h.after = (cmd, args) => { if (args[0] === 'eval') h.clients = [overlay]; }; else h.clients = [overlay];
    await assert.rejects(h.control.execute(t, { type: 'scroll', x: 1, y: 1, amount: 1 }), /Move Aether/);
    assert(!h.calls.some(c => c.command === 'ydotool'));
  }
});
test('cancellation after capture or cursor movement prevents every subsequent input', async () => {
  for (const stage of ['grim', 'eval']) {
    const h = harness(); const abort = new AbortController(); const t = await h.control.lockTarget();
    if (stage === 'eval') await h.control.capture(t);
    h.after = (cmd, args) => { if (cmd === stage || args[0] === stage) abort.abort(); };
    await assert.rejects(stage === 'grim' ? h.control.capture(t, abort.signal) : h.control.execute(t, { type: 'click', x: 1, y: 1 }, abort.signal), { name: 'AbortError' });
    assert(!h.calls.some(c => c.command === 'ydotool'));
    const count = h.calls.length;
    await assert.rejects(h.control.execute(t, { type: 'type', text: 'hello' }, abort.signal), { name: 'AbortError' });
    assert.equal(h.calls.length, count);
  }
});
test('typing sends printable text only through stdin with fixed argv, including shell-looking strings', async () => {
  const h = harness(); const t = await h.ready(); const text = '--file /etc/passwd; $(touch /tmp/evil) `date`';
  await h.control.execute(t, { type: 'type', text });
  const typed = h.calls.filter(c => c.command === 'ydotool');
  assert.equal(typed.map(c => c.options.input).join(''), text);
  assert(typed.every(c => c.options.input.length <= 8));
  const c = typed[0]; assert.equal(c.command, 'ydotool');
  assert.deepEqual(c.args, ['type', '--key-delay', '2', '--key-hold', '2', '--file', '-']); assert.equal(c.options.input, text.slice(0, 8));
  for (const value of ['', '\n', 'a\tb', 'hello\r', '\x1b', 'é', '\x7f', 'x'.repeat(1001), 5]) {
    await h.control.capture(t);
    await assert.rejects(h.control.execute(t, { type: 'type', text: value }), /ASCII/);
  }
});
test('rejects invalid coordinates, scroll amounts and extra input capabilities before helpers', async () => {
  const h = harness(); const t = await h.ready();
  for (const action of [{ type: 'key', text: 'Enter' }, { type: 'click', x: NaN, y: 0 }, { type: 'click', x: '1', y: 0 }, { type: 'click', x: 800, y: 0 }, { type: 'click', x: -1, y: 0 }, { type: 'scroll', x: 0, y: 0, amount: 1.5 }, { type: 'scroll', x: 0, y: 0, amount: 0 }, { type: 'scroll', x: 0, y: 0, amount: 6 }, { type: 'scroll', x: 0, y: 0, amount: '1;evil' }]) {
    await h.control.capture(t);
    const count = h.calls.length;
    await assert.rejects(h.control.execute(t, action));
    assert.equal(h.calls.length, count);
  }
});

test('each captured image authorizes only one action', async () => {
  const h = harness(); const t = await h.ready();
  await h.control.execute(t, { type: 'type', text: 'hello' });
  const count = h.calls.length;
  await assert.rejects(h.control.execute(t, { type: 'click', x: 0, y: 0 }), /Capture/);
  assert.equal(h.calls.length, count);
  await h.control.capture(t);
  await h.control.execute(t, { type: 'type', text: 'again' });
});
test('focus loss after the first type chunk prevents sending the remaining text', async () => {
  const h = harness(); const t = await h.ready();
  h.after = command => { if (command === 'ydotool') h.window.pid = 43; };
  await assert.rejects(h.control.execute(t, { type: 'type', text: 'abcdefghmore text never sent' }), /changed/);
  const typed = h.calls.filter(c => c.command === 'ydotool' && c.args[0] === 'type');
  assert.equal(typed.length, 1); assert.equal(typed[0].options.input, 'abcdefgh');
  await assert.rejects(h.control.execute(t, { type: 'type', text: 'retry' }), /Capture/);
});

test('aborted typing or mouse input releases virtual state on the same socket without further text', async () => {
  for (const type of ['type', 'click']) {
    const h = harness(); const t = await h.ready(); const controller = new AbortController();
    h.after = (command, args) => {
      if (command === 'ydotool' && (args[0] === 'type' || args[1] === '0xC0')) controller.abort();
    };
    const action = type === 'type' ? { type, text: 'abcdefghremaining' } : { type, x: 1, y: 1 };
    await assert.rejects(h.control.execute(t, action, controller.signal), { name: 'AbortError' });
    const input = h.calls.filter(c => c.command === 'ydotool');
    assert.equal(input.length, 3);
    assert.deepEqual(input[1].args, ['click', '0x80']);
    assert.deepEqual(input[2].args, ['key', '--key-delay', '0', ...Array.from({ length: 127 }, (_, i) => `${i + 1}:0`)]);
    for (const cleanup of input.slice(1)) {
      assert.equal(cleanup.options.signal, undefined);
      assert.equal(cleanup.options.timeout, 750);
      assert.equal(cleanup.options.env.YDOTOOL_SOCKET, input[0].options.env.YDOTOOL_SOCKET);
    }
    if (type === 'type') assert.equal(input[0].options.input, 'abcdefgh');
  }
});
test('input failure still attempts both releases and reports actionable cleanup failure', async () => {
  const h = harness(); const t = await h.ready();
  h.after = command => { if (command === 'ydotool') throw Error('socket unavailable'); };
  await assert.rejects(h.control.execute(t, { type: 'type', text: 'hello' }), error => error.code === 'INPUT_CLEANUP' && /virtual key\/button release failed.*ydotool/.test(error.message));
  assert.deepEqual(h.calls.filter(c => c.command === 'ydotool').map(c => c.args[0]), ['type', 'click', 'key']);
});
test('subprocess abort waits for actual child close before rejection', async () => {
  const { EventEmitter } = require('node:events');
  const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
  let child, spawnOptions;
  const fakeSpawn = (command, args, options) => {
    spawnOptions = options; child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = { resume() {} };
    child.stdin = new EventEmitter(); child.stdin.end = () => {};
    child.kill = () => {};
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted'); error.name = 'AbortError'; child.emit('error', error);
    });
    return child;
  };
  const context = { module: { exports: {} }, require: name => name === 'node:child_process' ? { spawn: fakeSpawn } : require(name), Buffer, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/desktop-control.js'), 'utf8') + '\nmodule.exports.run = run;', context);
  const controller = new AbortController(); let settled = false;
  const pending = context.module.exports.run('ydotool', ['type'], { signal: controller.signal, timeout: 1000, maxBuffer: 1000 }).finally(() => { settled = true; });
  controller.abort(); await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false); assert.equal(spawnOptions.killSignal, 'SIGKILL'); assert.equal(spawnOptions.shell, false);
  child.emit('close', null);
  await assert.rejects(pending, { name: 'AbortError' });
});
