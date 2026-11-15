// Register a built AppImage with the desktop so Wayland portals can identify it.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function installLauncher(imagePath, dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share')) {
  const image = fs.realpathSync(imagePath);
  fs.accessSync(image, fs.constants.X_OK);
  if (/[\r\n\0]/.test(image)) throw new Error('The AppImage path cannot contain line breaks.');
  // Desktop entries decode backslashes before the Exec field parses quoted arguments.
  const executable = image.replace(/([\\`"$])/g, '\\$1').replace(/\\/g, '\\\\').replace(/%/g, '%%');
  const destination = path.join(dataHome, 'applications', 'dev.prahladv.aether.desktop');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, '[Desktop Entry]\nType=Application\nName=Aether\nComment=Desktop AI copilot\nExec="' + executable + '"\nTerminal=false\nCategories=Utility;\nStartupWMClass=dev.prahladv.aether\n', { mode: 0o644 });
  return destination;
}

if (require.main === module) {
  try { console.log(installLauncher(process.argv[2] || path.join(__dirname, '../dist/Aether-0.1.0.AppImage'))); }
  catch (error) { console.error('Could not install Aether launcher:', error.message); process.exitCode = 1; }
}
module.exports = { installLauncher };
