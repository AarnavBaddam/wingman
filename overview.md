# Aether architecture

Aether is an Electron desktop app. It has a main process that can call providers and access OS APIs, and a renderer process that draws the floating panel and captures browser media tracks. `preload.js` exposes a narrow IPC bridge between them.

## Main files

| Path | Role |
|---|---|
| `main.js` | Creates the overlay, registers shortcuts, captures screenshots, manages audio buffers, and sends requests/results over IPC. |
| `preload.js` | Lists the methods and events the renderer may use. |
| `renderer/` | HTML/CSS/JS UI, settings, Markdown display, mic and system audio capture. |
| `src/store.js` | Reads and atomically saves settings; encrypts API keys with Electron `safeStorage`. |
| `src/llm.js` and `src/cli-provider.js` | Common streaming interface for cloud APIs, Ollama, and signed-in Claude/Codex CLIs. |
| `src/stt.js` | Transcribes PCM audio with local `whisper-cli`, OpenAI, or Gemini. |
| `src/linux-audio.js` | Captures the Linux default output monitor with `parec`, frames PCM samples, and stops the helper on cancellation or exit. |
| `src/linux-overlay.js` | Installs Hyprland's narrowly matched floating/pinned/no-blur rule and coalesces compositor-coordinate drag/resize updates for Aether alone. |
| `src/window-resize.js` | Calculates bounded bottom-corner resize geometry while keeping the opposite corner anchored. |
| `src/library.js`, `data/library.json` | Loads and searches the bundled, attributed reference library. |
| `src/research.js` | Fetches Tavily results when needed, builds dated source evidence, and validates/normalizes numeric citation groups against retrieved source IDs. |
| `src/prompts.js` | Defines Assist, meeting, Ask, Research, and coding tasks. |
| `scripts/build-library.js` | Refreshes the library from Wikipedia's API. |
| `electron-builder.cjs` | Linux, macOS, and Windows packaging settings. |
| `docs/release-validation.md` | Current release evidence, remaining acceptance checks, and publishing prerequisites. |
| `scripts/linux-runtime.Dockerfile` | Pinned Ubuntu base and native libraries for a headless AppImage runtime smoke test. |

## A typed factual question

1. The renderer sends the question and mode through the preload bridge.
2. `main.js` captures a screenshot for **Ask**, or skips it for **Research**.
3. `src/research.js` asks `src/library.js` for a local title match with the same normalized topic terms and enough source text. More specific titles do not satisfy a general-topic query. Current questions and misses use Tavily; if the model says local evidence is insufficient, it retries once with Tavily. No usable evidence produces an error.
4. The selected provider receives the question and numbered source passages, followed by instructions to preserve factual relationships, distinguish dates/events, and cite factual sentences. For factual modes, Aether waits for a complete draft and checks that its citation numbers refer to retrieved sources before displaying it. This check cannot establish semantic accuracy; live models have still changed facts. Ollama requests have a two-minute timeout so a stalled local model does not hold the UI indefinitely.
5. The renderer displays the answer and clickable source links. Library links credit Wikipedia contributors and CC BY-SA 4.0.

## Keyboard shortcuts

Settings reuses one key recorder for Assist and Show / hide. Preload sends each change to the main process, which checks conflicts, replaces the global binding, and persists the preference. A failed save restores the previous binding. The default restore combination is Ctrl+Shift+Space (Command+Shift+Space on macOS); labels follow saved settings. Startup registration status disables the sharing Hide button if no restore binding registered. This cannot prove Wayland will deliver keys; test physically before sharing. Linux packaging synchronizes `dev.prahladv.aether.desktop` with Electron's portal identity.

Electron 44 fixes host app registration with modern Wayland portals. `scripts/install-linux.js` installs the matching per-user desktop launcher for a built AppImage. `src/hypr-shortcut.js` connects the Show / hide portal action to a Hyprland Lua runtime binding. It waits for the portal action, rejects existing desktop key conflicts, replaces only Aether-owned bindings, and cleans up on quit. Main-process changes are serialized and roll back both native binding and Electron registration on failure. Restart Aether after a Hyprland configuration reload. This helper handles Show / hide; other global actions may still need desktop setup. Electron 44 raises the macOS minimum to 13.

