'use strict';
// One status line for the dock and the notch, so they can never disagree about what Aether is doing.
(function (root) {
  const short = text => String(text || '').replace(/[.…]+$/, '').replace(/\s+/g, ' ').trim().slice(0, 60);

  const LINGER = { done: 8000, answered: 10000, failed: 20000 };
  // Finished states carry `at` from main, so a later update can never bring an old status back.
  // expires: ms after which the caller should repaint with that part of the state cleared.
  function describe(state, clock, now = Date.now()) {
    const auto = state.auto || {}, write = state.write || {}, answer = state.answer || {};
    const left = (part, ms) => (part.at ? ms - (now - part.at) : ms);
    const line = { step: '', text: 'AETHER · READY', sub: '', key: state.toggleLabel || '', led: 'led', live: false, busy: false, sweep: false, expires: null, clear: null, listening: false };
    if (auto.active) {
      Object.assign(line, { step: auto.step ? String(auto.step).padStart(2, '0') : '', text: short(auto.message) || 'AUTO', sub: auto.target === 'zen' ? 'ZEN' : 'DESK', key: 'ESC', led: 'led on', live: true, busy: true, sweep: true });
    } else if (write.status === 'typing') {
      Object.assign(line, { text: 'WRITE ' + (write.typed || 0) + (write.total ? '/' + write.total : ''), sub: 'ZEN', key: 'ESC', led: 'led on', live: true, busy: true, sweep: true });
    } else if (write.status === 'done' && left(write, LINGER.done) > 0) {
      Object.assign(line, { text: 'WRITE DONE', led: 'led on', live: true, expires: left(write, LINGER.done), clear: 'write' });
    } else if (['drafting', 'humanising', 'detecting', 'armed'].includes(write.status) && write.stage) {
      Object.assign(line, { text: 'WRITE · ' + String(write.status).toUpperCase(), key: 'OPEN', led: 'led on', live: true });
    } else if (answer.status === 'working') {
      Object.assign(line, { text: short(answer.message) || 'THINKING', led: 'led on', live: true, sweep: true });
    } else if (answer.status === 'done' && left(answer, LINGER.answered) > 0) {
      Object.assign(line, { text: 'ANSWERED', key: 'OPEN', led: 'led on', live: true, expires: left(answer, LINGER.answered), clear: 'answer' });
    } else if (answer.status === 'error' && left(answer, LINGER.failed) > 0) {
      Object.assign(line, { text: short(answer.message) || 'ANSWER FAILED', key: 'OPEN', led: 'led need', live: true, expires: left(answer, LINGER.failed), clear: 'answer' });
    } else if (auto.status === 'paused' && auto.message) {
      Object.assign(line, { text: short(auto.message), key: 'OPEN', led: 'led need', live: true });
    } else if (['error', 'skipped'].includes(auto.status) && auto.message && left(auto, LINGER.failed) > 0) {
      Object.assign(line, { text: short(auto.message), key: 'OPEN', led: 'led need', live: true, expires: left(auto, LINGER.failed), clear: 'auto' });
    } else if (auto.status === 'done' && auto.message && left(auto, LINGER.done) > 0) {
      Object.assign(line, { text: 'DONE · ' + short(auto.message), led: 'led on', live: true, expires: left(auto, LINGER.done), clear: 'auto' });
    } else if (state.listening) {
      Object.assign(line, { text: 'LISTEN ' + clock(), led: 'led listen', live: true, listening: true });
    }
    line.title = auto.active ? short(auto.message) : '';
    return line;
  }

  const api = { describe, short };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AetherStatus = api;
})(typeof window !== 'undefined' ? window : globalThis);
