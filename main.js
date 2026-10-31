const DEBUG = false; // Set to false to disable debug logging
const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell } = require('electron');
const path = require('path');
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { createLLM } = require('./src/llm');
const { getEvidence, searchWeb, researchPrompt, validateGroundedAnswer, needsWebFollowup, isScreenQuestion, extractUrls, openLinks, linkPrompt, verifyQuotes, quoteWarning } = require('./src/research');
const { MODES, responseSystem } = require('./src/prompts');
const { appendResumeContext } = require('./src/profile-context');
const { rms16 } = require('./src/wav');

let win = null;
let dock = null, dockDismissed = false, dockHiddenForSharing = false, startDocked = true;
const dockState = { auto: {}, listening: false, panelVisible: false, toggleLabel: '' };
// Windows: one fixed transparent window holds everything; the shape animates inside it, the window
// never resizes. Other platforms keep the dock and panel (Linux cannot forward mouse moves when ignored).
const notchMode = process.platform === 'win32' && !!app.commandLine && app.commandLine.getSwitchValue('ozone-platform') !== 'headless';
const NOTCH_W = 1120, NOTCH_H = 940;
let notchOpen = false;
const panelShown = () => !!win && !win.isDestroyed() && win.isVisible() && (!notchMode || notchOpen);
function notchBounds() {
  const { bounds } = screen.getPrimaryDisplay();
  return { x: Math.round(bounds.x + (bounds.width - NOTCH_W) / 2), y: bounds.y, width: NOTCH_W, height: Math.min(NOTCH_H, bounds.height) };
}
// win.blur() does not hand focus back on Windows, so note who had it before Aether took it.
let notchReturnTo = 0;
async function rememberForeground() {
  try {
    const { handle } = await require('./src/windows-control').foregroundWindow();
    if (handle !== Number(win.getNativeWindowHandle().readBigUInt64LE())) notchReturnTo = handle;
  } catch {} // nothing to go back to; tucking still works
}
async function returnFocus() {
  const handle = notchReturnTo;
  notchReturnTo = 0;
  if (!win || win.isDestroyed() || !win.isFocused()) return;
  win.blur();
  if (handle) await require('./src/windows-control').activateWindow(handle).catch(() => {});
}
function setNotch(open, focus = false) {
  notchOpen = open;
  updateDock({ panelVisible: open });
  if (win && !win.isDestroyed()) win.webContents.send('notch:set', { open, focus });
}
const registeredShortcuts = {};
let hyprShortcut = null;
let toggleBindingError = null;
let toggleBindingReady = Promise.resolve();
let autoRefresh = null, activityWatcher = null, autoRefreshPaused = false;
let autoRefreshChange = Promise.resolve();
let autoRefreshActive = false;
let autoSession = null;
let zenControl = null;
let writeSession = null;

function codexProfileDir() {
  const dir = path.join(app.getPath('userData'), 'codex-profile');
  require('fs').mkdirSync(dir, { recursive: true }); // codex refuses a CODEX_HOME that doesn't exist
  return dir;
}

// Chrome (DevTools Protocol) is the Windows browser backend; AETHER_BROWSER=zen overrides.
function useChrome() { return process.env.AETHER_BROWSER ? process.env.AETHER_BROWSER === 'chrome' : process.platform === 'win32'; }
function getZenControl() {
  if (!zenControl) zenControl = useChrome()
    ? require('./src/chrome-control').createChromeControl()
    : require('./src/zen-control').createZenControl();
  return zenControl;
}

// ---- Write mode: human-paced typing into a locked Zen tab ----
function resolveInksplashDir() {
  const fs = require('fs');
  const s = store.getSettings().writeMode || {};
  if (s.inksplashDir && fs.existsSync(path.join(s.inksplashDir, 'humanize_cli.py'))) return s.inksplashDir;
  // Bundled Config C humaniser (vendored from InkSplash). Lives on the real fs in
  // both dev and packaged builds (shipped via extraResources, not inside asar).
  const bundled = app.isPackaged ? path.join(process.resourcesPath, 'humanizer') : path.join(__dirname, 'humanizer');
  if (fs.existsSync(path.join(bundled, 'humanize_cli.py'))) return bundled;
  const guess = path.resolve(__dirname, '..', '..', 'inksplash'); // sibling checkout fallback
  return fs.existsSync(path.join(guess, 'humanize_cli.py')) ? guess : '';
}
// A user-set interpreter is honoured only when it is an existing regular file
// named python/python3[.N], so a tampered setting can't turn the humaniser or
// detector subprocess into an arbitrary-executable sink.
function validPython(p) {
  if (!p || typeof p !== 'string' || !path.isAbsolute(p) || !/^python(3(\.\d+)?)?(\.exe)?$/i.test(path.basename(p))) return null;
  try { return require('fs').statSync(p).isFile() ? p : null; } catch { return null; }
}
function resolvePython(inksplashDir) {
  const fs = require('fs');
  const vp = validPython((store.getSettings().writeMode || {}).pythonPath);
  if (vp) return vp;
  if (inksplashDir) { const venv = process.platform === 'win32' ? path.join(inksplashDir, '.venv', 'Scripts', 'python.exe') : path.join(inksplashDir, '.venv', 'bin', 'python'); if (fs.existsSync(venv)) return venv; }
  return process.platform === 'win32' ? 'python' : 'python3';
}
// Zen keystroke sink: connect, lock the tab, click to focus the editor once, then
// stream keys. Keeps typing across desktop switches (browser-native, no OS cursor).
function makeZenTyper(tabId, signal) {
  const control = getZenControl();
  let ready = null, target = null;
  const ensure = () => ready || (ready = (async () => {
    await control.connect(signal);
    target = await control.lockTarget(tabId, signal);
    await control.capture(target, signal);
    await control.execute(target, { type: 'click', x: Math.floor(target.width * 0.5), y: Math.floor(target.height * 0.28) }, signal);
    await control.focusTab(target, signal);
  })());
  return {
    async key(v) { await ensure(); await control.writeKey(target, v, signal); },
    async backspace() { await ensure(); await control.writeKey(target, '', signal); },
    async release() { try { if (target) await control.release(target); } catch { /* best-effort */ } },
  };
}
function writeDetector() {
  const dir = resolveInksplashDir();
  // Packaged: aether_detect.py lives under resources/ (real fs), not in app.asar.
  const detectDir = app.isPackaged ? process.resourcesPath : __dirname;
  return require('./src/detect').createDetector({ pythonPath: resolvePython(dir), scriptDir: detectDir, inksplashDir: dir, isolated: true });
}
function getWriteSession() {
  if (writeSession) return writeSession;
  writeSession = require('./src/write-session').createWriteSession({
    getSettings: () => store.getSettings(),
    getCodexHome: settings => settings.codexSeparateAccount ? codexProfileDir() : undefined,
    createLLM,
    humanize: (text, opts, signal) => {
      const wm = store.getSettings().writeMode || {};
      if (wm.humanizer !== 'local') {
        const settings = store.getSettings();
        const llm = createLLM({ ...settings, codexHome: settings.codexSeparateAccount ? codexProfileDir() : undefined });
        // Sentence mode is the default: live it took an essay from 99.3% to 15.5% local AI in 2 rounds.
        if ((wm.humanizer || 'sentences') === 'sentences') {
          return require('./src/humanize').createSentenceHumanizer({ llm, scoreSegments: (list, options, s) => writeDetector().segments(list, options, s) }).humanize(text, opts, signal);
        }
        return require('./src/humanize').createModelHumanizer({ llm }).humanize(text, opts, signal);
      }
      const dir = resolveInksplashDir();
      if (!dir) throw new Error('Set the InkSplash humaniser folder in Settings → Write mode.');
      return require('./src/humanize').createHumanizer({ pythonPath: resolvePython(dir), scriptDir: dir, isolated: true })
        .humanize(text, { candidates: wm.candidates, refine: wm.refine, ...opts }, signal);
    },
    detect: (text, opts, signal) => {
      const wm = store.getSettings().writeMode || {};
      return writeDetector().detect(text, { zerogpt: wm.detector === 'local+zerogpt', ...opts }, signal);
    },
    releaseModel: () => { try { require('./src/codex-server').stopCodexServer(codexProfileDir()); } catch { /* best-effort */ } },
    createTyper: ({ tabId, signal }) => makeZenTyper(tabId, signal),
    onUpdate: update => {
      send('write-mode:state', { stage: update.stage, status: update.status, message: update.message,
        aiScore: update.aiScore, pass: update.pass, detail: update.detail, text: update.text,
        index: update.index, total: update.total, typed: update.typed });
      updateDock({ write: { stage: update.stage, status: update.status, typed: update.typed, total: update.total, at: Date.now() } });
    },
    onEnd: () => { state.busy = false; },
  });
  return writeSession;
}

