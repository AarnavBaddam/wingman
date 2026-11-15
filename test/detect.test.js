'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDetector } = require('../src/detect');

// Stub "python" (/bin/sh) that echoes a JSON verdict.
function stub(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-dt-stub-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'aether_detect.py'), body);
  return dir;
}

test('parses the detector JSON verdict', async () => {
  const dir = stub('echo \'{"aiScore":21.7,"factScore":0.95,"zerogpt":null,"pass":true,"detail":"local 21.7 pct"}\'\n');
  const { detect } = createDetector({ pythonPath: '/bin/sh', scriptDir: dir, inksplashDir: '/x' });
  const r = await detect('some text', {}, new AbortController().signal);
  assert.strictEqual(r.aiScore, 21.7);
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.factScore, 0.95);
});

test('passes --source and --zerogpt flags through', async () => {
  // Stub echoes its own argument list so we can assert flag wiring.
  const dir = stub('printf \'{"aiScore":%s}\' "$(echo "$@" | grep -c source)"\n');
  const { detect } = createDetector({ pythonPath: '/bin/sh', scriptDir: dir, inksplashDir: '/x' });
  const r = await detect('t', { source: 'the source', zerogpt: true }, new AbortController().signal);
  assert.strictEqual(r.aiScore, 1, '--source was present in args');
});

test('rejects on detector error payload', async () => {
  const dir = stub('printf \'{"error":"InkSplash dir not found"}\'\nexit 2\n');
  const { detect } = createDetector({ pythonPath: '/bin/sh', scriptDir: dir, inksplashDir: '/x' });
  await assert.rejects(() => detect('t', {}, new AbortController().signal), /InkSplash dir not found/);
});

test('abort kills and rejects', async () => {
  const dir = stub('sleep 5\nprintf \'{"aiScore":0}\'\n');
  const { detect } = createDetector({ pythonPath: '/bin/sh', scriptDir: dir, inksplashDir: '/x' });
  const ctrl = new AbortController();
  const p = detect('t', {}, ctrl.signal);
  setTimeout(() => ctrl.abort(), 60);
  await assert.rejects(() => p, /Write stopped/);
});
