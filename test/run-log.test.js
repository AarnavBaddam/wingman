const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunLog } = require('../src/run-log');

test('run log writes trace lines, dedupes unchanged screenshots and keeps only the newest runs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-runs-'));
  let clock = Date.parse('2026-10-24T01:00:00Z');
  const now = () => new Date(clock += 1000);
  const png = 'data:image/png;base64,' + Buffer.from('fake png').toString('base64');
  const log = createRunLog(root, { now });
  assert.equal(log.image(png), '001.png');
  assert.equal(log.image(png), '001.png');
  assert.equal(log.image(png + 'AA'), '002.png');
  assert.equal(log.image('not an image'), null);
  log.write({ kind: 'goal', goal: 'Fill form' }); log.write({ kind: 'end', status: 'done' });
  const lines = fs.readFileSync(path.join(log.dir, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(l => l.kind), ['goal', 'end']);
  assert.equal(fs.readFileSync(path.join(log.dir, '001.png'), 'utf8'), 'fake png');
  for (let i = 0; i < 6; i++) createRunLog(root, { now, keep: 3 });
  assert.equal(fs.readdirSync(root).length, 3);
  assert.ok(!fs.existsSync(log.dir));
  fs.rmSync(root, { recursive: true });
});