function stopForegroundAuto(reason) {
  if (autoSession?.target !== 'zen') autoSession?.stop(reason);
}

// Lightweight diagnostic log so shortcut behavior can be verified from a file.
function log(msg) {
  try {
    require('fs').appendFileSync(path.join(app.getPath('userData'), 'wingman-debug.log'),
      new Date().toISOString() + ' ' + msg + '\n');
  } catch (_) {}
}

const DEFAULT_ASSIST_SHORTCUT = 'CommandOrControl+Return';
const DEFAULT_TOGGLE_SHORTCUT = 'CommandOrControl+Shift+Space';
const RESERVED_SHORTCUTS = new Set([
  'commandorcontrol+h',
  'commandorcontrol+shift+x'
]);

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
const buffers = { you: [], them: [] };
const transcript = []; // { channel, text, ts }
const FLUSH_MS = 3500;
const MIN_BYTES = Math.floor(16000 * 2 * 0.6); // ~0.6s
const RMS_GATE = 240;
let flushTimer = null;
let linuxAudio = null;

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  if (channel === 'auto-mode:state') updateDock({ auto: { ...data, target: autoSession?.target, at: Date.now() } });
  if (channel === 'capture:state') updateDock({ listening: !!data.active });
  // Every stage of an answer reaches the status line; tokens only mark the first change.
  const answer = { 'llm:start': { status: 'working', message: 'Thinking' }, 'llm:phase': { status: 'working', message: data?.message },
    'llm:token': { status: 'working', message: 'Answering', streaming: true }, 'llm:done': { status: 'done' }, 'llm:error': { status: 'error', message: data?.message } }[channel];
  if (answer && !(answer.streaming && dockState.answer?.streaming)) updateDock({ answer: { ...answer, at: Date.now() } });
}

async function setPanelPinned(pinned) {
  try { return await require('./src/linux-overlay').hyprSetPinned(pinned); }
  catch (error) { log('panel pin change failed: ' + error.message); return false; }
}

