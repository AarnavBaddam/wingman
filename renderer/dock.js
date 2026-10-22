/* Aether dock: a status strip under the top bar. Click opens the panel; swipe up dismisses. */
(function () {
  const api = window.aetherDock;
  const $ = id => document.getElementById(id);
  const dock = $('dock');
  let listenSince = 0, listenTimer = null, idleTimer = null, last = {};

  const short = text => String(text || '').replace(/[.]+$/, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  function clock() {
    const s = Math.max(0, Math.floor((Date.now() - listenSince) / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function paint(state) {
    last = state;
    const auto = state.auto || {}, write = state.write || {}, led = $('led');
    clearInterval(listenTimer); listenTimer = null;
    let step = '', text = 'AETHER · READY', sub = '', key = state.toggleLabel || '', ledClass = 'led';
    if (auto.active) {
      step = auto.step ? String(auto.step).padStart(2, '0') : '';
      text = short(auto.message) || 'AUTO'; sub = auto.target === 'zen' ? 'ZEN' : 'DESK'; key = 'ESC'; ledClass = 'led on';
    } else if (write.status === 'typing') {
      text = 'WRITE ' + (write.typed || 0) + (write.total ? '/' + write.total : ''); sub = 'ZEN'; key = 'ESC'; ledClass = 'led on';
    } else if (write.status === 'done') {
      text = 'WRITE DONE'; ledClass = 'led on';
      clearTimeout(idleTimer); idleTimer = setTimeout(() => paint({ ...last, write: {} }), 8000);
    } else if (['drafting', 'humanising', 'detecting', 'armed'].includes(write.status) && write.stage) {
      text = 'WRITE · ' + String(write.status).toUpperCase(); key = 'OPEN'; ledClass = 'led on';
    } else if (['paused', 'error', 'skipped'].includes(auto.status) && auto.message) {
      text = short(auto.message); key = 'OPEN'; ledClass = 'led need';
    } else if (auto.status === 'done' && auto.message) {
      text = 'DONE · ' + short(auto.message); ledClass = 'led on';
      clearTimeout(idleTimer); idleTimer = setTimeout(() => paint({ ...last, auto: {} }), 8000);
    } else if (state.listening) {
      if (!listenSince) listenSince = Date.now();
      text = 'LISTEN ' + clock(); ledClass = 'led listen';
      listenTimer = setInterval(() => { $('text').textContent = 'LISTEN ' + clock(); }, 1000);
    }
    if (!state.listening) listenSince = 0;
    $('step').textContent = step; $('text').textContent = text; $('sub').textContent = sub; $('key').textContent = key;
    led.className = ledClass;
    dock.title = (auto.active ? short(auto.message) + ' · ' : '') + 'Click to open Aether · swipe up to dismiss';
  }
  api.onState(paint);

  // Click (no travel) opens; a swipe up or a long sideways flick dismisses.
  let start = null;
  dock.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY, moved: false };
    dock.setPointerCapture(event.pointerId);
  });
  dock.addEventListener('pointermove', event => {
    if (!start) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) start.moved = true;
    if (start.moved) dock.style.transform = `translate(${dx * 0.3}px, ${Math.min(0, dy)}px)`;
    if (dy < -16 || Math.abs(dx) > 90) {
      start = null; dock.style.transform = ''; dock.classList.add('gone');
      setTimeout(() => { api.dismiss(); dock.classList.remove('gone'); }, 200);
    }
  });
  const end = () => {
    if (!start) return;
    const clicked = !start.moved; start = null; dock.style.transform = '';
    if (clicked) api.activate();
  };
  dock.addEventListener('pointerup', end);
  dock.addEventListener('pointercancel', () => { start = null; dock.style.transform = ''; });
  dock.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); api.activate(); } });
  paint({});
})();
