'use strict';
// The notch shell (Windows). One spring-driven shape inside a fixed transparent window: rest bar,
// live status, hover peek and the full sheet are all the same object changing size.
(function () {
  const api = window.wingman;
  if (!api?.notchMode) return;
  const N = window.AetherNotchState, Status = window.AetherStatus;
  const $ = id => document.getElementById(id);
  const shape = $('notch-shape'), clip = $('notch-clip'), hit = $('notch-hit');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const DWELL_MS = 170, TUCK_MS = 240, NEAR_PX = 26, EDGE_PX = 18, DEFAULT_HIDE_MS = 8000;
  const store = {
    get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
  };
  document.body.classList.add('notch');
  for (const [mode, label] of [['say', 'Say'], ['followup', 'Follow-up']]) document.querySelector(`[data-mode="${mode}"] .n`).textContent = label;

  const maxSheet = () => ({ w: innerWidth - 24, h: innerHeight - 12 });
  let sheet = N.clampSheet(store.get('aether.notch.size') || N.SHEET, maxSheet());
  let state = N.reduce(N.initial(), { type: 'pin', value: !!store.get('aether.notch.pin') });
  let near = false, liveWidth = 0, spring = N.SPRING.near;
  const motion = { w: { x: N.SIZE.rest.w, v: 0 }, h: { x: N.SIZE.rest.h, v: 0 } };
  let autoHide = true, autoHideMs = DEFAULT_HIDE_MS, autoHideTimer = 0;

  function scheduleAutoHide() {
    clearTimeout(autoHideTimer);
    autoHideTimer = 0;
    if (!autoHide || !N.canAutoHide(state)) return;
    autoHideTimer = setTimeout(() => {
      autoHideTimer = 0;
      if (N.canAutoHide(state)) api.notchHide();
      else if (state.view !== 'rest') scheduleAutoHide();
    }, autoHideMs);
  }
  function applyNotchSettings(settings) {
    autoHide = settings?.autoHide !== false;
    const seconds = Number(settings?.delay);
    autoHideMs = (Number.isFinite(seconds) ? Math.max(2, Math.min(60, seconds)) : 8) * 1000;
    scheduleAutoHide();
  }
  api.settingsGet().then(settings => applyNotchSettings({ autoHide: settings.notchAutoHide, delay: settings.notchHideDelay })).catch(() => {});
  api.on('notch:settings', applyNotchSettings);

  // ---- shape: the only per-frame work. Children are absolutely placed, so nothing reflows.
  let raf = 0, lastT = 0;
  function paintShape() {
    const { x: w } = motion.w, { x: h } = motion.h;
    shape.style.width = w + 'px';
    shape.style.height = h + 'px';
    shape.style.setProperty('--r', N.radiusFor(h) + 'px');
    const ear = Math.min(10, Math.max(0, (h - 6) * 0.6));
    shape.style.setProperty('--ear', ear + 'px');
    hit.style.width = Math.max(w, 150) + EDGE_PX * 2 + 'px';
    hit.style.height = h + EDGE_PX + 'px';
  }
  function frame(t) {
    const dt = lastT ? (t - lastT) / 1000 : 1 / 60;
    lastT = t;
    const goal = N.targetSize(state, sheet, near, liveWidth);
    motion.w = N.stepSpring(motion.w, goal.w, dt, spring.w);
    motion.h = N.stepSpring(motion.h, goal.h, dt, spring.h);
    if (N.settled(motion.w, goal.w) && N.settled(motion.h, goal.h)) {
      motion.w = { x: goal.w, v: 0 }; motion.h = { x: goal.h, v: 0 };
      raf = 0; lastT = 0;
      paintShape();
      return;
    }
    paintShape();
    raf = requestAnimationFrame(frame);
  }
  function animate(next) {
    spring = next;
    if (reduced.matches) {
      const goal = N.targetSize(state, sheet, near, liveWidth);
      motion.w = { x: goal.w, v: 0 }; motion.h = { x: goal.h, v: 0 };
      paintShape();
      return;
    }
    if (!raf) { lastT = 0; raf = requestAnimationFrame(frame); }
  }

  // ---- state
  let previous = state.view, pendingFocus = null;
  function dispatch(event, viaKeyboard) {
    const before = state;
    state = N.reduce(state, event);
    if (state === before) return;
    render(viaKeyboard);
  }
  function render(viaKeyboard) {
    const view = state.view, changed = view !== previous;
    shape.dataset.view = view;
    shape.dataset.live = state.live && view === 'rest' ? '1' : '';
    shape.dataset.busy = state.busy ? '1' : '';
    if (changed) {
      const opening = view !== 'rest';
      animate(viaKeyboard ? N.SPRING.key : opening ? N.SPRING.open : N.SPRING.close);
      if ((view === 'sheet') !== (previous === 'sheet')) api.notchOpened(view === 'sheet');
      if (previous === 'rest') api.notchRemember();
      if (previous !== 'rest' && view === 'rest') { closeSubViews(); api.notchBlur(); }
      previous = view;
    } else {
      animate(N.SPRING.near);
    }
    syncHolds();
    scheduleAutoHide();
  }
  function closeSubViews() { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); }

  // ---- what must keep the notch open
  let streamingUntil = 0, resizing = false;
  const open = sel => { const el = document.querySelector(sel); return !!el && !el.classList.contains('hidden'); };
  function holds() {
    const active = document.activeElement;
    const typing = !!active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') && !!active.value;
    return Number(typing || open('#settings-scrim') || open('#onboard-scrim') || resizing || Date.now() < streamingUntil);
  }
  function syncHolds() {
    const value = holds();
    if (value !== state.holds) { state = N.reduce(state, { type: 'holds', value }); }
    scheduleAutoHide();
  }
  new MutationObserver(() => { streamingUntil = Date.now() + 1800; }).observe($('messages'), { childList: true, subtree: true, characterData: true });
  document.addEventListener('focusin', syncHolds);
  document.addEventListener('input', syncHolds);

  // ---- pointer. Forwarded moves drive hover; the real cursor confirms leaving.
  let dwell = 0, tuck = 0, poll = 0;
  const overShape = (x, y, pad) => {
    const halfW = Math.max(motion.w.x, 150) / 2 + pad;
    return Math.abs(x - innerWidth / 2) <= halfW && y <= motion.h.x + pad;
  };
  function pointer(x, y) {
    if (state.view !== 'rest') scheduleAutoHide();
    const inside = overShape(x, y, EDGE_PX);
    const wasNear = near;
    near = !state.busy && state.view === 'rest' && overShape(x, y, NEAR_PX);
    if (inside !== state.inside) {
      dispatch({ type: inside ? 'enter' : 'leave' });
      clearTimeout(dwell); clearTimeout(tuck);
      if (inside) dwell = setTimeout(() => dispatch({ type: 'dwell' }), DWELL_MS);
      else tuck = setTimeout(() => { syncHolds(); dispatch({ type: 'tuck' }); }, TUCK_MS);
    }
    if (near !== wasNear) animate(N.SPRING.near);
  }
  document.addEventListener('mousemove', e => { if (!resizing) pointer(e.clientX, e.clientY); });
  document.addEventListener('pointerdown', () => { if (state.view !== 'rest') scheduleAutoHide(); });
  document.addEventListener('keydown', () => { if (state.view !== 'rest') scheduleAutoHide(); });
  function watchCursor() {
    clearInterval(poll);
    poll = setInterval(async () => {
      const p = await api.notchCursor().catch(() => null);
      if (!p || resizing) return;
      pointer(p.x, p.y);
      syncHolds();
      if (!state.inside) dispatch({ type: 'tuck' });
      if (state.view === 'rest' && !state.inside) { clearInterval(poll); poll = 0; }
    }, 110);
  }
  hit.addEventListener('mouseenter', watchCursor);
  shape.addEventListener('mouseenter', watchCursor);

  // ---- status line (replaces the dock)
  let last = {}, listenSince = 0, idle = 0, listenTick = 0;
  const clock = () => {
    const s = Math.max(0, Math.floor((Date.now() - listenSince) / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };
  function paintStatus(data) {
    last = data;
    clearInterval(listenTick);
    if (data.listening && !listenSince) listenSince = Date.now();
    if (!data.listening) listenSince = 0;
    const line = Status.describe(data, clock);
    clearTimeout(idle); // a timer left from an older status must not clear this one
    if (line.expires) idle = setTimeout(() => paintStatus({ ...last, [line.clear]: {} }), line.expires);
    if (line.listening) listenTick = setInterval(() => { $('n-text').textContent = $('np-status').textContent = 'LISTEN ' + clock(); }, 1000);
    $('n-step').textContent = line.step; $('n-text').textContent = line.text; $('n-sub').textContent = line.sub;
    $('n-key').textContent = line.key === 'OPEN' || line.key === 'ESC' ? line.key : '';
    $('n-led').className = line.led; $('np-led').className = line.led;
    $('np-status').textContent = line.live ? line.text : '';
    $('np-listen').classList.toggle('on', !!data.listening);
    shape.dataset.sweep = line.sweep ? '1' : '';
    // Measure the live pill from its text so it hugs the status, not a fixed box.
    liveWidth = Math.min(460, Math.max(180, $('notch-live').scrollWidth + 8));
    dispatch({ type: 'live', live: line.live, busy: line.busy });
    animate(N.SPRING.near);
    // Clicks and the synthetic cursor must pass straight through while Aether is driving the desktop.
    document.body.classList.toggle('notch-busy', line.busy && state.view === 'rest');
  }
  api.on('notch:state', paintStatus);

  // ---- commands from main (shortcuts, Show / hide)
  function focusField() {
    const field = $('input');
    if (field && !field.closest('.hidden')) field.focus();
  }
  api.on('notch:set', ({ open: shouldOpen, focus }) => {
    dispatch({ type: shouldOpen ? 'open' : 'close' }, true);
    if (shouldOpen && focus) focusField();
  });

  // ---- peek controls drive the real controls, so there is one implementation of each action.
  function expand(run) {
    dispatch({ type: 'expand' });
    api.notchFocus();
    pendingFocus = run;
    setTimeout(() => { const task = pendingFocus; pendingFocus = null; task?.(); }, 60);
  }
  $('notch-peek').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.id === 'np-ask' || 'ask' in button.dataset) { expand(focusField); return; }
    const target = document.querySelector(button.dataset.proxy || button.dataset.open);
    if ('stay' in button.dataset) target?.click();
    else expand(() => target?.click());
  });

  // A click on the bar itself is the fast path past the peek.
  const barClick = event => {
    if (!event.target.closest('#notch-peek, #notch-sheet')) expand(focusField);
  };
  shape.addEventListener('click', barClick);
  hit.addEventListener('click', barClick);

  $('notch-collapse').addEventListener('click', () => dispatch({ type: 'close' }));
  $('notch-hide').addEventListener('click', () => api.notchHide());
  const pin = $('notch-pin');
  const showPin = () => pin.setAttribute('aria-pressed', String(state.pinned));
  pin.addEventListener('click', () => { dispatch({ type: 'pin', value: !state.pinned }); store.set('aether.notch.pin', state.pinned); showPin(); });
  showPin();

  // Escape closes and stays closed until the pointer leaves. Settings and tutorials keep their own Escape.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || open('#settings-scrim') || open('#onboard-scrim')) return;
    dispatch({ type: 'escape' }, true);
  });

  // ---- resize from the edges; grows evenly from the notch and is remembered.
  for (const edge of document.querySelectorAll('.notch-edge')) {
    let from = null;
    edge.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      edge.setPointerCapture(event.pointerId);
      from = { x: event.clientX, y: event.clientY, ...sheet };
      resizing = true;
      shape.classList.add('resizing');
    });
    edge.addEventListener('pointermove', event => {
      if (!from) return;
      const type = edge.dataset.edge;
      const dx = (event.clientX - from.x) * 2, dy = event.clientY - from.y;
      sheet = N.clampSheet({
        w: from.w + (type.includes('e') ? dx : type.includes('w') ? -dx : 0),
        h: from.h + (type.includes('s') ? dy : 0)
      }, maxSheet());
      sheetVars();
      motion.w = { x: sheet.w, v: 0 }; motion.h = { x: sheet.h, v: 0 };
      paintShape();
    });
    const done = () => { if (!from) return; from = null; resizing = false; shape.classList.remove('resizing'); store.set('aether.notch.size', sheet); syncHolds(); };
    edge.addEventListener('pointerup', done);
    edge.addEventListener('pointercancel', done);
  }
  const sheetVars = () => { shape.style.setProperty('--sheet-w', sheet.w + 'px'); shape.style.setProperty('--sheet-h', sheet.h + 'px'); };
  addEventListener('resize', () => { sheet = N.clampSheet(sheet, maxSheet()); sheetVars(); });

  // First run: the tutorial lives in the sheet, so it must be open to be seen.
  new MutationObserver(() => { if (open('#onboard-scrim')) dispatch({ type: 'open' }); }).observe($('onboard-scrim'), { attributes: true, attributeFilter: ['class'] });

  sheetVars();
  shape.dataset.view = 'rest';
  paintShape();
  if (open('#onboard-scrim')) dispatch({ type: 'open' });
})();
