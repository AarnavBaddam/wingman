const fs = require('node:fs');
const path = require('node:path');

// One folder per Auto run: trace.jsonl (one JSON event per line) plus the screenshot behind each
// decision, so a failed run on a new kind of form can be replayed into a test. Local only, owner-only
// permissions: it holds screenshots and typed answers (sensitive labels are refused before typing).
// ponytail: PNG per changed screenshot (~0.3 MB each); keep only the newest `keep` runs.
function createRunLog(rootDir, { keep = 5, now = () => new Date() } = {}) {
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 }); fs.chmodSync(rootDir, 0o700);
  const runs = fs.readdirSync(rootDir).filter(name => /^\d{8}-\d{6}/.test(name)).sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - keep + 1))) fs.rmSync(path.join(rootDir, old), { recursive: true, force: true });
  let name = now().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  for (let n = 2; fs.existsSync(path.join(rootDir, name)); n++) name = name.slice(0, 15) + '-' + n;
  const dir = path.join(rootDir, name);
  fs.mkdirSync(dir, { mode: 0o700 });
  let lastImage = null, lastFile = null, images = 0;
  return {
    dir,
    // Returns the file name holding this screenshot; an unchanged screen reuses the previous file.
    image(dataUrl) {
      if (dataUrl === lastImage) return lastFile;
      const match = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl));
      if (!match) return null;
      lastImage = dataUrl; lastFile = String(++images).padStart(3, '0') + '.png';
      fs.writeFileSync(path.join(dir, lastFile), Buffer.from(match[1], 'base64'), { mode: 0o600 });
      return lastFile;
    },
    write(event) {
      fs.appendFileSync(path.join(dir, 'trace.jsonl'), JSON.stringify({ t: now().toISOString(), ...event }) + '\n', { mode: 0o600 });
    }
  };
}

module.exports = { createRunLog };
