const { spawn } = require('node:child_process');
const macdaemon = require('../packages/macdotool/client');

const MAX_BUFFER = 40 * 1024 * 1024;
const ownClass = value => /^(?:dev\.prahladv\.aether(?:\.desktop)?|aether|wingman)$/i.test(value);
// Fitts-like cursor travel time (ms) for the macOS smooth move: longer trips take a little longer, capped.
const smoothMs = distance => Math.round(Math.min(90, 25 + 10 * Math.log2(1 + distance / 40)));
// Minimum-jerk position fraction, so drags accelerate and settle like a hand.
const minJerk = t => t * t * t * (10 - 15 * t + 6 * t * t);
const cancelled = signal => { if (signal?.aborted) { const error = new Error('Desktop action cancelled.'); error.name = 'AbortError'; throw error; } };

// No shell, bounded binary output, and stdin rather than command arguments for text.
function run(command, args, options) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command, args, { env: options.env, signal: options.signal, killSignal: 'SIGKILL', shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    const chunks = []; let bytes = 0, failure = null;
    const stop = error => {
      failure ||= error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop(new Error('Desktop helper timed out')), options.timeout);
    // Abort emits error before close: wait for close so cleanup cannot race the
    // dying input process and accidentally be followed by another key press.
    child.on('error', error => { failure ||= error; });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > options.maxBuffer) stop(new Error('Desktop helper output exceeded limit'));
      else if (!failure) chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(failure || new Error('Desktop helper failed'));
      else resolve({ stdout: Buffer.concat(chunks) });
    });
    child.stdin.end(options.input || '');
  });
}

