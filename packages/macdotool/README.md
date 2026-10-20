# macdotool

A small macOS counterpart to [ydotool](https://github.com/ReimuNotMoe/ydotool) plus the few
`hyprctl`/`grim` queries Aether's desktop Auto mode needs. One Swift file, no dependencies.

Build (needs Xcode Command Line Tools): `node build.js` → `bin/macdotool` (universal, macOS 14+).

| Command | Like | Notes |
| --- | --- | --- |
| `click 0xC0` | `ydotool click` | `0x40` down, `0x80` up, `0xC0` both; low nibble 0 left, 1 right, 2 middle. Clicks at the cursor. |
| `mousemove [-a] -x N -y N` | `ydotool mousemove` | `-a` absolute global points. Moves while a button is held are sent as drags. |
| `mousemove -w -x 0 -y N` | `ydotool mousemove -w` | Wheel lines; positive `y` scrolls up. |
| `type [--key-delay ms] [--key-hold ms] [--file -] [text]` | `ydotool type` | Unicode payloads, so keyboard layout does not matter. |
| `key [--key-delay ms] code:state…` | `ydotool key` | macOS virtual keycodes (0–127). |
| `debug` | `ydotool debug` | Exits 0 only with Accessibility access; prompts once otherwise. |
| `activewindow`, `clients`, `cursorpos` | `hyprctl -j …` | Same JSON shape: `address`, `pid`, `class` (bundle id), `mapped`, `at`, `size`. |
| `capture -g "x,y wxh"` | `grim -s 1 -g … -` | PNG on stdout at one pixel per point (ScreenCaptureKit). |
| `watch` | Hyprland binds | Prints `x y` per left click or scroll; exits when stdin closes. |

Coordinates are global points with the origin at the top-left of the main display.

Permissions (System Settings › Privacy & Security), granted to the app that launches it:
Accessibility (input, focused window), Screen Recording (`capture`), Input Monitoring if `watch` is refused.
