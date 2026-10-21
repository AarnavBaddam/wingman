# Aether UI overhaul: shared design spec

Date: 2026-10-21. Input to all three direction drafts. Each draft reads only this spec.

## What Aether is
A desktop AI overlay for Linux (Hyprland), forked from Wingman. It sees the current screen, hears meetings, answers questions with sources, and runs **Auto**: it clicks, types and scrolls through forms by itself, either on the desktop (moving the real cursor) or inside a chosen Zen browser tab in the background (with its own purple-for-now "second cursor" drawn on the page).

## Who and where
One user, a student / power user on CachyOS + Hyprland, 1920x1080 at scale 1, Quickshell top bar 44px tall: dark rounded pills, monospace clock, blue time text, orange weather text. Aether floats over a browser with a homework or form page. Viewing distance: laptop, 50-70 cm. Glances matter more than reading sessions.

## What is wrong today (from a real screenshot, `current-ui.png`)
Generic Bootstrap blue, a separate toolbar strip plus a panel, two different Hide buttons, a status banner jammed into the content, Auto controls bolted on as a loose radio row and checkbox, `-` and `+` zoom buttons with no labels, mode actions separated by bullet dots. Nothing says "Aether"; nothing groups by task.

## New: dock mode (the "taskbar extension")
Modeled on Sentient OS's notch: a small always-present pill at the top center of the screen, sitting just under (or visually attached to) the Quickshell bar. Click it (or the show/hide shortcut) and it expands into the full panel. While Auto runs, the dock itself shows live progress, so the user can keep working and glance up. Dock states to design:
1. Idle: wordmark/glyph + shortcut hint.
2. Listening to a meeting: live indicator.
3. Auto running: step count, current action ("Typing answer"), target ("Zen · MyLab Math"), stop affordance (Escape).
4. Needs you: paused or a skipped graph question.

## Panel content (real, use exactly)
- Input placeholder: "Ask about your screen or conversation". Example typed task: "Answer this question and submit it".
- Depth control: Answer / Work / Deep (current: Work).
- Modes: Assist, What should I say?, Follow-up questions, Recap, Research.
- Auto: target Desktop | Zen tab; selected tab "MyLab Math: Q3 of 10"; "Allow submit" switch, off by default, labelled "this run only"; Run Auto button.
- Answer example: z = 15(cos(5π/12) + i sin(5π/12)). Work: moduli 5/2 × 6 = 15; arguments π/6 + π/4 = 5π/12.
- Footer: Hide (shortcut Ctrl+Shift+Space), Hide for sharing, Settings.

## Motif (the form seed)
The dock is the home of Aether's cursor. When idle the cursor glyph rests in the dock; when Auto runs it is "out" on the page, and the dock shows what it is doing. The second cursor on the page and the dock share one color and shape, so the user can connect "that thing clicking" with "that thing in my bar". Each draft must show the second cursor on the page at the answer box.

## Format
One HTML per direction, 1440x900 canvas (the screen scaled to 75%), self-contained. Top: the user's real Quickshell bar screenshot (base64). Behind: a browser window with the MyLab-style math question in light theme. Show the dock (Auto-running state) and the expanded panel at once, plus a small strip of the four dock states. Same content in all three; layouts must differ structurally.

## Constraints
- Body text at least 14px, labels at least 12px, contrast at least 4.5:1.
- No emoji icons, no purple gradient, no GitHub-dark + neon glow, no Inter/Space Grotesk/Fraunces as display.
- Must be buildable in Electron with CSS; no images needed beyond icons drawn as simple strokes.
- Accessibility: visible focus, real labels on the switch and segmented controls.
