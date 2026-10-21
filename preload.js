const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('wingman', {
  setZoomLevel: (level) => webFrame.setZoomLevel(level),
  getZoomLevel: () => webFrame.getZoomLevel(),
  platform: process.platform,
  compositorMoves: process.platform === 'linux' && !!process.env.HYPRLAND_INSTANCE_SIGNATURE,
  autoRefreshSupported: process.platform === 'linux' && !!process.env.HYPRLAND_INSTANCE_SIGNATURE,
  autoRefreshPause: (paused) => ipcRenderer.send('auto-refresh:pause', paused),
  autoRefreshStatus: () => ipcRenderer.invoke('auto-refresh:status'),
  autoModeStatus: () => ipcRenderer.invoke('auto-mode:status'),
  autoModeStart: (goal, options) => ipcRenderer.invoke('auto-mode:start', goal, { allowSubmit: options?.allowSubmit === true, target: options?.target || 'desktop', tabId: options?.tabId }),
  autoModeZenTabs: () => ipcRenderer.invoke('auto-mode:zen-tabs'),
  autoModeStop: () => ipcRenderer.send('auto-mode:stop'),
  moveStart: () => ipcRenderer.invoke('window:move-start'),
  moveUpdate: () => ipcRenderer.send('window:move-update'),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  shortcutAssistSet: (accelerator) => ipcRenderer.invoke('shortcut:assist:set', accelerator),
  shortcutToggleSet: (accelerator) => ipcRenderer.invoke('shortcut:toggle:set', accelerator),
  shortcutStatus: () => ipcRenderer.invoke('shortcut:status'),
  ask: (payload) => ipcRenderer.send('ask', payload),
  hideForSharing: () => ipcRenderer.send('window:hide-for-sharing'),
  panelHide: () => ipcRenderer.send('panel:hide'),
  dockShow: () => ipcRenderer.send('dock:show'),
  resizeStart: (request) => ipcRenderer.invoke('window:resize-start', request),
  resizeMove: (point) => ipcRenderer.send('window:resize-move', point),
  resizeEnd: (request) => ipcRenderer.send('window:resize-end', request),
  captureToggle: () => ipcRenderer.invoke('capture:toggle'),
  captureStop: () => ipcRenderer.invoke('capture:stop'),
  captureState: () => ipcRenderer.invoke('capture:state'),
  systemAudioStart: () => ipcRenderer.invoke('capture:system:start'),
  systemAudioStop: () => ipcRenderer.invoke('capture:system:stop'),
  micPcm: (arrayBuffer) => ipcRenderer.send('mic:pcm', arrayBuffer),
  systemPcm: (arrayBuffer) => ipcRenderer.send('system:pcm', arrayBuffer),
  setIgnoreMouse: (v) => ipcRenderer.send('mouse:ignore', v),
  openPane: (url) => ipcRenderer.send('open-pane', url),
  log: (msg) => ipcRenderer.send('log', msg),
  on: (channel, cb) => {
    const allowed = ['capture:state', 'capture:system-ended', 'llm:start', 'llm:phase', 'llm:token', 'llm:done', 'llm:error', 'llm:sources', 'auto-refresh:state', 'auto-mode:state', 'status', 'transcript'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
