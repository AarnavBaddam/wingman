# Aether release validation

## Latest shortcut and sharing checks

- Full-monitor `wf-recorder` recording (no audio) confirmed Hide removed Aether. The user's physical Ctrl+Alt+Shift+9 press failed to restore it; the agent restored the window. Keep native restore pending.
- Show / hide now uses the Settings recorder, default Ctrl+Shift+Space (Command+Shift+Space on macOS), independently of Assist. Changes save transactionally; failed saves restore the previous binding. Known startup registration failure disables Hide in the UI and main IPC.
- 49 tests pass, including shortcut replacement/conflicts/save rollback/startup conflict. Localhost Playwright passed change/reset/cancel/conflict, shifted digits, tooltip updates, and unavailable-restore Hide recovery. Native AppImage custom save/reset/reload and persisted default checks passed. Final pack/AppImage build, isolated startup/research IPC and SHA-256 checks passed. Latest artifact is 143,329,894 bytes; SHA-256 `5b9309a73918b3f01ad393fd594a22d948c33d6af33da49906048e6601ee4c8a`. User's physical Ctrl+Shift+Space result remains pending.
- Linux desktop identity now matches `dev.prahladv.aether.desktop`; explicit portal flags alone did not create a Hyprland shortcut entry. Do not mark restore fixed based on registration success.

Last checked: 2026-10-17. Phase 5 remains open. These results apply to the `codex/wingman-hardening` checkpoint. The user authorized a local commit; push is deferred.

## Implemented

- GPL-3.0-or-later Wingman fork, renamed Aether, with Aarnav Baddam credited.
- OS-backed encryption and atomic migration of API keys; settings errors preserve existing data.
- Screen/audio capture failure handling and full-window Hide for sharing.
- Ollama and signed-in Claude/Codex CLI providers; local Whisper with no cloud transcription fallback for Ollama.
- A separately attributed, CC BY-SA 4.0 Wikipedia library containing 1,832 articles.
- Local-first factual retrieval, Tavily fallback, displayed sources, and a citation/uncertainty gate.

## Fresh checks

- `npm test`: 45 passed, zero failed, including narrower-title rejection and Linux native-audio readiness, framing, failure, retry, and activation/lifecycle regressions.
- `npm run pack`: exit 0. `app.asar` contains `data/library.json`, `LICENSE`, and research/settings modules.
- Localhost Playwright with the actual renderer and a mocked Electron bridge: Research submission, source and CC BY-SA links, Claude/Codex/Ollama selection, mandatory local STT for Ollama, failed settings-save recovery, and Hide bridge invocation passed; zero page errors. Answers in this UI fixture are synthetic, not provider output.
- The unpacked Linux app and rebuilt `dist/Aether-0.1.0.AppImage` both started through Playwright's Electron driver with separate temporary user-data directories. This was headless on the existing host, not a clean Linux installation. Neither profile contained user keys.
- `npm run dist:linux`: exit 0; latest AppImage size 143,329,894 bytes. The AppImage runtime was checked with `--appimage-version` during the initial validation pass.
- Live `qwen2.5-coder:7b` through Aether's Ollama adapter answered `Banach space` and `General relativity` using local evidence and passed citation-number validation. Manual comparison exposed factual drift: the Banach response said Banach later coined “Banach space,” whereas its source says he coined “Fréchet space.” The relativity response used “developed ... in 1916,” blending a source's May 1916 publication date with another source's 1907–1915 development period. These are quality findings, not successful factual acceptance checks.
- `npm audit --omit=dev`: zero findings. Full audit: eight moderate findings in the builder dependency chain. The root [sprintf-js advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) still lists no patched version. Audit suggests a builder downgrade; no dependency downgrade or override was applied.
- `git diff --check`: passed before checkpoint edits; rerun before committing.

The initial headless sessions lacked desktop D-Bus variables and reported `safeStorage` unavailable with backend `basic_text`. A later check connected to the real GNOME Keyring and passed encrypted save/restart-decrypt with `--password-store=gnome-libsecret`; default backend selection on Hyprland still chose `basic_text`. Aether continues refusing keys in an insecure environment.

