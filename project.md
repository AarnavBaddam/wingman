# Aether project state

## Current phase

Phase 5: platform validation and release readiness. Linux keyring, microphone, output-monitor audio lifecycle, fresh-container runtime, normal FUSE launch, and physical Hyprland Hide/restore have concrete results. Live Tavily, selected-window/recipient sharing checks, speech quality, a fully clean desktop install, and macOS/Windows remain open. Work is on `codex/wingman-hardening`; local commits are authorized and push remains deferred. See [release validation](docs/release-validation.md).

## Sharing and configurable shortcuts

- User requested an actual desktop recording and shorter, user-selected restore keys. A private, audio-free full-monitor `wf-recorder` recording confirmed Hide removes the window. The user's physical old Ctrl+Alt+Shift+9 press did not restore it; the agent showed it again. Recording is ignored under `dist/validation/`.
- Added Show / hide to the existing Settings shortcut recorder, with reset, Escape cancel, conflict errors, saved preferences, and dynamic tooltip/onboarding labels. New default is Ctrl+Shift+Space (Command+Shift+Space on macOS). Assist retains its own setting. Failed saves restore the old runtime binding.
- Startup conflicts must not strand a user: actual registration status disables Hide when the restore binding is unavailable; the main-process Hide handler also waits for native setup. Registration booleans alone do not prove Wayland delivery.
- Portal trace found Electron 43 skipped host app registration: `CreateSession` failed with “An app id is required.” Electron 44.9.0 sends the missing registration. The portal then required the installed `dev.prahladv.aether.desktop` launcher, supplied by `scripts/install-linux.js`. Hyprland also requires a compositor binding; `src/hypr-shortcut.js` creates it, updates it for custom keys, and removes only owned bindings on quit. Headless checks skip global shortcuts to avoid altering the signed-in desktop.
- 49 unit tests pass; review found no further important issues after the startup-conflict fix. Localhost Playwright exercised change/reset/cancel/conflict, shifted digits, tooltip updates, and unavailable-restore Hide recovery. Native AppImage custom save/reset/reload passed, and the reset preference was confirmed on disk without exposing keys. Final pack, AppImage build/startup/research IPC, and checksum checks passed. AppImage is 143,329,894 bytes, SHA-256 `5b9309a73918b3f01ad393fd594a22d948c33d6af33da49906048e6601ee4c8a`.
- User physically pressed Ctrl+Shift+Space twice after the repair and confirmed hide/restore both worked. Normal FUSE AppImage launch, native custom key save/reset/reload/disk, and runtime binding cleanup passed. Portal dispatch independently toggled BrowserWindow hidden/visible; a local audio-free recording confirms disappearance but does not establish visual restoration after the workspace changed. Do not overstate recording evidence.
- Latest: 59 tests pass; review found no further important issues after fixing startup-conflict recovery, first-save cleanup, and stale owned bindings. Localhost Playwright and final pack/build/startup/research IPC passed. Electron 44 native audio lifecycle and Ubuntu 24.04 runtime were rerun successfully. Final AppImage: 139,434,546 bytes; SHA-256 `541522520ecce7c349a7fc9e56f91ed8da82b7aec80f31ad4f8b9d23c9794136`. Graph refreshed to 554 nodes/899 edges.
- Limits: restart Aether after a Hyprland configuration reload clears runtime bindings; automatic binding targets Lua Hyprland (0.55+), Show / hide only. Other global actions may need desktop setup. Electron 44 requires macOS 13+. Never run concurrent extraction-mode AppImage checks: they can share and remove each other's temporary resources. No recorder is running; push remains deferred.

## Phases

