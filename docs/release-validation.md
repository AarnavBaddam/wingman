# Aether release validation

Last checked: 2026-10-17. Phase 5 remains open. These results apply to the `codex/wingman-hardening` checkpoint. The user authorized a local commit; push is deferred.

## Implemented

- GPL-3.0-or-later Wingman fork, renamed Aether, with Aarnav Baddam credited.
- OS-backed encryption and atomic migration of API keys; settings errors preserve existing data.
- Screen/audio capture failure handling and full-window Hide for sharing.
- Ollama and signed-in Claude/Codex CLI providers; local Whisper with no cloud transcription fallback for Ollama.
- A separately attributed, CC BY-SA 4.0 Wikipedia library containing 1,832 articles.
- Local-first factual retrieval, Tavily fallback, displayed sources, and a citation/uncertainty gate.

## Fresh checks

- `npm test`: 37 passed, zero failed.
- `npm run pack`: exit 0. `app.asar` contains `data/library.json`, `LICENSE`, and research/settings modules.
- Localhost Playwright with the actual renderer and a mocked Electron bridge: Research submission, source and CC BY-SA links, Claude/Codex/Ollama selection, mandatory local STT for Ollama, failed settings-save recovery, and Hide bridge invocation passed; zero page errors. Answers in this UI fixture are synthetic, not provider output.
- The unpacked Linux app and rebuilt `dist/Aether-0.1.0.AppImage` both started through Playwright's Electron driver with separate temporary user-data directories. This was headless on the existing host, not a clean Linux installation. Neither profile contained user keys.
- `npm run dist:linux`: exit 0; AppImage size 143,330,085 bytes. The AppImage runtime responds to `--appimage-version`.
- Live `qwen2.5-coder:7b` through Aether's Ollama adapter answered `Banach space` and `General relativity` using local evidence and passed citation-number validation. Manual comparison exposed factual drift: the Banach response said Banach later coined “Banach space,” whereas its source says he coined “Fréchet space.” The relativity response used “developed ... in 1916,” blending a source's May 1916 publication date with another source's 1907–1915 development period. These are quality findings, not successful factual acceptance checks.
- `npm audit --omit=dev`: zero findings. Full audit: eight moderate findings in the builder dependency chain. The root [sprintf-js advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) still lists no patched version. Audit suggests a builder downgrade; no dependency downgrade or override was applied.
- `git diff --check`: passed before checkpoint edits; rerun before committing.

The headless packaged sessions reported `safeStorage` unavailable and backend `basic_text`. This does not validate a desktop keyring. Aether must continue refusing to save nonempty keys in that environment.

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

Live Tavily, answer faithfulness after the observed Ollama errors, real desktop key storage, native sharing/audio/permission behavior, a clean Linux installation, and macOS/Windows release validation remain open. Earlier local Claude/Codex/Whisper probes are recorded in `project.md`; they were not rerun as part of this pass.
