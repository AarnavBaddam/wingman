const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { BUTTONS_SCRIPT, pickButtons } = require('./zen-control');

// Chrome backend for Auto/Write mode over the DevTools Protocol. Same surface as
// zen-control so main.js and auto-session don't care which browser is behind it.
// Chrome >=136 ignores --remote-debugging-port on the default profile, so Aether
// launches Chrome with its own --user-data-dir.
const PORT = Number(process.env.AETHER_CHROME_PORT) || 9222;
const BASE = `http://127.0.0.1:${PORT}`;
const PROFILE = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Aether', 'chrome-profile');
const PNG = '89504e470d0a1a0a';

function cancelled(signal) {
  if (signal?.aborted) { const error = new Error('Chrome action cancelled.'); error.name = 'AbortError'; throw error; }
}

function locateChrome() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const found = [process.env.CHROME_PATH, ...roots.map(r => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'))].find(p => p && fs.existsSync(p));
  if (!found) throw new Error('Chrome was not found. Install it or set CHROME_PATH to chrome.exe.');
  return found;
}

async function getJson(url, init) {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000), ...init });
  if (!res.ok) throw new Error(`Chrome returned ${res.status}`);
  return res.json();
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url), pending = new Map();
    let id = 0;
    const conn = {
      closed: false,
      send(method, params = {}) {
        return new Promise((ok, no) => {
          if (conn.closed) return no(new Error('Chrome connection closed.'));
          const n = ++id; pending.set(n, { ok, no }); ws.send(JSON.stringify({ id: n, method, params }));
        });
      },
      close() { conn.closed = true; try { ws.close(); } catch {} }
    };
    ws.onopen = () => resolve(conn);
    ws.onerror = () => reject(new Error('Chrome DevTools connection failed.'));
    ws.onmessage = event => {
      const msg = JSON.parse(event.data), p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.no(new Error(msg.error.message)) : p.ok(msg.result);
    };
    ws.onclose = () => { conn.closed = true; for (const p of pending.values()) p.no(new Error('Chrome connection closed.')); pending.clear(); };
  });
}