1. **Audit and target** — cloned Aarnav Baddam's Wingman, identified plaintext key storage, capture-state failures, capture exclusion limits, and platform-specific build assumptions. Complete.
2. **Harden core** — OS-backed key encryption and migration, capture failure handling, audio readiness, full-window Hide for sharing. Complete in code and focused tests.
3. **Provider choices** — Ollama, Claude CLI, Codex CLI, and local Whisper transcription. Complete in code; local CLI/model smoke checks completed on Linux.
4. **Grounded answers** — bundled 1,832-article Wikipedia reference library, local lexical retrieval, Tavily fallback for current/weak matches or model uncertainty, source display, and citation gate. Complete in code and mocked network tests.
5. **Platform validation and release** — Linux AppImage builds and browser UI checks pass. Native share exclusion, real audio permissions, macOS/Windows packaging, and a live Tavily request remain to verify on their target environments.

## Decisions

- Product name: **Aether**; app ID: `dev.prahladv.aether`.
- Keep the original GPL-3.0-or-later license and credit the Wingman author. The Wikipedia library has separate CC BY-SA 4.0 attribution.
- Linux first, then macOS, then Windows. No promise of invisibility in all screen capture or locked/proctored environments. Use OS protection where supported, a preview check, and full-window hide.
- Ollama keeps transcription local, with no cloud fallback. Claude/Codex use their installed signed-in CLIs.
- Typed factual questions retrieve local sources first; current questions and library misses use Tavily. Without usable sources, the answer path fails closed.

## Checks run

- `npm test`: latest suite has 59 passing tests.
- `npm run dist:linux`: built `dist/Aether-0.1.0.AppImage` (137 MB); `app.asar` contains the reference library and GPL license. The AppImage responds to `--appimage-version`.
- Headless Playwright on localhost: Research button, source and license links, provider choices, settings save/scroll, and Ollama local transcription controls worked with a mocked Electron bridge; no page errors.
- Live local Claude and Codex CLI replies passed. Ollama answered a library-backed Banach space question with a valid citation. An earlier Whisper probe passed.
- `npm audit --omit=dev`: zero findings. Full audit has 8 moderate findings from the upstream builder dependency chain (`sprintf-js`), with no patched package release currently available.

## Next steps

1. Set up Tavily and enter a key in Aether; the user confirmed it is not configured yet. Then test live search and inspect citation quality on math, science, and current-fact prompts.
2. Finish speech-to-transcript quality checks on Linux. Real microphone acquisition/denial, output-monitor PCM, keyring round trip, capture lifecycle and physical Hyprland Hide/restore pass. Selected-window/recipient previews and other compositor hotkeys remain to check; macOS/Windows require their hardware.
3. Smoke test the AppImage on a clean Linux user account with real desktop capture permissions and a configured model.
4. Review the upstream builder advisory when a patched `sprintf-js` path becomes available.

## Validation follow-up — 2026-10-17

- Reran all 37 tests, `npm run pack`, and `npm run dist:linux`: passed. Rebuilt AppImage is 143,330,085 bytes; packaged library and license are present.
- Real Playwright on localhost passed Research/source/license rendering, provider selection, mandatory local STT for Ollama, failed settings-save recovery, and Hide bridge wiring, with zero page errors. The Electron bridge and answer were fixtures.
- Playwright launched both the unpacked app and AppImage headlessly with isolated temporary profiles. This proves packaged startup on this host, not a clean Linux install or native permission behavior. Headless secure storage was unavailable (`basic_text`); real desktop keyring validation remains open.
- Production dependency audit remains clean. Full audit still reports eight moderate builder-chain findings. The `sprintf-js` advisory has no patched version; no downgrade/override was applied.
- User clarified that Tavily is not set up yet. Live search testing is deferred until setup and a key are available; no live Tavily request was made.
- Live Ollama (`qwen2.5-coder:7b`) math/science probes passed citation-number validation but failed full source-faithfulness review: a Banach naming relationship was reversed and a relativity development date was conflated with publication. Investigate prompt/model behavior and repeat evidence-level checks before marking factual quality complete. Citation validation alone is insufficient.
- `origin` still points at the original author's Wingman repository for fetch and push. User authorized a local commit only; push is deferred until an Aether destination and explicit push instructions are provided.
- No application source or dependencies changed during this validation pass. Checkpoint and release checklist were updated. The temporary browser harness is `/tmp/aether-validation.cjs`, not a shipped test runner.

