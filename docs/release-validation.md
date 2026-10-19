# Aether release validation

## Drag/drop support — 2026-10-19

- Current artifact supersedes earlier hashes: `dist/Aether-0.1.0.AppImage`, 139,930,280 bytes; SHA-256 `52cd0aefd96a34ffd4227d702db1d3205a57368f50d24a8f0c80a6c2206b61e5`. 177 tests, `npm run pack`, `npm run dist:linux`, and diff check pass. Packaged ASAR contains the new model schema and both drag executors. Graph: 789 nodes / 1,234 edges.
- Localhost Playwright ran the Auto engine with scripted drag decisions on HTML draggable and pointer-driven sorting tiles; both landed and emitted trusted Chromium input events. The real installed Zen binary, using only a disposable headless QA profile, passed both widget types in a hidden iframe. Native HTML drag in hidden Zen failed to complete drop; the fixed HTML adapter passed with synthetic events. Pointer-based Zen dragging remains native. A visible isolated Electron target confirmed actual Hyprland/ydotool drag to the expected bin with trusted pointer events. Test windows/processes were closed. No real-form input or model requests were made.
- Automated coverage includes endpoint bounds, malformed destinations, submission-label rejection, DPR conversion, twelve held-pointer moves, fresh screenshot consumption, cancellation release, iframe restoration, native focus-loss release and answer-verification invalidation. This proves input plumbing, not live-model reasoning or every third-party widget.
- Final FUSE AppImage passed isolated headless startup, submission-default/preload/IPC checks and real clicked target/tab selection against three existing Zen web tabs. The first probe timed out while the prior production Aether held its Zen session; after closing that old instance, the probe passed. No Zen restart was needed.

## Auto selector correction — 2026-10-19

- Current artifact supersedes all hashes below: `dist/Aether-0.1.0.AppImage`, 139,930,340 bytes; SHA-256 `712d30f8707b8c289832b88999f3c4f54052404796add86a77d2ad29cbec80bb`. Full 171-test suite, `npm run pack`, `npm run dist:linux` and diff check pass. Graph refreshed: 788 nodes / 1,233 edges.
- Reproduced the user's failed native select in the real overlay: trusted pointer/focus events arrived without usable popup selection. Earlier `selectOption()` checks had bypassed popup behavior. Replaced mode and tab popup selectors with standard in-page radio controls and an inline tab list. Browser click tests pass; actual mapped Electron trusted-click checks successfully selected Zen, connected and selected a tab. Final AppImage Playwright repeated the click path using real preload/IPC against the existing Zen session; no model/form actions were invoked. Fresh test-profile onboarding was completed before testing the controls; no forced clicks were used.
- Reopened normal production Aether after packaging, without the temporary diagnostic remote-debugging endpoint. Zen was not restarted or replaced, and its form was not clicked/submitted. The live model trial remains user-owned.

## Zen tab attachment — 2026-10-19

- Current artifact supersedes checksums below: `dist/Aether-0.1.0.AppImage`, 139,930,276 bytes, SHA-256 `66ef898e94ee3c054d6e86d851c54767f0bd9f813dfb2da64d3f4ecea192cf2e`. 171 tests pass, including 13 native browser-controller tests. Pack, AppImage build, real localhost Playwright target-selector/form/repetition checks and final FUSE headless startup/preload/IPC pass.
- Real disposable-profile QA used the installed Zen binary, not a downloaded copy. Native hidden-tab click, ASCII text `Aether background QA`, checked checkbox, trusted button event and iframe click all passed. Fixed bounded hidden-tab scroll produced scrollY 360. OS cursor and active window stayed unchanged. The temporary QA browser was closed. These checks establish same-host input/isolation behavior, not live model quality.
- User authorized one real Zen restart. Restarted the exact existing profile with `--marionette`, preserving the profile/cookies and confirming the restored form tab is present. Temporary startup `user.js` enabled resume-once and background focus, then was removed. `focusmanager.testmode=true` remains enabled for background typing. Listener verified at `127.0.0.1:2828`. Packaged Aether listed three real Zen web tabs through actual IPC, then disconnected without closing them. No clicks/submission or provider request on the real form.
- Reopened final AppImage against the user's real Aether profile; compositor confirms visible mapped 700×420 overlay. Current provider/account preferences were not changed. Initial Connect may activate Zen once; subsequent test actions used `focus:false`. Zen mode remains gated to this Hyprland host's existing global Escape integration. Model decision latency is not solved by input isolation.
- Graph refreshed: 782 nodes / 1,225 edges. See [Zen setup](zen-tab-control.md) for operation and disabling/re-enabling automation. No commit/push; durable intent is recorded locally because memory MCP is unavailable.