// -------- dock (taskbar extension) --------
// A small status strip top-center under the bar. Clicking opens the panel under it; the
// panel can then be dragged anywhere while the dock stays. Swiping the dock up dismisses it.
function toggleLabel() {
  // Never let a settings/keyring failure break capture or Auto status updates.
  let accelerator = 'CommandOrControl+Shift+Space';
  try { accelerator = store.getSettings().shortcuts?.toggle || accelerator; } catch {}
  return accelerator.replace('CommandOrControl', process.platform === 'darwin' ? '⌘' : 'Ctrl').replace(/\+/g, ' ').replace('Shift', '⇧').replace('Space', 'SPC');
}
function updateDock(patch) {
  Object.assign(dockState, patch, { toggleLabel: toggleLabel() });
  // Auto-hide removes the window, so a live status brings it back without taking focus. Hide for sharing stays hidden.
  if (notchMode && win && !win.isDestroyed() && !win.isVisible() && !dockHiddenForSharing && require('./renderer/status-line').describe(dockState, () => '').live) win.showInactive();
  if (dock && !dock.isDestroyed()) dock.webContents.send('dock:state', dockState);
  if (notchMode && win && !win.isDestroyed()) win.webContents.send('notch:state', dockState);
}
// Wayland clients cannot position themselves; on Hyprland ask the compositor once the window maps.
async function placeOnHyprland(kind) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try { if (await require('./src/linux-overlay').hyprPlace(kind)) return true; } catch { return false; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  return false;
}
function createDock() {
  if (notchMode || (dock && !dock.isDestroyed())) return;
  const { DOCK_W, DOCK_H } = require('./src/linux-overlay');
  const { workArea } = screen.getPrimaryDisplay();
  dock = new BrowserWindow({
    title: 'Aether Dock', width: DOCK_W, height: DOCK_H,
    x: Math.round(workArea.x + (workArea.width - DOCK_W) / 2), y: workArea.y + 6,
    frame: false, transparent: true, hasShadow: false, resizable: false, movable: false,
    skipTaskbar: true, alwaysOnTop: true, fullscreenable: false, show: false,
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: { preload: path.join(__dirname, 'dock-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  if (process.platform === 'darwin' || process.platform === 'win32') dock.setContentProtection(true);
  dock.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : undefined);
  if (process.platform === 'darwin') dock.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  dock.on('closed', () => { dock = null; });
  dock.loadFile(path.join(__dirname, 'renderer', 'dock.html'));
  dock.webContents.on('did-finish-load', () => {
    updateDock({});
    if (dockDismissed || dockHiddenForSharing) return;
    dock.showInactive(); void placeOnHyprland('dock');
  });
}
function showDock() {
  dockDismissed = false; dockHiddenForSharing = false;
  if (notchMode) { if (win && !win.isDestroyed() && !win.isVisible()) { assertOverlay(); win.showInactive(); } return; }
  if (!dock || dock.isDestroyed()) { createDock(); return; }
  if (!dock.isVisible()) { dock.showInactive(); void placeOnHyprland('dock'); }
}
function openPanelFromDock() {
  const wasVisible = win && !win.isDestroyed() && win.isVisible();
  showWindow();
  if (wasVisible || !dock || dock.isDestroyed()) return;
  // Open under the dock; after this the panel is free to be dragged away.
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) void placeOnHyprland('panel');
  else {
    const d = dock.getBounds(), w = win.getBounds();
    win.setPosition(Math.round(d.x + (d.width - w.width) / 2), d.y + d.height + 6);
  }
}

// -------- window --------
function createWindow() {
  let overlayError = null;
  try {
    require('./src/linux-overlay').configureLinuxOverlay({ headless: app.commandLine.getSwitchValue('ozone-platform') === 'headless' });
  } catch (error) {
    overlayError = error.message;
    log(overlayError);
  }
  const { workArea } = screen.getPrimaryDisplay();
  const W = 600, H = 600;
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    title: 'Aether',
    show: false, // shown after load (or left docked)
    ...(notchMode ? { ...notchBounds(), movable: false, thickFrame: false } : { width: W, height: H, minWidth: 520, minHeight: 420, x: Math.round(workArea.x + (workArea.width - W) / 2), y: workArea.y + 6 }),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: !notchMode,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    // macOS 'panel' (NSPanel): floats over full-screen apps and appears on
    // every Space. This is what actually makes the overlay follow the user
    // into a fullscreen app — setVisibleOnAllWorkspaces alone is unreliable.
    ...(isMac ? { type: 'panel' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: notchMode ? ['--aether-notch'] : [],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // macOS and Windows can request capture exclusion; Linux has no equivalent here.
  if ((process.platform === 'darwin' || process.platform === 'win32') && !process.env.AETHER_QA_CAPTURE) win.setContentProtection(true);
  if (notchMode) win.setIgnoreMouseEvents(true, { forward: true });
  if (isMac) {
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    // 'panel' window type (above) floats over fullscreen apps. This call makes
    // it join all Spaces; skipTransformProcessType keeps the Dock icon visible.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    if (typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(false);
  } else {
    win.setAlwaysOnTop(true);
  }
  if (app.dock && isMac) app.dock.show();

  win.webContents.on('did-start-loading', () => { autoSession?.stop('Auto stopped because Aether reloaded.'); writeSession?.stop('Write stopped because Aether reloaded.'); autoRefreshPaused = true; autoRefresh?.cancelPending(); stopWindowGesture(); setCapturing(false); });
  win.on('show', () => updateDock({ panelVisible: true }));
  win.on('hide', () => { if (notchMode) notchOpen = false; updateDock({ panelVisible: false }); });
  win.on('closed', () => { autoSession?.stop('Auto stopped because Aether closed.'); writeSession?.stop('Write stopped because Aether closed.'); stopWindowGesture(); setCapturing(false); });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => {
    if (overlayError) send('status', { message: overlayError });
    if (win.isVisible()) return;
    // The notch window is always mapped; open and closed are renderer states.
    if (notchMode) { win.showInactive(); assertOverlay(); updateDock({}); return; }
    // With the dock running, start as just the dock; the panel opens from it (Sentient-style).
    // Headless checks and setup errors still show the panel directly.
    if (startDocked && !overlayError && app.commandLine.getSwitchValue('ozone-platform') !== 'headless') { startDocked = false; return; }
    win.showInactive();
    // Re-assert overlay settings each time the window appears, so it keeps
    // following the user into fullscreen apps and across Spaces.
    assertOverlay();
  });
  win.webContents.on('render-process-gone', (_e, d) => { autoSession?.stop('Auto stopped because the interface closed.'); writeSession?.stop('Write stopped because the interface closed.'); setCapturing(false); console.log('[wingman] renderer gone', JSON.stringify(d)); });
}

function assertOverlay() {
  if (!win || win.isDestroyed()) return;
  if (process.platform === 'darwin') {
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  } else {
    win.setAlwaysOnTop(true);
  }
}

// Show or hide the overlay. Recreates the window if it was closed.
function toggleWindow() {
  log('toggleWindow fired. win=' + (win && !win.isDestroyed()) + ' visible=' + (win && win.isVisible()));
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (notchMode) {
    if (!win.isVisible()) { dockHiddenForSharing = false; assertOverlay(); win.showInactive(); return; } // back from Hide for sharing
    if (notchOpen) { stopForegroundAuto('Auto stopped because Aether was hidden.'); stopWindowGesture(); setNotch(false); void returnFocus(); }
    else { assertOverlay(); void rememberForeground().finally(() => { win.focus(); setNotch(true, true); }); }
    return;
  }
  if (win.isVisible()) {
    stopForegroundAuto('Auto stopped because Aether was hidden.');
    stopWindowGesture();
    win.hide();
  } else {
    assertOverlay();
    win.show();
    win.focus();
    if (dockHiddenForSharing && !dockDismissed) showDock();
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  assertOverlay();
  if (notchMode) {
    if (!win.isVisible()) win.showInactive();
    void rememberForeground().finally(() => { if (win && !win.isDestroyed()) { win.focus(); setNotch(true, true); } });
    return;
  }
  win.show();
  win.focus();
}

// -------- STT flushing --------
async function flushChannel(channel) {
  if (state.transcribing[channel]) return;
  const chunks = buffers[channel];
  if (!chunks.length) return;
  const pcm = Buffer.concat(chunks);
  buffers[channel] = [];
  if (pcm.length < MIN_BYTES) return;
  if (rms16(pcm) < RMS_GATE) return; // silence gate

  state.transcribing[channel] = true;
  try {
    const settings = store.getSettings();
    const stt = createSTT(settings);
    if (!stt.available) {
      if (!sttDisabled) { sttDisabled = true; send('status', { message: stt.providers.includes('local')
        ? 'Local transcription is unavailable. Set a Whisper model path and install whisper-cli in Settings.'
        : 'No transcription key set. Add an OpenAI (Whisper) or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.' }); }
      return;
    }
    const res = await stt.transcribe(pcm);
    if (res.error) {
      handleSttError(res.error, settings);
      return;
    }
    if (res.text && res.text.trim()) {
      const turn = { channel, text: res.text.trim(), ts: Date.now() };
      transcript.push(turn);
      if (DEBUG) console.log(`[TRANSCRIPT] ${channel === 'you' ? 'You' : 'Them'}:`, turn.text);
      send('transcript', turn);
    }
  } catch (e) {
    console.log('[stt] error', e && e.message);
  } finally {
    state.transcribing[channel] = false;
  }
}

function handleSttError(err, settings) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  if (sttDisabled) return;
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found';
  sttDisabled = true; // stop hammering the API every few seconds
  if (err.provider === 'local') {
    send('status', { message: 'Local transcription stopped: ' + err.message + '. Check the model path and whisper-cli installation in Settings.' });
    return;
  }
  if (noAccess) {
    send('status', { message: 'Transcription off: your ' + err.provider + ' key has no access to a speech-to-text model (403). Screen + LeetCode still work. To enable listening: give the key Whisper/transcription access, or add a Gemini key in Settings and reopen.' });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushChannel('you'); flushChannel('them'); }, FLUSH_MS);
}
function stopFlushLoop() { if (flushTimer) { clearInterval(flushTimer); flushTimer = null; } }

// -------- capture toggle --------
// Microphone capture stays in the renderer; Linux meeting audio uses parec's output monitor.
function stopLinuxAudio() {
  const capture = linuxAudio;
  linuxAudio = null;
  capture?.stop();
}
function setCapturing(active) {
  state.capturing = active;
  if (active) {
    startFlushLoop();
  } else {
    stopLinuxAudio();
    stopFlushLoop();
    buffers.you = []; buffers.them = [];
  }
  send('capture:state', { active });
  return active;
}

// -------- feature runner --------
async function runFeature(mode, userText, capturePoint) {
  if (DEBUG) console.log('[DEBUG MAIN] runFeature called:', { mode, userText, isBusy: state.busy });
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) {
    if (DEBUG) console.log('[DEBUG MAIN] mode not found:', mode);
    return;
  }
  if (mode === 'research' && (!userText || !userText.trim())) {
    send('llm:error', { message: 'Type a research question first.' });
    return;
  }
  state.busy = true;
  try {
    const settings = store.getSettings();
    const llm = createLLM({ ...settings, codexHome: settings.codexSeparateAccount ? codexProfileDir() : undefined });
    const userBubble = def.userBubble !== null ? def.userBubble : (mode === 'ask' ? userText : null);
    if (DEBUG) console.log('[DEBUG MAIN] LLM settings loaded:', { provider: settings.provider, smart: settings.smart });
    send('llm:start', { userBubble, small: !!def.small });

    if (!llm.ready) {
      if (DEBUG) console.log('[DEBUG MAIN] LLM not ready (missing key or model).');
      send('llm:error', { message: settings.provider === 'ollama'
        ? 'Start Ollama and select a local model in Settings.'
        : ['claude-cli', 'codex-cli'].includes(settings.provider)
          ? 'Install and sign in to the selected CLI provider, then try again.'
          : 'Add your ' + settings.provider + ' API key in Settings (gear icon) to start. Model: ' + (llm.model || 'unset') + '.' });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen) {
      send('llm:phase', { message: 'Reading your screen…' });
      if (DEBUG) console.log('[DEBUG MAIN] Feature needs screen. Capturing screenshot...');
      try {
        imageDataUrl = await captureScreenshot(capturePoint);
        if (!imageDataUrl) throw new Error('No screenshot was returned');
        if (DEBUG) console.log('[DEBUG MAIN] Screenshot captured successfully (length:', imageDataUrl.length, ')');
      } catch (e) {
        if (DEBUG) console.error('[DEBUG MAIN] Screenshot capture failed:', e);
        send('llm:error', { message: e?.code === 'CAPTURE_SETUP' ? e.message : process.platform === 'darwin'
          ? 'Screen capture failed. Check Aether’s Screen Recording permission in System Settings, then try again.'
          : 'Screen capture failed. Check capture permissions and try again.' });
        return;
      }
    }

    const built = def.build({ transcript, userText: userText || '' });
    // Links the user pasted are opened directly; their page text is the evidence.
    const links = extractUrls(userText || '').length ? (send('llm:phase', { message: 'Opening links…' }), await openLinks(userText)) : { sources: [], failures: [] };
    if (links.failures.length) send('status', { message: 'Could not open: ' + links.failures.map(f => `${f.url} (${f.reason})`).join('; ') });
    const needsResearch = !links.sources.length && (mode === 'research' || (mode === 'ask' && !isScreenQuestion(userText)));
    if (needsResearch) send('llm:phase', { message: 'Finding sources…' });
    let sources = links.sources.length ? links.sources : needsResearch ? await getEvidence(userText, settings.apiKeys.tavily) : [];
    const publishSources = () => {
      if (sources.length) send('llm:sources', { sources: sources.map(({ number, title, url, origin }) => ({ number, title, url, origin })) });
    };
    publishSources();
    if (DEBUG) console.log('[DEBUG MAIN] Built prompt. Starting LLM stream...');
    const answer = () => {
      send('llm:phase', { message: sources.length ? 'Writing a sourced answer…' : 'Writing an answer…' });
      return llm.stream({
      system: appendResumeContext(responseSystem(def.system, settings.smart), settings.resumeContext),
      turns: [{ role: 'user', text: built + (sources.length ? researchPrompt(sources) : '') + linkPrompt(links.failures) }],
      imageDataUrl,
      onToken: (t) => { if (!sources.length) send('llm:token', { text: t }); }
      });
    };
    let fullText = await answer();
    if (needsWebFollowup(fullText, sources)) {
      send('status', { message: 'Local sources were insufficient; searching the web.' });
      sources = await searchWeb(userText, settings.apiKeys.tavily);
      publishSources();
      fullText = await answer();
    }
    const checked = sources.length ? validateGroundedAnswer(fullText, sources) : fullText;
    // Quotes are checked word-for-word against what was actually retrieved, never trusted.
    const warning = sources.length || links.failures.length ? quoteWarning(verifyQuotes(checked, sources).unverified) : '';
    if (sources.length) send('llm:token', { text: checked + warning });
    else if (warning) send('llm:token', { text: warning });
    if (DEBUG) console.log('[DEBUG MAIN] Full LLM Output:\n', fullText);
    send('llm:done', {});
  } catch (e) {
    send('llm:error', { message: 'Error: ' + (e && e.message ? e.message : String(e)) });
  } finally {
    state.busy = false;
    void autoRefresh?.flush();
  }
}

function autoRefreshSupported() {
  return process.platform === 'linux' && !!process.env.HYPRLAND_INSTANCE_SIGNATURE && app.commandLine.getSwitchValue('ozone-platform') !== 'headless';
}
function autoModeSupported() {
  if (process.platform === 'win32') {
    try { require('./src/windows-control').locateInputTool(); return true; } catch { return false; }
  }
  return autoRefreshSupported();
}
async function configureAutoRefresh(enabled) {
  if (!autoRefresh) autoRefresh = require('./src/auto-refresh').createAutoRefresh({
    run: point => runFeature('assist', '', point), isBusy: () => state.busy,
    canObserve: () => panelShown() && !autoRefreshPaused
  });
  if (!enabled) { autoRefresh.setEnabled(false); activityWatcher?.stop(); activityWatcher = null; publishAutoRefreshState(false); return; }
  if (!autoRefreshSupported()) throw new Error('Click/scroll auto refresh is currently available on Hyprland. Manual Assist remains available.');
  if (!activityWatcher) {
    const watcher = require('./src/hypr-activity').createHyprActivityWatcher({
      onActivity: point => autoRefresh.activity(point),
      onError: () => {
        autoRefresh.setEnabled(false);
        activityWatcher?.stop(); activityWatcher = null;
        publishAutoRefreshState(false, 'Auto refresh stopped. Toggle it off and on in Settings to reconnect, or use manual Assist.');
      }
    });
    activityWatcher = watcher;
    try { await watcher.start(); if (activityWatcher !== watcher) throw new Error('Auto refresh connection stopped. Try enabling it again.'); }
    catch (error) { watcher.stop(); if (activityWatcher === watcher) activityWatcher = null; throw error; }
  }
  autoRefresh.setEnabled(true);
  publishAutoRefreshState(true);
}
function publishAutoRefreshState(active, error) {
  autoRefreshActive = active;
  send('auto-refresh:state', { active, error });
}

async function startAutoMode(goal, options) {
  const target = options?.target || 'desktop';
  if (target === 'desktop' && !autoModeSupported()) throw new Error(process.platform === 'win32'
    ? 'Windows Auto requires tools/ydotool.exe. Run npm run build:input or set YDOTOOL_PATH to its full path.'
    : 'Desktop Auto currently requires native Hyprland, grim and ydotool.');
  if (state.busy) throw new Error('Wait for the current answer or stop Auto first.');
  if (!panelShown()) throw new Error('Show Aether before starting Auto.');
  if (autoRefreshPaused) throw new Error('Close Settings/onboarding and expand Aether before starting Auto.');
  if (!autoSession) autoSession = require('./src/auto-session').createAutoSession({
    getSettings: () => store.getSettings(), createLLM,
    getCodexHome: settings => settings.codexSeparateAccount ? codexProfileDir() : undefined,
    createDesktopControl: () => process.platform === 'win32'
      ? require('./src/windows-control').createWindowsControl()
      : require('./src/desktop-control').createDesktopControl(),
    createBrowserControl: () => getZenControl(),
    createStopWatcher: options => process.platform === 'win32'
      ? require('./src/windows-auto-stop').createWindowsAutoStop(options)
      : require('./src/hypr-auto-stop').createHyprAutoStop(options),
    createRunLog: () => require('./src/run-log').createRunLog(path.join(app.getPath('userData'), 'auto-runs')),
    research: (query, settings) => getEvidence(query, settings.apiKeys.tavily),
    onUpdate: update => {
      // Never expose screenshots, typed values or source bodies through status logs.
      send('auto-mode:state', { active: update.active, status: update.status, message: update.message, step: update.step });
      if (update.sources?.length) send('llm:sources', { sources: update.sources.map(({ number, title, url, origin }) => ({ number, title, url, origin })) });
    },
    // The panel follows the user again once a desktop run ends, however it ended.
    onEnd: () => { state.busy = false; autoRefresh?.cancelPending(); void setPanelPinned(true); }
  });
  state.busy = true; autoRefresh?.cancelPending();
  // Desktop Auto works on this workspace: keep the panel here until the run ends.
  if (target === 'desktop') await setPanelPinned(false);
  try { return autoSession.start(goal, { allowSubmit: options?.allowSubmit === true, target, tabId: options?.tabId }); }
  catch (error) { state.busy = false; throw error; }
}

// -------- IPC --------
ipcMain.handle('auto-mode:status', () => ({ supported: autoModeSupported(), ...(autoSession?.status || { active: false, status: 'idle', message: '' }) }));
ipcMain.handle('auto-mode:start', (_event, goal, options) => startAutoMode(goal, options));
ipcMain.on('auto-mode:stop', () => autoSession?.stop());
ipcMain.handle('auto-mode:zen-tabs', async () => {
  if (state.busy) throw new Error('Stop the current task before refreshing Zen tabs.');
  try {
    const control = getZenControl();
    await control.connect();
    return (await control.listTabs()).filter(tab => /^https?:\/\//i.test(tab.url));
  } catch (error) { await zenControl?.close(); zenControl = null; throw error; }
});
// Only the panel renderer may drive Write mode; reject any other frame/window.
function fromPanel(event) { if (win && !win.isDestroyed() && event.sender !== win.webContents) throw new Error('Unauthorized sender.'); }
ipcMain.handle('write-mode:prepare', async (event, payload) => {
  fromPanel(event);
  if (state.busy) throw new Error('Wait for the current task or stop it first.');
  state.busy = true;
  try { return await getWriteSession().prepare(payload || {}); }
  finally { state.busy = false; }
});
ipcMain.handle('write-mode:humanize', async (event, text) => {
  fromPanel(event);
  if (state.busy) throw new Error('Wait for the current task or stop it first.');
  state.busy = true;
  try { return await getWriteSession().humanizeLoop({ text }); }
  finally { state.busy = false; }
});
ipcMain.handle('write-mode:approve', (event, text) => { fromPanel(event); return getWriteSession().approve(text); });
ipcMain.handle('write-mode:type', (event, tabId, typingConfig) => {
  fromPanel(event);
  if (typeof tabId !== 'string' || !tabId.trim()) throw new Error('Pick a Zen tab to type into.');
  const session = getWriteSession();
  if (session.stage !== 'armed') throw new Error('Approve the final text before typing.');
  if (state.busy) throw new Error('Wait for the current task or stop it first.');
  state.busy = true;
  // Default the typing knobs from saved Write-mode settings when none are passed.
  const cfg = (typingConfig && Object.keys(typingConfig).length) ? typingConfig : (store.getSettings().writeMode?.typing || {});
  // Long-running; status flows through onUpdate and onEnd clears busy. The finally
  // is a safety net so an early rejection can never strand the busy lock.
  session.typeInto(tabId, cfg).catch(() => {}).finally(() => { if (!writeSession || !writeSession.active) state.busy = false; });
  return { started: true };
});
ipcMain.on('write-mode:stop', (event) => { try { fromPanel(event); } catch { return; } writeSession?.stop(); });
ipcMain.handle('write-mode:zen-tabs', async (event) => {
  fromPanel(event);
  try { const control = getZenControl(); await control.connect(); return (await control.listTabs()).filter(tab => /^https?:\/\//i.test(tab.url)); }
  catch (error) { await zenControl?.close(); zenControl = null; throw error; }
});
ipcMain.handle('write-mode:python-status', async (event) => {
  fromPanel(event);
  const dir = resolveInksplashDir();
  const candidates = [validPython(store.getSettings().writeMode?.pythonPath), dir && path.join(dir, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python'), process.platform === 'win32' ? 'python' : 'python3'].filter(Boolean);
  const env = require('./src/python-env').createPythonEnv({ candidates });
  const status = await env.detect();
  return { ...status, inksplashDir: dir };
});
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('codex:login-status', () => require('./src/codex-login').codexLoginStatus(codexProfileDir()));
ipcMain.handle('codex:login', async () => {
  const { startCodexLogin, cancelCodexLogin } = require('./src/codex-login');
  let login = null;
  // ponytail: in-memory partition = fresh cookies every time, so the user's other ChatGPT
  // account in their normal browser never hijacks this sign-in. "Continue with Google" may
  // refuse embedded windows; email sign-in works.
  const open = url => {
    login = new BrowserWindow({ width: 520, height: 720, title: 'Sign in to Codex', autoHideMenuBar: true,
      webPreferences: { partition: 'codex-login', contextIsolation: true, sandbox: true } });
    login.on('closed', () => { login = null; cancelCodexLogin(); });
    login.loadURL(url);
  };
  try { await startCodexLogin(codexProfileDir(), open); }
  finally { if (login && !login.isDestroyed()) login.destroy(); }
  require('./src/codex-server').stopCodexServer(codexProfileDir());
  return true;
});
ipcMain.handle('auto-refresh:status', () => ({ supported: autoRefreshSupported(), active: autoRefreshActive }));
ipcMain.handle('settings:set', (event, patch) => {
  const apply = async () => {
    if (patch.smart !== undefined && ![false, true, 'deep'].includes(patch.smart)) throw new Error('Invalid response depth');
    if (patch.codexSeparateAccount !== undefined && typeof patch.codexSeparateAccount !== 'boolean') throw new Error('Invalid Codex account setting');
    if (patch.autoRefresh !== undefined && typeof patch.autoRefresh !== 'boolean') throw new Error('Invalid auto refresh setting');
    if (patch.notchAutoHide !== undefined && typeof patch.notchAutoHide !== 'boolean') throw new Error('Invalid notch auto-hide setting');
    if (patch.notchHideDelay !== undefined && (!Number.isInteger(patch.notchHideDelay) || patch.notchHideDelay < 2 || patch.notchHideDelay > 60)) throw new Error('Notch hide delay must be between 2 and 60 seconds');
    const previous = !!store.getSettings().autoRefresh;
    if (patch.autoRefresh !== undefined) await configureAutoRefresh(patch.autoRefresh);
    try {
      sttDisabled = false;
      const result = store.setSettings(patch);
      if (notchMode && win && !win.isDestroyed() && event.sender === win.webContents && (patch.notchAutoHide !== undefined || patch.notchHideDelay !== undefined)) {
        win.webContents.send('notch:settings', { autoHide: result.notchAutoHide, delay: result.notchHideDelay });
      }
      return result;
    }
    catch (error) { if (patch.autoRefresh !== undefined) await configureAutoRefresh(previous); throw error; }
  };
  const result = autoRefreshChange.then(apply);
  autoRefreshChange = result.catch(() => {});
  return result;
});
ipcMain.on('auto-refresh:pause', (_event, paused) => { autoRefreshPaused = !!paused; if (paused) { autoRefresh?.cancelPending(); stopForegroundAuto('Auto stopped while Aether is paused.'); } });
ipcMain.handle('shortcut:assist:set', (_e, accelerator) => setAssistShortcut(accelerator));
ipcMain.handle('shortcut:toggle:set', (_e, accelerator) => {
  const next = toggleBindingReady.then(() => setToggleShortcut(accelerator));
  toggleBindingReady = next.then(() => {}, () => {});
  return next;
});
ipcMain.handle('shortcut:status', async () => {
  await toggleBindingReady;
  return { ...registeredShortcuts, toggle: toggleBindingError ? undefined : registeredShortcuts.toggle };
});
ipcMain.handle('capture:toggle', () => setCapturing(!state.capturing));
ipcMain.handle('capture:stop', () => setCapturing(false));
ipcMain.handle('capture:state', () => ({ active: state.capturing }));
ipcMain.handle('capture:system:start', async () => {
  if (process.platform !== 'linux') return false;
  if (!linuxAudio) {
    const capture = require('./src/linux-audio').startLinuxAudio(
      chunk => { if (state.capturing) buffers.them.push(chunk); },
      () => {
        if (linuxAudio !== capture) return;
        linuxAudio = null;
        send('capture:system-ended', {});
      }
    );
    linuxAudio = capture;
  }
  const capture = linuxAudio;
  const ready = await capture.ready;
  if (!ready && linuxAudio === capture) stopLinuxAudio();
  return ready && linuxAudio === capture;
});
ipcMain.handle('capture:system:stop', () => stopLinuxAudio());
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
ipcMain.on('window:hide-for-sharing', async () => {
  await toggleBindingReady;
  if (registeredShortcuts.toggle && !toggleBindingError && win && !win.isDestroyed()) {
    stopForegroundAuto('Auto stopped because Aether was hidden.'); stopWindowGesture();
    if (notchMode) setNotch(false);
    win.hide();
    // Sharing hides everything Aether draws, the dock included.
    if (notchMode) dockHiddenForSharing = true;
    if (dock && !dock.isDestroyed() && dock.isVisible()) { dockHiddenForSharing = true; dock.hide(); }
  }
});
ipcMain.on('dock:activate', event => {
  if (!dock || event.sender !== dock.webContents) return;
  if (win && !win.isDestroyed() && win.isVisible()) { stopForegroundAuto('Auto stopped because Aether was hidden.'); stopWindowGesture(); win.hide(); }
  else openPanelFromDock();
});
ipcMain.on('dock:dismiss', event => {
  if (!dock || event.sender !== dock.webContents) return;
  dockDismissed = true; dock.hide();
});
ipcMain.on('dock:show', event => { if (win && event.sender === win.webContents) showDock(); });
ipcMain.on('panel:hide', event => {
  if (!win || event.sender !== win.webContents) return;
  stopForegroundAuto('Auto stopped because Aether was hidden.'); stopWindowGesture();
  if (notchMode) { setNotch(false); void returnFocus(); return; }
  win.hide();
  if (dockDismissed) showDock();
});
ipcMain.on('mic:pcm', (_e, arrayBuffer) => { if (state.capturing) buffers.you.push(Buffer.from(arrayBuffer)); });
ipcMain.on('system:pcm', (_e, arrayBuffer) => { if (state.capturing) buffers.them.push(Buffer.from(arrayBuffer)); });
ipcMain.on('notch:opened', (event, open) => {
  if (!win || event.sender !== win.webContents) return;
  notchOpen = open;
  // Opening the sheet reads the answer, so ANSWERED has nothing left to announce.
  updateDock({ panelVisible: open, ...(open && dockState.answer?.status === 'done' ? { answer: {} } : {}) });
});
ipcMain.on('notch:focus', event => { if (win && event.sender === win.webContents) win.focus(); });
ipcMain.on('notch:remember', event => { if (win && event.sender === win.webContents) void rememberForeground(); });
ipcMain.on('notch:blur', event => { if (win && event.sender === win.webContents) void returnFocus(); });
ipcMain.on('notch:hide', event => {
  if (!notchMode || !win || event.sender !== win.webContents || win.isDestroyed()) return;
  stopForegroundAuto('Auto stopped because Aether was hidden.');
  stopWindowGesture();
  setNotch(false);
  win.hide();
  void returnFocus();
});
// Forwarded mouse moves stop at the window edge, so leaving is confirmed from the real cursor.
ipcMain.handle('notch:cursor', event => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return null;
  const p = screen.getCursorScreenPoint(), b = win.getBounds();
  return { x: p.x - b.x, y: p.y - b.y };
});
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
let nativeGesture = null;
let finalizingGesture = null;
function stopWindowGesture() {
  nativeGesture?.stop(); finalizingGesture?.stop();
  nativeGesture = null; finalizingGesture = null; resizeSession = null;
}
function finishWindowGesture() {
  const gesture = nativeGesture;
  nativeGesture = null; resizeSession = null;
  if (!gesture) return;
  finalizingGesture = gesture;
  gesture.finish().catch(() => send('status', { message: 'Could not finish window movement. Try the desktop window controls.' }))
    .finally(() => { if (finalizingGesture === gesture) finalizingGesture = null; });
}
function updateNativeGesture() {
  const gesture = nativeGesture;
  gesture?.update().catch(() => {
    if (nativeGesture !== gesture) return;
    stopWindowGesture(); send('status', { message: 'Window movement failed. Try the desktop window controls.' });
  });
}
ipcMain.handle('window:move-start', event => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents || app.commandLine.getSwitchValue('ozone-platform') === 'headless') return false;
  stopWindowGesture();
  nativeGesture = require('./src/linux-overlay').createHyprGesture('move');
  return !!nativeGesture;
});
ipcMain.on('window:move-update', event => { if (win && event.sender === win.webContents) updateNativeGesture(); });
let resizeSession = null;
const validResizePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
ipcMain.handle('window:resize-start', (event, request) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents || !validResizePoint(request) || !['bottom-left', 'bottom-right'].includes(request.corner)) return null;
  stopWindowGesture();
  if (app.commandLine.getSwitchValue('ozone-platform') !== 'headless') nativeGesture = require('./src/linux-overlay').createHyprGesture(request.corner);
  if (nativeGesture) return { native: false };
  resizeSession = { bounds: win.getBounds(), corner: request.corner, x: request.x, y: request.y };
  return { native: false };
});
ipcMain.on('window:resize-move', (event, point) => {
  if (nativeGesture && win && event.sender === win.webContents) { updateNativeGesture(); return; }
  if (!resizeSession || !win || win.isDestroyed() || event.sender !== win.webContents || !validResizePoint(point)) return;
  win.setBounds(require('./src/window-resize').resizeBounds(resizeSession.bounds, resizeSession.corner, point.x - resizeSession.x, point.y - resizeSession.y));
});
ipcMain.on('window:resize-end', (event, request) => {
  if (win && event.sender === win.webContents) {
    if (request?.cancel) stopWindowGesture();
    else finishWindowGesture();
  }
});
ipcMain.on('open-pane', (_e, url) => {
  if (typeof url !== 'string' || !/^(https:\/\/|x-apple\.systempreferences:)/i.test(url)) return;
  shell.openExternal(url).catch(() => {});
});
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));

