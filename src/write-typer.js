'use strict';
// Write-mode executor: walks a typing plan (src/typing-plan.js), waiting each
// event's delay, then pushing the keystroke to an injectable sink. The sink is
// the only thing that knows *how* keys are delivered — a Zen Marionette driver
// or the InkSplash extension — so the pacing/cancel/progress loop is shared and
// testable without a live browser.
//
// A Zen sink keeps typing across desktop switches for free: Marionette sends
// browser-native keys and never touches the OS cursor or focused workspace.

// Default clock: resolves after ms, rejects 'Auto stopped.' on abort. Matches
// src/auto-session.js's wait() so Escape/Stop cancels a run the same way.
function defaultWait(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Auto stopped.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

// events: from createTypingPlan(). sink: { key(v), backspace(), gap?(ms) }.
async function runTyping(events, sink, { signal, onProgress, wait = defaultWait } = {}) {
  const total = events.length;
  for (let i = 0; i < total; i++) {
    const e = events[i];
    await wait(e.delayMs, signal);
    signal.throwIfAborted();
    if (e.type === 'key') await sink.key(e.value);
    else if (e.type === 'backspace') await sink.backspace();
    else if (e.type === 'gap' && typeof sink.gap === 'function') await sink.gap(e.delayMs);
    if (onProgress) onProgress({ index: i, total, type: e.type });
  }
}

module.exports = { runTyping, defaultWait };
