#!/usr/bin/env node
// Round-trip latency bench for `macdotool serve`. Read-only requests only: it never posts input.
// Usage: node bench.js [cursorpos-count=200] [activewindow-count=100] [capture-count=20]
const { spawn } = require('node:child_process');
const path = require('node:path');

const child = spawn(path.join(__dirname, 'bin', 'macdotool'), ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map();
let buffer = '', nextId = 1;
child.stdout.on('data', chunk => {
  buffer += chunk;
  for (let nl; (nl = buffer.indexOf('\n')) >= 0;) {
    const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
    const reply = JSON.parse(line);
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  }
});

function call(argv, input) {
  const id = nextId++;
  return new Promise(resolve => {
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ id, argv, input }) + '\n');
  });
}

async function measure(label, count, argv) {
  const times = [];
  for (let i = 0; i < count; i++) {
    const start = process.hrtime.bigint();
    const reply = await call(argv);
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
    if (!reply.ok) { console.log(`${label}: failed: ${reply.error}`); return; }
  }
  times.sort((a, b) => a - b);
  const pick = q => times[Math.min(times.length - 1, Math.floor(times.length * q))].toFixed(2);
  console.log(`${label}: n=${count} median=${pick(0.5)} ms p95=${pick(0.95)} ms min=${times[0].toFixed(2)} max=${times[times.length - 1].toFixed(2)}`);
}

(async () => {
  const [a, b, c] = [200, 100, 20].map((d, i) => Number(process.argv[2 + i] ?? d));
  await measure('cursorpos', a, ['cursorpos']);
  await measure('activewindow', b, ['activewindow']);
  await measure('capture 1400x900', c, ['capture', '-g', '0,0 1400x900']);
  child.stdin.end();
})();
