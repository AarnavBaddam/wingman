const test = require('node:test'), assert = require('node:assert/strict');
const { createAutoSession } = require('../src/auto-session');
function setup(over = {}) {
  const updates = [], requests = []; let cleanup = 0, ended = 0, captured = 0, stop;
  const manager = createAutoSession({ getSettings: () => ({ provider: 'codex-cli', codexSeparateAccount: true, resumeContext: 'PRIVATE PROFILE' }),
    getCodexHome: () => '/separate-profile',
    createLLM: settings => { assert.equal(settings.codexHome, '/separate-profile'); return { ready: true, stream: async args => { requests.push(args); return '{"type":"done","message":"Review draft."}'; } }; },
    createDesktopControl: () => ({ lockTarget: async () => ({ id: 1 }), capture: async () => { captured++; return { imageDataUrl: 'image', width: 100, height: 100 }; }, execute: async () => {} }),
    createStopWatcher: ({ onStop }) => { stop = onStop; return { start: async () => {}, stop: () => cleanup++ }; },
    research: async () => [], countdownMs: 0, onUpdate: update => updates.push(update), onEnd: () => ended++, ...over });
  return { manager, updates, requests, escape: () => stop('Escape pressed.'), get cleanup() { return cleanup; }, get ended() { return ended; }, get captured() { return captured; } };
}
test('session locks a target, uses isolated provider and leaves private profile out of decisions', async () => {
  const h = setup(); h.manager.start('Draft form'); await h.manager.completion;
  assert.equal(h.captured, 1); assert.equal(h.cleanup, 1); assert.equal(h.ended, 1);
  assert(!JSON.stringify(h.requests).includes('PRIVATE PROFILE'));
  assert.equal(h.updates.at(-1).active, false); assert.equal(h.updates.at(-1).status, 'done');
});
test('Escape cancels countdown before capture and prevents overlapping sessions', async () => {
  const h = setup({ countdownMs: 5000 }); h.manager.start('Draft');
  assert.throws(() => h.manager.start('Other'), /already running/);
  h.escape(); await h.manager.completion;
  assert.equal(h.captured, 0); assert.equal(h.cleanup, 1);
  assert.equal(h.updates.at(-1).message, 'Escape pressed.');
});
test('failed key registration fails closed and clears the session', async () => {
  const h = setup({ createStopWatcher: () => ({ start: async () => { throw Error('Escape unavailable'); }, stop() {} }) });
  h.manager.start('Draft'); await h.manager.completion;
  assert.equal(h.captured, 0); assert.equal(h.manager.active, false);
  assert.match(h.manager.status.message, /Escape unavailable/); assert.equal(h.ended, 1);
});
test('stopping during a provider response discards the late decision', async () => {
  let release, executed = 0;
  const h = setup({ createLLM: () => ({ ready: true, stream: () => new Promise(resolve => release = resolve) }),
    createDesktopControl: () => ({ lockTarget: async () => ({}), capture: async () => ({ imageDataUrl: 'image', width: 100, height: 100 }), execute: async () => executed++ }) });
  h.manager.start('Draft');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  h.manager.stop(); await h.manager.completion;
  release('{"type":"click","x":5,"y":5,"label":"Option","intent":"select"}');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(executed, 0); assert.equal(h.manager.status.status, 'stopped');
});
test('session remains active until cancelled input teardown drains', async () => {
  let release, executeStarted = false;
  const h = setup({ createLLM: () => ({ ready: true, stream: async () => '{"type":"click","x":5,"y":5,"label":"Option","intent":"select"}' }),
    createDesktopControl: () => ({ lockTarget: async () => ({}), capture: async () => ({ imageDataUrl: 'image', width: 100, height: 100 }), execute: () => { executeStarted = true; return new Promise(resolve => release = resolve); } }) });
  h.manager.start('Draft');
  while (!executeStarted) await new Promise(resolve => setImmediate(resolve));
  h.manager.stop(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.manager.active, true); assert.equal(h.ended, 0);
  release(); await h.manager.completion;
  assert.equal(h.manager.active, false); assert.equal(h.ended, 1);
});
