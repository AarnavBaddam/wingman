const DEBUG = false; // Set to false to disable debug logging
const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell } = require('electron');
const path = require('path');
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { createLLM } = require('./src/llm');
const { getEvidence, searchWeb, researchPrompt, validateGroundedAnswer, needsWebFollowup } = require('./src/research');
const { MODES } = require('./src/prompts');
const { appendResumeContext } = require('./src/profile-context');
const { rms16 } = require('./src/wav');

let win = null;
const registeredShortcuts = {};
let hyprShortcut = null;
let toggleBindingError = null;
let toggleBindingReady = Promise.resolve();

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

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

// -------- window --------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 700, H = 600;
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: workArea.y + 6,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    // macOS 'panel' (NSPanel): floats over full-screen apps and appears on
    // every Space. This is what actually makes the overlay follow the user
    // into a fullscreen app — setVisibleOnAllWorkspaces alone is unreliable.
    ...(isMac ? { type: 'panel' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // macOS and Windows can request capture exclusion; Linux has no equivalent here.
  if (process.platform === 'darwin' || process.platform === 'win32') win.setContentProtection(true);
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

  win.webContents.on('did-start-loading', () => setCapturing(false));
  win.on('closed', () => setCapturing(false));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => {
    if (win.isVisible()) return;
    win.showInactive();
    // Re-assert overlay settings each time the window appears, so it keeps
    // following the user into fullscreen apps and across Spaces.
    assertOverlay();
  });
  win.webContents.on('render-process-gone', (_e, d) => { setCapturing(false); console.log('[wingman] renderer gone', JSON.stringify(d)); });
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
  if (win.isVisible()) {
    win.hide();
  } else {
    assertOverlay();
    win.show();
    win.focus();
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  assertOverlay();
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
async function runFeature(mode, userText) {
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
    const llm = createLLM(settings);
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
      if (DEBUG) console.log('[DEBUG MAIN] Feature needs screen. Capturing screenshot...');
      try {
        imageDataUrl = await captureScreenshot();
        if (!imageDataUrl) throw new Error('No screenshot was returned');
        if (DEBUG) console.log('[DEBUG MAIN] Screenshot captured successfully (length:', imageDataUrl.length, ')');
      } catch (e) {
        if (DEBUG) console.error('[DEBUG MAIN] Screenshot capture failed:', e);
        send('llm:error', { message: process.platform === 'darwin'
          ? 'Screen capture failed. Check Aether’s Screen Recording permission in System Settings, then try again.'
          : 'Screen capture failed. Check capture permissions and try again.' });
        return;
      }
    }

    const built = def.build({ transcript, userText: userText || '' });
    let sources = ['research', 'ask'].includes(mode) ? await getEvidence(userText, settings.apiKeys.tavily) : [];
    if (DEBUG) console.log('[DEBUG MAIN] Built prompt. Starting LLM stream...');
    const answer = () => llm.stream({
      system: appendResumeContext(def.system, settings.resumeContext),
      turns: [{ role: 'user', text: built + (sources.length ? researchPrompt(sources) : '') }],
      imageDataUrl,
      onToken: (t) => { if (!sources.length) send('llm:token', { text: t }); }
    });
    let fullText = await answer();
    if (needsWebFollowup(fullText, sources)) {
      send('status', { message: 'Local sources were insufficient; searching the web.' });
      sources = await searchWeb(userText, settings.apiKeys.tavily);
      fullText = await answer();
    }
    if (sources.length) send('llm:token', { text: validateGroundedAnswer(fullText, sources) });
    if (DEBUG) console.log('[DEBUG MAIN] Full LLM Output:\n', fullText);
    if (sources.length) send('llm:sources', { sources: sources.map(({ number, title, url, origin }) => ({ number, title, url, origin })) });
    send('llm:done', {});
  } catch (e) {
    send('llm:error', { message: 'Error: ' + (e && e.message ? e.message : String(e)) });
  } finally {
    state.busy = false;
  }
}

// -------- IPC --------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => { sttDisabled = false; return store.setSettings(patch); });
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
  if (registeredShortcuts.toggle && !toggleBindingError && win && !win.isDestroyed()) win.hide();
});
ipcMain.on('mic:pcm', (_e, arrayBuffer) => { if (state.capturing) buffers.you.push(Buffer.from(arrayBuffer)); });
ipcMain.on('system:pcm', (_e, arrayBuffer) => { if (state.capturing) buffers.them.push(Buffer.from(arrayBuffer)); });
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
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
  // Headless checks must not register keys or alter the signed-in desktop's bindings.
  if (app.commandLine.getSwitchValue('ozone-platform') !== 'headless') {
    registerShortcuts();
    initializeHyprShortcut();
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

  // Keep the overlay in front of fullscreen apps: when the active app changes
  // its fullscreen state, re-assert the window level and space settings.
  ['enter-full-screen', 'leave-full-screen'].forEach((evt) => {
    app.on(evt, (_e, bw) => { if (bw !== win) assertOverlay(); });
  });
});

app.on('will-quit', () => {
  stopLinuxAudio();
  try { if (hyprShortcut) hyprShortcut.stop(); } catch (error) { log('Hyprland binding cleanup failed: ' + error.message); }
  globalShortcut.unregisterAll();
});
// Never quit when the overlay window is closed — wingman stays resident so the
// Command+` toggle (and the other global shortcuts) keep working. Quit via the
// Cmd+Shift+X shortcut or quitting the app from the Dock.
app.on('window-all-closed', () => {});
