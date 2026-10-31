// Capture the interaction display, not an unrelated primary monitor.
// First call triggers the macOS Screen-Recording permission prompt for the app.
const { app, desktopCapturer, screen } = require('electron');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

async function captureScreenshot(point) {
  if (process.platform === 'linux' && process.env.HYPRLAND_INSTANCE_SIGNATURE && app?.commandLine?.getSwitchValue('ozone-platform') !== 'headless') {
    try {
      const options = { timeout: 10000, maxBuffer: 40 * 1024 * 1024 };
      const position = point || JSON.parse((await run('hyprctl', ['-j', 'cursorpos'], options)).stdout);
      const monitors = JSON.parse((await run('hyprctl', ['-j', 'monitors'], options)).stdout);
      const monitor = monitors.find(m => {
        const width = (m.transform % 2 ? m.height : m.width) / (m.scale || 1);
        const height = (m.transform % 2 ? m.width : m.height) / (m.scale || 1);
        return position.x >= m.x && position.x < m.x + width && position.y >= m.y && position.y < m.y + height;
      });
      if (!monitor?.name) throw new Error('No interaction display');
      const { stdout } = await run('grim', ['-o', monitor.name, '-t', 'png', '-'], { ...options, encoding: 'buffer' });
      if (!Buffer.isBuffer(stdout) || stdout.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('No screenshot');
      return 'data:image/png;base64,' + stdout.toString('base64');
    } catch {
      const error = new Error('Hyprland screen capture failed. Ensure grim is installed and screen-copy access is available.');
      error.code = 'CAPTURE_SETUP';
      throw error;
    }
  }
  const display = screen.getDisplayNearestPoint(point || screen.getCursorScreenPoint());
  const { width, height } = display.size;
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.floor(width * scale), height: Math.floor(height * scale) }
  });
  if (!sources.length) return null;
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || (sources.length === 1 ? sources[0] : null);
  if (!src) return null;
  const img = src.thumbnail;
  if (!img || img.isEmpty()) return null;
  return img.toDataURL(); // data:image/png;base64,...
}

module.exports = { captureScreenshot };