## Remaining acceptance checks

### Live Tavily and factual quality

The user confirmed Tavily is not set up yet. Create/configure the Tavily account and enter the key in Aether Settings before live checks. No live request has been made. Never put the key in chat, logs, fixtures, or this repository.

1. In Research, ask `Who is the current president of France?` Verify web sources appear, source links open, and the answer's date-sensitive claim is supported by the retrieved passages.
2. Ask `Banach space` and `General relativity`. Inspect whether each answer is supported by local evidence. If the model explicitly finds local evidence insufficient, confirm one web fallback and the replacement source list.
3. Ask a question outside the library, such as a local event this week. Confirm a Tavily request and usable sources, or a clear failure without an unsupported answer.
4. Disconnect the network and repeat a current question. Confirm the request stops with an error. Restore networking afterward.

Citation numbers prove that a retrieved source was referenced; they do not prove that every claim follows from it. Quality review remains manual. Before declaring grounded-answer quality ready, investigate the observed naming/date drift, assess prompt or model changes, and repeat math/science examples against the actual source text. Do not treat a prompt change or a valid citation number as proof of semantic accuracy.

### Linux desktop permissions and sharing

Record distribution, X11/Wayland session, model, sharing app, and observed result for each run.

- Save a key on a real secure-storage backend, restart Aether, and confirm the key remains usable. Confirm the settings file has encrypted keys without printing their contents.
- Deny microphone access; verify the error and inactive state. Then allow access and verify real speech reaches the transcript.
- Test microphone only, system audio only, and both. Stop a shared track; verify the remaining track continues, or listening stops when none remain.
- Select Ollama/local Whisper and transcribe real speech. Confirm there is no cloud transcription fallback.
- Test screen capture success and denial; denial must stop a screen-dependent request before provider submission.
- Check a selected-window/tab share and a full-display share from a recipient or recording. Use Hide for sharing and verify the entire window disappears, then restore it with `Ctrl+Alt+Shift+9`.
- Test the global shortcut and overlay behavior on the target compositor. Never interpret the mocked Hide check as native exclusion evidence.

### Clean Linux installation

Use a fresh supported Linux VM or separate machine/user with no development checkout or `node_modules`. A temporary profile on this development host does not satisfy this check.

1. Launch the AppImage through its normal desktop/runtime path; record any FUSE or library prerequisites.
2. Configure a model and local Whisper as needed. Confirm missing CLI/model prerequisites produce useful errors.
3. Complete onboarding, save settings using the desktop keyring, restart, and run a library-backed Research request.
4. Repeat real capture/audio and Hide/restore checks. Record actual results before marking this complete.

### macOS and Windows

- Build on each target OS and launch the output. The current macOS configuration targets arm64; decide whether Intel Mac support is required before adding another architecture.
- On macOS, verify microphone/screen-recording permissions, signing, notarization, and downloaded-app launch with the intended Apple credentials.
- On Windows, verify installer/startup, signing as required for distribution, microphone/system audio, shortcuts, and capture protection.
- On both, inspect a real share/recording preview; content protection remains best effort.

### Publishing

- Recheck the builder advisory when a patched dependency path is available; validate any dependency change with tests and packaging.
- Review the full uncommitted fork, licenses, bundled article attribution, and release limitations.
- Choose the Aether repository destination. `origin` currently fetches and pushes to `https://github.com/AarnavBaddam/wingman.git`; do not push fork work there by default.
- Local checkpoint commit is authorized. Push remains deferred until an Aether destination and explicit push instructions are provided. Build distributed release artifacts from the reviewed commit and keep platform claims limited to verified platforms.

## Evidence still missing

Live Tavily, answer faithfulness after the observed Ollama errors, recipient/recording sharing previews, full speech/meeting transcription checks, normal desktop keyring configuration, a full clean Linux desktop installation, and macOS/Windows release validation remain open. Earlier local Claude/Codex/Whisper probes are recorded in `project.md`; they were not rerun as part of this pass.

## Grounding follow-up

