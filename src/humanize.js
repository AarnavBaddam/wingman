'use strict';
// Humaniser bridge: shells out to the InkSplash Python "Config C" pipeline
// (stealth rule engine — burstiness + GPT-2 perplexity, the only path proven to
// move real ZeroGPT, ~20% on the testset). Approach A (user decision 2026-10-22):
// reuse the tested Python pipeline as a subprocess rather than re-porting it.
//
// Config C == `humanize_cli.py <in> <out>` with HUMANIZE_MODE=stealth +
// HUMANIZE_STEALTH_ENGINE=rule + INKSPLASH_SCORE_MODE=real. It is slow
// (minutes/essay); the default kill timeout is 600 s to match InkSplash's bridge.
//
// `pythonPath`/`scriptDir` are injected so the app can point at a bundled
// interpreter (via the Python downloader wizard) or a user venv. `spawn` is
// injected so the bridge is unit-testable without torch installed.
const nodeSpawn = require('node:child_process').spawn;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_C_ENV = {
  HUMANIZE_MODE: 'stealth',
  HUMANIZE_STEALTH_ENGINE: 'rule',
  INKSPLASH_SCORE_MODE: 'real',
};

function createHumanizer({ pythonPath, scriptDir, script = 'humanize_cli.py', env = {}, spawn = nodeSpawn, timeoutMs = 600000 }) {
  // opts may override Config C knobs (candidates, refine) per run.
  function humanize(text, opts = {}, signal) {
    return new Promise((resolve, reject) => {
      if (typeof text !== 'string' || !text.trim()) return reject(new Error('Nothing to humanise.'));
      if (signal?.aborted) return reject(new Error('Write stopped.'));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-hz-'));
      const inFile = path.join(dir, 'in.txt'), outFile = path.join(dir, 'out.txt');
      const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } };
      fs.writeFileSync(inFile, text, 'utf8');

      const runEnv = { ...process.env, ...CONFIG_C_ENV, ...env };
      if (opts.candidates != null) runEnv.INKSPLASH_CANDIDATES = String(opts.candidates);
      if (opts.refine != null) runEnv.INKSPLASH_REFINE = String(opts.refine);

      const child = spawn(pythonPath, [path.join(scriptDir, script), inFile, outFile], {
        cwd: scriptDir, env: runEnv, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '', settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; try { child.kill('SIGKILL'); } catch {} cleanup(); reject(new Error('Humanise timed out.')); } }, timeoutMs);
      const onAbort = () => { if (!settled) { settled = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch {} cleanup(); reject(new Error('Write stopped.')); } };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stderr?.on('data', d => { stderr += d.toString(); });
      child.on('error', err => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); cleanup(); reject(new Error(`Humaniser failed to start: ${err.message}`)); });
      child.on('close', code => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        try {
          if (code !== 0) return reject(new Error(`Humanise exited ${code}: ${stderr.trim().slice(-400) || 'no output'}`));
          const out = fs.readFileSync(outFile, 'utf8');
          if (!out.trim()) return reject(new Error('Humanise produced no output.'));
          resolve({ text: out });
        } catch (e) { reject(new Error(`Humanise output unreadable: ${e.message}`)); }
        finally { cleanup(); }
      });
    });
  }
  return { humanize };
}

module.exports = { createHumanizer, CONFIG_C_ENV };
