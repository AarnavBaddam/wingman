const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createClient } = require('../packages/macdotool/client');

// Fake daemon: records request lines, replies on demand, closes when killed.
function harness() {
  const h = { spawns: [], lines: [] };
  h.client = createClient({ binary: '/x/macdotool', spawn: (...args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.on('data', d => { for (const l of String(d).split('\n').filter(Boolean)) h.lines.push(JSON.parse(l)); });
    child.unrefd = false; child.unref = () => { child.unrefd = true; };
    child.kill = signal => { child.killed = signal; setImmediate(() => child.emit('close', null)); };
    h.spawns.push({ args, child }); h.child = child; return child;
  } });
  h.reply = obj => h.child.stdout.write(JSON.stringify(obj) + '\n');
  h.tick = () => new Promise(r => setTimeout(r, 5));
  return h;
}
const opts = extra => ({ timeout: 5000, maxBuffer: 1000, ...extra });

test('daemon client reuses one unref-ed daemon, keeps order, decodes base64 and sends input', async () => {
  const h = harness();
  const a = h.client.call('x', ['activewindow'], opts()), b = h.client.call('x', ['type', '--file', '-'], opts({ input: 'hi' }));
  await h.tick();
  assert.equal(h.spawns.length, 1);
  assert.deepEqual(h.spawns[0].args.slice(0, 2), ['/x/macdotool', ['serve']]);
  assert.equal(h.child.unrefd, true);
  assert.deepEqual(h.lines, [{ id: 1, argv: ['activewindow'] }, { id: 2, argv: ['type', '--file', '-'], input: 'hi' }]);
  h.reply({ id: 2, ok: true, out: Buffer.from('two').toString('base64') });
  h.reply({ id: 1, ok: true, out: Buffer.from('one').toString('base64') });
  assert.equal((await a).stdout.toString(), 'one');
  assert.equal((await b).stdout.toString(), 'two');
});

test('daemon client rejects error replies and oversize output', async () => {
  const h = harness();
  const a = h.client.call('x', ['click', '1'], opts());
  await h.tick();
  h.reply({ id: 1, ok: false, code: 2, error: 'bad click' });
  await assert.rejects(a, error => error.message === 'bad click' && error.code === 2);
  const b = h.client.call('x', ['capture'], opts({ maxBuffer: 3 }));
  await h.tick();
  h.reply({ id: 2, ok: true, out: Buffer.from('four').toString('base64') });
  await assert.rejects(b, /exceeded limit/);
  assert.equal(h.spawns.length, 1);
});

test('abort sends cancel and settles on the daemon reply without killing it', async () => {
  const h = harness(), controller = new AbortController();
  const a = h.client.call('x', ['type'], opts({ signal: controller.signal, input: 'abc' }));
  await h.tick();
  controller.abort();
  await h.tick();
  assert.deepEqual(h.lines.at(-1), { cancel: 1 });
  let settled = false; a.catch(() => {}).then(() => { settled = true; });
  await h.tick();
  assert.equal(settled, false);
  h.reply({ id: 1, ok: false, cancelled: true, error: 'cancelled' });
  await assert.rejects(a, { name: 'AbortError' });
  assert(!h.child.killed);
  await assert.rejects(h.client.call('x', ['debug'], opts({ signal: controller.signal })), { name: 'AbortError' });
});

test('abort without an acknowledgement kills the daemon and settles after close; next call respawns', async () => {
  const h = harness(), controller = new AbortController();
  const a = h.client.call('x', ['type'], opts({ signal: controller.signal }));
  await h.tick();
  const first = h.child;
  controller.abort();
  await assert.rejects(a, { name: 'AbortError' });
  assert.equal(first.killed, 'SIGKILL');
  const b = h.client.call('x', ['debug'], opts());
  await h.tick();
  assert.equal(h.spawns.length, 2);
  h.reply({ id: 2, ok: true, out: '' });
  assert.equal((await b).stdout.length, 0);
});

test('timeout cancels then kills a silent daemon', async () => {
  const h = harness();
  await assert.rejects(h.client.call('x', ['click', '1'], opts({ timeout: 20 })), /timed out/);
  assert.deepEqual(h.lines.at(-1), { cancel: 1 });
  assert.equal(h.child.killed, 'SIGKILL');
});

test('daemon death rejects every in-flight call, and the next call respawns', async () => {
  const h = harness();
  const a = h.client.call('x', ['clients'], opts()), b = h.client.call('x', ['cursorpos'], opts());
  await h.tick();
  h.child.emit('close', 1);
  await assert.rejects(a, /failed/); await assert.rejects(b, /failed/);
  const c = h.client.call('x', ['debug'], opts());
  await h.tick();
  assert.equal(h.spawns.length, 2);
  h.reply({ id: 3, ok: true, out: '' });
  await c;
});

test('a response over 80 MB or a malformed line is a protocol failure that kills the daemon', async () => {
  const h = harness();
  const a = h.client.call('x', ['capture'], opts());
  await h.tick();
  h.child.stdout.write('{"id":1,"ok":true,"out":"' + 'A'.repeat(81 * 1024 * 1024));
  await assert.rejects(a, /exceeded limit/);
  assert.equal(h.child.killed, 'SIGKILL');
  const b = h.client.call('x', ['debug'], opts());
  await h.tick();
  h.child.stdout.write('not json\n');
  await assert.rejects(b, /protocol/);
});
