const { spawn } = require('node:child_process');

const MAX_BUFFER = 40 * 1024 * 1024;
const ownClass = value => /^(?:dev\.prahladv\.aether(?:\.desktop)?|aether|wingman)$/i.test(value);
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

function createDesktopControl({ env = process.env, pid = process.pid, call = run } = {}) {
  const locked = new WeakMap();
  const helperEnv = { ...env, YDOTOOL_SOCKET: env.YDOTOOL_SOCKET || (env.XDG_RUNTIME_DIR ? `${env.XDG_RUNTIME_DIR}/.ydotool_socket` : '') };
  async function invoke(command, args, signal, extra = {}) {
    cancelled(signal);
    try {
      const result = await call(command, args, { env: helperEnv, signal, timeout: 10000, maxBuffer: MAX_BUFFER, encoding: 'buffer', ...extra });
      cancelled(signal);
      return result.stdout;
    } catch (error) {
      cancelled(signal);
      if (error.name === 'AbortError') throw error;
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
    try { return windowData(JSON.parse(String(await invoke('hyprctl', ['-j', 'activewindow'], signal)))); }
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
    const png = await invoke('grim', ['-s', '1', '-g', `${x},${y} ${width}x${height}`, '-t', 'png', '-'], signal);
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
    if (!action || !['click', 'type', 'scroll'].includes(action.type)) throw new Error('Unsupported desktop action.');
    if (action.type === 'type') {
      if (typeof action.text !== 'string' || !action.text.length || action.text.length > 1000 || /[^\x20-\x7e]/.test(action.text)) throw new Error('Type accepts printable ASCII text only, without Enter or Tab.');
      if (!helperEnv.YDOTOOL_SOCKET) throw new Error('Configure the ydotool socket before desktop input.');
      // Focus checks and input are separate compositor operations, not atomic.
      // Small chunks bound text sent if focus changes during a helper call.
      for (let offset = 0; offset < action.text.length; offset += 8) {
        await validate(target, signal);
        await input(['type', '--key-delay', '2', '--key-hold', '2', '--file', '-'], { input: action.text.slice(offset, offset + 8) });
      }
      return;
    }
    if (![action.x, action.y].every(Number.isFinite) || action.x < 0 || action.y < 0 || action.x >= target.size[0] || action.y >= target.size[1]) throw new Error('Desktop coordinates are outside the captured window.');
    if (action.type === 'scroll' && (!Number.isSafeInteger(action.amount) || action.amount === 0 || Math.abs(action.amount) > 5)) throw new Error('Scroll amount must be a nonzero integer between -5 and 5.');
    if (!helperEnv.YDOTOOL_SOCKET) throw new Error('Configure the ydotool socket before desktop input.');
    const x = target.at[0] + Math.min(target.size[0] - 1, Math.round(action.x));
    const y = target.at[1] + Math.min(target.size[1] - 1, Math.round(action.y));
    async function checkPoint() {
      let clients;
      try { clients = JSON.parse(String(await invoke('hyprctl', ['-j', 'clients'], signal))); }
      catch (error) { cancelled(signal); throw new Error('Cannot check Aether window positions. Retry desktop control.'); }
      if (!Array.isArray(clients)) throw new Error('Cannot check Aether window positions.');
      for (const w of clients) {
        if (w.mapped !== true || !(ownClass(w.class) || w.pid === pid)) continue;
        if (!Array.isArray(w.at) || w.at.length !== 2 || !Array.isArray(w.size) || w.size.length !== 2 || [...w.at, ...w.size].some(n => !Number.isFinite(n)) || w.size.some(n => n <= 0)) throw new Error('Cannot check Aether window positions.');
        if (x >= w.at[0] && y >= w.at[1] && x < w.at[0] + w.size[0] && y < w.at[1] + w.size[1]) throw new Error('Move Aether away from the target point before acting.');
      }
    }
    await checkPoint();
    await validate(target, signal);
    const response = await invoke('hyprctl', ['eval', `hl.dispatch(hl.dsp.cursor.move({x=${x},y=${y}}))`], signal);
    if (String(response).trim() !== 'ok') throw new Error('Hyprland cursor move failed.');
    await checkPoint();
    await validate(target, signal);
    await input(action.type === 'click' ? ['click', '0xC0'] : ['mousemove', '-w', '-x', '0', '-y', String(-action.amount)]);
  }
  async function execute(target, action, signal) {
    let inputAttempted = false;
    const input = async (args, extra) => {
      cancelled(signal);
      inputAttempted = true;
      return invoke('ydotool', args, signal, extra);
    };
    try { await executeAction(target, action, signal, input); }
    catch (error) {
      if (inputAttempted) {
        // SIGKILL can interrupt a virtual key/button hold. Release on the same
        // ydotool device after the input helper closes, even after cancellation.
        // Only release after our own input attempt; never touch a physical device.
        const releases = [
          ['click', '0x80'],
          ['key', '--key-delay', '0', ...Array.from({ length: 127 }, (_, i) => `${i + 1}:0`)]
        ];
        let cleanupFailed = false;
        for (const args of releases) {
          try { await invoke('ydotool', args, undefined, { timeout: 750 }); }
          catch { cleanupFailed = true; }
        }
        if (cleanupFailed) {
          const failure = new Error('Desktop input stopped, but virtual key/button release failed. Restore the ydotool service/socket before continuing.', { cause: error });
          failure.code = 'INPUT_CLEANUP';
          throw failure;
        }
      }
      throw error;
    }
  }
  return { lockTarget, capture, execute };
}

module.exports = { createDesktopControl };