## Listening

The renderer asks for a microphone track. On Linux, meeting audio comes from `parec` in the main process, capturing the default PulseAudio/PipeWire output monitor as 16 kHz, mono, signed 16-bit PCM. Other platforms keep the renderer's display-media path. Capture becomes active only after a usable track or native PCM arrives; the renderer rechecks availability after pending permission requests and activation. IPC carries native readiness and unexpected-end events, while an idempotent capture-stop operation keeps overlapping cleanup from toggling capture back on. The helper stops on cancellation, renderer reload/crash, window closure, or app quit, with a bounded startup wait and forced-stop fallback.

Audio is buffered in `main.js` by speaker channel. `src/stt.js` transcribes non-silent chunks. Local mode writes a private temporary WAV for `whisper-cli` and removes it after each call. Transcripts stay in memory for the current session. Linux requires `parec` on `PATH`; without it, microphone-only listening remains available. Restart listening after changing the default audio output.

## Security and platform limits

API keys are encrypted in the settings file and saving fails if the OS secure-storage backend is unavailable. The renderer never receives Node access directly, but it does receive settings through the preload bridge for editing. External source links are opened through a scheme-restricted main-process handler. CLI providers start without a shell and use temporary directories for image inputs.

Tavily is now configured on this Linux account. Real checks confirmed local-first library retrieval and live web fallback, with encrypted save/decrypt through GNOME Keyring. The user selected local Ollama: fast model `qwen25-vl-7b-16k:latest`, Smart model `qwen35-9b-64k:latest`, and the existing local Whisper model are configured. These installed aliases provide larger contexts for source packets. Tavily supplies evidence while Ollama writes the answer; source links and valid citation numbers still do not prove factual accuracy. This host's launcher explicitly selects GNOME Keyring so normal launches can decrypt the saved key.

Electron capture exclusion applies on macOS/Windows only and is best effort. Linux selected-window or tab sharing and full-window hide are the practical controls. Locked/proctored browsers may block the app. See [screen sharing compatibility](docs/screen-sharing.md).

## Extending the app

Linux placement belongs partly to the compositor. Native Hyprland ignored Electron's always-on-top hint for tiling, so `createWindow()` prepares the session rule before constructing the window. It matches only `dev.prahladv.aether`, survives app restarts in that compositor session, and needs Aether restarted after a compositor config reload. GNOME/KDE and other tiling managers need their own native verification; see README's desktop matrix.

The full-width six-dot toolbar and bottom corners send narrow gesture events through preload. Hyprland updates use its actual cursor/window coordinates and target only the exact app process; repeated motion is coalesced rather than spawning an unbounded command queue. Release snapshots and flushes the final position, while cancellation and lifecycle cleanup stop motion. Other platforms use Electron's native drag region and bounded resize calculations. Opaque UI surfaces plus the Hyprland no-blur rule prevent the full transparent window from becoming a blurred square. Linux keeps mouse input enabled because ignored mousemove events cannot be forwarded back to the renderer.

Research buffers model output until citation validation succeeds. Sources appear immediately after retrieval and survive rejection or provider failure; a web retry replaces the local source panel. Numeric groups/ranges are checked outside formatted math/code. This validates reference IDs, not whether each claim follows from the cited passage. The retrieval date is not a publication date or proof that results are current; live Ollama replies still need factual-quality work.

Release verification separates renderer checks with a mocked Electron bridge from actual packaged startup and native desktop tests. An isolated user-data directory checks first-run defaults without changing existing settings; it does not reproduce a clean operating system, secure desktop keyring, or microphone/share permissions. Use the [release checklist](docs/release-validation.md) before claiming support for an environment.

- Add a model provider in `src/llm.js`, then add its selection and configuration fields in `renderer/` and defaults in `src/store.js`.
- Add or alter a task in `src/prompts.js`, then connect a UI action to its mode.
- Refresh the reference set with `node scripts/build-library.js`, inspect the content/license metadata, and run `npm test` and `npm run pack` so the package includes it.
