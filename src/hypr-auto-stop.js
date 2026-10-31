const { execFileSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

function createHyprAutoStop({ onStop = () => {}, env = process.env, pid = process.pid,
  callSync = args => execFileSync('hyprctl', args, { env, timeout: 1500, encoding: 'utf8', maxBuffer: 1024 * 1024 }),
  connect = socketPath => net.createConnection(socketPath)
} = {}) {
  let current;
  const globalName = '__aether_auto_stop_' + pid;
  const cleanup = `local handle = _G[${JSON.stringify(globalName)}]; if handle then handle:remove() end; _G[${JSON.stringify(globalName)}] = nil`;
  const install = `${cleanup}
_G[${JSON.stringify(globalName)}] = hl.bind("Escape", function() hl.dispatch(hl.dsp.event("aether-auto-stop:${pid}")) end, { non_consuming = true, ignore_mods = true, description = "Aether: Stop Auto" })`;

  function dispose(state) {
    if (state.disposed) return;
    state.disposed = true;
    if (current === state) current = undefined;
    clearTimeout(state.timer);
    state.cancel?.(new Error('Hyprland Auto stop listener stopped.'));
    state.socket?.destroy();
    if (state.installing) {
      state.installing = false;
      if (String(callSync(['eval', cleanup])).trim() !== 'ok') throw new Error('Hyprland could not remove the Auto Escape binding.');
    }
  }
  function fail(state, reason) {
    if (current !== state) return;
    try { dispose(state); }
    catch (error) { reason += ' Cleanup failed: ' + error.message; }
    onStop(reason);
  }
  return {
    start() {
      if (current) return current.promise;
      if (!Number.isSafeInteger(pid) || pid <= 0 || !path.isAbsolute(env.XDG_RUNTIME_DIR || '') || !/^[a-zA-Z0-9_-]+$/.test(env.HYPRLAND_INSTANCE_SIGNATURE || '')) {
        return Promise.reject(new Error('Hyprland Auto stop requires a valid session environment and PID.'));
      }
      const state = { buffer: '', dropping: false, installing: false };
      current = state;
      state.promise = (async () => {
        try {
          await new Promise((resolve, reject) => {
            state.cancel = reject;
            state.socket = connect(path.join(env.XDG_RUNTIME_DIR, 'hypr', env.HYPRLAND_INSTANCE_SIGNATURE, '.socket2.sock'));
            state.socket.setEncoding('utf8');
            state.timer = setTimeout(() => reject(new Error('Hyprland Auto stop socket timed out.')), 1500);
            state.socket.once('connect', resolve);
            state.socket.on('error', error => {
              state.connectionError = error;
              if (state.ready) fail(state, 'Auto stopped: Hyprland Escape listener failed: ' + error.message);
              else reject(error);
            });
            state.socket.on('close', () => {
              state.connectionError = new Error('Hyprland Auto stop socket closed.');
              if (current !== state) return;
              if (state.ready) fail(state, 'Auto stopped: Hyprland Escape listener disconnected.');
              else reject(state.connectionError);
            });
            state.socket.on('data', chunk => {
              if (current !== state || !state.ready) return;
              for (const part of String(chunk).split(/(?<=\n)/)) {
                const complete = part.endsWith('\n');
                if (!state.dropping && state.buffer.length + part.length <= 65536) state.buffer += part;
                else { state.buffer = ''; state.dropping = true; }
                if (!complete) continue;
                if (!state.dropping && state.buffer.startsWith('configreloaded>>')) {
                  fail(state, 'Auto stopped: Hyprland configuration reloaded; the Escape listener must reconnect.');
                  return;
                }
                if (!state.dropping && state.buffer === `custom>>aether-auto-stop:${pid}\n`) {
                  fail(state, 'Auto stopped: Escape pressed.');
                  return;
                }
                state.buffer = ''; state.dropping = false;
              }
            });
          });
          clearTimeout(state.timer);
          state.cancel = undefined;
          if (current !== state) throw new Error('Hyprland Auto stop listener stopped.');
          if (state.connectionError) throw state.connectionError;
          state.installing = true;
          if (String(callSync(['eval', install])).trim() !== 'ok') throw new Error('Hyprland could not install the Auto Escape binding.');
          state.ready = true;
        } catch (error) {
          try { dispose(state); } catch (cleanupError) { onStop('Auto stopped: Escape cleanup failed: ' + cleanupError.message); }
          throw error;
        }
      })();
      return state.promise;
    },
    stop() {
      if (!current) return;
      try { dispose(current); } catch (error) { onStop('Auto stopped: Escape cleanup failed: ' + error.message); }
    }
  };
}

module.exports = { createHyprAutoStop };
