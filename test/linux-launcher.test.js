const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installLauncher } = require('../scripts/install-linux');

test('Linux launcher registers the portal identity and preserves quoted AppImage paths', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-launcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = path.join(root, 'Aether $value "quoted" 100%.AppImage');
  fs.writeFileSync(image, '', { mode: 0o755 });
  const launcher = installLauncher(image, path.join(root, 'data'));
  assert.equal(path.basename(launcher), 'dev.prahladv.aether.desktop');
  const entry = fs.readFileSync(launcher, 'utf8');
  // Decode the desktop-entry string layer before checking Exec quoting.
  const exec = entry.split('\n').find(line => line.startsWith('Exec=')).slice(5).replace(/\\\\/g, '\\');
  assert.equal(exec, '"' + image.replace(/([\\`"$])/g, '\\$1').replace(/%/g, '%%') + '"');
  assert.match(entry, /StartupWMClass=dev\.prahladv\.aether/);
  assert(!entry.includes('sh -c'));
  assert.throws(() => installLauncher(path.join(root, 'missing'), root));
});
