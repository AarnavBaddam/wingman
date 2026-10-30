/* Aether dock: a status strip under the top bar. Click opens the panel; swipe up dismisses. */
(function () {
  const api = window.aetherDock;
  const $ = id => document.getElementById(id);
  const dock = $('dock');
  let listenSince = 0, listenTimer = null, idleTimer = null, last = {};

  function clock() {
    const s = Math.max(0, Math.floor((Date.now() - listenSince) / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function paint(state) {
    last = state;
    clearInterval(listenTimer); listenTimer = null;
    if (state.listening && !listenSince) listenSince = Date.now();
    if (!state.listening) listenSince = 0;
    const line = window.AetherStatus.describe(state, clock);
    if (line.expires) { clearTimeout(idleTimer); idleTimer = setTimeout(() => paint({ ...last, [line.clear]: {} }), line.expires); }
    if (line.listening) listenTimer = setInterval(() => { $('text').textContent = 'LISTEN ' + clock(); }, 1000);
    $('step').textContent = line.step; $('text').textContent = line.text; $('sub').textContent = line.sub; $('key').textContent = line.key;
    $('led').className = line.led;
    dock.title = (line.title ? line.title + ' · ' : '') + 'Click to open Aether · swipe up to dismiss';
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
