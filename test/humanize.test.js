'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHumanizer, CONFIG_C_ENV } = require('../src/humanize');

// A stub "python" (really /bin/sh) that uppercases input and prefixes the
// HUMANIZE_MODE env, so we can assert Config C env propagated and output is read.
function stubDir(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-hz-stub-'));
  fs.writeFileSync(path.join(dir, 'humanize_cli.py'), body);
  return dir;
}

test('Config C env is set', () => {
  assert.strictEqual(CONFIG_C_ENV.HUMANIZE_MODE, 'stealth');
  assert.strictEqual(CONFIG_C_ENV.HUMANIZE_STEALTH_ENGINE, 'rule');
});

test('runs the subprocess, passes Config C env, returns transformed text', async () => {
  const dir = stubDir('printf "%s:" "$HUMANIZE_MODE" > "$2"\ntr a-z A-Z < "$1" >> "$2"\n');
  const { humanize } = createHumanizer({ pythonPath: '/bin/sh', scriptDir: dir });
  const { text } = await humanize('hello essay', {}, new AbortController().signal);
  assert.strictEqual(text, 'stealth:HELLO ESSAY');
});

test('per-run opts override Config C knobs', async () => {
  const dir = stubDir('printf "%s/%s" "$INKSPLASH_CANDIDATES" "$INKSPLASH_REFINE" > "$2"\n');
  const { humanize } = createHumanizer({ pythonPath: '/bin/sh', scriptDir: dir });
  const { text } = await humanize('x', { candidates: 20, refine: 5 }, new AbortController().signal);
  assert.strictEqual(text, '20/5');
});

test('nonzero exit rejects with stderr tail', async () => {
  const dir = stubDir('echo "boom detail" 1>&2\nexit 3\n');
  const { humanize } = createHumanizer({ pythonPath: '/bin/sh', scriptDir: dir });
  await assert.rejects(() => humanize('x', {}, new AbortController().signal), /exited 3.*boom detail/s);
});

test('abort kills the process and rejects', async () => {
  const dir = stubDir('sleep 5\nprintf done > "$2"\n');
  const { humanize } = createHumanizer({ pythonPath: '/bin/sh', scriptDir: dir });
  const ctrl = new AbortController();
  const p = humanize('x', {}, ctrl.signal);
  setTimeout(() => ctrl.abort(), 60);
  await assert.rejects(() => p, /Write stopped/);
});

test('isolated:true runs python with -I (no env/cwd import injection)', async () => {
  const { EventEmitter } = require('node:events');
  let argv;
  const fakeSpawn = (file, args) => {
    argv = args;
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => { fs.writeFileSync(args[args.length - 1], 'done'); child.emit('close', 0); });
    return child;
  };
  const { humanize } = createHumanizer({ pythonPath: 'python3', scriptDir: '/x', spawn: fakeSpawn, isolated: true });
  await humanize('hi', {}, new AbortController().signal);
  assert.strictEqual(argv[0], '-I');
});

test('empty input rejects without spawning', async () => {
  const { humanize } = createHumanizer({ pythonPath: '/bin/false', scriptDir: '/nonexistent' });
  await assert.rejects(() => humanize('   ', {}, new AbortController().signal), /Nothing to humanise/);
});
