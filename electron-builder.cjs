/* electron-builder configuration.
 *
 * Moved out of package.json so signing can be chosen by the environment rather
 * than hardcoded.
 *
 *   • Signed + notarized — set MAC_SIGN=1 with a "Developer ID Application"
 *     identity reachable in the keychain (or CSC_LINK in CI), plus
 *     APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID. electron-builder
 *     signs with the hardened runtime, notarizes, and staples. The app then
 *     opens on the first double-click with no warning at all.
 *
 *   • Ad-hoc fallback (no cert) — identity:null, so a fork or a secret-less CI
 *     run still produces a valid (not "damaged") build. It is NOT distributable:
 *     macOS refuses it after a download, and since macOS 15 the old
 *     right-click → Open escape hatch is gone.
 */

// Gated on an explicit flag rather than on CSC_LINK: a bare .p12 carries only
// the leaf certificate, and signing with an incomplete chain fails in a way
// that looks like a wrong password.
const hasCert = process.env.MAC_SIGN === "1";
const canNotarize =
  hasCert &&
  !!process.env.APPLE_ID &&
  !!process.env.APPLE_APP_SPECIFIC_PASSWORD &&
  !!process.env.APPLE_TEAM_ID;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "dev.prahladv.aether",
  productName: "Aether",
  publish: null,
  files: ["main.js", "preload.js", "src/**/*", "renderer/**/*", "data/**/*", "packages/macdotool/index.js", "LICENSE"],
  // Desktop Auto on macOS needs the macdotool helper; compile it before packaging.
  beforePack: (context) => {
    if (context.electronPlatformName === "darwin") require("./packages/macdotool/build").build();
  },
  directories: { buildResources: "build-resources" },
  mac: {
    target: [{ target: "zip", arch: ["arm64"] }],
    category: "public.app-category.productivity",
    // Outside asar so it can be spawned; electron-builder signs it with the app.
    extraResources: [{ from: "packages/macdotool/bin/macdotool", to: "macdotool" }],
    // With a real cert, let electron-builder discover it and apply the hardened
    // runtime (notarization is refused without it). Without one, identity:null
    // makes it skip signing rather than fail.
    identity: hasCert ? undefined : null,
    hardenedRuntime: hasCert,
    gatekeeperAssess: false,
    entitlements: "build-resources/entitlements.mac.plist",
    entitlementsInherit: "build-resources/entitlements.mac.plist",
    // electron-builder 26 wants a boolean; the credentials come from
    // APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID in the env.
    notarize: canNotarize,
    extendInfo: {
      NSMicrophoneUsageDescription:
        "transcribes microphone so it can help you in conversations.",
      NSCameraUsageDescription: "does not use the camera.",
      NSAudioCaptureUsageDescription:
        "captures system audio to transcribe the other participant in a call.",
    },
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
  },
  linux: {
    target: [{ target: "AppImage", arch: ["x64"] }],
    category: "Utility",
    syncDesktopName: true,
  },
};
