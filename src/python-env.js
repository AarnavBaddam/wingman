'use strict';
// Python environment detection for the Write-mode humaniser/detector (approach A).
// The humaniser is a Python subprocess, so end-users need an interpreter with
// torch/transformers/spacy/nltk/textstat. This probes candidate interpreters and
// reports which one works and what's missing, so the downloader wizard can either
// point at a usable interpreter or offer to build a venv.
//
// `exec` is injected (default execFile) so detection is unit-testable.
const { execFile } = require('node:child_process');

const DEFAULT_REQUIRES = ['torch', 'transformers', 'spacy', 'nltk', 'textstat'];

// Prints, one per line, each required module that is NOT importable.
const CHECK = 'import importlib.util as u,sys\n[print(m) for m in sys.argv[1].split(",") if u.find_spec(m) is None]';

function defaultExec(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { timeout: 20000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' }));
  });
}

function createPythonEnv({ candidates = [], requires = DEFAULT_REQUIRES, exec = defaultExec } = {}) {
  async function probe(pythonPath) {
    if (!pythonPath) return { ok: false, pythonPath, missing: [...requires], runnable: false };
    const res = await exec(pythonPath, ['-c', CHECK, requires.join(',')]);
    if (res.code !== 0 && res.stdout.trim() === '') {
      return { ok: false, pythonPath, missing: [...requires], runnable: false, error: (res.stderr || '').trim().slice(-200) };
    }
    const missing = res.stdout.split('\n').map(s => s.trim()).filter(Boolean);
    return { ok: missing.length === 0, pythonPath, missing, runnable: true };
  }

  // First candidate that satisfies everything; else the most-complete partial.
  async function detect() {
    let best = null;
    for (const p of candidates) {
      const r = await probe(p);
      if (r.ok) return r;
      if (!best || (r.runnable && r.missing.length < best.missing.length)) best = r;
    }
    return best || { ok: false, pythonPath: null, missing: [...requires], runnable: false };
  }

  // The pip command the wizard can run (or show) to complete a usable interpreter.
  function setupCommand(pythonPath, requirementsFile) {
    const target = requirementsFile ? ['-r', requirementsFile] : requires;
    return { file: pythonPath, args: ['-m', 'pip', 'install', '--upgrade', ...target] };
  }

  return { probe, detect, setupCommand, requires };
}

module.exports = { createPythonEnv, DEFAULT_REQUIRES };
