'use strict';
// Detector bridge for Write mode. Shells to scripts/aether_detect.py, which
// reuses the InkSplash scorers: local AI% (always), fact-preservation vs the
// source, and optional authoritative ZeroGPT. Returns a parsed verdict the
// review UI shows and the user can re-run. Same injectable-subprocess pattern as
// src/humanize.js so it is testable without torch.
const nodeSpawn = require('node:child_process').spawn;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createDetector({ pythonPath, scriptDir, inksplashDir, script = 'scripts/aether_detect.py', spawn = nodeSpawn, timeoutMs = 120000, isolated = false }) {
  // opts: { source, zerogpt, aiMax, factMin }
  function detect(text, opts = {}, signal) {
    return new Promise((resolve, reject) => {
      if (typeof text !== 'string' || !text.trim()) return reject(new Error('Nothing to check.'));
      if (signal?.aborted) return reject(new Error('Write stopped.'));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-dt-'));
      const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } };
      const textFile = path.join(dir, 'text.txt');
      fs.writeFileSync(textFile, text, 'utf8');
      // -I (isolated): ignore PYTHONPATH/cwd/user-site so env can't inject imports.
      const args = isolated ? ['-I', path.join(scriptDir, script), '--text', textFile] : [path.join(scriptDir, script), '--text', textFile];
      if (typeof opts.source === 'string' && opts.source.trim()) {
        const srcFile = path.join(dir, 'source.txt');
        fs.writeFileSync(srcFile, opts.source, 'utf8');
        args.push('--source', srcFile);
      }
      if (opts.zerogpt) args.push('--zerogpt');
      if (inksplashDir) args.push('--inksplash-dir', inksplashDir);
      if (opts.aiMax != null) args.push('--ai-max', String(opts.aiMax));
      if (opts.factMin != null) args.push('--fact-min', String(opts.factMin));

      const child = spawn(pythonPath, args, { cwd: scriptDir, env: { ...process.env, INKSPLASH_DIR: inksplashDir || process.env.INKSPLASH_DIR || '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', settled = false;
      const finish = fn => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); cleanup(); fn(); };
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(() => reject(new Error('Detector timed out.'))); }, timeoutMs);
      const onAbort = () => { try { child.kill('SIGKILL'); } catch {} finish(() => reject(new Error('Write stopped.'))); };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('error', err => finish(() => reject(new Error(`Detector failed to start: ${err.message}`))));
      child.on('close', code => finish(() => {
        let json;
        try { json = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() || '{}'); }
        catch { return reject(new Error(`Detector output unparseable: ${(stderr || stdout).trim().slice(-300)}`)); }
        if (code !== 0 || json.error) return reject(new Error(`Detector failed: ${json.error || stderr.trim().slice(-300) || 'exit ' + code}`));
        resolve({ aiScore: json.aiScore, factScore: json.factScore, meaning: json.meaning ?? null, zerogpt: json.zerogpt, pass: json.pass !== false, detail: json.detail });
      }));
    });
  }
  return { detect };
}

module.exports = { createDetector };
