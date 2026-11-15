const { execFileSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

function createHyprActivityWatcher({ onActivity, onError = () => {}, env = process.env, pid = process.pid,
  callSync = args => execFileSync('hyprctl', args, { env, timeout: 1500, encoding: 'utf8', maxBuffer: 1024 * 1024 }),
  connect = socketPath => net.createConnection(socketPath)
} = {}) {
  let current;
  const globalName = '__aether_activity_' + pid;
  const cleanup = `local handles = _G[${JSON.stringify(globalName)}]; if handles then for _, handle in ipairs(handles) do handle:remove() end end; _G[${JSON.stringify(globalName)}] = nil`;
  function install() {
    const options = 'non_consuming = true, ignore_mods = true';
    return `${cleanup}
local handles = {}; _G[${JSON.stringify(globalName)}] = handles
local function activity()
  local cursor = hl.get_cursor_pos()
  if not cursor or type(cursor.x) ~= "number" or type(cursor.y) ~= "number" or cursor.x ~= cursor.x or cursor.y ~= cursor.y or math.abs(cursor.x) > 1000000 or math.abs(cursor.y) > 1000000 then return end
  local own_mapped = false
  for _, w in ipairs(hl.get_windows()) do
    if w.class == "dev.prahladv.aether" and w.mapped then
      if w.pid == ${pid} then own_mapped = true end
      if cursor.x >= w.at.x and cursor.x < w.at.x + w.size.x and cursor.y >= w.at.y and cursor.y < w.at.y + w.size.y then return end
    end
  end
  if own_mapped then hl.dispatch(hl.dsp.event(string.format("aether-activity:${pid}:%d:%d", math.floor(cursor.x), math.floor(cursor.y)))) end
end
handles[#handles + 1] = hl.bind("mouse:272", activity, { ${options}, release = true })
${['mouse_up', 'mouse_down', 'mouse_left', 'mouse_right'].map(key => `handles[#handles + 1] = hl.bind("${key}", activity, { ${options} })`).join('\n')}`;
  }
  function dispose(state) {
    if (current === state) current = undefined;
    clearTimeout(state.timer);
    state.cancel?.(new Error('Hyprland activity watcher stopped.'));
    state.socket?.destroy();
    if (state.installing) {
      state.installing = false;
      const result = callSync(['eval', cleanup]);
      if (String(result).trim() !== 'ok') throw new Error('Hyprland could not remove activity bindings.');
    }
  }
  function fail(state, error) {
    if (current !== state) return;
    try { dispose(state); } catch (cleanupError) { onError(cleanupError); }
    onError(error);
  }
  return {
    start() {
      if (current) return current.promise;
      if (!Number.isSafeInteger(pid) || pid <= 0 || !path.isAbsolute(env.XDG_RUNTIME_DIR || '') || !/^[a-zA-Z0-9_-]+$/.test(env.HYPRLAND_INSTANCE_SIGNATURE || '')) {
        return Promise.reject(new Error('Hyprland activity requires a valid session environment and PID.'));
      }
      const state = { buffer: '', dropping: false, installing: false };
      current = state;
      state.promise = (async () => {
        try {
          await new Promise((resolve, reject) => {
            state.cancel = reject;
            const socketPath = path.join(env.XDG_RUNTIME_DIR, 'hypr', env.HYPRLAND_INSTANCE_SIGNATURE, '.socket2.sock');
            state.socket = connect(socketPath);
            state.socket.setEncoding('utf8');
            state.timer = setTimeout(() => reject(new Error('Hyprland activity socket timed out.')), 1500);
            state.socket.once('connect', resolve);
            state.socket.on('error', error => state.ready ? fail(state, error) : reject(error));
            state.socket.on('close', () => {
              if (current !== state) return;
              const error = new Error('Hyprland activity socket closed.');
              if (state.ready) fail(state, error); else reject(error);
            });
            state.socket.on('data', chunk => {
              if (current !== state || !state.ready) return;
              for (const part of String(chunk).split(/(?<=\n)/)) {
                const complete = part.endsWith('\n');
                if (!state.dropping && state.buffer.length + part.length <= 65536) state.buffer += part;
                else { state.buffer = ''; state.dropping = true; }
                if (complete) {
                  if (!state.dropping && state.buffer.startsWith('configreloaded>>')) {
                    fail(state, new Error('Hyprland configuration reloaded. Toggle auto Assist to reconnect.'));
                    return;
                  }
                  const point = !state.dropping && state.buffer.match(/^custom>>aether-activity:(\d+):(-?\d{1,7}):(-?\d{1,7})\n$/);
                  if (point && point[1] === String(pid) && Math.abs(Number(point[2])) <= 1000000 && Math.abs(Number(point[3])) <= 1000000) {
                    onActivity?.({ x: Number(point[2]), y: Number(point[3]) });
                  }
                  state.buffer = ''; state.dropping = false;
                }
              }
            });
          });
          clearTimeout(state.timer);
          state.cancel = undefined;
          if (current !== state) throw new Error('Hyprland activity watcher stopped.');
          state.installing = true;
          const result = callSync(['eval', install()]);
          if (String(result).trim() !== 'ok') throw new Error('Hyprland could not install activity bindings.');
          state.ready = true;
        } catch (error) {
          try { dispose(state); } catch (cleanupError) { onError(cleanupError); }
          throw error;
        }
      })();
      return state.promise;
    },
    stop() {
      if (!current) return;
      try { dispose(current); } catch (error) { onError(error); }
    }
  };
}

module.exports = { createHyprActivityWatcher };
