const { globalShortcut } = require('electron');

// ydotool.exe is used for input; Electron owns the emergency stop shortcut so
// Escape remains available even when the target application has focus.
function createWindowsAutoStop({ onStop = () => {}, register = globalShortcut.register, unregister = globalShortcut.unregister } = {}) {
  let active = false;
  const accelerator = 'Escape';
  return {
    start() {
      if (active) return Promise.resolve();
      if (!register(accelerator, () => onStop('Auto stopped because Escape was pressed.'))) {
        return Promise.reject(new Error('Could not reserve Escape for stopping Auto. Close the conflicting shortcut and retry.'));
      }
      active = true;
      return Promise.resolve();
    },
    stop() {
      if (!active) return;
      active = false;
      try { unregister(accelerator); } catch {}
    }
  };
}

module.exports = { createWindowsAutoStop };
