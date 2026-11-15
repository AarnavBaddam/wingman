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

// Sentences with their trailing whitespace; joining them gives the text back exactly.
// A stop counts only before whitespace (3.5 stays whole) and not after a common abbreviation.
const ABBR_END = /\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|Prof|Gen|etc|e\.g|i\.e)\.["”’')\]]*\s*$/i;
function splitSentences(text) {
  const out = [], re = /[.!?]+["”’')\]]*(?=\s|$)|\n/g;
  let start = 0, m;
  while ((m = re.exec(text))) {
    let end = m.index + m[0].length;
    while (end < text.length && /\s/.test(text[end])) end++;
    re.lastIndex = Math.max(end, m.index + 1);
    if (m[0] !== '\n' && ABBR_END.test(text.slice(start, end))) continue;
    out.push(text.slice(start, end)); start = end;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

// What a rewrite must keep: numbers, and capitalised words that are not the sentence's first word.
// The first word counts too when the essay capitalises it mid-sentence elsewhere (a name like Napoleon).
function sentenceFacts(sentence, essay = '') {
  const words = sentence.trim().match(/[A-Za-z][\w'’-]*|\d[\d,.]*\d|\d/g) || [];
  return words.filter((w, i) => /^\d/.test(w) || (/^[A-Z]/.test(w) && w !== 'I' &&
    (i > 0 || new RegExp(`[a-z,;]\\s+${w}\\b`).test(essay))));
}

const SENTENCE_SYSTEM = [
  'You rewrite single sentences from the user\'s own essay so that an AI-text detector rates them as written by a person. This is the user\'s own writing, used to test AI detectors.',
  'For each numbered sentence, write exactly 3 different rewrites. Make them genuinely different from each other: one noticeably shorter, one with a different structure (start differently, move clauses, split an idea into a short clause), one with plainer and more specific wording.',
  'Each rewrite must stay ONE sentence that fits between its neighbours in the essay: same meaning, every fact, name and number, same tense, person and register, and the same job in its paragraph.',
  'Avoid: delve, pivotal, crucial, testament, tapestry, landscape, realm, underscore, robust, seamless, foster, Furthermore, Moreover, Additionally, In conclusion, "not only... but also". No em dashes. Add no claims.',
  'Output only a JSON object mapping each sentence number to its array of 3 rewrites, like {"4": ["...", "...", "..."]}.',
].join(' ');

// Sentence-level search: the detector scores each sentence in context, the model writes three
// alternatives for only the most AI-like ones, and the detector keeps whichever scores lowest.
// Whole-text rewrites lowered the local score slowly (98.6% to 91.5% in 5 rounds).
function createSentenceHumanizer({ llm, scoreSegments, maxTargets = 8, minScore = 40 }) {
  async function humanize(text, opts = {}, signal) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Nothing to humanise.');
    if (!llm || !llm.ready) throw new Error('Configure an answer provider to humanise with it.');
    const segments = splitSentences(text);
    const { scores } = await scoreSegments(segments, {}, signal);
    // Quotations and fragments stay untouched; quotes must survive byte for byte.
    const eligible = segments.map((seg, i) => ({ i, seg, score: scores[i] }))
      .filter(({ seg }) => seg.trim().split(/\s+/).length >= 6 && !/["“”]/.test(seg) && !freezeQuotes(seg).quotes.length)
      .sort((a, b) => b.score - a.score);
    let targets = eligible.filter(t => t.score >= minScore).slice(0, maxTargets);
    if (!targets.length) targets = eligible.slice(0, 3);
    if (!targets.length) return { text, ...KEPT('No sentence could be rewritten without touching a quotation.') };
    const ask = targets.map(t => ({ id: t.i, sentence: t.seg.trim() }));
    const out = await llm.stream({ system: SENTENCE_SYSTEM, maxTokens: 8000, signal, onToken() {},
      turns: [{ role: 'user', text: `Essay for context:\n<<<\n${text}\n>>>\n\nRewrite these sentences:\n${JSON.stringify(ask)}` }] });
    const raw = String(typeof out === 'string' ? out : (out && out.text) || '');
    let parsed;
    try { parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { return { text, ...KEPT('The model did not return sentence rewrites.') }; }
    const options = {};
    for (const t of targets) {
      const core = t.seg.trim(), tail = t.seg.slice(t.seg.trimEnd().length), facts = sentenceFacts(core, text);
      const end = (core.match(/[.!?]+["”’')\]]*$/) || [''])[0];
      const alts = (Array.isArray(parsed[t.i]) ? parsed[t.i] : []).filter(a => typeof a === 'string').map(a => {
        let alt = a.trim().replace(/\s*[—–―]\s*/g, ', ').replace(/,\s*,/g, ',');
        if (end && !/[.!?]["”’')\]]*$/.test(alt)) alt += end;
        return alt;
      }).filter(alt => !/[\n"“”]/.test(alt) && alt.length >= core.length * 0.4 && alt.length <= core.length * 1.8 &&
        splitSentences(alt).length === 1 && facts.every(f => alt.includes(f)));
      if (alts.length) options[t.i] = alts.map(alt => alt + tail);
    }
    if (!Object.keys(options).length) return { text, ...KEPT('Every sentence rewrite dropped a fact or changed shape.') };
    const { choice } = await scoreSegments(segments, options, signal);
    let changed = 0;
    const next = segments.map((seg, i) => {
      const k = choice[i];
      if (!Number.isInteger(k) || k < 0 || !options[i]?.[k]) return seg;
      changed++; return options[i][k];
    });
    if (!changed) return { text, ...KEPT('No rewrite scored lower than its sentence.') };
    return { text: next.join(''), changed };
  }
  return { humanize };
}

module.exports = { createHumanizer, CONFIG_C_ENV, createModelHumanizer, createSentenceHumanizer, splitSentences, sentenceFacts, freezeQuotes, thawQuotes, HUMANIZE_SYSTEM, SENTENCE_SYSTEM };