// -------- shortcuts --------
function normalizeShortcut(accelerator) {
  return typeof accelerator === 'string' ? accelerator.trim().replace(/\s+/g, '') : '';
}

function registerShortcut(action, accelerator) {
  const next = normalizeShortcut(accelerator) || (action === 'assist' ? DEFAULT_ASSIST_SHORTCUT : DEFAULT_TOGGLE_SHORTCUT);
  if (next.length > 80) return { ok: false, error: 'That shortcut is too long.' };
  if (RESERVED_SHORTCUTS.has(next.toLowerCase()) || Object.entries(registeredShortcuts).some(([name, key]) => name !== action && key.toLowerCase() === next.toLowerCase())) {
    return { ok: false, error: 'That shortcut is reserved by another Aether action.' };
  }

  const callback = action === 'assist' ? () => runFeature('assist', '') : () => toggleWindow();
  const previous = registeredShortcuts[action];
  if (previous) globalShortcut.unregister(previous);

  try {
    if (!globalShortcut.register(next, callback)) {
      if (previous) globalShortcut.register(previous, callback);
      return { ok: false, error: 'That shortcut is already in use by another application.' };
    }
  } catch (_) {
    if (previous) globalShortcut.register(previous, callback);
    return { ok: false, error: 'That key combination is not a valid global shortcut.' };
  }

  registeredShortcuts[action] = next;
  return { ok: true, accelerator: next };
}

