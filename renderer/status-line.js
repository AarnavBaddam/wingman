'use strict';
// One status line for the dock and the notch, so they can never disagree about what Aether is doing.
(function (root) {
  const short = text => String(text || '').replace(/[.]+$/, '').replace(/\s+/g, ' ').trim().slice(0, 60);

  // expires: ms after which the caller should repaint with that part of the state cleared.
  function describe(state, clock) {
    const auto = state.auto || {}, write = state.write || {};
    const line = { step: '', text: 'AETHER · READY', sub: '', key: state.toggleLabel || '', led: 'led', live: false, busy: false, expires: null, clear: null, listening: false };
    if (auto.active) {
      Object.assign(line, { step: auto.step ? String(auto.step).padStart(2, '0') : '', text: short(auto.message) || 'AUTO', sub: auto.target === 'zen' ? 'ZEN' : 'DESK', key: 'ESC', led: 'led on', live: true, busy: true });
    } else if (write.status === 'typing') {
      Object.assign(line, { text: 'WRITE ' + (write.typed || 0) + (write.total ? '/' + write.total : ''), sub: 'ZEN', key: 'ESC', led: 'led on', live: true, busy: true });
    } else if (write.status === 'done') {
      Object.assign(line, { text: 'WRITE DONE', led: 'led on', live: true, expires: 8000, clear: 'write' });
    } else if (['drafting', 'humanising', 'detecting', 'armed'].includes(write.status) && write.stage) {
      Object.assign(line, { text: 'WRITE · ' + String(write.status).toUpperCase(), key: 'OPEN', led: 'led on', live: true });
    } else if (['paused', 'error', 'skipped'].includes(auto.status) && auto.message) {
      Object.assign(line, { text: short(auto.message), key: 'OPEN', led: 'led need', live: true });
    } else if (auto.status === 'done' && auto.message) {
      Object.assign(line, { text: 'DONE · ' + short(auto.message), led: 'led on', live: true, expires: 8000, clear: 'auto' });
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
