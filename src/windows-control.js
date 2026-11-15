const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage, screen } = require('electron');
const { captureScreenshot } = require('./screen');

const MAX_TEXT = 1000;
// Providers resize big screenshots before the model sees them, and then the model's coordinates no
// longer match the size we reported. Send a size no provider shrinks and map clicks back up.
const MAX_SHOT_WIDTH = 1600;
// Commands that hold a button or key; a killed one must be followed by `release`.
const HOLDS = new Set(['drag', 'type', 'clear', 'click-at']);

function cancelled(signal) {
  if (signal?.aborted) { const error = new Error('Desktop action cancelled.'); error.name = 'AbortError'; throw error; }
}

// skip: pids whose windows must not be locked (Aether's own panel is foreground when Auto starts),
// so the lock falls through to the next visible window below it in z-order.
function query(tool, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || 'Windows foreground-window query failed.')));
  });
}

async function foregroundWindow(signal, skip = [], tool = locateInputTool()) {
  const data = JSON.parse(await query(tool, skip.length ? ['fg', skip.join(',')] : ['fg'], signal));
  if (!Number.isSafeInteger(data.handle) || data.handle <= 0 || data.right <= data.left || data.bottom <= data.top) throw new Error('Target window unavailable. Focus the intended application and retry.');
  return Object.freeze({ handle: data.handle, left: data.left, top: data.top, width: data.right - data.left, height: data.bottom - data.top });
}

function locateInputTool() {
  const found = [
    process.env.YDOTOOL_PATH,
    app.isPackaged ? path.join(process.resourcesPath, 'tools', 'ydotool.exe') : path.join(__dirname, '..', 'tools', 'ydotool.exe')
  ].find(candidate => candidate && fs.existsSync(candidate));
  if (!found) throw new Error('ydotool.exe was not found. Run "npm run build:input" or set YDOTOOL_PATH to its full path.');
  return found;
}

// A killed hold command can leave a button or key down; `release` lifts whatever is still held.
function release(tool) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(tool, ['release'], { windowsHide: true, stdio: 'ignore' }); } catch { resolve(); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 1500);
    const done = () => { clearTimeout(timer); resolve(); };
    child.on('error', done);
    child.on('close', done);
  });
}

function invoke(tool, args, signal, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stderr = '', settled = false;
    const finish = async (error, killed) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (killed && HOLDS.has(args[0])) await release(tool);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(new Error('Windows input action timed out.'), true); }, timeout);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish(error, error?.name === 'AbortError'));
    child.on('close', code => finish(code === 0 ? null : new Error(stderr.trim() || 'Windows input action failed.')));
  });
}

function createWindowsControl({ capture = captureScreenshot, getSkipPids = () => app.getAppMetrics().map(m => m.pid), getDisplay = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) } = {}) {
  const tool = locateInputTool();
  let locked = null;
  let shot = null;
  async function validate(target, signal) {
    cancelled(signal);
    let current = await foregroundWindow(signal, [], tool);
    if (current.handle !== target.handle) {
      // Focus drifted (a click can hand focus to another window); bring the locked window back once.
      await invoke(tool, ['activate', String(target.handle)], signal);
      current = await foregroundWindow(signal, [], tool);
      if (current.handle !== target.handle) throw new Error('Target window changed. Focus it and start again.');
    }
    return current;
  }
  return {
    multiInput: true, // inputs are independent: Auto needn't re-capture between keypad presses
    async lockTarget(signal) { locked = await foregroundWindow(signal, getSkipPids(), tool); return locked; },
    async capture(target, signal) {
      await validate(target, signal);
      await invoke(tool, ['nudge'], signal);
      await new Promise(resolve => setTimeout(resolve, 180));
      const display = getDisplay();
      const scale = display.scaleFactor || 1;
      const imageDataUrl = await capture({ x: display.bounds.x + Math.floor(display.bounds.width / 2), y: display.bounds.y + Math.floor(display.bounds.height / 2) });
      if (!imageDataUrl) throw new Error('Windows screen capture returned no image.');
      // The screenshot is physical pixels; shrink it and remember the factor to map clicks back to the desktop.
      const fullWidth = Math.floor(display.size.width * scale), fullHeight = Math.floor(display.size.height * scale);
      let url = imageDataUrl, width = fullWidth, height = fullHeight;
      if (fullWidth > MAX_SHOT_WIDTH) {
        width = MAX_SHOT_WIDTH; height = Math.round(fullHeight * MAX_SHOT_WIDTH / fullWidth);
        url = nativeImage.createFromDataURL(imageDataUrl).resize({ width, height, quality: 'best' }).toDataURL();
      }
      shot = { display, scale, k: fullWidth / width };
      return { imageDataUrl: url, width, height };
    },
    async execute(target, action, signal) {
      if (!locked || locked.handle !== target.handle) throw new Error('Capture the locked target before acting.');
      await validate(target, signal);
      if (!shot) throw new Error('Capture the screen before acting.');
      // Screenshot pixels -> physical desktop pixels (display origin + DPI aware).
      const point = (x, y) => {
        const p = screen.dipToScreenPoint({ x: shot.display.bounds.x + x * shot.k / shot.scale, y: shot.display.bounds.y + y * shot.k / shot.scale });
        return [String(Math.round(p.x)), String(Math.round(p.y))];
      };
      if (action.type === 'type') {
        if (typeof action.text !== 'string' || !action.text.length || action.text.length > MAX_TEXT || /[^\x20-\x7e]/.test(action.text)) throw new Error('Windows Auto accepts printable ASCII text only.');
        await invoke(tool, ['type', '--human', '--wpm', '180', '-e', '0', '--', action.text], signal, Math.max(10000, action.text.length * 150));
        return;
      }
      if (action.type === 'clear') { await invoke(tool, ['clear'], signal); return; }
      if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) throw new Error('Windows action coordinates are invalid.');
      const [x, y] = point(action.x, action.y);
      if (action.type === 'click') await invoke(tool, ['click-at', x, y, String(action.clicks === 2 ? 2 : 1)], signal);
      else if (action.type === 'scroll') await invoke(tool, ['scroll', x, y, String(action.amount)], signal);
      else if (action.type === 'drag') {
        const [toX, toY] = point(action.toX, action.toY);
        await invoke(tool, ['drag', x, y, toX, toY], signal);
      } else throw new Error('Unsupported Windows Auto action.');
    },
    release() { locked = null; shot = null; }
  };
}

const activateWindow = handle => invoke(locateInputTool(), ['activate', String(handle)]);

module.exports = { createWindowsControl, foregroundWindow, activateWindow, locateInputTool };