function setAssistShortcut(accelerator) {
  return setShortcut('assist', accelerator);
}

function setShortcut(action, accelerator) {
  const previous = registeredShortcuts[action];
  const result = registerShortcut(action, accelerator);
  if (result.ok) {
    try { store.setSettings({ shortcuts: { [action]: result.accelerator } }); }
    catch (_) {
      globalShortcut.unregister(result.accelerator);
      delete registeredShortcuts[action];
      if (previous) registerShortcut(action, previous);
      return { ok: false, error: 'Could not save the shortcut. The previous shortcut is unchanged.' };
    }
  }
  return result;
}

async function setToggleShortcut(accelerator) {
  const previous = registeredShortcuts.toggle;
  const result = registerShortcut('toggle', accelerator);
  if (!result.ok) return result;
  try {
    if (hyprShortcut) await hyprShortcut.bind(result.accelerator);
    store.setSettings({ shortcuts: { toggle: result.accelerator } });
    toggleBindingError = null;
    return result;
  } catch (error) {
    globalShortcut.unregister(result.accelerator);
    delete registeredShortcuts.toggle;
    try { if (hyprShortcut) hyprShortcut.stop(); } catch (cleanupError) { log('Hyprland rollback cleanup failed: ' + cleanupError.message); }
    if (previous) {
      registerShortcut('toggle', previous);
      try { if (hyprShortcut) await hyprShortcut.bind(previous); toggleBindingError = null; }
      catch (restoreError) { toggleBindingError = restoreError.message; }
    } else toggleBindingError = error.message;
    return { ok: false, error: 'Could not update Show / hide: ' + error.message };
  }
}

