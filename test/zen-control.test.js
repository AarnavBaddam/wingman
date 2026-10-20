const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const vm = require('node:vm');
const { createZenControl } = require('../src/zen-control');

function png(width = 800, height = 600) {
  const data = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(data);
  data.writeUInt32BE(13, 8); data.write('IHDR', 12); data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
  return data.toString('base64');
}
test('drag holds the pointer through scaled intermediate moves and releases it', async t => {
  const { control, commands } = await fixture(t);
  const target = await control.lockTarget('tab-a'); await control.capture(target);
  await control.execute(target, { type: 'drag', x: 100, y: 100, toX: 600, toY: 400 });
  const steps = commands.find(c => c.name === 'WebDriver:PerformActions').params.actions[0].actions;
  assert.deepEqual(steps[0], { type: 'pointerMove', origin: 'viewport', duration: 0, x: 50, y: 50 });
  assert.equal(steps[1].type, 'pointerDown');
  const moves = steps.slice(2).filter(a => a.type === 'pointerMove');
  assert.ok(moves.length >= 8);
  assert.equal(moves.at(-1).x, 300); assert.equal(moves.at(-1).y, 200);
  assert.notEqual(steps.at(-1).type, 'pointerUp');
  assert.deepEqual(commands.filter(c => c.name === 'WebDriver:PerformActions').at(-1).params.actions[0].actions, [
    { type: 'pointerMove', origin: 'viewport', duration: 40, x: 299, y: 200 },
    { type: 'pointerMove', origin: 'viewport', duration: 40, x: 300, y: 200 },
    { type: 'pointerUp', button: 0 }]);
  assert.equal(commands.at(-1).name, 'WebDriver:ReleaseActions');
  await assert.rejects(control.execute(target, { type: 'drag', x: 1, y: 1, toX: 2, toY: 2 }), /Capture/);
  await control.capture(target);
  await assert.rejects(control.execute(target, { type: 'drag', x: 1, y: 1, toX: 800, toY: 2 }), /outside/);
});
test('cancellation during drag drains the gesture and releases the held pointer', async t => {
  const aborter = new AbortController();
  const { control, commands } = await fixture(t, name => { if (name === 'WebDriver:PerformActions') aborter.abort(); });
  const target = await control.lockTarget('tab-a'); await control.capture(target);
  await assert.rejects(control.execute(target, { type: 'drag', x: 10, y: 10, toX: 200, toY: 200 }, aborter.signal), { name: 'AbortError' });
  assert.equal(commands.at(-1).name, 'WebDriver:ReleaseActions');
});
async function fixture(t, override = () => undefined, options = {}) {
  const commands = [], sockets = new Set(); let current = 'tab-a';
  const frame = value => { const json = JSON.stringify(value); return Buffer.from(`${Buffer.byteLength(json)}:${json}`); };
  const server = net.createServer(socket => {
    socket.setNoDelay(true);
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const greeting = frame({ applicationType: 'gecko', marionetteProtocol: 3 });
    socket.write(greeting.subarray(0, 3)); socket.write(greeting.subarray(3));
    let bytes = Buffer.alloc(0);
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      while (true) {
        const colon = bytes.indexOf(58); if (colon < 0) return;
        const length = Number(bytes.subarray(0, colon).toString()); if (bytes.length < colon + 1 + length) return;
        const packet = JSON.parse(bytes.subarray(colon + 1, colon + 1 + length)); bytes = bytes.subarray(colon + 1 + length);
        const [, id, name, params] = packet; commands.push({ name, params });
        const changed = override(name, params, commands);
        if (changed === 'hang') continue;
        let result = changed;
        if (result === undefined) {
          if (name === 'WebDriver:GetWindowHandles') result = ['tab-a', 'tab-b'];
          else if (name === 'WebDriver:SwitchToWindow') { current = params.handle; result = null; }
          else if (name === 'WebDriver:GetWindowHandle') result = current;
          else if (name === 'WebDriver:GetTitle') result = 'Form café';
          else if (name === 'WebDriver:GetCurrentURL') result = 'https://example.com/form';
          else if (name === 'WebDriver:ExecuteScript') result = params.sandbox === 'aether-drag' ? { handled: false } : params.sandbox === 'aether-drag-hover' ? { hovered: true } : params.args.length ? { scrolled: true } : { width: 400, height: 300, dpr: 2 };
          else if (name === 'WebDriver:TakeScreenshot') result = png();
          else result = {};
        }
        const response = frame([1, id, null, { value: result }]);
        // Deliberately split inside UTF-8 text and protocol delimiters.
        for (let offset = 0; offset < response.length; offset += 7) socket.write(response.subarray(offset, offset + 7));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const control = createZenControl({ port: server.address().port, timeoutMs: 500, ...options });
  t.after(async () => { await control.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await control.connect();
  return { control, commands };
}

test('lists current tabs through fragmented UTF-8 packets and switches without focus', async t => {
  const { control, commands } = await fixture(t);
  assert.deepEqual(await control.listTabs(), ['tab-a', 'tab-b'].map(id => ({ id, title: 'Form café', url: 'https://example.com/form' })));
  assert.ok(commands.filter(c => c.name === 'WebDriver:SwitchToWindow').every(c => c.params.focus === false));
  await control.close();
  assert.ok(!commands.some(c => /DeleteSession|Quit|CloseWindow/.test(c.name)));
});
test('requires a real target and fresh screenshot for each action and scales screenshot pixels', async t => {
  const { control, commands } = await fixture(t);
  const target = await control.lockTarget('tab-a');
  assert.ok(Object.isFrozen(target));
  await assert.rejects(control.execute(target, { type: 'click', x: 200, y: 100 }), /Capture/);
  assert.deepEqual(await control.capture(target), { imageDataUrl: `data:image/png;base64,${png()}`, width: 800, height: 600 });
  await control.execute(target, { type: 'click', x: 200, y: 100 });
  const pointer = commands.find(c => c.name === 'WebDriver:PerformActions').params.actions[0];
  assert.equal(pointer.actions[0].x, 100); assert.equal(pointer.actions[0].y, 50);
  assert.deepEqual(pointer.actions.slice(1).map(a => a.type), ['pointerDown', 'pointerUp']);
  await assert.rejects(control.execute(target, { type: 'click', x: 200, y: 100 }), /Capture/);
  await assert.rejects(control.lockTarget('missing'), /closed|available/i);
  await assert.rejects(control.capture({ ...target }), /Lock/);
});
test('rejects bounds, non-ASCII, changed geometry and stale targets without input', async t => {
  let resized = false, removed = false;
  const { control, commands } = await fixture(t, name => {
    if (removed && name === 'WebDriver:GetWindowHandles') return ['tab-b'];
    if (resized && name === 'WebDriver:ExecuteScript') return { width: 401, height: 300, dpr: 2 };
  });
  const target = await control.lockTarget('tab-a');
  await control.capture(target);
  await assert.rejects(control.execute(target, { type: 'click', x: 800, y: 0 }), /outside/);
  await control.capture(target);
  await assert.rejects(control.execute(target, { type: 'type', text: 'a\n' }), /ASCII/);
  await control.capture(target); resized = true;
  await assert.rejects(control.execute(target, { type: 'click', x: 10, y: 10 }), /changed/);
  resized = false; removed = true;
  await assert.rejects(control.capture(target), /closed/);
  assert.equal(commands.filter(c => c.name === 'WebDriver:PerformActions').length, 0);
});
test('types printable text using paired keys and scrolls at bounded CSS coordinates', async t => {
  const { control, commands } = await fixture(t); const target = await control.lockTarget('tab-a');
  await control.capture(target); await control.execute(target, { type: 'type', text: 'Hi!' });
  await control.capture(target); await control.execute(target, { type: 'scroll', x: 100, y: 100, amount: -2 });
  const actions = commands.filter(c => c.name === 'WebDriver:PerformActions').map(c => c.params.actions[0]);
  assert.deepEqual(actions[0].actions.map(a => a.type), ['keyDown', 'keyUp', 'keyDown', 'keyUp', 'keyDown', 'keyUp']);
  const scroll = commands.find(c => c.name === 'WebDriver:ExecuteScript' && c.params.args.length);
  assert.deepEqual(scroll.params.args, [50, 50, -240]);
  assert.equal(commands.filter(c => c.name === 'WebDriver:ReleaseActions').length, 1);
  assert.deepEqual(commands.at(-1), { name: 'WebDriver:SwitchToFrame', params: { id: null } });
});
test('HTML drag uses bounded fixed script through frames and resets context without duplicate native input', async t => {
  let depth = 0;
  const frame = { 'element-6066-11e4-a52e-4f735466cecf': 'frame-a' };
  const { control, commands } = await fixture(t, (name, params) => {
    if (name === 'WebDriver:ExecuteScript' && params.sandbox === 'aether-drag') return depth++ === 0 ? { frame, x: 20, y: 30, toX: 100, toY: 150 } : { handled: true };
  });
  const target = await control.lockTarget('tab-a'); await control.capture(target);
  await control.execute(target, { type: 'drag', x: 100, y: 100, toX: 500, toY: 400 });
  assert.deepEqual(commands.filter(c => c.name === 'WebDriver:SwitchToFrame').map(c => c.params), [{ element: frame }, { id: null }]);
  assert.deepEqual(commands.filter(c => c.params.sandbox === 'aether-drag').map(c => c.params.args), [[50, 50, 250, 200], [20, 30, 100, 150]]);
  assert.equal(commands.filter(c => c.name === 'WebDriver:PerformActions').length, 0);
});
test('draggable attribute does not swallow mouse widgets that reject HTML drop', async t => {
  for (const acceptsHTML of [false, true]) {
    const events = [];
    const source = { draggable: true, dispatchEvent: e => { events.push(e.type); return true; } };
    const destination = { dispatchEvent: e => { events.push(e.type); return !(acceptsHTML && e.type === 'dragover'); } };
    const { control, commands } = await fixture(t, (name, params) => {
      if (name !== 'WebDriver:ExecuteScript' || params.sandbox !== 'aether-drag') return;
      return vm.runInNewContext('(function(){' + params.script + '}).apply(null, points)', {
        points: params.args, innerWidth: 400, innerHeight: 300,
        document: { elementFromPoint: x => x < 100 ? source : destination },
        DataTransfer: class {}, DragEvent: class { constructor(type, init) { Object.assign(this, { type }, init); } }
      });
    });
    const target = await control.lockTarget('tab-a'); await control.capture(target);
    await control.execute(target, { type: 'drag', x: 100, y: 100, toX: 500, toY: 400 });
    assert.equal(commands.filter(c => c.name === 'WebDriver:PerformActions').length, acceptsHTML ? 0 : 2);
    assert.equal(events.includes('drop'), acceptsHTML);
    assert.ok(events.includes('dragend'));
  }
});
test('abort drains the in-flight command and releases input before rejecting', async t => {
  const aborter = new AbortController();
  const { control, commands } = await fixture(t, name => { if (name === 'WebDriver:PerformActions') aborter.abort(); });
  const target = await control.lockTarget('tab-a'); await control.capture(target);
  await assert.rejects(control.execute(target, { type: 'type', text: '1234567890123456' }, aborter.signal), { name: 'AbortError' });
  assert.equal(commands.filter(c => c.name === 'WebDriver:PerformActions').length, 1);
  assert.equal(commands.at(-1).name, 'WebDriver:ReleaseActions');
});
test('bounded command timeout closes connection and prevents queued late input', async t => {
  const { control } = await fixture(t, name => name === 'WebDriver:GetWindowHandles' ? 'hang' : undefined, { timeoutMs: 40 });
  await assert.rejects(control.listTabs(), /timed out/);
  await assert.rejects(control.lockTarget('tab-a'), /connect/i);
});
test('rejects mismatched screenshot geometry and abort before work', async t => {
  const { control } = await fixture(t, name => name === 'WebDriver:TakeScreenshot' ? png(801, 600) : undefined);
  const target = await control.lockTarget('tab-a');
  await assert.rejects(control.capture(target), /dimensions/);
  await assert.rejects(control.execute(target, { type: 'click', x: 1, y: 1 }), /Capture/);
  await assert.rejects(control.listTabs(AbortSignal.abort()), { name: 'AbortError' });
});
test('input timeout reports cleanup uncertainty and never sends another text chunk', async t => {
  const { control, commands } = await fixture(t, name => name === 'WebDriver:PerformActions' ? 'hang' : undefined, { timeoutMs: 50 });
  const target = await control.lockTarget('tab-a'); await control.capture(target);
  await assert.rejects(control.execute(target, { type: 'type', text: '1234567890123456' }), { code: 'INPUT_CLEANUP' });
  assert.equal(commands.filter(c => c.name === 'WebDriver:PerformActions').length, 1);
});
test('already aborted input consumes authorization without sending native events', async t => {
  const { control, commands } = await fixture(t); const target = await control.lockTarget('tab-a'); await control.capture(target);
  await assert.rejects(control.execute(target, { type: 'click', x: 1, y: 1 }, AbortSignal.abort()), { name: 'AbortError' });
  await assert.rejects(control.execute(target, { type: 'click', x: 1, y: 1 }), /Capture/);
  assert.equal(commands.filter(c => c.name === 'WebDriver:PerformActions').length, 0);
});
test('scroll traverses iframe references and always restores top frame', async t => {
  let depth = 0;
  const frame = { 'element-6066-11e4-a52e-4f735466cecf': 'frame-a' };
  const { control, commands } = await fixture(t, (name, params) => {
    if (name === 'WebDriver:ExecuteScript' && params.args.length) return depth++ === 0 ? { frame, x: 20, y: 30 } : { scrolled: true };
  });
  const target = await control.lockTarget('tab-a'); await control.capture(target);
  await control.execute(target, { type: 'scroll', x: 100, y: 100, amount: 2 });
  assert.deepEqual(commands.filter(c => c.name === 'WebDriver:SwitchToFrame').map(c => c.params), [{ element: frame }, { id: null }]);
  assert.deepEqual(commands.filter(c => c.name === 'WebDriver:ExecuteScript' && c.params.args.length).map(c => c.params.args), [[50, 50, 240], [20, 30, 240]]);
});
test('excessive iframe depth fails with top context restored and consumed image', async t => {
  const { control, commands } = await fixture(t, (name, params) => name === 'WebDriver:ExecuteScript' && params.args.length ? { frame: { 'element-6066-11e4-a52e-4f735466cecf': 'frame' }, x: 1, y: 1 } : undefined);
  const target = await control.lockTarget('tab-a'); await control.capture(target);
  await assert.rejects(control.execute(target, { type: 'scroll', x: 1, y: 1, amount: 1 }), /depth/);
  assert.deepEqual(commands.at(-1), { name: 'WebDriver:SwitchToFrame', params: { id: null } });
  await assert.rejects(control.execute(target, { type: 'scroll', x: 1, y: 1, amount: 1 }), /Capture/);
});
test('can disconnect and immediately reconnect the same client without stale socket events', async t => {
  const { control } = await fixture(t);
  await control.close(); await control.connect();
  assert.equal((await control.listTabs()).length, 2);
});
test('fractional DPR matches canvas integer truncation without shifting click coordinates', async t => {
  const { control, commands } = await fixture(t, name => {
    if (name === 'WebDriver:ExecuteScript') return { width: 101, height: 101, dpr: 1.5 };
    if (name === 'WebDriver:TakeScreenshot') return png(151, 151);
  });
  const target = await control.lockTarget('tab-a'); assert.equal(target.width, 151);
  await control.capture(target); await control.execute(target, { type: 'click', x: 150, y: 150 });
  const move = commands.find(c => c.name === 'WebDriver:PerformActions').params.actions[0].actions[0];
  assert.equal(move.x, 100); assert.equal(move.y, 100);
});
test('scrollbar-trimmed screenshots are accepted and bound coordinates by the real image', async t => {
  const { control } = await fixture(t, name => name === 'WebDriver:TakeScreenshot' ? png(770, 600) : undefined);
  const target = await control.lockTarget('tab-a');
  const screen = await control.capture(target);
  assert.equal(screen.width, 770); assert.equal(screen.height, 600);
  await assert.rejects(control.execute(target, { type: 'click', x: 780, y: 10 }), /outside/);
  await control.capture(target); await control.execute(target, { type: 'click', x: 769, y: 10 });
});
test('screenshots far smaller than the viewport are still rejected', async t => {
  const { control } = await fixture(t, name => name === 'WebDriver:TakeScreenshot' ? png(700, 600) : undefined);
  await assert.rejects(control.capture(await control.lockTarget('tab-a')), /dimensions/);
});
test('fractional desktop scaling with 1x screenshots maps clicks by the real image scale', async t => {
  const { control, commands } = await fixture(t, name => {
    if (name === 'WebDriver:ExecuteScript') return { width: 1463, height: 756, dpr: 1.3043478260869565 };
    if (name === 'WebDriver:TakeScreenshot') return png(1463, 756);
  });
  const target = await control.lockTarget('tab-a');
  assert.deepEqual((({ width, height }) => ({ width, height }))(await control.capture(target)), { width: 1463, height: 756 });
  await control.execute(target, { type: 'click', x: 1000, y: 500 });
  const move = commands.find(c => c.name === 'WebDriver:PerformActions').params.actions[0].actions[0];
  assert.equal(move.x, 1000); assert.equal(move.y, 500);
});
test('double click sends two press/release pairs at one point', async t => {
  const { control, commands } = await fixture(t, name => {
    if (name === 'WebDriver:ExecuteScript') return { width: 800, height: 600, dpr: 1 };
    if (name === 'WebDriver:TakeScreenshot') return png(800, 600);
  });
  const target = await control.lockTarget('tab-a'); await control.capture(target);
  await control.execute(target, { type: 'click', x: 100, y: 200, clicks: 2 });
  const actions = commands.find(c => c.name === 'WebDriver:PerformActions').params.actions[0].actions;
  assert.deepEqual(actions.map(a => a.type), ['pointerMove', 'pointerDown', 'pointerUp', 'pointerDown', 'pointerUp']);
});
