const { contextBridge, ipcRenderer } = require('electron');

// The dock only shows status and opens/dismisses; it gets no settings, keys or Auto control.
contextBridge.exposeInMainWorld('aetherDock', {
  onState: cb => ipcRenderer.on('dock:state', (_event, state) => cb(state)),
  activate: () => ipcRenderer.send('dock:activate'),
  dismiss: () => ipcRenderer.send('dock:dismiss')
});
