const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { resizeBounds } = require('./window-resize');
const run = promisify(execFile);
const DOCK_W = 460, DOCK_H = 44;
const CLASS = 'dev.prahladv.aether';

// Native Wayland has no client-controlled always-on-top/placement protocol.
// Install the static rule before BrowserWindow maps, so it never takes a tile.
// Keep one session-owned rule across app restarts; no user config is rewritten.
const HYPR_RULE = String.raw`
for _, old in ipairs({"aether_overlay_rule_v1", "aether_overlay_rule_v2", "aether_overlay_rule_v3", "aether_overlay_rule_v4"}) do
  if _G[old] then _G[old]:set_enabled(false) end
end
if not _G.aether_overlay_rule_v5 then
  -- The panel follows the user across workspaces; desktop Auto unpins it for the run.
  _G.aether_overlay_rule_v5 = hl.window_rule({
    name = "aether-overlay",
    match = { class = "^dev\\.prahladv\\.aether$", title = "^Aether$" },
    float = true,
    pin = true,
    no_blur = true,
    no_shadow = true,
    size = {600, 600},
    center = true,
  })
  -- The dock is a taskbar extension: it stays on every workspace, like the bar.
  if _G.aether_dock_rule_v1 then _G.aether_dock_rule_v1:set_enabled(false) end
  _G.aether_dock_rule_v1 = hl.window_rule({
    name = "aether-dock",
    match = { class = "^dev\\.prahladv\\.aether$", title = "^Aether Dock$" },
    float = true,
    pin = true,
    no_blur = true,
    no_shadow = true,
    no_initial_focus = true,
    size = {${DOCK_W}, ${DOCK_H}},
  })
else
  _G.aether_overlay_rule_v5:set_enabled(true)
  _G.aether_dock_rule_v1:set_enabled(true)
end`;

function configureLinuxOverlay({ platform = process.platform, env = process.env, headless = false,
  call = args => execFileSync('hyprctl', args, { timeout: 1500, maxBuffer: 64 * 1024, encoding: 'utf8' }) } = {}) {
  if (platform !== 'linux' || headless || !env.HYPRLAND_INSTANCE_SIGNATURE) return false;
  try {
    if (call(['eval', HYPR_RULE.replace('${DOCK_W}', DOCK_W).replace('${DOCK_H}', DOCK_H)]).trim() !== 'ok') throw Error('Rule refused');
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
  // The dock shares this pid and class; only the panel (title Aether) is dragged or resized.
  const window = JSON.parse(callSync(['-j', 'clients'])).find(w => w.pid === pid && w.class === CLASS && w.title === 'Aether');
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

// Place one of Aether's own windows (by exact title) at absolute compositor coordinates.
// The dock goes top-center of the focused monitor, just under any reserved bar area;
// the panel opens centered just under the dock.
async function hyprPlace(kind, { pid = process.pid, env = process.env, platform = process.platform,
  call = async args => (await run('hyprctl', args, { timeout: 1500, maxBuffer: 1024 * 1024 })).stdout } = {}) {
  if (platform !== 'linux' || !env.HYPRLAND_INSTANCE_SIGNATURE) return false;
  if (!['dock', 'panel'].includes(kind) || !Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid window placement');
  const clients = JSON.parse(await call(['-j', 'clients'])).filter(w => w.pid === pid && w.class === CLASS && /^0x[0-9a-f]+$/i.test(w.address));
  const dock = clients.find(w => w.title === 'Aether Dock'), panel = clients.find(w => w.title === 'Aether');
  const target = kind === 'dock' ? dock : panel;
  if (!target) return false;
  let x, y;
  if (kind === 'dock') {
    const m = JSON.parse(await call(['-j', 'monitors'])).find(monitor => monitor.focused);
    if (!m) return false;
    const width = m.width / (m.scale || 1), top = (m.reserved?.[1] || 0);
    x = Math.round(m.x + (width - target.size[0]) / 2); y = Math.round(m.y + top + 6);
  } else {
    if (!dock) return false;
    x = Math.round(dock.at[0] + (dock.size[0] - target.size[0]) / 2); y = Math.round(dock.at[1] + dock.size[1] + 6);
  }
  if (![x, y].every(Number.isFinite)) return false;
  const script = `local w = hl.get_window("address:${target.address}"); if w and w.pid == ${pid} and w.class == "${CLASS}" then hl.dispatch(hl.dsp.window.move({x=${x},y=${y},relative=false,window=w})) end`;
  return (await call(['eval', script])).trim() === 'ok';
}

// Pin (follow every workspace) or unpin (stay put) the panel, then confirm the real state.
async function hyprSetPinned(pinned, { pid = process.pid, env = process.env, platform = process.platform,
  call = async args => (await run('hyprctl', args, { timeout: 1500, maxBuffer: 1024 * 1024 })).stdout } = {}) {
  if (platform !== 'linux' || !env.HYPRLAND_INSTANCE_SIGNATURE) return false;
  if (typeof pinned !== 'boolean' || !Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid pin request');
  const find = async () => JSON.parse(await call(['-j', 'clients'])).find(w => w.pid === pid && w.class === CLASS && w.title === 'Aether' && /^0x[0-9a-f]+$/i.test(w.address));
  const panel = await find();
  if (!panel) return false;
  if (panel.pinned === pinned) return true;
  // hl.dsp.window.pin toggles, so only dispatch when the state differs.
  const script = `local w = hl.get_window("address:${panel.address}"); if w and w.pid == ${pid} and w.class == "${CLASS}" and w.pinned ~= ${pinned} then hl.dispatch(hl.dsp.window.pin({window=w})) end`;
  if ((await call(['eval', script])).trim() !== 'ok') return false;
  return (await find())?.pinned === pinned;
}

module.exports = { configureLinuxOverlay, createHyprGesture, hyprPlace, hyprSetPinned, DOCK_W, DOCK_H };
