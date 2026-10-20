#!/usr/bin/env node
// Compiles main.swift into a universal (arm64 + x86_64) binary at bin/macdotool.
// No-op off macOS and when the binary is newer than the source.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function build({ force = false } = {}) {
  if (process.platform !== 'darwin') return null;
  const source = path.join(__dirname, 'main.swift');
  const out = path.join(__dirname, 'bin', 'macdotool');
  if (!force && fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(source).mtimeMs) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const slices = ['arm64', 'x86_64'].map(arch => {
    const slice = `${out}-${arch}`;
    execFileSync('swiftc', ['-swift-version', '5', '-O', '-target', `${arch}-apple-macos14.0`, '-o', slice, source], { stdio: 'inherit' });
    return slice;
  });
  execFileSync('lipo', ['-create', '-output', out, ...slices], { stdio: 'inherit' });
  slices.forEach(slice => fs.rmSync(slice));
  return out;
}

if (require.main === module) {
  try { const out = build({ force: process.argv.includes('--force') }); if (out) console.log('macdotool: ' + out); }
  catch (error) { console.error('macdotool build failed. Install Xcode Command Line Tools (xcode-select --install).'); process.exit(1); }
}

module.exports = { build };
