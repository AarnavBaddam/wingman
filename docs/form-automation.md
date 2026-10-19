# Screenshot-driven form trial

The user will test an already-open form using Aether's separate Free Codex CLI account and existing default model setting. This change adds no browser connection or model override.

## Research and choice

Two practical approaches were considered:

- Browser structure: use labels/roles and DOM state, wait for actionability, and scroll elements into view. This offers stronger field targeting for web forms, but needs a browser integration and does not cover native applications. [Playwright actions](https://playwright.dev/docs/input) document these behaviors.
- Screenshot loop: observe, choose one bounded action, execute, then observe again. Keep explicit state so the model does not reconstruct the whole task each turn. This reuses Aether's existing native controller. [Anthropic's agent guidance](https://www.anthropic.com/engineering/building-effective-agents) describes agents using environmental feedback in a loop and the importance of tool design.

The trial uses the screenshot loop. Aether records form layout, current question, navigation meaning, scroll needs and verification state. It instructs the model to read clipped questions with overlapping scroll views, verify selections before advancing, distinguish per-answer submission from final submission, inspect validation errors, and verify a visible receipt before completion. Unknown form structure remains unknown until observed; this is not a hidden full-page scan.

### Continuous capture follow-up

The user asked whether a package can supply continuous viewing at about 1 FPS. Electron already supports [desktop video capture](https://www.electronjs.org/docs/latest/api/desktop-capturer) through `getDisplayMedia`; [`requestVideoFrameCallback`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback) provides per-frame processing. A future implementation could maintain one capture stream and retain only its newest frame, discard backlog during inference, and wait for a post-action frame before another decision. The exact Hyprland/portal capture path would need native validation and must preserve target identity, cropping and cancellation.

This build does not add that stream. The current CLI adapter accepts one still image per decision; a capture stream alone does not give the model continuous inference or guarantee one decision per second. Measure capture versus model latency in the trial before replacing the capture backend.

Fresh-image pixel comparison flags unchanged screens. It is only feedback: focus can change without visible pixels, and unrelated animation can change pixels without task progress. The model must inspect the result. A map is also a model claim; it is not an independent proof that a field or receipt was read correctly.

## Running the trial

### Existing browser and background work

The user requires their current browser profile, logins and already-open form. A fresh automation browser is not acceptable. They identified Zen and selected browser-native automation with one authorized restart. The implemented [Zen tab controller](zen-tab-control.md) reuses that session through Marionette; clicks/keys bypass the desktop pointer and bounded scripted scrolling handles hidden tabs. Its same-host background isolation checks pass. A Chromium extension was considered earlier, but Firefox lacks Chrome's debugger API; no extension was built. Another workspace alone does not isolate the desktop ydotool executor.

### Repetition follow-up

The user's run ended with the old generic repetition message. Unit tests reproduced false pauses on identical Next actions across changing screens and duplicate selections that could toggle a checkbox off. Current logic skips duplicate same-point selections, considers screen-image changes, gives recovery guidance before pausing and identifies the repeated action type/intent. Strict inline `form` metadata can accompany an input or done response, so mapping/verification need not require a separate model request. Tests prove those behaviors, not which action was repeated in the user's original run. The follow-up has 156 passing tests and a real localhost duplicate-checkbox check; the live Free Codex trial remains unvalidated.

1. Restart the rebuilt Aether AppImage. Keep Codex CLI and the separate account selected; leave model overrides at CLI default.
2. Enter a concrete goal with any personal/test values the form needs.
3. Check **Allow Auto to submit this form** for this run. It resets when started.
4. Click **Auto**, focus the form within three seconds, and keep Aether clear of the fields. Escape stops it.

Submission defaults to review. When enabled, both per-answer and final submission are allowed after answer verification. Sensitive operations remain blocked. The run is bounded to 80 decisions / ten minutes. Typing remains ASCII, append-only into empty fields.

## Evidence and limits

- 153 unit tests pass, including schema/permission checks, form-map invalidation, submission verification, unchanged-screen feedback, bounded format correction and cancellation.
- Real localhost Playwright passed the submission control/reset and three real form flows: long single page with scrolling, multi-step Next, and per-question Submit. Decisions were scripted; this is execution/loop evidence.
- An isolated native Electron target confirmed actual Hyprland/ydotool click, typing and scrolling. The previously stopped ydotool user service was started and enabled.
- No live Free Codex request was made in this follow-up. The user's trial will establish recognition quality for their form; success on arbitrary forms is not established.