function registerShortcuts() {
  const okH = globalShortcut.register('CommandOrControl+H', () => runFeature('leetcode', ''));
  const okX = globalShortcut.register('CommandOrControl+Shift+X', () => app.quit());
  log('shortcut results H=' + okH + ' X=' + okX);

  let configured;
  try {
    const settings = store.getSettings();
    configured = settings.shortcuts;
  } catch (err) {
    console.error('[wingman] settings unavailable at startup:', err);
  }
  for (const [action, fallback] of Object.entries({ assist: DEFAULT_ASSIST_SHORTCUT, toggle: DEFAULT_TOGGLE_SHORTCUT })) {
    const result = registerShortcut(action, configured?.[action] || fallback);
    if (!result.ok) {
      console.error('[Aether] unable to register ' + action + ' shortcut:', result.error);
      if (configured?.[action] && configured[action] !== fallback) setShortcut(action, fallback);
    }
  }
}

function initializeHyprShortcut() {
  if (process.platform !== 'linux' || !process.env.HYPRLAND_INSTANCE_SIGNATURE) return;
  hyprShortcut = require('./src/hypr-shortcut').createHyprShortcut();
  if (registeredShortcuts.toggle) {
    toggleBindingReady = hyprShortcut.bind(registeredShortcuts.toggle).catch(error => {
      toggleBindingError = error.message;
      log('Hyprland restore binding unavailable: ' + error.message);
    });
  }
}

