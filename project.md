# Aether project state

## Current phase

Phase 5: platform validation and release readiness. Source audit, hardening, provider integration, and local-first research are implemented. Fresh Linux checks completed on 2026-10-17; native permissions, live Tavily, and other OS checks remain open. Work is on `codex/wingman-hardening`; the user authorized a local checkpoint commit and deferred push. See [release validation](docs/release-validation.md) for the full remaining checklist.

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

- `npm test`: 37 passing tests.
- `npm run dist:linux`: built `dist/Aether-0.1.0.AppImage` (137 MB); `app.asar` contains the reference library and GPL license. The AppImage responds to `--appimage-version`.
- Headless Playwright on localhost: Research button, source and license links, provider choices, settings save/scroll, and Ollama local transcription controls worked with a mocked Electron bridge; no page errors.
- Live local Claude and Codex CLI replies passed. Ollama answered a library-backed Banach space question with a valid citation. An earlier Whisper probe passed.
- `npm audit --omit=dev`: zero findings. Full audit has 8 moderate findings from the upstream builder dependency chain (`sprintf-js`), with no patched package release currently available.

## Next steps

1. Set up Tavily and enter a key in Aether; the user confirmed it is not configured yet. Then test live search and inspect citation quality on math, science, and current-fact prompts.
2. Test real microphone/system capture and share previews on Linux; test capture exclusion and package signing on macOS/Windows hardware.
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
