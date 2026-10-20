// macOS counterpart of hypr-auto-stop. Escape is a global shortcut while Auto
// runs; unlike Hyprland's non-consuming bind it is swallowed, which is fine
// because Auto itself never types Escape.
function createMacAutoStop({ onStop = () => {}, globalShortcut = require('electron').globalShortcut } = {}) {
  let active = false;
  const stop = () => {
    if (!active) return;
    active = false;
    globalShortcut.unregister('Escape');
  };
  return {
    async start() {
      if (active) return;
      if (!globalShortcut.register('Escape', () => { stop(); onStop('Auto stopped: Escape pressed.'); })) {
        throw new Error('Could not reserve Escape to stop Auto. Close apps that use Escape as a global shortcut and retry.');
      }
      active = true;
    },
    stop
  };
}

module.exports = { createMacAutoStop };