function createDesktopControl({ env = process.env, pid = process.pid, platform = process.platform, call = platform === 'darwin' ? macdaemon.call : run,
  macdotool = platform === 'darwin' ? require('../packages/macdotool').binaryPath() : 'macdotool' } = {}) {
  const locked = new WeakMap();
  const mac = platform === 'darwin';
  // macdotool mirrors ydotool's argv and hyprctl's JSON, so only command names differ per platform.
  const inputTool = mac ? macdotool : 'ydotool';
  const helperEnv = mac ? env : { ...env, YDOTOOL_SOCKET: env.YDOTOOL_SOCKET || (env.XDG_RUNTIME_DIR ? `${env.XDG_RUNTIME_DIR}/.ydotool_socket` : '') };
  const query = (what, signal) => mac ? invoke(macdotool, [what], signal) : invoke('hyprctl', ['-j', what], signal);
  async function moveCursor(x, y, signal, smooth = []) {
    if (mac) { await invoke(macdotool, ['mousemove', '--absolute', '-x', String(x), '-y', String(y), ...smooth], signal); return; }
    const response = await invoke('hyprctl', ['eval', `hl.dispatch(hl.dsp.cursor.move({x=${x},y=${y}}))`], signal);
    if (String(response).trim() !== 'ok') throw new Error('Hyprland cursor move failed.');
  }
  async function invoke(command, args, signal, extra = {}) {
    cancelled(signal);
    try {
      const result = await call(command, args, { env: helperEnv, signal, timeout: 10000, maxBuffer: MAX_BUFFER, encoding: 'buffer', ...extra });
      cancelled(signal);
      return result.stdout;
    } catch (error) {
      cancelled(signal);
      if (error.name === 'AbortError') throw error;
      if (mac) {
        if (args[0] === 'capture') throw new Error('Desktop capture failed. Allow Aether in System Settings > Privacy & Security > Screen Recording, then retry.');
        if (['debug', 'click', 'mousemove', 'type', 'key'].includes(args[0])) throw new Error('Desktop input failed. Allow Aether in System Settings > Privacy & Security > Accessibility, then retry.', { cause: error });
        throw new Error('Desktop control failed. Allow Aether in System Settings > Privacy & Security > Accessibility, then retry.');
      }
      if (command === 'ydotool') throw new Error(`Desktop input failed. Run systemctl --user start ydotool, then check YDOTOOL_SOCKET (${helperEnv.YDOTOOL_SOCKET || 'not configured'}) and /dev/uinput permissions.`, { cause: error });
      throw new Error(`Desktop ${command === 'grim' ? 'capture' : 'control'} failed. Check Hyprland, grim, and the ydotool service/socket.`);
    }
  }
  function windowData(w) {
    if (!w || w.mapped !== true || !/^0x[0-9a-f]+$/i.test(w.address) || /^0x0+$/i.test(w.address) ||
        !Number.isSafeInteger(w.pid) || w.pid < 1 || w.pid === pid || typeof w.class !== 'string' || !w.class || ownClass(w.class) ||
        !Array.isArray(w.at) || w.at.length !== 2 || !Array.isArray(w.size) || w.size.length !== 2 ||
        !w.at.every(n => Number.isSafeInteger(n) && Math.abs(n) <= 1000000) ||
        !w.size.every(n => Number.isSafeInteger(n) && n > 0 && n <= 32768)) throw new Error('Select a mapped application window outside Aether.');
    return { address: w.address, pid: w.pid, class: w.class, at: Object.freeze([...w.at]), size: Object.freeze([...w.size]) };
  }
  async function active(signal) {
    try { return windowData(JSON.parse(String(await query('activewindow', signal)))); }
    catch (error) { cancelled(signal); throw new Error('Target window unavailable. Focus the intended application and retry.'); }
  }
  async function validate(target, signal) {
    cancelled(signal);
    if (!locked.has(target)) throw new Error('Lock an application window first.');
    const current = await active(signal);
    if (JSON.stringify(current) !== JSON.stringify(target)) throw new Error('Target window changed. Focus it and start again.');
  }
  async function lockTarget(signal) {
    const target = Object.freeze(await active(signal));
    locked.set(target, false);
    return target;
  }
  async function capture(target, signal) {
    await validate(target, signal);
    // Invalidate the previous image even if this capture fails.
    locked.set(target, false);
    const [x, y] = target.at, [width, height] = target.size;
    const geometry = `${x},${y} ${width}x${height}`;
    const png = mac ? await invoke(macdotool, ['capture', '-g', geometry], signal) : await invoke('grim', ['-s', '1', '-g', geometry, '-t', 'png', '-'], signal);
    await validate(target, signal);
    if (!Buffer.isBuffer(png) || png.length < 33 || png.length > MAX_BUFFER ||
        png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR' ||
        png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) throw new Error('Screenshot dimensions changed. Capture the target again.');
    locked.set(target, true);
    return { imageDataUrl: 'data:image/png;base64,' + png.toString('base64'), width, height };
  }
  async function executeAction(target, action, signal, input) {
    const authorized = locked.get(target);
    // Every attempt consumes its image, including validation errors and cancellation.
    if (authorized) locked.set(target, false);
    cancelled(signal);
    if (!authorized) throw new Error('Capture the locked target before acting.');
    if (!action || !['click', 'type', 'scroll', 'drag'].includes(action.type)) throw new Error('Unsupported desktop action.');
    if (action.type === 'type') {
      if (typeof action.text !== 'string' || !action.text.length || action.text.length > 1000 || /[^\x20-\x7e]/.test(action.text)) throw new Error('Type accepts printable ASCII text only, without Enter or Tab.');
      if (!mac && !helperEnv.YDOTOOL_SOCKET) throw new Error('Configure the ydotool socket before desktop input.');
      // Focus checks and input are separate compositor operations, not atomic.
      // Small chunks bound text sent if focus changes during a helper call.
      for (let offset = 0; offset < action.text.length; offset += 8) {
        await validate(target, signal);
        await input(mac ? ['type', '--key-delay', '1', '--key-hold', '1', '-e', '0', '--file', '-'] : ['type', '--key-delay', '2', '--key-hold', '2', '--file', '-'], { input: action.text.slice(offset, offset + 8) });
      }
      return;
    }
    if (![action.x, action.y].every(Number.isFinite) || action.x < 0 || action.y < 0 || action.x >= target.size[0] || action.y >= target.size[1]) throw new Error('Desktop coordinates are outside the captured window.');
    if (action.type === 'drag' && (![action.toX, action.toY].every(Number.isFinite) || action.toX < 0 || action.toY < 0 || action.toX >= target.size[0] || action.toY >= target.size[1])) throw new Error('Desktop drag destination is outside the captured window.');
    if (action.type === 'scroll' && (!Number.isSafeInteger(action.amount) || action.amount === 0 || Math.abs(action.amount) > 5)) throw new Error('Scroll amount must be a nonzero integer between -5 and 5.');
    if (!mac && !helperEnv.YDOTOOL_SOCKET) throw new Error('Configure the ydotool socket before desktop input.');
    const x = target.at[0] + Math.min(target.size[0] - 1, Math.round(action.x));
    const y = target.at[1] + Math.min(target.size[1] - 1, Math.round(action.y));
    async function checkPoint(px = x, py = y) {
      let clients;
      try { clients = JSON.parse(String(await query('clients', signal))); }
      catch (error) { cancelled(signal); throw new Error('Cannot check Aether window positions. Retry desktop control.'); }
      if (!Array.isArray(clients)) throw new Error('Cannot check Aether window positions.');
      for (const w of clients) {
        if (w.mapped !== true || !(ownClass(w.class) || w.pid === pid)) continue;
        if (!Array.isArray(w.at) || w.at.length !== 2 || !Array.isArray(w.size) || w.size.length !== 2 || [...w.at, ...w.size].some(n => !Number.isFinite(n)) || w.size.some(n => n <= 0)) throw new Error('Cannot check Aether window positions.');
        if (px >= w.at[0] && py >= w.at[1] && px < w.at[0] + w.size[0] && py < w.at[1] + w.size[1]) throw new Error('Move Aether away from the target point before acting.');
      }
    }
    await checkPoint();
    await validate(target, signal);
    let smooth = [];
    if (mac) {
      let ms = 40;
      try { const p = JSON.parse(String(await query('cursorpos', signal))); const d = Math.hypot(x - p.x, y - p.y); if (Number.isFinite(d)) ms = smoothMs(d); }
      catch { cancelled(signal); }
      smooth = ['--smooth', String(ms)];
    }
    await moveCursor(x, y, signal, smooth);
    await checkPoint();
    await validate(target, signal);
    if (action.type === 'drag') {
      const endX = Math.min(target.size[0] - 1, Math.round(action.toX));
      const endY = Math.min(target.size[1] - 1, Math.round(action.toY));
      await input(['click', '0x40']);
      for (let i = 1; i <= 12; i++) {
        const px = Math.round(mac ? x + (target.at[0] + endX - x) * minJerk(i / 12) : x + (target.at[0] + endX - x) * i / 12);
        const py = Math.round(mac ? y + (target.at[1] + endY - y) * minJerk(i / 12) : y + (target.at[1] + endY - y) * i / 12);
        await checkPoint(px, py); await validate(target, signal);
        await moveCursor(px, py, signal, mac ? ['--smooth', '16', '--ease', 'linear'] : []);
        if (!mac) await new Promise(resolve => setTimeout(resolve, 40));
      }
      await checkPoint(target.at[0] + endX, target.at[1] + endY);
      await validate(target, signal);
      await input(['click', '0x80']);
      return;
    }
    await input(action.type === 'click' ? ['click', '0xC0'] : ['mousemove', '-w', '-x', '0', '-y', String(-action.amount)]);
  }
  async function execute(target, action, signal) {
    let inputAttempted = false, connected = false;
    const input = async (args, extra) => {
      cancelled(signal);
      if (!connected) {
        // debug connects to the daemon without emitting input. Fail before cleanup
        // is needed, and recheck focus after the extra helper round trip.
        await invoke(inputTool, ['debug'], signal);
        await validate(target, signal);
        connected = true;
      }
      inputAttempted = true;
      return invoke(inputTool, args, signal, extra);
    };
    try { await executeAction(target, action, signal, input); }
    catch (error) {
      if (inputAttempted) {
        // SIGKILL can interrupt a virtual key/button hold. Release on the same
        // ydotool device after the input helper closes, even after cancellation.
        // Only release after our own input attempt; never touch a physical device.
        // macdotool type only ever presses virtual keycode 0.
        const releases = [
          ['click', '0x80'],
          ['key', '--key-delay', '0', ...(mac ? ['0:0'] : Array.from({ length: 127 }, (_, i) => `${i + 1}:0`))]
        ];
        let cleanupFailed = false;
        for (const args of releases) {
          try { await invoke(inputTool, args, undefined, { timeout: 750 }); }
          catch { cleanupFailed = true; }
        }
        if (cleanupFailed) {
          const failure = new Error(mac ? 'Desktop input stopped, but virtual key/button release failed. Check Aether\'s Accessibility permission before continuing.'
            : 'Desktop input stopped, but virtual key/button release failed. Restore the ydotool service/socket before continuing.', { cause: error });
          failure.code = 'INPUT_CLEANUP';
          throw failure;
        }
      }
      throw error;
    }
  }
  return { lockTarget, capture, execute };
}

module.exports = { createDesktopControl, smoothMs };
