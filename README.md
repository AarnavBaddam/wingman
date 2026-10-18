# Aether

Aether is a desktop copilot for studying, meetings, and coding practice. It can use a screenshot and optional microphone or shared audio context, then answer through an API provider, a local Ollama model, or a signed-in Claude/Codex CLI.

This is a fork of [Wingman by Aarnav Baddam](https://github.com/AarnavBaddam/wingman). The original code remains under [GPL-3.0-or-later](LICENSE); changes in this fork are distributed under the same license. The bundled reference text is separately credited below.

## What changed

- API keys are encrypted through Electron's OS-backed `safeStorage`. Aether refuses to save nonempty keys if secure storage is unavailable, and migrates old plaintext settings atomically.
- Screen capture errors stop the request and show an error. Listening starts only after an audio track is usable, and stops when the last track ends.
- A **Hide for sharing** control hides the entire window. Choose your Show / hide keys in **Settings → Keyboard shortcuts**; the default is `Ctrl+Shift+Space` (`⌘⇧Space` on macOS). Test restoring on your desktop before sharing. macOS and Windows also request OS capture exclusion. See [screen sharing compatibility](docs/screen-sharing.md) for limits and a preview check.
- Ollama, Claude CLI, and Codex CLI are available alongside the original API providers. Local Whisper transcription is available and is mandatory when Ollama is selected.
- Typed factual questions search a bundled 1,832-article reference library first. Current questions, library gaps, and explicit model uncertainty use Tavily web search. The app displays retrieved source links and holds a factual answer until it cites one of them or states uncertainty. Retrieval and citation checks reduce unsupported answers; they cannot prove every claim true.
- Linux AppImage packaging is configured; macOS and Windows targets remain available.

## Install

Use Node.js 20 or newer. From this directory:

```bash
npm ci
npm start
```

Build a local unpacked app with `npm run pack`, or an AppImage on Linux with `npm run dist:linux`. `npm run dist` targets macOS; `npm run dist:win` targets Windows. macOS signing and notarization need your own Apple credentials. The Linux AppImage and cross-platform capture behavior need validation on the target machine.

Electron 44 requires macOS 13 or later. After building on Linux, register the AppImage's desktop identity so Wayland portals can recognize Aether:

```bash
node scripts/install-linux.js # defaults to dist/Aether-0.1.0.AppImage
# Or pass the absolute path to your AppImage as the first argument.
```

This installs a per-user application launcher without copying the AppImage; rerun it if you move the file. On Hyprland with Lua configuration (0.55+), Aether creates its Show / hide binding at startup and updates it when you choose new keys. It refuses existing desktop key conflicts and removes its own binding on quit. Restart Aether after reloading Hyprland configuration, which clears runtime bindings. Other global actions may require desktop bindings; their buttons remain available.

### Linux desktop behavior

Linux overlay behavior depends on the desktop/compositor, not just the operating system. Electron's always-on-top flag alone did not prevent native Wayland tiling on Hyprland.

| Desktop/session | Overlay setup and validation |
|---|---|
| Hyprland 0.55+ with Lua | Aether uses `hyprctl` to install an exact-app-ID floating/pinned rule before its window appears. It opens at 700×420 without taking a tile; pinning follows workspaces. Native mapping, drag, bottom-corner resize and hide/restore were verified on Hyprland 0.56.2. |
| GNOME / KDE, Wayland or X11 | Existing Electron window hints remain in use. Native placement, fullscreen stacking, workspace following and global shortcuts need desktop-specific validation. |
| Sway / i3 / other tiling managers | No automatic rules yet. Configure a floating rule in that manager before relying on the overlay; these sessions are unverified. |

The Hyprland rule is scoped to `dev.prahladv.aether`; other apps keep their normal layout. It also disables compositor blur/shadows for Aether, preventing a blurred rectangle outside the panel. It is installed in the compositor session, without rewriting your configuration. Restart Aether after a Hyprland configuration reload. Missing `hyprctl` or unsupported Lua setup produces a visible status message. Fullscreen stacking and capture exclusion are separate checks; floating does not make the window invisible in recordings. See [Hyprland's rule documentation](https://wiki.hypr.land/0.55.0/Configuring/Basics/Window-Rules/).

Hold the six-dot area in the full-width toolbar to move Aether. Hover either bottom corner for the diagonal resize cursor, then drag; minimum size is 520×300. On Hyprland these controls use compositor coordinates because Wayland does not expose global window coordinates through Electron. On Linux the window keeps mouse input enabled, since ignored mousemove forwarding is unavailable; keep this in mind when collapsing the panel. Other platforms' corner controls use Electron bounds and still need native validation.

Screen capture on native Hyprland requires `grim` on PATH (`sudo pacman -S --needed grim` on Arch/CachyOS). Manual Assist reads the display under the pointer. Settings offers optional **Auto refresh Assist after clicks or scrolling** on Hyprland: it waits 650 ms for external activity to settle, keeps only the latest pending refresh and captures that interaction's display. It pauses while Aether is hidden/collapsed or settings/onboarding is open. Auto is off by default; other desktops use manual Assist. Enabling it sends more screenshots to the selected provider and may use more allowance. Fresh AI answers still take model processing time.

## Configure providers

Open **Settings** in Aether and select one provider:

| Provider | Setup |
|---|---|
| OpenAI, Anthropic, Gemini, Nvidia, Groq | Enter your own API key and model names. Use a vision model for screen features. |
| Ollama | Start [Ollama](https://docs.ollama.com/api/openai-compatibility), install a model, and enter its exact model name. Screen features need a vision-capable model. The app connects to `127.0.0.1:11434`. |
| Claude CLI | Install the [Claude CLI](https://code.claude.com/docs/en/headless), sign in, and make `claude` available on `PATH`. Model fields may stay blank. |
| Codex CLI | Install the [Codex CLI](https://learn.chatgpt.com/docs/cli/reference), sign in, and make `codex` available on `PATH`. Model fields may stay blank. |

The CLI adapters invoke the installed command for each request. Claude runs with tools disabled. Codex runs in its read-only sandbox, but its CLI may still read accessible local files. Keep local files and account permissions in mind when choosing a provider.

For meeting transcription, choose **Cloud key** (OpenAI Whisper or Gemini) or **Local Whisper**. Local mode needs `whisper-cli` and an absolute path to a downloaded [whisper.cpp model](https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/README.md). There is no cloud fallback from local mode. Ollama always uses local transcription even when cloud keys are saved.

On Linux, meeting audio uses `parec` to capture the default output monitor through PulseAudio or PipeWire's PulseAudio service. `parec` comes from `libpulse` on Arch/CachyOS and `pulseaudio-utils` on Ubuntu/Debian. If unavailable, listening can continue with the microphone. Restart listening after changing output devices. The helper captures the default output, not one selected meeting app.

If secure storage is unavailable on a Linux desktop using GNOME Keyring, unlock/configure that keyring and start Aether with the explicit backend:

```bash
./dist/Aether-0.1.0.AppImage --password-store=gnome-libsecret
# From the development checkout:
npm start -- --password-store=gnome-libsecret
```

This was verified against the running GNOME Keyring on Hyprland. Other keyring setups need their matching [Electron storage backend](https://www.electronjs.org/docs/latest/api/safe-storage). Aether continues refusing nonempty API keys when secure storage is unavailable.

## Research and privacy

Type a factual question in the composer, or type a question and press **Research**. Aether searches its local reference library first. A local-only answer requires a matching topic title and enough text; a narrower article is not sufficient for a general topic. Otherwise, if the question concerns current information, or if the model says the local evidence is insufficient, it queries [Tavily Search](https://help.tavily.com/articles/4840311948-tavily-search-api). Add a Tavily key in Settings to enable this fallback. Without a key or usable source, the app reports that it cannot research the answer. It does not silently ask the model to guess.

The local library covers mathematics, computer science, physics, biology, chemistry, and related history. Its 1,832 English Wikipedia extracts were downloaded on 2026-10-16. Each displayed source links to its article. The text is © [Wikipedia contributors](https://en.wikipedia.org/wiki/Wikipedia:Copyrights), under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). `node scripts/build-library.js` refreshes the library; verify the resulting count and content before release. Library text is separate from Aether's GPL-licensed code.

Screenshots, transcripts, and your optional résumé are sent to the selected model provider when used in a request. When web fallback runs, the typed query is sent to Tavily; screenshots and transcripts are not sent to Tavily by the app. Ollama and local Whisper keep model and transcription requests on your device, although using Tavily still sends a search query. No Aether server or telemetry is included.

## Capture and screen sharing

**No app can guarantee that an overlay remains visible to you while invisible to every screen share, recorder, or locked environment.** Linux has no Electron capture exclusion for this window. On macOS and Windows, OS exclusion is best effort and capture tools may bypass it. Check the recipient or recording preview before relying on it; use **Hide for sharing** and restore with your configured shortcut (default `Ctrl+Shift+Space`, or `⌘⇧Space` on macOS). Sharing a selected app window or browser tab is safer than sharing the full display when available. [Platform details and common apps](docs/screen-sharing.md).

Proctored or locked browsers may block other applications and shortcuts. Aether does not bypass those restrictions, and operation in such modes is not supported.

## Development

The source is plain Electron, HTML, CSS, and JavaScript. `main.js` owns the window, capture, and request flow; `renderer/` owns the UI and audio capture; `src/` contains settings, providers, local transcription, library retrieval, and web search. Run `npm test` for focused checks. The reference library ships in `data/library.json`.
