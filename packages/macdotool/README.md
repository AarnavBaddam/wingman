# macdotool

A small macOS counterpart to [ydotool](https://github.com/ReimuNotMoe/ydotool) plus the few
`hyprctl`/`grim` queries Aether's desktop Auto mode needs. One Swift file, no dependencies.

Build (needs Xcode Command Line Tools): `node build.js` → `bin/macdotool` (universal, macOS 14+).

| Command | Like | Notes |
| --- | --- | --- |
| `click [-r N] [-D ms] 0xC0…` | `ydotool click` | `0x40` down, `0x80` up, `0xC0` both (8 ms hold); low nibble 0 left, 1 right, 2 middle. Clicks at the cursor. Several codes run in order, `-r` repeats the list, `-D` pauses between (default 25). Clicks within the system double-click window count 1, 2, … within one command, so a repeat is a real double click. |
| `mousemove [-a] -x N -y N [--smooth ms] [--ease minjerk\|linear]` | `ydotool mousemove` | `-a` absolute global points. Moves while a button is held are sent as drags. `--smooth` (cap 2000) interpolates a straight line at ~120 Hz and lands exactly on the target; `minjerk` is the default curve, `linear` is for callers chaining segments. 0 or absent is one jump. |
| `mousemove -w -x 0 -y N` | `ydotool mousemove -w` | Wheel lines; positive `y` scrolls up. |
| `type [-d ms] [-H ms] [-D ms] [-e 0\|1] [--chunk N] [--file -] [text…]` | `ydotool type` | Unicode payloads, so keyboard layout does not matter. `-e 1` (default, as ydotool) turns `\n` `\t` `\\` into Return, Tab, `\`, in args and `--file` alike. `-D` types each arg separately with a pause between (a space is typed between them). `--chunk N` (1–20) carries N UTF-16 units per key event; surrogate pairs are never split. Held Shift/Cmd are ignored. |
| `key [--key-delay ms] code:state…` | `ydotool key` | macOS virtual keycodes (0–127). |
| `debug` | `ydotool debug` | Exits 0 only with Accessibility access; prompts once per process, then checks silently. |
| `activewindow`, `clients`, `cursorpos` | `hyprctl -j …` | Same JSON shape: `address`, `pid`, `class` (bundle id), `mapped`, `at`, `size`. |
| `capture -g "x,y wxh"` | `grim -s 1 -g … -` | PNG on stdout at one pixel per point (ScreenCaptureKit). |
| `watch` | Hyprland binds | Prints `x y` per left click or scroll; exits when stdin closes. |

## serve (the ydotoold half)

`macdotool serve` is a persistent daemon: one process, no per-call spawn (about 0.05 ms per `cursorpos`
and 1 ms per `activewindow` round trip, against 19–37 ms to spawn). It speaks newline-delimited JSON on stdio.

```
→ {"id":1,"argv":["click","0xC0"],"input":"optional stdin text"}
← {"id":1,"ok":true,"out":"<base64 stdout bytes>"}
← {"id":1,"ok":false,"code":2,"error":"message"}
→ {"cancel":1}      ← {"id":1,"ok":false,"cancelled":true,"error":"cancelled"}
```

- `argv` is exactly the CLI's, through the same dispatch. `watch` and `serve` are refused. `input` feeds `type --file -`.
- Requests run one at a time, in order. An error fails only its request. A malformed line gets `{"ok":false,"error":…}`.
- Cancel is read ahead of the busy worker and checked at least every ~4 ms, so it interrupts a smooth move or a long `type` between events; an unknown or finished id is a no-op. Buttons or keys the cancelled request left down are released.
- On stdin EOF or SIGTERM it releases any button or key it holds down, then exits 0.
- `capture` caches the display list until the display configuration changes or a capture fails.
- Why stdio and not a socket: a socket would let any local process borrow Aether's Accessibility grant. A pipe ties the daemon to its parent and it dies with it.
- `MACDOTOOL_DRY=1` counts and discards posted events (tests); replies then carry `events`. `bench.js` times read-only requests.

Coordinates are global points with the origin at the top-left of the main display.

Permissions (System Settings › Privacy & Security), granted to the app that launches it:
Accessibility (input, focused window), Screen Recording (`capture`), Input Monitoring if `watch` is refused.
