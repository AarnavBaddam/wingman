const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { resizeBounds } = require('./window-resize');
const run = promisify(execFile);

// Native Wayland has no client-controlled always-on-top/placement protocol.
// Install the static rule before BrowserWindow maps, so it never takes a tile.
// Keep one session-owned rule across app restarts; no user config is rewritten.
const HYPR_RULE = String.raw`
if _G.aether_overlay_rule_v1 then _G.aether_overlay_rule_v1:set_enabled(false) end
if _G.aether_overlay_rule_v2 then _G.aether_overlay_rule_v2:set_enabled(false) end
if not _G.aether_overlay_rule_v3 then
  _G.aether_overlay_rule_v3 = hl.window_rule({
    name = "aether-overlay",
    match = { class = "^dev\\.prahladv\\.aether$" },
    float = true,
    pin = false,
    no_blur = true,
    no_shadow = true,
    size = {700, 420},
    center = true,
  })
else
  _G.aether_overlay_rule_v3:set_enabled(true)
end`;

function configureLinuxOverlay({ platform = process.platform, env = process.env, headless = false,
  call = args => execFileSync('hyprctl', args, { timeout: 1500, maxBuffer: 64 * 1024, encoding: 'utf8' }) } = {}) {
  if (platform !== 'linux' || headless || !env.HYPRLAND_INSTANCE_SIGNATURE) return false;
  try {
    if (call(['eval', HYPR_RULE]).trim() !== 'ok') throw Error('Rule refused');
    return true;
  } catch {
    throw new Error('Hyprland floating overlay setup failed. Aether needs hyprctl and Hyprland 0.55+ with Lua support. Check the Linux desktop setup in README.');
  }
}

// Absolute moves never change workspace, so a window dragged onto another monitor
// stayed bound to the old monitor's workspace. On release, adopt the workspace of
// the monitor under the window center (silently, then restore the exact position).
const REBIND = (b, address) => ` local m = hl.get_monitor_at(${b.x + b.width / 2}, ${b.y + b.height / 2}); local ws = m and m.active_workspace; if ws and w.workspace.id ~= ws.id then hl.dispatch(hl.dsp.window.move({workspace=ws.id, follow=false, window=w})); w = hl.get_window("address:${address}"); if w then hl.dispatch(hl.dsp.window.move({x=${b.x},y=${b.y},relative=false,window=w})) end end`;

function createHyprGesture(mode, { platform = process.platform, env = process.env, pid = process.pid,
  callSync = args => execFileSync('hyprctl', args, { timeout: 1500, maxBuffer: 1024 * 1024, encoding: 'utf8' }),
  call = async args => (await run('hyprctl', args, { timeout: 1500, maxBuffer: 64 * 1024 })).stdout } = {}) {
  if (platform !== 'linux' || !env.HYPRLAND_INSTANCE_SIGNATURE) return null;
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid window process');
  if (!['move', 'bottom-left', 'bottom-right'].includes(mode)) throw new Error('Invalid window gesture');
  const window = JSON.parse(callSync(['-j', 'clients'])).find(w => w.pid === pid && w.class === 'dev.prahladv.aether');
  const start = JSON.parse(callSync(['-j', 'cursorpos']));
  if (!window || !window.floating || !/^0x[0-9a-f]+$/i.test(window.address) || ![...window.at, ...window.size, start.x, start.y].every(Number.isFinite)) throw new Error('Aether floating window unavailable');
  const initial = { x: window.at[0], y: window.at[1], width: window.size[0], height: window.size[1] };
  let active = true, running = null, pending = false;
  async function applyPoint(point, rebind = false) {
    if (![point.x, point.y].every(Number.isFinite)) throw new Error('Invalid cursor position');
    const dx = point.x - start.x, dy = point.y - start.y;
    const bounds = mode === 'move' ? { ...initial, x: Math.round(initial.x + dx), y: Math.round(initial.y + dy) } : resizeBounds(initial, mode, dx, dy);
    const script = `local w = hl.get_window("address:${window.address}"); if w and w.pid == ${pid} and w.class == "dev.prahladv.aether" then hl.dispatch(hl.dsp.window.resize({x=${bounds.width},y=${bounds.height},relative=false,window=w})); hl.dispatch(hl.dsp.window.move({x=${bounds.x},y=${bounds.y},relative=false,window=w}));${rebind ? REBIND(bounds, window.address) : ''} end`;
    if ((await call(['eval', script])).trim() !== 'ok') throw new Error('Hyprland window update failed');
  }
  const gesture = {
    update() {
      pending = true;
      if (running) return running;
      running = (async () => { try {
        // Coalesce pointer motion; never queue a subprocess for every mouse event.
        while (active && pending) {
          pending = false;
          const point = JSON.parse(await call(['-j', 'cursorpos']));
          if (!active) break;
          await applyPoint(point);
        }
      } finally { running = null; } })();
      return running;
    },
    async finish() {
      // Freeze the release position now, before asynchronous work can sample a later move.
      try {
        const point = JSON.parse(callSync(['-j', 'cursorpos']));
        pending = false;
        await running; if (active) await applyPoint(point, true);
      }
      finally { gesture.stop(); }
    },
    stop() { active = false; pending = false; }
  };
  return gesture;
}

module.exports = { configureLinuxOverlay, createHyprGesture };
