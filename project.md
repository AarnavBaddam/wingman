# Aether project state

## Current phase

Phase 5: platform validation and release readiness. Linux keyring, microphone, output-monitor audio lifecycle, fresh-container runtime, normal FUSE launch, physical Hyprland Hide/restore, and live Tavily retrieval pass. Ollama is configured; factual-quality review, selected-window/recipient sharing, speech quality, a fully clean desktop install, and macOS/Windows remain open. Work is on `codex/wingman-hardening`; local commits are authorized and push remains deferred. See [release validation](docs/release-validation.md).

## Screen refresh follow-up

- User wants Assist to remain manual by default, with an optional click/scroll refresh. Settings now exposes that option on native Hyprland; other desktops remain manual. Activity waits 650 ms to settle, coalesces bursts and retains at most one latest pending request while a generation runs. Hidden/collapsed/settings/onboarding states pause observation. Runtime listener failure clears the Auto indicator and reports recovery guidance.
- Explicit screen questions skip unrelated library/Tavily retrieval and stream the answer immediately. Factual Ask and Research retain their source/citation gate. Reading/searching/writing phase labels show progress. This fixes the Google Assistant search-result detour; it does not guarantee accurate model interpretation.
- Capture now follows the cursor display for manual requests and the original interaction display for automatic requests. Native Hyprland uses `hyprctl` plus `grim` (required on PATH); missing capture support fails with setup guidance. Other platforms select the nearest Electron display. The image may include the visible overlay.
- 93 tests, localhost Playwright, pack and Linux AppImage build pass. Native unpacked testing passed real capture on the secondary display, non-consuming physical click/scroll, burst coalescing, preserved interaction display after pointer movement, and disabling. Native scheduling tests use a controlled provider; they do not prove model quality. Review found and fixed binary PNG decoding; the regression now checks binary capture options.
- A separate real Ollama test with a controlled fresh image took 4,838 ms to the first token and 5,310 ms total; identical-image repetition took 50 ms to first token and 384 ms total. Fresh screen understanding is not instantaneous, and one response misread a text color. No accuracy guarantee follows from the timing test.
- Code graph refreshed: 640 nodes, 1,011 edges. The same native activity/capture checks passed against the final FUSE AppImage. Latest artifact: 139,446,618 bytes, SHA-256 `ec40a1c55759f5d9dd7b259e980463de78e4bfe77c9793da312dc91ac78ecd6f`; details in `docs/release-validation.md`.
- Free Codex duration cannot be estimated honestly: the official pricing page publishes no fixed Free quota and describes Free desktop access, while Aether invokes `codex exec`. Free CLI eligibility must be checked before relying on it. Provider selection remains local Ollama.

## Hyprland overlay placement

- User reported Aether shrinking the current app instead of overlaying it. Native inspection confirmed Aether's exact class `dev.prahladv.aether` was tiled on Hyprland 0.56.2 despite Electron `alwaysOnTop`. Manually floating it restored T3's tiled width from 950 to 1,908 pixels.
- `src/linux-overlay.js` installs an exact-class floating/pinned rule before `BrowserWindow` maps on native Hyprland. Reuses one compositor-session rule across app restarts without rewriting user config. Skips headless runs, other desktops and other platforms; failures surface setup guidance in the app.
- User also requested removing the blurred surround, a wider six-dot drag handle, and resizing from either bottom corner. Final default is 700×420, minimum 520×300. The toolbar/panel fit the viewport, use opaque surfaces, and omit outer glow. Hyprland's rule disables compositor blur/shadows only for Aether. The unused pulsing-dot exception was removed after making the indicator static.
- Native CSS dragging did not move the Wayland window. Hyprland's interactive Lua drag/resize actions also require key-binding press context and silently do nothing from IPC. Final controls snapshot the exact process/window and compositor cursor, coalesce pointer updates, and issue targeted position/size changes. Release flushes the final cursor position; cancellation/hide/reload/quit stops pending motion. Other platforms retain native drag regions and use bounded Electron corner resizing; native validation there is pending.
- 72 tests passed. Localhost Playwright checked toolbar/panel fit at 520×300, 700×420 and 1000×700, six-dot movement, both corner cursors/events, retained Linux input, normal answer/source display and rejection. `npm run pack` and AppImage build passed. Actual mouse input against the final AppImage passed handle drag, both corner resizes, and fast press/move/release; neighboring tiled geometry stayed unchanged. Review caught a dropped final-position race, fixed with a failing regression and re-reviewed successfully.
- README separates Hyprland's verified placement from unverified GNOME/KDE and other tiling managers. Restart after Hyprland config reload; fullscreen stacking and capture exclusion remain distinct checks. Linux cannot forward ignored mousemove events, so mouse input stays enabled; a collapsed panel still has the surrounding native window's input footprint. Code graph refreshed (584 nodes, 941 edges).

## Research validation follow-up

