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
| `src/library.js`, `data/library.json` | Loads and searches the bundled, attributed reference library. |
| `src/research.js` | Fetches Tavily results when needed, builds source evidence, and checks citations. |
| `src/prompts.js` | Defines Assist, meeting, Ask, Research, and coding tasks. |
| `scripts/build-library.js` | Refreshes the library from Wikipedia's API. |
| `electron-builder.cjs` | Linux, macOS, and Windows packaging settings. |
| `docs/release-validation.md` | Current release evidence, remaining acceptance checks, and publishing prerequisites. |

## A typed factual question

1. The renderer sends the question and mode through the preload bridge.
2. `main.js` captures a screenshot for **Ask**, or skips it for **Research**.
3. `src/research.js` asks `src/library.js` for a strong local title match with enough source text. Current questions and misses use Tavily; if the model says local evidence is insufficient, it retries once with Tavily. No usable evidence produces an error.
4. The selected provider receives the question and numbered source passages. For factual modes, Aether waits for a complete draft and checks that its citation numbers refer to retrieved sources before displaying it. Ollama requests have a two-minute timeout so a stalled local model does not hold the UI indefinitely.
5. The renderer displays the answer and clickable source links. Library links credit Wikipedia contributors and CC BY-SA 4.0.

## Listening

The renderer asks for microphone and optional system audio tracks. It reports capture active only when at least one track is usable. Audio becomes 16 kHz PCM, moves to `main.js` through IPC, and is buffered by speaker channel. `src/stt.js` transcribes non-silent chunks. Local mode writes a private temporary WAV for `whisper-cli` and removes it after each call. Transcripts stay in memory for the current session.

## Security and platform limits

API keys are encrypted in the settings file and saving fails if the OS secure-storage backend is unavailable. The renderer never receives Node access directly, but it does receive settings through the preload bridge for editing. External source links are opened through a scheme-restricted main-process handler. CLI providers start without a shell and use temporary directories for image inputs.

Electron capture exclusion applies on macOS/Windows only and is best effort. Linux selected-window or tab sharing and full-window hide are the practical controls. Locked/proctored browsers may block the app. See [screen sharing compatibility](docs/screen-sharing.md).

## Extending the app

Release verification separates renderer checks with a mocked Electron bridge from actual packaged startup and native desktop tests. An isolated user-data directory checks first-run defaults without changing existing settings; it does not reproduce a clean operating system, secure desktop keyring, or microphone/share permissions. Use the [release checklist](docs/release-validation.md) before claiming support for an environment.

- Add a model provider in `src/llm.js`, then add its selection and configuration fields in `renderer/` and defaults in `src/store.js`.
- Add or alter a task in `src/prompts.js`, then connect a UI action to its mode.
- Refresh the reference set with `node scripts/build-library.js`, inspect the content/license metadata, and run `npm test` and `npm run pack` so the package includes it.
