'use strict';
// Pure notch logic: the interaction state machine and the springs. No DOM, so node --test covers it.
// Loaded as a plain script in the renderer and via require() in tests.
(function (root) {
  // Sizes in CSS px. `rest` is deliberately tiny: the screen edge is the target, not the bar.
  const SIZE = { rest: { w: 64, h: 8 }, near: { w: 86, h: 11 }, live: { w: 340, h: 34 }, peek: { w: 548, h: 212 } };
  const SHEET = { w: 600, h: 620, minW: 520, minH: 420 };

  // Separate width and height springs let the shape lead sideways and settle downward, as a body does.
  // Apple-style parameters: response is the period in seconds, damping 1 is critical (no overshoot).
  const SPRING = {
    open: { w: { response: 0.34, damping: 0.9 }, h: { response: 0.4, damping: 0.86 } },
    close: { w: { response: 0.26, damping: 1 }, h: { response: 0.24, damping: 1 } },
    key: { w: { response: 0.17, damping: 1 }, h: { response: 0.17, damping: 1 } }, // keyboard: repeated often, stay out of the way
    near: { w: { response: 0.16, damping: 0.8 }, h: { response: 0.16, damping: 0.8 } }
  };

  // Semi-implicit Euler, substepped so a long frame cannot destabilise a stiff spring.
  function stepSpring(s, target, dt, { response, damping }) {
    const k = (2 * Math.PI / response) ** 2, c = 2 * damping * (2 * Math.PI / response);
    let { x, v } = s, left = Math.min(dt, 0.05);
    while (left > 0) {
      const h = Math.min(left, 1 / 240);
      v += (-k * (x - target) - c * v) * h;
      x += v * h;
      left -= h;
    }
    return { x, v };
  }
  const settled = (s, target) => Math.abs(s.x - target) < 0.08 && Math.abs(s.v) < 1;

  const initial = () => ({ view: 'rest', inside: false, armed: false, escLatch: false, live: false, busy: false, holds: 0, pinned: false });

  // A live status, active Auto/Write run, typed text, settings, and a pinned sheet
  // must remain available. The shell decides when the idle timer expires; this
  // predicate keeps that decision pure and testable.
  const canAutoHide = s => !s.pinned && !s.holds && !s.busy && !s.live;

  // view: rest | peek | sheet. armed: the pointer has been inside since opening, so leaving means something.
  // A sheet opened by shortcut must not tuck away before the user ever pointed at it.
  function reduce(s, event) {
    switch (event.type) {
      case 'enter': return { ...s, inside: true, armed: s.view !== 'rest' || s.armed };
      case 'leave': return { ...s, inside: false, escLatch: false };
      case 'dwell': return s.view === 'rest' && s.inside && !s.escLatch && !s.busy ? { ...s, view: 'peek', armed: true } : s;
      case 'expand': return { ...s, view: 'sheet', armed: s.inside };
      case 'open': return { ...s, view: 'sheet', armed: s.inside, escLatch: false };
      case 'close': return { ...s, view: 'rest', armed: false };
      case 'escape': return s.view === 'rest' ? s : { ...s, view: 'rest', armed: false, escLatch: s.inside };
      case 'tuck': return s.view !== 'rest' && s.armed && !s.inside && !s.pinned && !s.holds ? { ...s, view: 'rest', armed: false } : s;
      case 'holds': return { ...s, holds: event.value };
      case 'pin': return { ...s, pinned: !!event.value };
      case 'live': return { ...s, live: !!event.live, busy: !!event.busy };
      default: return s;
    }
  }

  // What the shape should be sized to right now.
  function targetSize(s, sheet, near, liveWidth) {
    if (s.view === 'sheet') return sheet;
    if (s.view === 'peek') return SIZE.peek;
    if (s.live) return { w: liveWidth || SIZE.live.w, h: SIZE.live.h };
    return near ? SIZE.near : SIZE.rest;
  }

  const radiusFor = h => Math.min(26, Math.max(4, h * 0.42));
  const clampSheet = (size, max) => ({
    w: Math.round(Math.min(max.w, Math.max(SHEET.minW, size.w))),
    h: Math.round(Math.min(max.h, Math.max(SHEET.minH, size.h)))
  });

  const api = { SIZE, SHEET, SPRING, stepSpring, settled, initial, reduce, targetSize, radiusFor, clampSheet, canAutoHide };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AetherNotchState = api;
})(typeof window !== 'undefined' ? window : globalThis);
