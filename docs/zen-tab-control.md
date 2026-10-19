# Zen tab control

Use the current Zen profile, logins and open forms. This mode attaches to existing tabs; it does not launch another browser/profile or use ydotool's desktop pointer.

## Current host setup

The user approved one restart. Their installed Zen was restarted with its exact existing profile and `--marionette`; the form tab is present after restoration. A one-time startup file enabled session restoration and `focusmanager.testmode=true`, then was removed. No profile/cookie copy or model request was made. Aether was rebuilt and reopened.

1. In Aether, click the **Zen tab** radio next to **Auto target**.
2. Click **Connect Zen**, then click the existing form's radio in the inline tab list.
3. Enter the task and its required test values. Enable **Allow Auto to submit this form** if desired.
4. Click **Auto**. There is no foreground countdown in Zen mode. You can work in another tab/app/workspace and hide Aether; leave the target form untouched. **Escape** or **Stop Auto** cancels.

Connect may activate Zen once. Handles are specific to the automation session; reconnect and select the form again after restarting Zen or Aether. Closing the selected tab or changing its viewport makes the run stop instead of falling back to another tab.

## Reconnecting after a normal Zen restart

The automation flag applies to the running process. If Zen was restarted normally, quit it and launch your installed Zen with `zen-browser --marionette`; retain your usual profile. Do not run a second process on a locked profile. Background typing also requires the `focusmanager.testmode` preference to remain true. This host setup already has it enabled.

To stop offering the automation endpoint, quit Zen and restart normally without `--marionette`. Reset `focusmanager.testmode` in `about:config` if you no longer want background automation focus behavior. The listener is bound to loopback; it is intended for trusted local software.

## Implementation and evidence

- Direct [Mozilla Marionette protocol](https://firefox-source-docs.mozilla.org/remote/marionette/Protocol.html) through Node networking, with no new dependency or driver download. See Mozilla's [client API](https://firefox-source-docs.mozilla.org/python/marionette_driver.html) for `switch_to_window(handle, focus=False)` and background-focus preferences.
- Exact selected tab and viewport, bounded framed messages/timeouts, fresh screenshot authorization, PNG/DPR checks and paired input release. Closing Aether drops its transport without quitting Zen or closing tabs.
- Native trusted clicks/keys work in hidden tabs when background focus is enabled. A same-binary disposable profile confirmed typed text, checkbox state, trusted button events and iframe clicks with unchanged OS cursor/focus.
- Native wheel events did not scroll hidden tabs. Browser scroll actions therefore use a fixed, bounded internal hit-test/scroll script, including up to five iframe levels; the model cannot provide script text. Hidden-tab scrollY 360 was confirmed.
- 171 tests and real localhost Playwright UI/form checks pass. The final AppImage's real preload/IPC listed existing Zen tabs. These prove execution plumbing and isolation on this host, not live Free Codex reasoning accuracy or speed. Platform support still depends on native Hyprland's existing Escape/Stop integration.
