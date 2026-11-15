const test = require('node:test');
const assert = require('node:assert/strict');
const { createHyprShortcut, combination } = require('../src/hypr-shortcut');

function harness() {
  const calls = [];
  const bindings = [];
  const shortcuts = ['Ctrl+Shift+Space', 'Alt+K'].map(key => ({ name: 'dev.prahladv.aether:ABCDEF-' + key }));
  function call(args) {
    calls.push(args);
    if (args[1] === 'binds') return JSON.stringify(bindings);
    if (args[1] === 'globalshortcuts') return JSON.stringify(shortcuts);
    return 'ok\n';
  }
  return { calls, bindings, shortcuts, helper: createHyprShortcut({ call: async args => call(args), callSync: call, pause: async () => {} }) };
}

test('Hyprland restore binds the portal action and replaces only its own keys', async () => {
  const h = harness();
  await h.helper.bind('CommandOrControl+Shift+Space');
  assert(h.calls.some(args => args[1].includes('hl.bind("CTRL + SHIFT + Space", hl.dsp.global("dev.prahladv.aether:ABCDEF-Ctrl+Shift+Space")')));
  h.bindings.push({ modmask: 5, key: 'Space', description: 'Aether: Show / hide' });
  await h.helper.bind('Alt+K');
  assert(h.calls.some(args => args[1] === 'hl.unbind("CTRL + SHIFT + Space")'));
  h.bindings.push({ modmask: 8, key: 'K', description: 'Aether: Show / hide' });
  h.helper.stop();
  assert.equal(h.calls.at(-1)[1], 'hl.unbind("ALT + K")');
});

test('Hyprland rejects existing desktop binds and unsupported keys without changing them', async () => {
  const h = harness();
  h.bindings.push({ modmask: 5, key: 'SPACE', description: 'User action' });
  await assert.rejects(h.helper.bind('CommandOrControl+Shift+Space'), /already bound/);
  assert(!h.calls.some(args => args[0] === 'eval'));
  assert.throws(() => combination('Alt+"; os.execute()'), /choose a letter/);
});

test('missing portal actions time out without creating a dead desktop binding', async () => {
  const h = harness();
  h.shortcuts.length = 0;
  await assert.rejects(h.helper.bind('Alt+K'), /Linux launcher/);
  assert(!h.calls.some(args => args[0] === 'eval'));
});

test('cleanup preserves a desktop binding added over the same keys', async () => {
  const h = harness();
  await h.helper.bind('Alt+K');
  h.bindings.push({ modmask: 8, key: 'K', description: 'User action' });
  h.helper.stop();
  assert(!h.calls.some(args => args[1].startsWith('hl.unbind')));
});

test('restart replaces stale Aether bindings instead of triggering twice', async () => {
  const h = harness();
  h.bindings.push({ modmask: 5, key: 'Space', description: 'Aether: Show / hide' });
  await h.helper.bind('CommandOrControl+Shift+Space');
  const edits = h.calls.filter(args => args[0] === 'eval');
  assert.equal(edits[0][1], 'hl.unbind("CTRL + SHIFT + Space")');
  assert(edits[1][1].startsWith('hl.bind('));
});