function createChromeControl() {
  const targets = new Map(); // frozen target -> { conn, tabId, scale, view }
  let ready = false, queue = Promise.resolve();
  const enqueue = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

  async function connectInternal(signal) {
    cancelled(signal);
    try { await getJson(`${BASE}/json/version`); }
    catch {
      fs.mkdirSync(PROFILE, { recursive: true });
      spawn(locateChrome(), [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check'], { detached: true, stdio: 'ignore' }).unref();
      let up = false;
      for (let i = 0; i < 40 && !up; i++) {
        await new Promise(r => setTimeout(r, 500)); cancelled(signal);
        up = await getJson(`${BASE}/json/version`).then(() => true, () => false);
      }
      if (!up) throw new Error('Chrome automation unavailable. Close Chrome windows using the Aether profile and retry.');
    }
    ready = true;
  }
  function requireReady() { if (!ready) throw new Error('Connect Chrome automation first.'); }
  function state(target) {
    const s = targets.get(target); if (!s) throw new Error('Lock an exact Chrome tab first.');
    if (s.conn.closed) throw new Error('Chrome tab closed. Lock the tab again.');
    return s;
  }

  async function listTabs(signal) {
    requireReady(); cancelled(signal);
    const list = await getJson(`${BASE}/json/list`);
    return list.filter(t => t.type === 'page' && !t.url.startsWith('devtools://'))
      .map(t => ({ id: t.id, title: String(t.title).slice(0, 500), url: String(t.url).slice(0, 4000) }));
  }

  async function viewport(conn) {
    const { result } = await conn.send('Runtime.evaluate', { expression: '[innerWidth, innerHeight, devicePixelRatio]', returnByValue: true });
    const [width, height, dpr] = result.value;
    return { width, height, dpr };
  }

  async function lockTarget(id, signal) {
    requireReady(); cancelled(signal);
    const tab = (await getJson(`${BASE}/json/list`)).find(t => t.id === id && t.type === 'page');
    if (!tab) throw new Error('Chrome tab not found. Refresh the tab list.');
    const conn = await openSocket(tab.webSocketDebuggerUrl);
    await conn.send('Page.enable');
    await conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }); // page keeps input focus even if its window isn't foreground
    await conn.send('Page.bringToFront');
    const view = await viewport(conn);
    const width = Math.floor(view.width * view.dpr), height = Math.floor(view.height * view.dpr);
    const target = Object.freeze({ id, width, height, size: Object.freeze([width, height]) });
    targets.set(target, { conn, view, scale: view.dpr });
    return target;
  }

  async function capture(target, signal) {
    const s = state(target); cancelled(signal);
    s.view = await viewport(s.conn);
    const { data } = await s.conn.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const png = Buffer.from(data, 'base64');
    if (png.length < 33 || png.subarray(0, 8).toString('hex') !== PNG) throw new Error('Invalid Chrome screenshot.');
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    s.scale = width / s.view.width;
    return { imageDataUrl: `data:image/png;base64,${data}`, width, height };
  }

  const mouse = (s, type, x, y, extra = {}) => s.conn.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
  const keyPress = async (s, key, code, extra = {}) => {
    await s.conn.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, ...extra });
    await s.conn.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, ...extra });
  };
  async function typeChar(s, ch) {
    if (ch === '\n') return keyPress(s, 'Enter', 'Enter', { windowsVirtualKeyCode: 13, text: '\r' });
    await s.conn.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch });
    await s.conn.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }

  async function execute(target, action, signal) {
    const s = state(target); cancelled(signal);
    if (action.type === 'type') { for (const ch of action.text) { cancelled(signal); await typeChar(s, ch); } return; }
    if (action.type === 'clear') {
      // Fixed Ctrl+A then Backspace in the focused field; never a model-chosen key.
      await keyPress(s, 'a', 'KeyA', { modifiers: 2, commands: ['selectAll'], windowsVirtualKeyCode: 65 });
      return keyPress(s, 'Backspace', 'Backspace', { windowsVirtualKeyCode: 8 });
    }
    const at = (px, py) => [Math.min(s.view.width - 1, Math.floor(px / s.scale)), Math.min(s.view.height - 1, Math.floor(py / s.scale))];
    if (![action.x, action.y].every(Number.isFinite)) throw new Error('Chrome action coordinates are invalid.');
    const [x, y] = at(action.x, action.y);
    await mouse(s, 'mouseMoved', x, y, { button: 'none' });
    if (action.type === 'scroll') return mouse(s, 'mouseWheel', x, y, { button: 'none', deltaX: 0, deltaY: action.amount * 120 });
    if (action.type === 'click') {
      for (let n = 1; n <= (action.clicks === 2 ? 2 : 1); n++) {
        await mouse(s, 'mousePressed', x, y, { clickCount: n, buttons: 1 });
        await mouse(s, 'mouseReleased', x, y, { clickCount: n });
      }
      return;
    }
    if (action.type === 'drag') {
      const [toX, toY] = at(action.toX, action.toY);
      await mouse(s, 'mousePressed', x, y, { clickCount: 1, buttons: 1 });
      await new Promise(r => setTimeout(r, 120));
      try {
        for (let i = 1; i <= 12; i++) {
          cancelled(signal);
          await mouse(s, 'mouseMoved', Math.round(x + (toX - x) * i / 12), Math.round(y + (toY - y) * i / 12), { buttons: 1 });
          await new Promise(r => setTimeout(r, 40));
        }
      } finally { await mouse(s, 'mouseReleased', toX, toY, { clickCount: 1 }); }
      return;
    }
    throw new Error('Unsupported Chrome action.');
  }

  async function findButtons(target, chars, signal) {
    const s = state(target); cancelled(signal);
    const { result, exceptionDetails } = await s.conn.send('Runtime.evaluate', {
      expression: `(function(){${BUTTONS_SCRIPT}}).apply(null, [${JSON.stringify(chars)}])`, returnByValue: true });
    if (exceptionDetails) throw new Error('Chrome button lookup failed.');
    const points = {};
    for (const [key, p] of Object.entries(pickButtons(result.value))) {
      const x = Math.round(p.x * s.scale), y = Math.round(p.y * s.scale);
      if (chars.includes(key) && x >= 0 && y >= 0) points[key] = { x, y };
    }
    return points;
  }

  // Write mode: one already-paced key per call; any non-printable token is Backspace.
  async function writeKey(target, token, signal) {
    const s = state(target); cancelled(signal);
    if (/^[\x20-\x7e]$/.test(token)) return typeChar(s, token);
    return keyPress(s, 'Backspace', 'Backspace', { windowsVirtualKeyCode: 8 });
  }
  async function focusTab(target, signal) {
    const s = state(target); cancelled(signal);
    await s.conn.send('Page.bringToFront');
  }
  function drop(target) { const s = targets.get(target); if (s) { s.conn.close(); targets.delete(target); } }

  return {
    connect: signal => enqueue(() => connectInternal(signal)),
    listTabs: signal => enqueue(() => listTabs(signal)),
    lockTarget: (id, signal) => enqueue(() => lockTarget(id, signal)),
    capture: (target, signal) => enqueue(() => capture(target, signal)),
    execute: (target, action, signal) => enqueue(() => execute(target, action, signal)),
    findButtons: (target, chars, signal) => enqueue(() => findButtons(target, chars, signal)),
    writeKey: (target, token, signal) => enqueue(() => writeKey(target, token, signal)),
    focusTab: (target, signal) => enqueue(() => focusTab(target, signal)),
    release: target => enqueue(() => drop(target)),
    openUrl: url => enqueue(async () => { requireReady(); await getJson(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }); }),
    close: () => enqueue(() => { ready = false; for (const t of [...targets.keys()]) drop(t); })
  };
}

module.exports = { createChromeControl, locateChrome };