// -------- remote Auto (textAgent: `Aether --auto "goal" [--zen-url URL] [--allow-submit]`) --------
function writeRemoteResult(result) {
  const fs = require('fs'), dir = path.join(app.getPath('userData'), 'remote-auto');
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'last.json'), JSON.stringify(result)); }
  catch (error) { log('Remote Auto result write failed: ' + error.message); }
}
function handleRemoteAuto(argv) {
  const remoteAuto = require('./src/remote-auto');
  let request;
  try { request = remoteAuto.parseRemoteAuto(argv); }
  catch (error) { writeRemoteResult({ status: 'error', message: error.message, at: new Date().toISOString() }); return true; }
  if (!request) return false;
  void remoteAuto.runRemoteAuto(request, {
    getZen: () => getZenControl(),
    // Hands the URL to the running Zen; detached so a cold Zen start never blocks Aether.
    openInZen: async url => {
      if (useChrome()) { const chrome = getZenControl(); await chrome.connect(); return chrome.openUrl(url); }
      const { LD_LIBRARY_PATH, ...env } = process.env; require('child_process').spawn('/opt/zen-browser-bin/zen-bin', ['--marionette', '--new-tab', url], { detached: true, stdio: 'ignore', env }).unref(); },
    showPanel: () => showWindow(),
    startAutoMode,
    waitForEnd: async () => { await autoSession?.completion; return autoSession?.status; },
    writeResult: writeRemoteResult
  });
  return true;
}
// One Aether per desktop: a second launch shows the panel, or hands its --auto request over.
// (Test harnesses load main.js with a stub app that lacks the lock.)
if (typeof app.requestSingleInstanceLock === 'function') {
  if (!app.requestSingleInstanceLock()) app.quit();
  else app.on('second-instance', (_event, argv) => {
    if (!handleRemoteAuto(argv)) { showDock(); showWindow(); }
  });
}

