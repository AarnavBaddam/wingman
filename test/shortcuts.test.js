const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8');

function harness() {
  const bindings = new Map();
  const saved = [];
  let failSave = false;
  const context = vm.createContext({
    registeredShortcuts: {}, hyprShortcut: null, toggleBindingError: null, DEFAULT_ASSIST_SHORTCUT: 'CommandOrControl+Return',
    DEFAULT_TOGGLE_SHORTCUT: 'CommandOrControl+Shift+Space',
    RESERVED_SHORTCUTS: new Set(['commandorcontrol+h', 'commandorcontrol+shift+x']),
    globalShortcut: {
      register(key, callback) { if (bindings.has(key)) return false; bindings.set(key, callback); return true; },
      unregister: key => bindings.delete(key)
    },
    store: { getSettings: () => ({ shortcuts: { assist: 'CommandOrControl+Shift+Space', toggle: 'CommandOrControl+Shift+Space' } }), setSettings(patch) { if (failSave) throw Error('disk unavailable'); saved.push(patch); } },
    log() {}, console: { error() {} }, app: { quit() {} }, runFeature() {}, toggleWindow() {}
  });
  vm.runInContext(source.slice(source.indexOf('function normalizeShortcut'), source.indexOf('// -------- lifecycle')), context);
  return { context, bindings, saved, set failSave(value) { failSave = value; } };
}

test('Show/hide changes its live binding and saves independently of Assist', () => {
  const h = harness();
  h.context.registerShortcut('assist', 'CommandOrControl+Return');
  h.context.registerShortcut('toggle', 'CommandOrControl+Shift+Space');
  assert.equal(h.context.setShortcut('toggle', 'Alt+Space').ok, true);
  assert(h.bindings.has('Alt+Space'));
  assert(h.bindings.has('CommandOrControl+Return'));
  assert(!h.bindings.has('CommandOrControl+Shift+Space'));
  assert.equal(h.saved[0].shortcuts.toggle, 'Alt+Space');
});

test('conflicts leave the previous Show/hide binding usable', () => {
  const h = harness();
  h.context.registerShortcut('toggle', 'Alt+Space');
  h.context.registerShortcut('assist', 'CommandOrControl+Return');
  for (const key of ['CommandOrControl+Return', 'CommandOrControl+H']) {
    assert.equal(h.context.setShortcut('toggle', key).ok, false);
    assert(h.bindings.has('Alt+Space'));
  }
  h.bindings.set('Alt+T', () => {});
  assert.equal(h.context.setShortcut('toggle', 'Alt+T').ok, false);
  assert(h.bindings.has('Alt+Space'));
});

test('failed persistence restores the previous binding for either action', () => {
  for (const action of ['assist', 'toggle']) {
    const h = harness();
    h.context.registerShortcut(action, 'Alt+Space');
    h.failSave = true;
    assert.equal(h.context.setShortcut(action, 'Alt+T').ok, false);
    assert(h.bindings.has('Alt+Space'));
    assert(!h.bindings.has('Alt+T'));
  }
});

test('startup conflict does not advertise a registered Show/hide binding', () => {
  const h = harness();
  h.context.registerShortcuts();
  assert.equal(h.context.registeredShortcuts.toggle, undefined);
  assert.equal(h.context.registeredShortcuts.assist, 'CommandOrControl+Shift+Space');
});

test('failed Hyprland binding preserves the previous registered and saved shortcut', async () => {
  const h = harness();
  h.context.registerShortcut('toggle', 'Alt+Space');
  h.context.hyprShortcut = { async bind(key) { if (key === 'Alt+K') throw Error('desktop conflict'); } };
  assert.equal((await h.context.setToggleShortcut('Alt+K')).ok, false);
  assert(h.bindings.has('Alt+Space'));
  assert(!h.bindings.has('Alt+K'));
  assert.equal(h.saved.length, 0);
});

test('failed save rolls back both Electron and the Hyprland binding', async () => {
  const h = harness();
  const nativeKeys = [];
  h.context.registerShortcut('toggle', 'Alt+Space');
  h.context.hyprShortcut = { async bind(key) { nativeKeys.push(key); } };
  h.failSave = true;
  assert.equal((await h.context.setToggleShortcut('Alt+K')).ok, false);
  assert.deepEqual(nativeKeys, ['Alt+K', 'Alt+Space']);
  assert(h.bindings.has('Alt+Space'));
});

test('startup registration conflict can recover with a new Hyprland shortcut', async () => {
  const h = harness();
  const nativeKeys = [];
  h.context.process = { platform: 'linux', env: { HYPRLAND_INSTANCE_SIGNATURE: 'test' } };
  h.context.require = () => ({ createHyprShortcut: () => ({ async bind(key) { nativeKeys.push(key); } }) });
  h.context.initializeHyprShortcut();
  assert.equal((await h.context.setToggleShortcut('Alt+K')).ok, true);
  assert.deepEqual(nativeKeys, ['Alt+K']);
});

test('failed first shortcut save removes the new native binding', async () => {
  const h = harness();
  let stopped = false;
  h.context.hyprShortcut = { async bind() {}, stop() { stopped = true; } };
  h.failSave = true;
  assert.equal((await h.context.setToggleShortcut('Alt+K')).ok, false);
  assert.equal(stopped, true);
  assert.equal(h.context.registeredShortcuts.toggle, undefined);
});