## Continued grounding work

- Local checkpoint commit: `fa61f1b` (`feat: harden Aether and add grounded research`). Push remains deferred.
- Fixed narrower-title acceptance in `getEvidence`: normalized query/title topic terms must match, so a general DNA question cannot rely only on an article about DNA fluorescence. Added a failing-then-passing regression; all 38 tests pass.
- Tightened and repositioned the evidence instructions for every factual claim. No provider/dependency change or extra model call was added.
- Live `qwen2.5-coder:7b` checks remain mixed: three of four final-prompt responses passed citation-number validation, one invalid source number was correctly blocked, and date wording still drifted. Naming accuracy improved in one sample, but semantic faithfulness is not complete.
- Localhost Playwright UI checks passed. The real unpacked-app IPC path correctly rejected the narrower DNA source and returned the missing-Tavily error. This headless test does not establish desktop capture, keyring, or audio behavior.
- Final `npm run pack` and `npm run dist:linux` passed; the rebuilt AppImage (143,330,112 bytes) passed isolated startup and the real IPC missing-Tavily check.
- Refreshed the code graph after the retrieval/test changes (493 nodes, 916 edges). Checkpoint/docs updated; this follow-up follows the user's local-commit-only instruction, with no push.
- User chose to keep AI summaries, block invalid citations, and show sources. Retain the existing summary flow rather than adding a source-excerpt mode. Factual-quality review remains open; Tavily setup and native/clean-install/macOS/Windows validation remain pending.

## Linux runtime and native audio

- User clarified that local commits remain allowed; the request was to keep working rather than end after each commit. Push remains deferred.
- Real GNOME Keyring save/encrypted-file/restart-decrypt checks passed using a disposable value and `--password-store=gnome-libsecret`. Default Hyprland backend selected `basic_text` and was correctly refused. README now documents the explicit backend for GNOME Keyring setups.
- Real microphone acquisition and stop passed; denying Electron media permission returned `NotAllowedError`. No audio samples were read, saved, or sent in that probe.
- AppImage started in a fresh Ubuntu 24.04 container with only the artifact mounted read-only. Fresh settings, refusal to save keys without a keyring, and research IPC fallback passed. Headless container used extraction mode and disabled Chromium sandbox; it does not replace a full desktop/FUSE install check. Added the runtime Dockerfile for repeatability.
- Found that the display-media loopback flag was not a Linux system-audio backend. Added `src/linux-audio.js` using installed `parec` to capture the default output monitor. Readiness waits for aligned PCM; startup/termination are bounded. Failed startup permits retry, and a source ending during microphone permission does not activate empty capture.
- All 44 tests pass. A real monitor produced aligned PCM. Packaged native-audio IPC start/stop/restart, renderer reload, and app quit returned capture streams to baseline. No audio was saved or transcribed by those tests.
- Localhost Playwright passed native-audio start/stop/failure UI with a fixture bridge, along with existing Research/settings/source/license/Hide checks. Actual microphone, native monitor, and packaged IPC were checked separately.
- Independent review found and verified a fix for a source-ending race during activation. Added a post-activation liveness check and idempotent `capture:stop` IPC; the new regression failed before the fix, and all 45 tests now pass. Re-review found no remaining important issue.
- User explicitly deferred real sharing previews until later. Continue other work across local commits; do not push.
- Final 45-test suite, localhost UI, `npm run pack`, and `npm run dist:linux` passed. Rebuilt AppImage is 143,329,917 bytes; native IPC/lifecycle and Ubuntu missing-helper retry checks passed after the activation-race fix. Code graph refreshed to 512 nodes and 947 edges.