// -------- lifecycle --------
app.whenReady().then(() => {
  // if (app.dock) app.dock.hide();

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using wingman's own grant.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (sources.length) callback({ video: sources[0], audio: 'loopback' });
      else callback();
    }).catch(() => callback());
  }, { useSystemPicker: false });

  createWindow();
  createDock();
  if (notchMode) screen.on('display-metrics-changed', () => { if (win && !win.isDestroyed()) win.setBounds(notchBounds()); });
  // Headless checks must not register keys or alter the signed-in desktop's bindings.
  if (app.commandLine.getSwitchValue('ozone-platform') !== 'headless') {
    registerShortcuts();
    initializeHyprShortcut();
    autoRefreshChange = Promise.resolve().then(() => configureAutoRefresh(!!store.getSettings().autoRefresh))
      .catch(error => { publishAutoRefreshState(false, error.message); send('status', { message: error.message }); });
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

  // Cold start with --auto: let the panel load before starting. ponytail: fixed 3 s wait, use a renderer-ready signal if it proves flaky.
  if (process.argv?.some(arg => arg === '--auto' || String(arg).startsWith('--auto='))) setTimeout(() => handleRemoteAuto(process.argv), 3000);

  // Keep the overlay in front of fullscreen apps: when the active app changes
  // its fullscreen state, re-assert the window level and space settings.
  ['enter-full-screen', 'leave-full-screen'].forEach((evt) => {
    app.on(evt, (_e, bw) => { if (bw !== win) assertOverlay(); });
  });
});

let quittingAfterAuto = false;
app.on('before-quit', event => {
  if (quittingAfterAuto || !autoSession?.active) return;
  event.preventDefault();
  autoSession.stop('Auto stopped because Aether is quitting.');
  void autoSession.completion.finally(() => { quittingAfterAuto = true; app.quit(); });
});
app.on('will-quit', () => {
  writeSession?.stop('Write stopped because Aether is quitting.');
  zenControl?.close();
  autoSession?.stop('Auto stopped because Aether is quitting.');
  autoRefresh?.stop(); activityWatcher?.stop();
  stopWindowGesture();
  stopLinuxAudio();
  try { if (hyprShortcut) hyprShortcut.stop(); } catch (error) { log('Hyprland binding cleanup failed: ' + error.message); }
  globalShortcut.unregisterAll();
});
// Never quit when the overlay window is closed — wingman stays resident so the
// Command+` toggle (and the other global shortcuts) keep working. Quit via the
// Cmd+Shift+X shortcut or quitting the app from the Dock.
app.on('window-all-closed', () => {});
