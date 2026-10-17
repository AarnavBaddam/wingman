# Aether project notes

- This is a GPL-3.0-or-later fork of Aarnav Baddam's Wingman. Keep attribution and the original code license unless every rights holder explicitly approves a change.
- Product name is Aether. Keep existing internal `wingman-data.json` compatibility unless a data migration is implemented.
- Never claim a visible overlay is invisible to every share or recorder. Linux has no Electron capture exclusion; macOS/Windows protection is best effort. Do not add bypasses for locked/proctored software.
- Ollama must not send audio to cloud transcription, even if cloud keys are saved. Research queries may use Tavily only after local retrieval is weak or the fact is current; show source links and fail closed when retrieval fails.
- The bundled Wikipedia text is CC BY-SA 4.0 and requires article links, Wikipedia contributor credit, and license notice. It is separate from the GPL code.
- A local title match may still lack the answer. If the model reports insufficient local evidence, retry Tavily once and show the resulting web sources.
- Run `npm test`, a real Playwright browser check on localhost, and `npm run pack` before claiming a changed flow works. Native capture/permission claims require testing on that OS.
- `graphify-out/` is ignored but should be refreshed after structural code changes. Keep `project.md` and `overview.md` current for cross-chat work.
- A fresh profile or headless packaged launch is not a clean Linux install or proof of desktop keyring/capture permissions. Track those checks separately in `docs/release-validation.md`.
- Check the push destination before publishing: the clone's `origin` currently points to Aarnav Baddam's upstream Wingman repository, not a user-owned Aether fork.
- Validate factual quality against retrieved passages, not citation-number checks alone: live Ollama probes have produced naming/date drift despite valid citations.
- A narrower article title must not satisfy a general-topic local-only query; require matching normalized topic terms before skipping web fallback.
- User preference: keep AI summaries for factual answers, block invalid citations, and show sources. Do not replace summaries with a source-excerpt mode. Citation validity still does not prove factual accuracy.
- Local commits are authorized; keep progressing between commits. Push remains deferred until explicitly authorized with an Aether destination.
- User wants configurable, short Show / hide keys. Reuse the Settings recorder; preserve Assist separately. A registered shortcut boolean is not proof of Wayland dispatch. Disable sharing Hide when registration fails, and keep physical restore validation separate from recording evidence that Hide removes the window.
- Linux meeting audio uses `parec` and the default output monitor; Electron's loopback flag is not the Linux backend. Keep microphone-only fallback and stop helpers on cancellation, reload/crash, and quit.
- Hyprland's default Electron storage backend may be `basic_text` despite a running GNOME Keyring. The explicit `--password-store=gnome-libsecret` backend passed encrypted save/restart checks here; do not force that backend on other keyring setups.
