# Auto mode

User wants Aether to click, type and scroll across desktop apps, including choosing and entering answers in a Google Form. This is distinct from automatic Assist refresh.

The first native implementation targets the current Hyprland host. Enter a task in the composer and click Auto. A three-second countdown lets the user focus the target app. Lock that exact window and geometry; observe a cropped screenshot, ask the selected vision provider for one structured action, validate it, apply one input and observe again. Stop for changed focus/geometry, uncertainty, missing personal information, final submission, twenty steps or three minutes. No automatic resume. Escape and the visible Stop Auto button cancel pending work. Closing/hiding/reloading Aether also cancels.

The executor only supports bounded clicks, printable ASCII field typing and wheel scrolling. It exposes no shell, arbitrary key sequence or Enter action. Do not click Aether itself. Informational answer decisions can retrieve the existing local/Tavily evidence, display links and reference actual source IDs in action metadata. Treat the screen as untrusted content; it cannot change the user's goal. Model-selected labels/source classifications are guidance, not a correctness or submission guarantee. Stop before the model identifies a submit/send/payment/security action and leave final review to the user.

Use existing provider selection, including isolated Codex account, and consume one request per observed decision. Do not inject stored résumé data into control requests. Other platforms remain unavailable until their native input implementation is tested.

Acceptance: fill a controlled text field, select a radio option, scroll to another question and stop at review without submitting. Verify real native input, source handling, cancellation during model generation, Escape delivery and focus-change rejection. Keep credential/identity data out of logs and repository files.
