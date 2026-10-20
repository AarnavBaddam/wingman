const { spawn } = require('node:child_process');

// macOS counterpart of hypr-activity: `macdotool watch` reports left clicks and
// scrolls from a listen-only event tap. Points over Aether are dropped here.
function createMacActivityWatcher({ onActivity, onError = () => {}, isOwnPoint = () => false,
  binary = require('../packages/macdotool').binaryPath(),
  start: launch = () => spawn(binary, ['watch'], { stdio: ['pipe', 'pipe', 'pipe'] })
} = {}) {
  let current;
  function dispose(state) {
    if (current === state) current = undefined;
    clearTimeout(state.timer);
    state.child.stdin.destroy();
    state.child.kill('SIGTERM');
  }
  return {
    start() {
      if (current) return current.promise;
      const state = { buffer: '', ready: false };
      current = state;
      state.child = launch();
      state.promise = new Promise((resolve, reject) => {
        const failed = message => {
          if (current !== state) return;
          dispose(state);
          const error = new Error(message);
          if (state.ready) onError(error); else reject(error);
        };
        state.timer = setTimeout(() => failed('macOS activity watcher timed out.'), 1500);
        let stderr = '';
        state.child.stderr.setEncoding('utf8');
        state.child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-500); });
        state.child.on('error', () => failed('macOS activity watcher could not start. Rebuild macdotool.'));
        state.child.on('close', () => failed(stderr.trim() || 'macOS activity watcher stopped.'));
        state.child.stdout.setEncoding('utf8');
        state.child.stdout.on('data', chunk => {
          if (current !== state) return;
          state.buffer += chunk;
          if (state.buffer.length > 65536) state.buffer = state.buffer.slice(state.buffer.lastIndexOf('\n') + 1);
          let newline;
          while ((newline = state.buffer.indexOf('\n')) !== -1) {
            const line = state.buffer.slice(0, newline);
            state.buffer = state.buffer.slice(newline + 1);
            if (!state.ready) {
              if (line !== 'ready') continue;
              state.ready = true; clearTimeout(state.timer); resolve();
              continue;
            }
            const match = line.match(/^(-?\d{1,7}) (-?\d{1,7})$/);
            if (!match) continue;
            const point = { x: Number(match[1]), y: Number(match[2]) };
            if (!isOwnPoint(point)) onActivity?.(point);
          }
        });
      });
      return state.promise;
    },
    stop() {
      if (current) dispose(current);
    }
  };
}

module.exports = { createMacActivityWatcher };
