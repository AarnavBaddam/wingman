'use strict';
// Write-mode orchestrator. Unlike Auto (one model-driven loop), Write mode has a
// user-approval gate in the middle, so it is a staged state machine:
//
//   idle → drafting → review → (user approves) → armed → typing → idle
//
// Hard rule (user decision 2026-10-22): once the user approves the final text the
// MODEL IS DISENGAGED — nothing past `approve()` may call a provider. Typing is
// pure keystroke simulation (src/typing-plan.js + src/write-typer.js) into a
// locked Zen tab, which keeps going across desktop switches.
//
// Every external capability is injected so the flow is testable without Electron,
// Python, or a live browser: createLLM (draft), humanize (Config C subprocess),
// detect (local GPT-2 / optional ZeroGPT), createTyper (Zen sink), releaseModel.
const { createTypingPlan } = require('./typing-plan');
const { runTyping, defaultWait } = require('./write-typer');

const WRITE_SYSTEM = 'You are a writing assistant. Produce the requested piece as clean prose only — no preamble, no meta commentary, no markdown fences. Write in a natural first-person student voice.';

function createWriteSession(deps) {
  const { getSettings, getCodexHome, createLLM, humanize, detect, releaseModel, createTyper, onUpdate = () => {}, onEnd = () => {} } = deps;
  let stage = 'idle';
  let armed = null;        // approved text, set by approve()
  let llm = null;          // held only between draft and approve
  let current = null;      // { controller } of the in-flight async op (busy lock)
  let lastTypedCount = 0;
  const publish = update => onUpdate({ stage, ...update });

  async function prepare({ prompt, pasted, humanizeOpts = {}, detectOpts = {} } = {}) {
    if (stage !== 'idle' && stage !== 'review') throw new Error('Finish or stop the current Write task first.');
    if (current) throw new Error('Write is busy.');
    const controller = new AbortController(); current = { controller };
    const signal = controller.signal;
    stage = 'drafting';
    try {
      let draft;
      if (typeof pasted === 'string' && pasted.trim()) {
        draft = pasted;                         // pasted text: no model draft
      } else {
        if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Enter a prompt or paste text.');
        if (prompt.length > 8000) throw new Error('Prompt is too long (max 8,000 characters).');
        const settings = getSettings();
        llm = createLLM({ ...settings, codexHome: getCodexHome(settings) });
        if (!llm.ready) throw new Error('Configure an answer provider before drafting.');
        publish({ status: 'drafting', message: 'Drafting…' });
        const out = await llm.stream({ system: WRITE_SYSTEM, turns: [{ role: 'user', text: prompt }], maxTokens: 2000, signal, onToken() {} });
        draft = typeof out === 'string' ? out : (out && out.text) || '';
        if (!draft.trim()) throw new Error('The model returned no draft.');
      }
      publish({ status: 'humanising', message: 'Humanising…' });
      const h = await humanize(draft, humanizeOpts, signal);
      const text = (h && h.text) || draft;
      publish({ status: 'detecting', message: 'Checking the detector…' });
      const d = (await detect(text, detectOpts, signal)) || {};
      stage = 'review';
      const review = { draft, text, aiScore: d.aiScore, pass: d.pass !== false, detail: d.detail };
      publish({ status: 'review', ...review });
      return review;
    } catch (error) {
      stage = 'idle'; llm = null;
      publish({ status: signal.aborted ? 'stopped' : 'error', message: signal.aborted ? 'Write stopped.' : error.message });
      throw error;
    } finally {
      current = null;
    }
  }

  function approve(finalText) {
    if (stage !== 'review') throw new Error('Prepare a draft before approving.');
    if (typeof finalText !== 'string' || !finalText.trim()) throw new Error('Approve some text to type.');
    if (finalText.length > 200000) throw new Error('Approved text is too long.');
    armed = finalText;
    // Disengage the model. Nothing past this point may call a provider.
    llm = null;
    try { if (releaseModel) releaseModel(); } catch { /* teardown best-effort */ }
    stage = 'armed';
    publish({ status: 'armed', message: 'Ready to type. Pick a tab to type into.' });
    return { armed: true };
  }

  async function typeInto(tabId, typingConfig = {}, wait = defaultWait) {
    if (stage !== 'armed' || !armed) throw new Error('Approve the final text before typing.');
    if (current) throw new Error('Write is busy.');
    const controller = new AbortController(); current = { controller };
    const signal = controller.signal;
    stage = 'typing'; lastTypedCount = 0;
    const { events, stats } = createTypingPlan(armed, typingConfig);
    publish({ status: 'typing', total: events.length, stats });
    let sink;
    try {
      sink = createTyper({ tabId, signal });
      await runTyping(events, sink, {
        signal, wait,
        onProgress: e => {
          if (e.type === 'key') lastTypedCount++;
          publish({ status: 'typing', index: e.index, total: e.total, type: e.type, typed: lastTypedCount });
        },
      });
      stage = 'idle'; armed = null;
      publish({ status: 'done', message: 'Typed the approved text.' });
    } catch (error) {
      stage = 'armed'; // stay armed so the user can retry
      const stopped = signal.aborted;
      publish({ status: stopped ? 'stopped' : 'error', message: stopped ? 'Write stopped.' : error.message });
      if (!stopped) throw error;
    } finally {
      try { if (sink && sink.release) await sink.release(); } catch { /* best-effort */ }
      current = null; onEnd();
    }
  }

  function stop(reason = 'Write stopped.') { if (current) current.controller.abort(); }

  return {
    prepare, approve, typeInto, stop,
    get stage() { return stage; },
    get active() { return current !== null; },
    get lastTypedCount() { return lastTypedCount; },
  };
}

module.exports = { createWriteSession, WRITE_SYSTEM };