## Form navigation trial — 2026-10-19

- Repetition follow-up supersedes the artifact/checksum below: 156 tests pass; final AppImage is 139,926,541 bytes, SHA-256 `468b7e0e6aa7bd0ba6a7f2d9c0e8e63271936064aee6d38083d0aa8af7081074`. Pack/build and normal FUSE headless startup/preload/IPC pass. Localhost Playwright additionally confirms a duplicate selection is not executed twice and leaves the checkbox checked while the run continues. Graph: 748 nodes / 1,159 edges. Inline form-map submission and changed-page Next repetition have unit coverage. No live-model speed/completion claim follows.
- 153 tests pass, along with `npm run pack`, `npm run dist:linux` and `git diff --check`. Final real localhost Playwright checks passed per-run submission permission/reset and single-page scrolling, multi-step Next and per-question submission, including actual entered values and visible submission receipts. Decisions were scripted; no live model request was made.
- Native isolated frameless Electron target confirmed ydotool click, text `native input passed` and scrollTop 34. Found and corrected a stopped/disabled user ydotool service; it is now enabled/active with its user-owned runtime socket. The executor now preflights connectivity and gives actionable setup guidance. Test profiles used no credentials or user form data.
- Final artifact: `dist/Aether-0.1.0.AppImage`, 139,926,515 bytes; SHA-256 `23d281ad7239d449458bf83e5670044739b17bf34ae37244d37bed68d8851233`. Normal FUSE headless launch passed with an isolated profile: new submission checkbox unchecked, real preload/IPC available, Auto inactive and correctly unsupported in headless mode. This packaged startup check does not prove the model can complete the user's form.
- Graph refresh: 740 nodes / 1,151 edges. User will test their already-open form with the existing separate Free Codex CLI account and default model setting. Restart Aether to load the build. No changes to provider/account preferences, no commit or push. Earlier review-only submission behavior below is historical; current submission is explicitly enabled per run.

## Desktop Auto mode — 2026-10-18

- 145 tests pass. Real localhost Playwright checks Auto start/stop/countdown, empty-goal guidance, pointerdown/state-change cancellation and held-Enter restart prevention, alongside existing formatting, Smart, sources, settings and layout flows; zero page errors. `npm run pack` and `npm run dist:linux` pass. Focused independent review found no remaining material issue after the recorded fixes.
- Live isolated Free Codex vision through the unpacked app completed an owned, disposable browser form in eight decisions: clicked/typed Name, selected Blue, scrolled twice, focused/typed Result42, then stopped. DOM assertions confirmed all three values and zero submissions. Physical Escape canceled the following countdown and removed the owned stop binding. Earlier runs missed focus or paused unnecessarily; these led to matching-field focus enforcement, exact pending-field recovery and offscreen-review prompt improvements. This is one successful form, not general model accuracy evidence or a Google Forms integration claim.
- The executor uses actual native Hyprland screenshots, compositor cursor movement and ydotool input, with no DOM access in Aether. Test fixture providers use DOM only to choose deterministic QA actions. Current support is Hyprland Lua/native Wayland; typing is printable ASCII, append-only into empty fields. Other desktop/OS backends, Unicode, replacement and multiline typing remain unsupported. Final submission is left for review; model label checks cannot guarantee every dangerous/final control is recognized.
- The latest read-only Free account usage probe reports 2 percent used in its 43,200-minute primary window, no secondary window, and no reached limit reported. This includes several development runs and does not give a fixed tasks/messages/hours estimate. Account identity and credentials are excluded.
- Final artifact: `dist/Aether-0.1.0.AppImage`, 139,923,092 bytes; SHA-256 `c6941557567aa718a181ef40352fa323fc0d238c014ff938758d67f43ba75408`. Supersedes the checksums below. Code graph refreshed: 736 nodes / 1,146 edges.
- The final normal-FUSE AppImage passed the same controlled form using a deterministic provider and real native capture/input: Name, Blue, Result42, zero submissions. Physical Escape canceled countdown and removed its binding. A separate uppercase typing interruption stopped before 300 characters, drained helpers, produced no late input and left Shift released (verified by typing a lowercase q afterward). This artifact check isolates executor/lifecycle correctness; the real model completion above used the unpacked build of the same source.