- Fixed a concrete retrieval error: `Explain DNA` previously accepted `Intrinsic DNA fluorescence` as sufficient local evidence. It now requires the matching normalized topic title, otherwise using web fallback or the missing-Tavily error. The new regression failed before the fix and passes afterward.
- Moved concise grounding instructions after the evidence. They apply to all factual claims and tell the model to preserve names, relationships, qualifiers, and distinct events/dates.
- Four live `qwen2.5-coder:7b` replies with the final prompt: three passed citation-number validation; one invented `[2]` when only source `[1]` existed and was correctly rejected. One Banach response preserved the previously reversed naming relationship, but relativity replies still blurred publication versus development/proposal dates. Prompt wording alone has not resolved semantic accuracy.
- Localhost Playwright UI checks passed with a fixture bridge. The real packaged Electron IPC path also rejected the narrower DNA article and returned the missing-Tavily error without emitting answer/source content. The headless onboarding overlay covered the panel, so this IPC check inspected the resulting DOM text rather than claiming a visible desktop interaction.
- After the final prompt change, `npm run pack` and `npm run dist:linux` passed again. The rebuilt AppImage passed isolated startup and the same real IPC fallback check.
- User chose to keep AI summaries, block invalid citations, and show sources. Retain that flow; do not add a source-excerpt mode. This decision does not mark semantic accuracy verified. No extra verification model or new dependency was added.

## Native Linux follow-up

- **Key storage:** disposable-value save, absence of plaintext in the settings file, app restart, and decrypt passed against the real GNOME Keyring with `--password-store=gnome-libsecret`. No user API key was read. Default Hyprland selection still used `basic_text`; see README setup instructions and [Electron's backend documentation](https://www.electronjs.org/docs/latest/api/safe-storage).
- **Microphone:** a real device returned a live audio track, which was stopped immediately. An Electron permission denial returned `NotAllowedError`. No samples were read, saved, or sent. Full microphone-to-transcript behavior remains a separate check.
- **Fresh runtime:** Ubuntu 24.04 base digest `sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac` plus native GUI/audio libraries, no development checkout or host `node_modules`. The read-only-mounted AppImage started and passed fresh-settings, secure-storage refusal, and research IPC checks. Only the AppImage was mounted; desktop, D-Bus, audio, and keyring sockets were not shared. Container used host networking for local debugging, AppImage extraction, and `--no-sandbox`. This is runtime portability evidence, not normal FUSE launch, desktop installation, sandbox validation, or capture-permission evidence. The recipe is `scripts/linux-runtime.Dockerfile`.
- **System audio fix:** [Electron's display-media handler](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts) documents its string loopback device for Windows. Linux now uses `parec --device=@DEFAULT_MONITOR@` for 16 kHz mono signed 16-bit PCM, without requesting a display stream. Requires PulseAudio or PipeWire's PulseAudio service and `parec` on `PATH` (`libpulse` on this CachyOS machine). Missing helper/audio service retains microphone-only fallback.
- **Native monitor:** real output monitor produced aligned PCM; no sample content was saved or transcribed. Packaged IPC start, stop, retry, renderer reload, and app quit were verified against real capture-stream counts, which returned to baseline.
- **Limits:** default output is chosen at capture startup; restart listening after switching outputs. This captures system output rather than one selected application. Speech content, transcription quality, real sharing previews, and behavior on other Linux desktops still need their own checks.
- **UI:** localhost Playwright passed Linux native-audio start/stop/failure states with a fixture bridge and zero page errors. The native device/backend checks above used the real packaged app separately.
- **Review:** independent review caught a source-ending race between readiness and activation. Added a post-activation liveness check and idempotent `capture:stop` IPC so overlapping cleanup cannot reactivate capture. Its regression failed before the fix and passes afterward; re-review found no remaining important issue.
- **Deferred by user:** recipient/recording sharing previews will be checked later. Local commits remain authorized; work should continue between commits, and push remains deferred.
- **Final gates:** all 45 tests, `npm run pack`, and `npm run dist:linux` passed after the activation-race fix. Localhost UI checks, real packaged native-audio lifecycle (including repeated idempotent stop), and the Ubuntu AppImage startup/missing-helper retry checks passed. Refreshed code graph: 512 nodes, 947 edges.