- Citation validation now expands numeric groups/ranges, checks actual retrieved source IDs, and rejects invalid or unsupported numeric reference groups. Formatted math/code literals are preserved. Regression cases include missing IDs, zero/negative IDs, reversed or huge ranges, em dashes, and mixed text.
- Retrieved sources are published before model generation. Rejected drafts and provider failures retain source links; web fallback replaces the local source panel. Invalid drafts remain buffered and are not displayed.
- Prompt records the UTC retrieval date and distinguishes the newest retrieved item from the latest overall. This is guidance, not proof of freshness or factual correctness.
- 64 tests and localhost Playwright passed, including real renderer click, source replacement, rejection, normal answer and attribution. Independent review caught a malformed-group bypass; its regression failed before the correction and passed afterward. Re-review found no further important issue.
- A real packaged Ollama/Tavily probe confirmed early source display, but still mixed Electron release versions and made contradictory latest-version claims. The prompt change has not resolved semantic accuracy. User preference remains AI summaries with invalid citations blocked and sources shown.
- Code graph refreshed (556 nodes, 903 edges). Release build/checksum status is recorded in `docs/release-validation.md`.

## Live Tavily setup

- Used the user's requested Sleipnir browser capabilities and their selected Google account to create/access Tavily. Kept marketing opt-in unchecked and used the free plan; no payment setup.
- Saved the default Tavily API key through Aether's existing settings IPC using an in-memory transfer. The key was not printed, put in command arguments, or saved in source/test files. Confirmed ciphertext on disk and successful decryption by a fresh Electron process using GNOME Keyring.
- Real retrieval checks passed: `Banach space` returned one library source without a web request; a current Electron release query and a DNA library-gap query each returned five numbered HTTPS web sources. Dashboard confirms 4 of 1,000 credits used for the two advanced searches. These checks validate retrieval, not AI answer accuracy.
- User selected local Ollama for answers. Final models: `qwen25-vl-7b-16k:latest` for fast answers and `qwen35-9b-64k:latest` for Smart mode. Both support text and vision. The plain `qwen3.5:9b` test loaded only a 4K context, so larger-context installed aliases avoid truncating source packets. Local transcription uses the existing `ggml-base.en.bin` Whisper model. Saved configuration retains the encrypted Tavily key.
- Actual Research IPC and rendered answer/source UI passed connectivity checks for library-backed Banach and current Electron release questions. These are integration checks, not factual-quality passes: the 4K model's uncited web answer was blocked, and the final fast model incorrectly called Electron 44.7.0 the latest even though this checkout uses 44.9.0. Its citation gate passed. Broader factual accuracy remains unresolved, including stale retrieval and unsupported current claims. Smart-mode answer quality has not been checked with the final alias.
- Updated this machine's per-user launcher to include `--password-store=gnome-libsecret`; the default backend here is insufficient for saved encrypted keys. Regenerating the launcher must preserve this host-specific choice; do not force it for other keyring setups.
- No application code or dependencies changed for account/provider setup. The existing graph and 59-test code checkpoint remain current. Aether reopened normally through FUSE using the explicit GNOME Keyring backend and refreshed desktop-session environment.

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
5. **Platform validation and release** — Linux builds, native Hyprland capture/controls, keyring, audio acquisition/lifecycle and live Tavily pass on this host. Factual/speech quality, recipient sharing, clean desktop installation, other desktops and macOS/Windows remain open.

## Decisions

- Product name: **Aether**; app ID: `dev.prahladv.aether`.
- Keep the original GPL-3.0-or-later license and credit the Wingman author. The Wikipedia library has separate CC BY-SA 4.0 attribution.
- Linux first, then macOS, then Windows. No promise of invisibility in all screen capture or locked/proctored environments. Use OS protection where supported, a preview check, and full-window hide.
- Ollama keeps transcription local, with no cloud fallback. Claude/Codex use their installed signed-in CLIs.
- Typed factual questions retrieve local sources first; current questions and library misses use Tavily. Without usable sources, the answer path fails closed.

## Checks run

- `npm test`: latest suite has 93 passing tests.
- `npm run dist:linux`: built `dist/Aether-0.1.0.AppImage` (137 MB); `app.asar` contains the reference library and GPL license. The AppImage responds to `--appimage-version`.
- Headless Playwright on localhost: Research button, source and license links, provider choices, settings save/scroll, and Ollama local transcription controls worked with a mocked Electron bridge; no page errors.
- Live local Claude and Codex CLI replies passed. Ollama answered a library-backed Banach space question with a valid citation. An earlier Whisper probe passed.
- `npm audit --omit=dev`: zero findings. Full audit has 8 moderate findings from the upstream builder dependency chain (`sprintf-js`), with no patched package release currently available.

## Next steps

1. Inspect complete Ollama source-backed answers on math, science, and current-fact prompts. Tavily setup, encrypted save/decrypt, local-first retrieval, and live web requests now pass; Ollama and local Whisper are configured.
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
