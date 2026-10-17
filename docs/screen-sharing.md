# Screen sharing compatibility

Aether uses Electron's `setContentProtection` on macOS and Windows. Electron does not provide that protection on Linux, and [Electron notes that newer macOS capture APIs can still capture a protected window](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable-macos-windows). These settings are best effort. There is no universal way to keep a visible window out of every capture method.

## Check a share before using it

1. Start the sharing app and choose a specific **window** or **tab** if possible.
2. Inspect the app's own preview or a second viewer/recording. Move Aether over the content and confirm it does not appear.
3. If it appears, click **Hide for sharing**. This hides the whole Aether window. Restore it with `Ctrl+Alt+Shift+9`, or `⌘⌥⇧9` on macOS, after the share ends.
4. Repeat the check whenever the OS, meeting app, capture mode, or display setup changes.

The restore shortcut is best effort: a desktop environment or another app can reserve it. During a locked session, another app may block it entirely.

## Common software

| Software | Share choices and Aether guidance |
|---|---|
| [Google Meet](https://support.google.com/meet/answer/9308856?hl=en) | Offers tab, window, and entire-screen sharing. Choose a tab or the intended window, then check the preview. |
| [Microsoft Teams](https://support.microsoft.com/en-us/teams/meetings/present-content-in-microsoft-teams-meetings) | Offers a window or entire screen. Choose the intended window and check the preview. Availability varies with organization and platform. |
| [Zoom on Linux](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060596) | Share support depends on Xorg/Wayland and Zoom's version. Do not assume a full-desktop share excludes Aether; check with a recipient. |
| [OBS Studio](https://obsproject.com/kb/window-capture-sources) | Window capture targets a selected window; display capture includes the display. Check the OBS preview and recording. |
| Other meeting or recording apps | Choose a window/tab if offered and validate with a viewer. App updates or different capture methods can change the result. |
| [Respondus LockDown Browser](https://web.respondus.com/lockdown-10reasons/) and similar proctored browsers | These products may prevent access to other apps and screen-capture functions. Aether does not bypass their restrictions and is not supported in locked sessions. |

## Platform limits

- **Linux:** Electron offers no capture-exclusion flag for Aether. On X11 or Wayland, full-display capture may include the overlay. Some Wayland compositors also limit window positioning, always-on-top behavior, and global shortcuts. Prefer a selected window/tab and validate it on the actual desktop and share app.
- **macOS:** Aether requests content protection and a floating panel. Modern capture paths may ignore protection. Screen Recording and Microphone permissions are required for their corresponding features.
- **Windows:** Aether requests content protection, but Microsoft [describes display affinity as a content-protection feature rather than a strict security guarantee](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity). Validate the actual sharing app.

Fullscreen apps and locked/proctored modes are different. An ordinary fullscreen app may allow a floating panel depending on the OS. A locked/proctored browser can intentionally block other software and shortcuts; Aether cannot promise operation there.
