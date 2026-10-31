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
  // files: { name: contents } written to a temp dir; build(paths) returns the script's arguments.
  function run(files, build, signal, timeout = timeoutMs) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Write stopped.'));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-dt-'));
      const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } };
      const paths = {};
      for (const [name, contents] of Object.entries(files)) { paths[name] = path.join(dir, name); fs.writeFileSync(paths[name], contents, 'utf8'); }
      // -I (isolated): ignore PYTHONPATH/cwd/user-site so env can't inject imports.
      const args = [...(isolated ? ['-I'] : []), path.join(scriptDir, script), ...build(paths)];
      if (inksplashDir) args.push('--inksplash-dir', inksplashDir);

      const child = spawn(pythonPath, args, { cwd: scriptDir, env: { ...process.env, INKSPLASH_DIR: inksplashDir || process.env.INKSPLASH_DIR || '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', settled = false;
      const finish = fn => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); cleanup(); fn(); };
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(() => reject(new Error('Detector timed out.'))); }, timeout);
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
        resolve(json);
      }));
    });
  }

  // opts: { source, zerogpt, aiMax, factMin }
  async function detect(text, opts = {}, signal) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Nothing to check.');
    const hasSource = typeof opts.source === 'string' && opts.source.trim();
    const json = await run({ 'text.txt': text, ...(hasSource && { 'source.txt': opts.source }) }, p => {
      const args = ['--text', p['text.txt']];
      if (hasSource) args.push('--source', p['source.txt']);
      if (opts.zerogpt) args.push('--zerogpt');
      if (opts.aiMax != null) args.push('--ai-max', String(opts.aiMax));
      if (opts.factMin != null) args.push('--fact-min', String(opts.factMin));
      return args;
    }, signal);
    return { aiScore: json.aiScore, factScore: json.factScore, meaning: json.meaning ?? null, zerogpt: json.zerogpt, pass: json.pass !== false, detail: json.detail };
  }

  // Sentence scores in context, or (with options) the best-scoring alternative per sentence index.
  async function segments(list, options = {}, signal) {
    if (!Array.isArray(list) || !list.length || list.some(s => typeof s !== 'string')) throw new Error('Nothing to score.');
    // Each option is a forward pass on CPU; give big essays room.
    const passes = list.length + Object.values(options).reduce((n, alts) => n + 1 + alts.length, 0);
    const json = await run({ 'segments.json': JSON.stringify({ segments: list, options }) }, p => ['--segments', p['segments.json']], signal, Math.max(timeoutMs, passes * 2000));
    if (!Array.isArray(json.scores) || json.scores.length !== list.length) throw new Error('Detector returned no sentence scores.');
    return { scores: json.scores, choice: json.choice || {} };
  }
  return { detect, segments };
}

module.exports = { createDetector };
