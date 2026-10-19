# Zen tab control plan

## Scope and authorization

Reuse the user's running Zen profile, logins and open forms. User approved one Zen restart to enable browser-native automation. Do not recreate or copy the profile, install a new browser, close user tabs, or run a live model trial on their form. Native desktop Auto remains available.

## Implementation

1. Add a bounded loopback Marionette client and tab controller using Node's existing networking library. Use native WebDriver pointer/key/wheel actions, fixed internal viewport scripts, exact selected-tab identity and fresh screenshots. Switch targets with `focus:false`; disconnect without Quit/DeleteSession. Test framing, bounds, cancellation and image authorization.
2. Add existing-style Auto target controls: Desktop or Zen tab, a Connect/refresh button and a tab selector. Pass only target type, selected handle and submission permission through the preload/IPC/session boundary. Zen tasks skip the foreground countdown; Escape/Stop remain active. Keep the same form engine and selected CLI provider.
3. Verify against a disposable Zen profile first, including trusted input, frames, scroll and no OS cursor/focus movement. Run full tests, real localhost Playwright UI checks and packaging. Then gracefully restart the exact existing Zen process once with its same profile and `--marionette`, restore its session, and confirm attachment without submitting anything.
4. Refresh graph and living docs. Report verified isolation separately from live model reasoning speed. Provide exact setup/reconnect instructions and leave commit/push for user direction.

## Design choices

Use direct Marionette rather than an extension: Firefox does not expose Chrome's debugger API, and page-script clicks do not provide the requested native-input behavior. Direct protocol avoids another binary/runtime dependency and supports focus-free tab selection. Automation is enabled only on loopback for the restarted process. Background rendering, viewport coordinates and event trust must be verified on this Zen build before claiming success.
