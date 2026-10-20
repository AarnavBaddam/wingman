const fs = require('node:fs');
const path = require('node:path');

// Packaged apps ship the binary in Contents/Resources (outside asar so it can be spawned).
function binaryPath(resourcesPath = process.resourcesPath) {
  const packaged = resourcesPath && path.join(resourcesPath, 'macdotool');
  return packaged && fs.existsSync(packaged) ? packaged : path.join(__dirname, 'bin', 'macdotool');
}

module.exports = { binaryPath };