## Separate Free account live check — 2026-10-18

- Official device-code login completed for Aether's own app-data Codex profile; development account remained separate. CLI login status reports ChatGPT and the official app-server rate-limit response reports plan `free`.
- Actual `streamCLI` text request returned AETHER_OK: first response 3,820 ms, total 4,527 ms. Controlled screenshot request returned correct number 42: first response 2,063 ms, total 2,369 ms. Only the fixture image and test prompts were sent; these are connectivity checks, not broad answer-quality passes.
- Playwright against the normal FUSE AppImage used the real Settings controls to select Codex CLI and its separate-account checkbox, clear model overrides to CLI defaults, save and reload. Provider/account/model preferences persisted, Auto stayed off and the encrypted Tavily key remained available. Aether reopened normally with that configuration. Local Whisper remains configured.
- Post-check usage baseline: bucket codex, plan free, primary usedPercent 0, windowDurationMins 43200 (30 days), resetsAt 1794933024, secondary null and no reached limit. Only two model requests were made. A displayed 0 percent does not establish a message count or hours estimate; compare after representative normal use. Read-only endpoint is documented in [Codex App Server](https://learn.chatgpt.com/docs/app-server).
- No source/dependency/build/graph change in this setup pass. Prior 104 tests and final AppImage checksum remain current. No credentials, account identifiers or device codes are recorded here; no push.

## Latest formatting and Smart depth — 2026-10-18

- 104 tests pass. Reproduced the former streaming failure in localhost Playwright before replacing the parser. Real renderer checks now pass formatted streaming/final agreement, code spacing, ordered lists, raw-symbol math, unsafe HTML/URL removal, Smart single/double-click, keyboard Deep access and reload persistence. Existing capture controls, source links and rejected-answer behavior also pass, with zero page errors.
- Marked/DOMPurify/KaTeX share one formatting path for streamed and completed text; code preserves spaces and avoids math interpretation. Separate Codex agent messages now have paragraph boundaries. This preserves provider text; it cannot reconstruct spaces the model never emitted. Incomplete markup can settle when closing syntax arrives.
- Smart Answer/Work/Deep policies are applied before generation, preserve Fast/Smart model tiers, and retain factual citations/uncertainty. These prompt policies are covered by tests, not live compliance checks for every model. Meeting formats remain intact.
- `npm run pack` and AppImage build pass. Normal FUSE AppImage checks with an isolated profile passed real settings IPC and Smart Work/Deep save/reload, separate-account preference persistence and fixture-driven streamed/final Markdown/math/code spacing. No provider call or usage allowance was consumed by these packaged checks. Production audit: zero findings. Independent review: no material findings.
- Separate Aether Codex login support was first checked with fake binaries, including parent/default/Claude authentication preservation. The later device-code login, actual Free text/image requests, usage baseline and real provider selection now pass; see the account checkpoint above. Duration under normal use remains unmeasured.
- Final AppImage: 139,913,796 bytes; SHA-256 `c1c89ab8f87ff35567d7ac78357d535a723550a2b15b58df1d6561f094c8a9ef`. Supersedes all earlier artifacts below. Code graph: 662 nodes / 1,039 edges.

## Latest screen updates and optional Auto

- Manual remains the default. Settings can enable external click/scroll Assist on native Hyprland. A 650 ms debounce groups bursts; generations never overlap and only the latest pending interaction is retained. Hidden/collapsed/settings/onboarding states pause requests. Runtime listener state drives the Auto badge and failures report recovery guidance. Other desktops remain manual.
- Explicit screen questions now bypass unrelated library/Tavily research and stream tokens with reading/writing feedback. Factual requests still show sources and wait for citation validation. Native Hyprland captures the cursor/interaction monitor with `grim`; PNG output uses binary encoding and missing capture support fails with actionable guidance. A visible overlay can still appear in captures.
- 93 tests passed; localhost Playwright passed default-off/settings/runtime-failure behavior, phase-to-token rendering, existing controls and source/rejection display with zero page errors. `npm run pack` and `npm run dist:linux` passed.
- Real native tests passed against both unpacked app and final normal FUSE AppImage: manual capture read the secondary fixture display; physical clicks and wheel events reached the target browser; a wheel burst yielded one Assist; capture retained the clicked monitor after the pointer moved away; disabling stopped requests. These checks use a controlled provider response with actual native capture, IPC, compositor bindings and input. They do not measure model quality. Review caught binary capture encoding, corrected with a regression and verified by these native runs.
- Separate real Ollama controlled-image timing: fresh image first token 4,838 ms, total 5,310 ms; identical-image repetition first token 50 ms, total 384 ms. One response misread text color. This is a sample timing, not an accuracy pass or guarantee of instant fresh updates.
- Latest artifact: 139,446,618 bytes; SHA-256 `ec40a1c55759f5d9dd7b259e980463de78e4bfe77c9793da312dc91ac78ecd6f`. Supersedes historical checksums below. Graph refreshed: 640 nodes, 1,011 edges. Local commit authorized; no push.
- Free Codex CLI access and a fixed usage duration have not been established. [Official pricing](https://learn.chatgpt.com/docs/pricing) describes Free desktop access, subject to rollout, and lists CLI under Plus; Aether uses `codex exec`. Do not promise Free CLI compatibility or an hours/messages estimate. Selected provider remains local Ollama.

## Latest Hyprland placement and window controls

- On Hyprland 0.56.2 native Wayland, Aether was tiled despite Electron's always-on-top setting; T3 shrank to 950 pixels wide. Floating Aether restored T3 to 1,908 pixels. Startup now installs an exact-app-ID floating/pinned rule before mapping, with Aether-only compositor blur/shadows disabled.
- Final UI uses an opaque panel and full-width toolbar with a six-dot drag area; default 700×420, minimum 520×300. Both bottom corners expose diagonal resize cursors. Native Wayland coordinates come from Hyprland; other platforms retain native toolbar dragging and bounded Electron resize handling and remain unverified natively.
- 72 tests passed, plus `npm run pack` and `npm run dist:linux`. Localhost Playwright checked real renderer fit at three sizes, grip/corner events, cursors, Linux input and research rendering, with zero page errors. Actual mouse input against the final FUSE-mounted AppImage passed grip movement, both corner resizes, and fast press/move/release. Neighboring tiled geometry was unchanged. Private desktop screenshot is ignored under `dist/validation/`.
- Independent review found final motion could be dropped on release; a failing regression proved it, then final-position flushing fixed it. Re-review found no further important issue. Hyprland's interactive drag dispatchers were rejected as a solution after native tests and upstream source showed they require key-binding press context.
- Linux mouse input stays enabled because ignored mousemove forwarding is unavailable. A collapsed panel still retains the native window's input footprint. Config reload requires restarting Aether. Fullscreen stacking, other Linux desktops, and recipient sharing are separate pending checks.
- Latest artifact: 139,438,121 bytes; SHA-256 `8067d206d2b5e1776068368b954c90fcb965d6c6f5392e8be5666535de96f110`. This supersedes earlier checksums below.

## Latest research checks

- Final `npm run pack` and `npm run dist:linux` passed. The final AppImage passed normal FUSE startup and real renderer/settings IPC with an isolated profile. Artifact: 139,434,549 bytes; SHA-256 `2cd035674ee65e7c46a940e500440f8fe3b67078261cc6b39182b15246d04310`. This supersedes the older artifact checksum below.
- 64 tests passed. Grouped/ranged citations now normalize to individual markers and reject missing IDs or malformed numeric groups, while formatted math/code stay intact. New regressions failed before the fixes. Independent review found a punctuation bypass, corrected and re-reviewed with no further important finding.
- Localhost Playwright used the actual renderer and a fixture bridge: a real send-button click, source links surviving rejection, web evidence replacing local evidence, normal cited answers and library attribution passed with zero page errors.
- Actual packaged IPC with the saved encrypted profile copied to a temporary directory confirmed sources arrive before the live Ollama answer completes. Real Tavily returned five sources. The answer still mixed versions and contradicted itself about the latest Electron release. Citation checks passed; factual quality did not. No credentials were printed or stored in the repository.
- Prompt now includes a UTC retrieval date and currentness guidance. This does not verify freshness or guarantee factual accuracy. Keep AI summaries as requested, with citation rejection and source links.

## Latest shortcut and sharing checks

- Full-monitor `wf-recorder` recordings (no audio) confirmed Hide removed Aether. Initial restore failed. After repairing portal identity and binding, the user physically pressed Ctrl+Shift+Space twice and confirmed hide and restore worked. Portal dispatch separately toggled BrowserWindow visibility false/true. The final clip does not establish visual restoration after a workspace change; keep those evidence types distinct.
- Show / hide now uses the Settings recorder, default Ctrl+Shift+Space (Command+Shift+Space on macOS), independently of Assist. Changes save transactionally; failed saves restore the previous binding. Known startup registration failure disables Hide in the UI and main IPC.
- 59 tests pass, including native-binding conflicts, rollback, first-save cleanup, startup recovery, and stale binding replacement. Review found no further important issues. Localhost Playwright passed shortcut change/reset/cancel/conflict/shifted-digit/tooltip and unavailable-restore recovery. Native AppImage custom save/reset/reload/disk, normal FUSE launch, native audio lifecycle, and fresh Ubuntu 24.04 runtime passed on Electron 44.9.0. Final pack/build/startup/research IPC/checksum checks passed. Latest artifact is 139,434,546 bytes; SHA-256 `541522520ecce7c349a7fc9e56f91ed8da82b7aec80f31ad4f8b9d23c9794136`.
- Portal trace proved Electron 43 omitted host registration; [upstream fixed it in Electron 44](https://github.com/electron/electron/issues/51875). `scripts/install-linux.js` registers the required matching desktop launcher. Hyprland Lua (0.55+) also requires an explicit compositor bind, now managed for Show / hide by Aether. Restart Aether after reloading Hyprland configuration. Other global actions still need compositor validation/setup. Electron 44 requires macOS 13+.
- Headless checks now skip desktop shortcut registration. Serialize extraction-mode AppImage checks: concurrent processes can remove shared temporary resources. Normal FUSE launch worked on this host, with Chromium sandbox disabled by the automation driver; this is still not a clean desktop-install test.

Last checked: 2026-10-17. Phase 5 remains open. These results apply to the `codex/wingman-hardening` checkpoint. The user authorized a local commit; push is deferred.

## Implemented

- GPL-3.0-or-later Wingman fork, renamed Aether, with Aarnav Baddam credited.
- OS-backed encryption and atomic migration of API keys; settings errors preserve existing data.
- Screen/audio capture failure handling and full-window Hide for sharing.
- Ollama and signed-in Claude/Codex CLI providers; local Whisper with no cloud transcription fallback for Ollama.
- A separately attributed, CC BY-SA 4.0 Wikipedia library containing 1,832 articles.
- Local-first factual retrieval, Tavily fallback, displayed sources, and a citation/uncertainty gate.

## Fresh checks

- `npm test`: 59 passed, zero failed, including retrieval, native-audio lifecycle, shortcut transactions, Hyprland binding ownership, and launcher regressions.
- `npm run pack`: exit 0. `app.asar` contains `data/library.json`, `LICENSE`, and research/settings modules.
- Localhost Playwright with the actual renderer and a mocked Electron bridge: Research submission, source and CC BY-SA links, Claude/Codex/Ollama selection, mandatory local STT for Ollama, failed settings-save recovery, and Hide bridge invocation passed; zero page errors. Answers in this UI fixture are synthetic, not provider output.
- The unpacked Linux app and rebuilt `dist/Aether-0.1.0.AppImage` both started through Playwright's Electron driver with separate temporary user-data directories. This was headless on the existing host, not a clean Linux installation. Neither profile contained user keys.
- `npm run dist:linux`: exit 0; latest AppImage size 139,434,546 bytes. The AppImage runtime was checked with `--appimage-version` during the initial validation pass.
- Live `qwen2.5-coder:7b` through Aether's Ollama adapter answered `Banach space` and `General relativity` using local evidence and passed citation-number validation. Manual comparison exposed factual drift: the Banach response said Banach later coined “Banach space,” whereas its source says he coined “Fréchet space.” The relativity response used “developed ... in 1916,” blending a source's May 1916 publication date with another source's 1907–1915 development period. These are quality findings, not successful factual acceptance checks.
- `npm audit --omit=dev`: zero findings. Full audit: eight moderate findings in the builder dependency chain. The root [sprintf-js advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) still lists no patched version. Audit suggests a builder downgrade; no dependency downgrade or override was applied.
- `git diff --check`: passed before checkpoint edits; rerun before committing.

The initial headless sessions lacked desktop D-Bus variables and reported `safeStorage` unavailable with backend `basic_text`. A later check connected to the real GNOME Keyring and passed encrypted save/restart-decrypt with `--password-store=gnome-libsecret`; default backend selection on Hyprland still chose `basic_text`. Aether continues refusing keys in an insecure environment.

## Remaining acceptance checks

### Live Tavily and factual quality

Tavily setup is complete using Sleipnir and the user's selected Google account. Aether saved the key encrypted; a fresh Electron process decrypted it successfully. A library-backed Banach query returned one local source, while current-release and DNA library-gap queries each returned five numbered HTTPS web sources. Those initial two advanced searches used 4 credits on the free plan. Additional current-release answer probes used Tavily as well. No key was printed or committed. User selected local Ollama: fast model `qwen25-vl-7b-16k:latest`, Smart model `qwen35-9b-64k:latest`, and the existing local Whisper model are configured. Research IPC produced real local/web-backed answers and rendered source links. Never put keys in chat, logs, fixtures, or this repository.

The final fast-model current-release answer incorrectly called Electron 44.7.0 the latest despite this checkout using 44.9.0; it passed citation-number validation. The earlier plain 9B model ran with a 4K context and its uncited web answer was correctly blocked. Final larger-context aliases avoid source-packet truncation but do not establish accuracy. Smart-mode answer quality remains untested. Keep source-faithfulness and recency checks open.

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
- Full-display recording disappearance and physical Hyprland Ctrl+Shift+Space hide/restore passed. Still check selected-window/tab sharing and a recipient preview. Repeat after changing OS, compositor or sharing app; no universal exclusion guarantee.
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

Answer faithfulness after the observed Ollama errors, selected-window/tab and recipient sharing previews, full speech/meeting transcription checks, a full clean Linux desktop installation, and macOS/Windows release validation remain open. Live Tavily, this host's GNOME Keyring configuration, full-monitor Hide recording, and physical Hide/restore have since passed; see the latest checkpoints above and `project.md`. Earlier local Claude/Codex/Whisper probes were not rerun as part of this pass.

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
