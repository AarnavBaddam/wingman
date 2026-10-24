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

function createHumanizer({ pythonPath, scriptDir, script = 'humanize_cli.py', env = {}, spawn = nodeSpawn, timeoutMs = 600000, isolated = false }) {
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

      // -I (isolated): ignore PYTHONPATH/cwd/user-site so env can't inject imports.
      const argv = isolated ? ['-I', path.join(scriptDir, script), inFile, outFile] : [path.join(scriptDir, script), inFile, outFile];
      const child = spawn(pythonPath, argv, {
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
          // 5 = the rewrite altered a quotation, so the CLI wrote the original text back.
          if (code === 5) return resolve({ text: fs.readFileSync(outFile, 'utf8'), note: 'The humaniser could not keep every quotation exact, so your text was left un-humanised.' });
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

// ---- Model humaniser: the answer provider (Codex for this user) rewrites the text. ----
// Quotations are frozen as [[Qn: words]] markers and restored by number, exactly as the
// Python CLI does, so the model can never change a quote.
const QUOTE_RE = /“[^”\n]*”|"[^"\n]*"/g;
const MARK_RE = /\[\[Q(\d+)(?::[^[\]]*)?\]\]/g;

function freezeQuotes(text) {
  const quotes = [];
  const masked = text.replace(QUOTE_RE, q => { quotes.push(q); return `[[Q${quotes.length}: ${q.slice(1, -1).replace(/[[\]]/g, '').trim()}]]`; });
  return { masked, quotes };
}

// null when a marker was lost, duplicated, or invented.
function thawQuotes(text, quotes) {
  text = text.replace(/["“”]+(\[\[Q\d+(?::[^[\]]*)?\]\])["“”]+/g, '$1');   // model re-wrapped a marker
  const ids = [...text.matchAll(MARK_RE)].map(m => Number(m[1])).sort((a, b) => a - b);
  if (ids.length !== quotes.length || ids.some((id, i) => id !== i + 1)) return null;
  return text.replace(MARK_RE, (m, id) => quotes[Number(id) - 1]);
}

const HUMANIZE_SYSTEM = [
  'Rewrite the user\'s text so it reads as written by a person, not a language model. This is the user\'s own writing, used to test AI detectors.',
  'Keep the author\'s voice, register, person, tense, format, paragraph breaks, and roughly the same length. Do not make it more casual or more formal than it is.',
  'Rhythm: make sentence lengths uneven. Follow a long sentence with a short one; never put two similar-length sentences in a row.',
  'Wording: prefer specific, plain words over smooth generic phrasing. Avoid: delve, pivotal, crucial, testament, tapestry, landscape, realm, underscore, robust, seamless, Furthermore, Moreover, Additionally, In conclusion. No em dashes.',
  'Fidelity: keep every claim, fact, name, date, number, and the thesis. Add nothing, drop nothing, invent nothing.',
  'Text like [[Q1: some words]] is an exact quotation: copy every such marker unchanged and exactly once, never put quotation marks around it, and never repeat or paraphrase its words outside the marker.',
  'Output only the rewritten text.',
].join(' ');

const KEPT = note => ({ note: `${note} Your text was left un-humanised.` });

// ponytail: one rewrite per run; Re-run asks for another. Add detector-scored best-of-N if one pass scores too high.
function createModelHumanizer({ llm }) {
  async function humanize(text, opts = {}, signal) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Nothing to humanise.');
    if (!llm || !llm.ready) throw new Error('Configure an answer provider to humanise with it.');
    const { masked, quotes } = freezeQuotes(text);
    // Later rounds hear how the last version scored, so each pass pushes harder.
    const feedback = opts.aiScore == null ? '' : `An AI detector rates this version ${Number(opts.aiScore).toFixed(1)}% AI-written. Rewrite it so its rhythm and word choice are clearly less predictable than this version, while following every rule.\n\n`;
    const out = await llm.stream({ system: HUMANIZE_SYSTEM, turns: [{ role: 'user', text: feedback + masked }], maxTokens: 8000, signal, onToken() {} });
    let rewritten = String(typeof out === 'string' ? out : (out && out.text) || '').trim();
    if (!rewritten) return { text, ...KEPT('The model returned no rewrite.') };
    const ratio = rewritten.length / masked.length;
    if (ratio < 0.7 || ratio > 1.4) return { text, ...KEPT(`The rewrite changed the length too much (${Math.round(ratio * 100)}%).`) };
    rewritten = rewritten.replace(/\s*[—–―]\s*/g, ', ').replace(/,\s*,/g, ',');   // quotes are still markers here
    const restored = thawQuotes(rewritten, quotes);
    if (restored === null) return { text, ...KEPT('The rewrite could not keep every quotation exact.') };
    return { text: restored };
  }
  return { humanize };
}

module.exports = { createHumanizer, CONFIG_C_ENV, createModelHumanizer, freezeQuotes, thawQuotes, HUMANIZE_SYSTEM };
