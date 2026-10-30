/* wingman renderer — UI state, mic capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const wingman = window.wingman; // exposed by preload
  document.documentElement.classList.toggle('hyprland', !!wingman.compositorMoves);
  const $ = (s) => document.querySelector(s);
  const cmdKey = wingman.platform === 'darwin' ? '⌘' : 'Ctrl';
  const isCmdOrCtrl = (e) => wingman.platform === 'darwin' ? e.metaKey : e.ctrlKey;
  const DEFAULT_ASSIST_SHORTCUT = 'CommandOrControl+Return';
  const DEFAULT_TOGGLE_SHORTCUT = 'CommandOrControl+Shift+Space';

  // Direction 3 (instrument UI) labels its keys with text; no icon painting needed.

  // ---- state -------------------------------------------------------------
  let settings = null;
  let autoRefreshActive = false;
  let autoRefreshSupported = !!wingman.autoRefreshSupported;
  let busy = false;
  let autoModeActive = false, autoModeSupported = false;
  let aiEl = null;       // current streaming <div class="ai-text">
  let caretEl = null;
  let assistShortcut = DEFAULT_ASSIST_SHORTCUT;
  let toggleShortcut = DEFAULT_TOGGLE_SHORTCUT;
  let recordingShortcut = false;

  const messages = $('#messages');

  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function shortcutParts(accelerator) {
    const labels = {
      CommandOrControl: wingman.platform === 'darwin' ? '⌘' : 'Ctrl',
      Command: '⌘', Control: 'Ctrl', Super: 'Super',
      Alt: wingman.platform === 'darwin' ? '⌥' : 'Alt',
      Shift: wingman.platform === 'darwin' ? '⇧' : 'Shift',
      Return: 'Enter', Escape: 'Esc', Space: 'Space',
      Up: '↑', Down: '↓', Left: '←', Right: '→'
    };
    return (accelerator || DEFAULT_ASSIST_SHORTCUT).split('+').map((part) => labels[part] || part);
  }

  function shortcutKeycapsHtml(accelerator, className) {
    const cls = className || 'keycap';
    return shortcutParts(accelerator).map((part) => '<span class="' + cls + '">' + esc(part) + '</span>').join(' ');
  }

  function syncAssistShortcutLabels() {
    const shortcutBtn = $('#shortcut-assist');
    if (shortcutBtn && !recordingShortcut) shortcutBtn.textContent = shortcutParts(assistShortcut).join(' + ');
    if (!recordingShortcut) $('#shortcut-toggle').textContent = shortcutParts(toggleShortcut).join(' + ');
    $('#share-hide-btn').title = 'Hide the entire window. Restore with ' + shortcutParts(toggleShortcut).join('+') + '. Test restoring before sharing.';
    const placeholder = $('#placeholder');
    if (placeholder) placeholder.innerHTML = 'Ask anything · ' + shortcutKeycapsHtml(assistShortcut) + ' Assist';
  }

  const renderMarkdown = window.createAnswerFormatter({ Marked: marked.Marked, DOMPurify, katex });
  let renderFrame = null;
  function paintAnswer() {
    if (!aiEl) return;
    aiEl.innerHTML = renderMarkdown(aiEl.dataset.raw || '');
    if (caretEl) aiEl.appendChild(caretEl);
  }

  function clearMessages() { cancelAnimationFrame(renderFrame); renderFrame = null; messages.innerHTML = ''; aiEl = null; caretEl = null; }

  function addUserBubble(text) {
    const b = document.createElement('div');
    b.className = 'user-bubble';
    b.textContent = text;
    messages.appendChild(b);
  }

  function startAi(small) {
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    messages.appendChild(aiEl);
  }

  function appendToken(t) {
    if (!aiEl) startAi(false);
    aiEl.querySelector('.llm-phase')?.remove();
    aiEl.dataset.raw += t;
    if (renderFrame === null) renderFrame = requestAnimationFrame(() => { renderFrame = null; paintAnswer(); });
  }

  function finalizeAi() {
    if (!aiEl) return;
    cancelAnimationFrame(renderFrame); renderFrame = null;
    const raw = aiEl.dataset.raw || '';
    aiEl.innerHTML = renderMarkdown(raw);
    aiEl = null; caretEl = null;
  }

  messages.addEventListener('click', event => {
    const link = event.target.closest('.ai-text a');
    if (!link) return;
    event.preventDefault();
    if (/^https:\/\//i.test(link.getAttribute('href') || '')) wingman.openPane(link.href);
  });

  function setBusy(v) { busy = v; $('#send-btn').classList.toggle('busy', v); }

  function paintAutoMode(state) {
    autoModeActive = !!state.active;
    if (typeof state.supported === 'boolean') autoModeSupported = state.supported;
    const button = $('#auto-mode-btn');
    $('#auto-submit').disabled = autoModeActive || !autoModeSupported;
    for (const id of ['#auto-target', '#auto-zen-connect', '#auto-zen-tab']) $(id).disabled = autoModeActive;
    button.querySelector('.n').textContent = autoModeActive ? 'Stop Auto' : 'Run Auto';
    button.classList.toggle('on', autoModeActive);
    button.disabled = !autoModeSupported && !autoModeActive;
    if (!autoModeSupported) button.title = wingman.platform === 'win32'
      ? 'Windows Auto requires ydotool.exe (npm run build:input).'
      : 'Desktop Auto currently requires native Hyprland, grim and ydotool.';
    const status = $('#auto-mode-status');
    status.textContent = state.message ? (state.step ? 'Step ' + state.step + ' · ' : '') + state.message : '';
    status.classList.toggle('hidden', !state.message);
    setBusy(autoModeActive);
    syncReadout();
  }
  // Header readout: what Auto would do right now.
  function syncReadout() {
    const zen = document.querySelector('input[name="auto-target"]:checked')?.value === 'zen';
    $('#readout').textContent = (autoModeActive ? 'AUTO ON' : 'AUTO') + ' · ' + (zen ? 'ZEN' : 'DESK') + ' · ARM ' + ($('#auto-submit').checked ? 'ON' : 'OFF');
  }
  $('#auto-submit').addEventListener('change', syncReadout);
  wingman.on('auto-mode:state', paintAutoMode);
  $('#auto-target').addEventListener('change', () => {
    const browser = document.querySelector('input[name="auto-target"]:checked').value === 'zen';
    $('#zen-row').classList.toggle('hidden', !browser);
    syncReadout();
    $('#auto-mode-btn').title = browser ? 'Run on the selected Zen tab without using the desktop cursor. Escape stops Auto.' : 'Focus the target app within 3 seconds after Auto starts. Escape stops Auto.';
  });
  $('#auto-zen-connect').addEventListener('click', async () => {
    if (busy) return showStatus('Stop the current task before refreshing Zen tabs.');
    const list = $('#auto-zen-tab');
    const selected = list.querySelector('input:checked')?.value;
    $('#auto-zen-connect').disabled = true;
    try {
      const tabs = await wingman.autoModeZenTabs();
      list.replaceChildren();
      for (const tab of tabs) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio'; input.name = 'zen-tab'; input.value = tab.id; input.checked = tab.id === selected;
        label.append(input, document.createTextNode(' ' + (tab.title || tab.url || 'Untitled tab')));
        list.append(label);
      }
      if (!tabs.length) list.textContent = 'No web tabs available';
      showStatus(tabs.length ? 'Zen connected. Select the form tab; leave it untouched while Auto runs.' : 'Zen connected, but no web tabs are available.');
    } catch (error) {
      list.textContent = 'Connect to list tabs';
      showStatus(error?.message || 'Could not connect to Zen. Restart it with --marionette.', true);
    } finally { $('#auto-zen-connect').disabled = autoModeActive; }
  });
  let autoClickStops = false;
  $('#auto-mode-btn').addEventListener('pointerdown', () => { autoClickStops = autoModeActive; });
  $('#auto-mode-btn').addEventListener('pointercancel', () => { autoClickStops = false; });
  $('#auto-mode-btn').addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      if (event.repeat) { event.preventDefault(); return; }
      autoClickStops = autoModeActive;
    }
  });
  $('#auto-mode-btn').addEventListener('click', async () => {
    const stops = autoClickStops || autoModeActive; autoClickStops = false;
    if (stops) { wingman.autoModeStop(); return; }
    const goal = $('#input').value.trim();
    if (!goal) return showStatus('Type a task first, then click Auto.');
    if (busy) return showStatus('Wait for the current answer first.');
    const target = document.querySelector('input[name="auto-target"]:checked').value;
    const tabId = $('#auto-zen-tab input:checked')?.value;
    if (target === 'zen' && !tabId) return showStatus('Connect Zen and select the form tab first.');
    try {
      clearMessages();
      await wingman.autoModeStart(goal, { allowSubmit: $('#auto-submit').checked, target, ...(target === 'zen' ? { tabId } : {}) });
      $('#auto-submit').checked = false; syncReadout();
    } catch (error) { showStatus(error?.message || 'Auto could not start.', true); }
  });

  // ---- Write mode --------------------------------------------------------
  const writeView = $('#write-view');
  const panelEl = $('#panel');
  const setWriteStage = (stage) => { $('#write-stage').textContent = (stage || 'prompt').toUpperCase(); };
  function showWriteButtons({ prepare, rerun, humanize, approve, type, stop }) {
    $('#write-prepare').classList.toggle('hidden', !prepare);
    $('#write-rerun').classList.toggle('hidden', !rerun);
    $('#write-humanize').classList.toggle('hidden', !humanize);
    $('#write-approve').classList.toggle('hidden', !approve);
    $('#write-type').classList.toggle('hidden', !type);
    $('#write-stop').classList.toggle('hidden', !stop);
  }
  function writeStatus(msg, err) { const el = $('#write-status'); el.textContent = msg; el.classList.remove('hidden'); el.classList.toggle('error', !!err); }
  function resetWrite() {
    $('#write-review').classList.add('hidden');
    $('#write-input').classList.remove('hidden');
    $('#write-paste-row').classList.remove('hidden');
    $('#write-detector').classList.add('hidden');
    $('#write-notes').classList.add('hidden');
    $('#write-zen-row').classList.add('hidden');
    $('#write-status').classList.add('hidden');
    showWriteButtons({ prepare: true });
    setWriteStage('prompt');
  }
  function enterWrite() { panelEl.classList.add('writing'); writeView.classList.remove('hidden'); resetWrite(); }
  function exitWrite() { panelEl.classList.remove('writing'); writeView.classList.add('hidden'); }
  $('#write-mode-btn').addEventListener('click', enterWrite);
  $('#write-back').addEventListener('click', exitWrite);
  $('#write-settings').addEventListener('click', openSettings);

  let prepNotes = [];
  function showReview(review, notesBefore = []) {
    $('#write-review').value = review.text || '';
    $('#write-review').classList.remove('hidden');
    $('#write-input').classList.add('hidden');
    $('#write-paste-row').classList.add('hidden');
    const det = $('#write-detector');
    det.classList.remove('hidden');
    const pct = review.aiScore == null ? '—' : Number(review.aiScore).toFixed(1) + '%';
    det.textContent = `AI: ${pct} · ${review.pass ? 'PASS' : 'FAIL'}${review.detail ? ' · ' + review.detail : ''}`;
    det.classList.toggle('pass', !!review.pass);
    det.classList.toggle('fail', !review.pass);
    // Unopened links, unverifiable quotes, and discarded rounds are shown, never hidden.
    const all = review.notes === notesBefore ? notesBefore : [...notesBefore, ...(review.notes || [])];
    const notes = $('#write-notes');
    notes.textContent = all.join('\n');
    notes.classList.toggle('hidden', !all.length);
    setWriteStage('review');
  }
  async function runHumanize() {
    const text = $('#write-review').value.trim();
    if (!text) return writeStatus('Nothing to humanise.', true);
    showWriteButtons({ stop: true });
    $('#write-review').readOnly = true;
    writeStatus('Humanising…');
    try {
      const review = await wingman.writeHumanize(text);
      showReview(review, prepNotes);
      writeStatus(review.reached ? 'Under target. Edit if you like, then Approve.' : 'Not under target yet. Humanize again, or Approve as is.');
    } catch (e) {
      writeStatus(/stopped/i.test(e?.message || '') ? 'Humanize stopped. The text shown is unchanged.' : (e?.message || 'Could not humanise.'), !/stopped/i.test(e?.message || ''));
    } finally {
      $('#write-review').readOnly = false;
      showWriteButtons({ rerun: true, humanize: true, approve: true });
    }
  }
  $('#write-humanize').addEventListener('click', runHumanize);
  async function runPrepare() {
    const text = $('#write-input').value.trim();
    if (!text) return writeStatus('Enter a prompt or paste text.', true);
    const paste = $('#write-paste-mode').checked;
    showWriteButtons({});
    writeStatus(paste ? 'Scoring your text…' : 'Drafting…');
    try {
      const review = await wingman.writePrepare(paste ? { pasted: text } : { prompt: text });
      prepNotes = review.notes || [];
      showReview(review, prepNotes);
      writeStatus('Here is the finished text. Humanize it, edit it, or Approve it as is.');
      showWriteButtons({ rerun: true, humanize: true, approve: true });
    } catch (e) {
      writeStatus(e?.message || 'Could not prepare the text.', true);
      showWriteButtons({ prepare: true });
    }
  }
  $('#write-prepare').addEventListener('click', runPrepare);
  $('#write-rerun').addEventListener('click', () => {
    $('#write-input').value = $('#write-input').value || $('#write-review').value;
    $('#write-input').classList.remove('hidden'); $('#write-review').classList.add('hidden');
    runPrepare();
  });
  $('#write-approve').addEventListener('click', async () => {
    const final = $('#write-review').value.trim();
    if (!final) return writeStatus('Nothing to approve.', true);
    try {
      await wingman.writeApprove(final);
      setWriteStage('armed');
      $('#write-zen-row').classList.remove('hidden');
      writeStatus('Model disengaged. Connect Zen, pick the tab, then Type it.');
      showWriteButtons({ type: true });
    } catch (e) { writeStatus(e?.message || 'Could not approve.', true); }
  });
  $('#write-zen-connect').addEventListener('click', async () => {
    const list = $('#write-zen-tab');
    const selected = list.querySelector('input:checked')?.value;
    $('#write-zen-connect').disabled = true;
    try {
      const tabs = await wingman.writeZenTabs();
      list.replaceChildren();
      for (const tab of tabs) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio'; input.name = 'write-zen-tab'; input.value = tab.id; input.checked = tab.id === selected;
        label.append(input, document.createTextNode(' ' + (tab.title || tab.url || 'Untitled tab')));
        list.append(label);
      }
      if (!tabs.length) list.textContent = 'No web tabs available';
      writeStatus(tabs.length ? 'Zen connected. Select the Google Docs tab.' : 'Zen connected, but no web tabs are available.');
    } catch (e) { list.textContent = 'Connect to list tabs'; writeStatus(e?.message || 'Could not connect to Zen. Restart it with --marionette.', true); }
    finally { $('#write-zen-connect').disabled = false; }
  });
  $('#write-type').addEventListener('click', async () => {
    const tabId = $('#write-zen-tab input:checked')?.value;
    if (!tabId) return writeStatus('Connect Zen and select the tab first.', true);
    try {
      await wingman.writeType(tabId, {});
      setWriteStage('typing');
      showWriteButtons({ stop: true });
      writeStatus('Typing… you can switch desktops. Stop or Escape to halt.');
    } catch (e) { writeStatus(e?.message || 'Could not start typing.', true); }
  });
  $('#write-stop').addEventListener('click', () => wingman.writeStop());
  wingman.on('write-mode:state', (s) => {
    if (!s) return;
    if (s.status === 'humanising') { setWriteStage('humanising'); if (s.message) writeStatus(s.message); return; }
    if (s.stage === 'review') return;   // Humanize results and failures are shown by runHumanize
    if (s.stage) setWriteStage(s.stage);
    if (s.status === 'typing' && s.total) { writeStatus(`Typing… ${s.typed || 0}/${s.total}`); showWriteButtons({ stop: true }); }
    else if (s.status === 'done') { resetWrite(); writeStatus(s.message || 'Typed the approved text.'); }
    else if (s.status === 'stopped') { writeStatus('Write stopped.'); showWriteButtons({ type: true }); setWriteStage('armed'); }
    else if (s.status === 'error') { writeStatus(s.message || 'Write error.', true); showWriteButtons({ type: true }); }
    else if (s.message) writeStatus(s.message);
  });

  // ---- actions -----------------------------------------------------------
  function runMode(mode, text) {
    if (busy) return;
    setBusy(true);
    wingman.ask({ mode, text: text || '' });
  }

  document.querySelectorAll('.act[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode !== 'research') return runMode(btn.dataset.mode, '');
      const question = $('#input').value.trim();
      if (!question) return showStatus('Type a research question first.');
      runMode('research', question);
    });
  });

  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');

  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  input.addEventListener('input', syncPlaceholder);
  input.addEventListener('focus', () => { composer.classList.add('focused'); placeholder.classList.add('hidden'); });
  input.addEventListener('blur', () => { composer.classList.remove('focused'); syncPlaceholder(); });
  $('#input-area').addEventListener('click', () => input.focus());

  function send() {
    const text = input.value.trim();
    if (!text) { runMode('assist', ''); return; }
    input.value = ''; syncPlaceholder();
    runMode('ask', text);
  }
  $('#send-btn').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    const captured = keyEventToAccelerator(e);
    if (captured.accelerator && captured.accelerator.toLowerCase() === assistShortcut.toLowerCase()) {
      e.preventDefault(); runMode('assist', ''); return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); send(); }
  });

  // Depth slider: Answer (smart false) / Work (true) / Deep ('deep').
  const smartBtn = $('#smart-toggle');
  const DEPTHS = { answer: false, work: true, deep: 'deep' };
  let smartSave = Promise.resolve(), smartRevision = 0;
  function syncSmart() {
    const value = settings?.smart;
    const current = value === 'deep' ? 'deep' : value ? 'work' : 'answer';
    for (const button of smartBtn.querySelectorAll('button')) {
      const on = button.dataset.depth === current;
      button.setAttribute('aria-checked', String(on)); button.tabIndex = on ? 0 : -1;
    }
    smartBtn.dataset.depth = current;
    $('#depth-readout').textContent = 'DEPTH: ' + current.toUpperCase();
  }
  function selectSmart(value) {
    if (!settings) return showStatus('Settings are unavailable. Restart Aether to retry.', true);
    const revision = ++smartRevision;
    settings.smart = value; syncSmart();
    smartSave = smartSave.catch(() => {}).then(() => wingman.settingsSet({ smart: value })).catch(async () => {
      if (revision === smartRevision) {
        try { settings.smart = (await wingman.settingsGet()).smart; } catch { settings.smart = false; }
        syncSmart(); showStatus('Could not save response depth. Try again.', true);
      }
    });
  }
  smartBtn.addEventListener('click', event => {
    const button = event.target.closest('button[data-depth]');
    if (button) selectSmart(DEPTHS[button.dataset.depth]);
  });
  smartBtn.addEventListener('keydown', event => {
    const order = ['answer', 'work', 'deep'], at = order.indexOf(smartBtn.dataset.depth);
    const next = event.key === 'ArrowRight' ? order[Math.min(2, at + 1)] : event.key === 'ArrowLeft' ? order[Math.max(0, at - 1)] : null;
    if (!next) return;
    event.preventDefault(); selectSmart(DEPTHS[next]); smartBtn.querySelector(`[data-depth="${next}"]`).focus();
  });
  // Alt+Enter still jumps straight to Deep from anywhere in the panel.
  document.addEventListener('keydown', event => { if (event.altKey && event.key === 'Enter') { event.preventDefault(); selectSmart('deep'); } });

  // Hide / collapse
  // Hide puts the panel away; the dock at the top stays and reopens it.
  $('#hide-btn').addEventListener('click', () => wingman.panelHide());
  $('#dock-btn').addEventListener('click', () => wingman.dockShow());
  $('#share-hide-btn').addEventListener('click', () => wingman.hideForSharing());

  // Start getDisplayMedia directly from the click so its user gesture stays valid.
  let captureStarting = false, captureCancelled = false;
  $('#stop-btn').addEventListener('click', async () => {
    if ($('#stop-btn').classList.contains('active')) { await wingman.captureStop(); return; }
    if (captureStarting) { captureCancelled = true; stopMic(); stopSystemAudio(); showStatus('Listening start cancelled. Close the capture prompt if it is still open.'); return; }
    captureStarting = true;
    captureCancelled = false;
    const system = startSystemAudio();
    const mic = startMic();
    const [systemReady, micReady] = await Promise.all([system, mic]);
    const hasSystem = systemReady && (linuxSystemActive || sysStream?.getAudioTracks().some(track => track.readyState === 'live'));
    const hasMic = micReady && micStream?.getAudioTracks().some(track => track.readyState === 'live');
    captureStarting = false;
    if (captureCancelled || (!hasSystem && !hasMic)) {
      stopMic(); stopSystemAudio();
      if (!captureCancelled) showStatus('Listening could not start. Check microphone and screen capture permissions.');
      return;
    }
    if (!hasSystem) showStatus(wingman.platform === 'linux'
      ? 'Listening to your microphone only. For meeting audio, install parec and check your PulseAudio/PipeWire output.'
      : 'Listening to your microphone only. Meeting audio is unavailable.');
    if (!hasMic) showStatus('Listening to meeting audio only. Microphone is unavailable.');
    try {
      if (!await wingman.captureToggle()) throw new Error('Listening did not start');
      if (!linuxSystemActive && !sysStream?.getAudioTracks().some(track => track.readyState === 'live') &&
          !micStream?.getAudioTracks().some(track => track.readyState === 'live')) {
        await wingman.captureStop();
        showStatus('Listening stopped because audio capture ended.');
      }
    } catch (err) {
      stopMic(); stopSystemAudio();
      showStatus('Listening could not start. Please try again.');
    }
  });

  // ---- capture: mic (renderer side) --------------------------------------
  let audioCtx = null, micStream = null, micNode = null, micProc = null;
  async function startMic() {
    if (micStream) return true;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      if (!micStream.getAudioTracks().some((track) => track.readyState === 'live')) { stopMic(); return false; }
      audioCtx = new AudioContext({ sampleRate: 16000 });
      await audioCtx.audioWorklet.addModule('./pcm-processor.js');
      micNode = audioCtx.createMediaStreamSource(micStream);
      micProc = new AudioWorkletNode(audioCtx, 'pcm-processor');
      micProc.port.onmessage = (e) => wingman.micPcm(e.data);
      const sink = audioCtx.createGain(); sink.gain.value = 0; // run processor silently
      micNode.connect(micProc); micProc.connect(sink); sink.connect(audioCtx.destination);
      if (!micStream.getAudioTracks().some((track) => track.readyState === 'live')) { stopMic(); return false; }
      micStream.getAudioTracks().forEach((track) => track.addEventListener('ended', audioTrackEnded, { once: true }));
      return true;
    } catch (err) {
      wingman.log('mic error: ' + (err && err.message));
      stopMic();
      return false;
    }
  }
  function stopMic() {
    if (micProc) { micProc.port.onmessage = null; micProc.disconnect(); micProc = null; }
    if (micNode) { micNode.disconnect(); micNode = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  }

  // ---- capture: system/meeting audio (getDisplayMedia loopback, in wingman's process) ----
  let sysStream = null, sysCtx = null, sysNode = null, sysProc = null, linuxSystemActive = false, linuxSystemEnded = false;
  async function startSystemAudio() {
    if (wingman.platform === 'linux') {
      linuxSystemEnded = false;
      try { linuxSystemActive = await wingman.systemAudioStart() && !linuxSystemEnded; return linuxSystemActive; }
      catch { linuxSystemActive = false; return false; }
    }
    if (sysStream) return true;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      stream.getVideoTracks().forEach((t) => t.stop()); // we only want the audio
      const tracks = stream.getAudioTracks();
      if (!tracks.some((track) => track.readyState === 'live')) { wingman.log('system audio: no live loopback track'); stream.getTracks().forEach((t) => t.stop()); return false; }
      sysStream = stream;
      sysCtx = new AudioContext({ sampleRate: 16000 });
      await sysCtx.audioWorklet.addModule('./pcm-processor.js');
      sysNode = sysCtx.createMediaStreamSource(new MediaStream(tracks));
      sysProc = new AudioWorkletNode(sysCtx, 'pcm-processor');
      sysProc.port.onmessage = (e) => wingman.systemPcm(e.data);
      const sink = sysCtx.createGain(); sink.gain.value = 0;
      sysNode.connect(sysProc); sysProc.connect(sink); sink.connect(sysCtx.destination);
      wingman.log('system audio: capturing loopback');
      if (!sysStream.getAudioTracks().some((track) => track.readyState === 'live')) { stopSystemAudio(); return false; }
      tracks.forEach((track) => track.addEventListener('ended', audioTrackEnded, { once: true }));
      return true;
    } catch (err) {
      wingman.log('system audio error: ' + (err && err.message));
      stopSystemAudio();
      return false;
    }
  }
  function stopSystemAudio() {
    if (wingman.platform === 'linux') {
      linuxSystemActive = false;
      linuxSystemEnded = true;
      wingman.systemAudioStop().catch(() => wingman.log('system audio stop failed'));
    }
    if (sysProc) { sysProc.port.onmessage = null; sysProc.disconnect(); sysProc = null; }
    if (sysNode) { sysNode.disconnect(); sysNode = null; }
    if (sysCtx) { sysCtx.close(); sysCtx = null; }
    if (sysStream) { sysStream.getTracks().forEach((t) => t.stop()); sysStream = null; }
  }
  let stoppingEndedCapture = false;
  function audioTrackEnded(systemEnded = false) {
    const hadMic = !!micStream, hadSystem = !!sysStream || linuxSystemActive;
    const hasMic = hadMic && micStream.getAudioTracks().some((track) => track.readyState === 'live');
    const hasSystem = hadSystem && (linuxSystemActive ? systemEnded !== true : sysStream.getAudioTracks().some((track) => track.readyState === 'live'));
    if (hadMic && !hasMic) stopMic();
    if (hadSystem && !hasSystem) stopSystemAudio();
    if (!$('#stop-btn').classList.contains('active')) return;
    if (!hasMic && !hasSystem) {
      if (!stoppingEndedCapture) {
        stoppingEndedCapture = true;
        showStatus('Listening stopped because audio capture ended.');
        wingman.captureStop().catch(() => showStatus('Could not stop listening automatically. Use the listening button.')).finally(() => { stoppingEndedCapture = false; });
      }
      return;
    }
    if (hadMic && !hasMic) showStatus('Microphone capture ended. Meeting audio continues.');
    else if (hadSystem && !hasSystem) showStatus('Meeting audio ended. Microphone continues.');
  }

  // ---- events from main --------------------------------------------------
  wingman.on('capture:system-ended', () => { linuxSystemEnded = true; audioTrackEnded(true); });
  wingman.on('capture:state', ({ active }) => {
    $('#live-dot').classList.toggle('off', !active);
    $('#stop-btn').classList.toggle('active', active);
    if (!active) { stopMic(); stopSystemAudio(); }
  });
  wingman.on('llm:start', ({ userBubble, small }) => {
    clearMessages();
    if (userBubble) addUserBubble(userBubble);
    startAi(!!small);
    setBusy(true);
  });
  wingman.on('llm:token', ({ text }) => appendToken(text));
  wingman.on('llm:phase', ({ message }) => {
    if (!aiEl || aiEl.dataset.raw) return;
    let phase = aiEl.querySelector('.llm-phase');
    if (!phase) { phase = document.createElement('span'); phase.className = 'llm-phase'; aiEl.insertBefore(phase, caretEl); }
    phase.textContent = message;
  });
  wingman.on('llm:done', () => { finalizeAi(); setBusy(false); });
  wingman.on('llm:sources', ({ sources }) => {
    const list = document.createElement('div');
    list.className = 'source-list';
    const label = document.createElement('div');
    label.textContent = 'Reference sources';
    list.appendChild(label);
    for (const source of sources || []) {
      if (!/^https:\/\//i.test(source.url)) continue;
      const link = document.createElement('a');
      link.href = source.url;
      link.textContent = `[${source.number}] ${source.title} · ${source.origin === 'library' ? 'Local library' : 'Web'}`;
      link.addEventListener('click', event => { event.preventDefault(); wingman.openPane(source.url); });
      list.appendChild(link);
    }
    if ((sources || []).some(source => source.origin === 'library')) {
      const attribution = document.createElement('div');
      attribution.textContent = 'Wikipedia contributors · ';
      const license = document.createElement('a');
      license.href = 'https://creativecommons.org/licenses/by-sa/4.0/';
      license.textContent = 'CC BY-SA 4.0';
      license.addEventListener('click', event => { event.preventDefault(); wingman.openPane(license.href); });
      attribution.appendChild(license);
      list.appendChild(attribution);
    }
    const previous = messages.querySelector('.source-list');
    if (previous) previous.replaceWith(list);
    else messages.appendChild(list);
  });
  wingman.on('llm:error', ({ message }) => {
    if (!aiEl) startAi(true);
    aiEl.dataset.raw = message; finalizeAi(); setBusy(false);
  });
  let statusTimer = null;
  function showStatus(message, persistent = false) {
    let el = document.getElementById('wingman-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wingman-status';
      const panel = document.getElementById('panel');
      panel.insertBefore(el, document.getElementById('action-row'));
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(statusTimer);
    if (!persistent) statusTimer = setTimeout(() => el.classList.remove('show'), 11000);
  }
  wingman.on('status', ({ message }) => { wingman.log('[status] ' + message); showStatus(message); });

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  function syncAutoRefreshPause() {
    wingman.autoRefreshPause(!$('#settings-scrim').classList.contains('hidden') || !$('#onboard-scrim').classList.contains('hidden') || $('#panel').classList.contains('collapsed'));
  }
  function syncAutoRefreshIndicator() { $('#auto-refresh-indicator').hidden = !autoRefreshActive; }
  wingman.on('auto-refresh:state', ({ active, error }) => {
    autoRefreshActive = !!active; syncAutoRefreshIndicator();
    if (error) showStatus(error, true);
  });
  function openSettings() { if (!settings) { showStatus('Settings are unavailable. Restart Aether to retry.', true); return; } fillSettings(); scrim.classList.remove('hidden'); syncAutoRefreshPause(); }
  async function closeSettings() {
    cancelShortcutRecording();
    try {
      await saveSettings();
      scrim.classList.add('hidden');
      syncAutoRefreshPause();
    } catch (err) {
      wingman.log('settings save error: ' + (err && err.message));
      $('#s-status').textContent = 'Could not save settings. Check access to your key storage, then try again.';
      $('#s-status').setAttribute('role', 'alert');
    }
  }
  $('#more-btn').addEventListener('click', openSettings);
  $('#s-close').addEventListener('click', closeSettings);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeSettings(); });

function fillSettings() {
    $('#auto-refresh').checked = !!settings.autoRefresh && autoRefreshSupported;
    $('#auto-refresh').disabled = !autoRefreshSupported;
    $('#auto-refresh-hint').textContent = autoRefreshSupported
      ? 'Off by default. After interaction pauses, a screenshot goes to your selected provider and uses its allowance.'
      : 'Click/scroll refresh is currently available on Hyprland. Manual Assist works here.';
    $('#notch-auto-hide').checked = settings.notchAutoHide !== false;
    $('#notch-hide-delay').value = Number.isInteger(settings.notchHideDelay) ? settings.notchHideDelay : 8;
    document.querySelectorAll('#provider-seg button').forEach((b) => b.classList.toggle('on', b.dataset.provider === settings.provider));
    $('#key-openai').value = settings.apiKeys.openai || '';
    $('#key-anthropic').value = settings.apiKeys.anthropic || '';
    $('#key-gemini').value = settings.apiKeys.gemini || '';
    $('#key-nvidia').value = settings.apiKeys.nvidia || '';
    $('#key-groq').value = settings.apiKeys.groq || '';
    $('#key-tavily').value = settings.apiKeys.tavily || '';
    $('#whisper-model-path').value = settings.whisperModelPath || '';
    updateSttControls();
    $('#resume-context').value = settings.resumeContext || '';
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    updateModelHint(settings.provider);
    const wm = settings.writeMode || {}; const t = wm.typing || {};
    document.querySelectorAll('#wm-detector-seg button').forEach(b => b.classList.toggle('on', b.dataset.detector === (wm.detector || 'local')));
    document.querySelectorAll('#wm-humanizer-seg button').forEach(b => b.classList.toggle('on', b.dataset.humanizer === (wm.humanizer || 'sentences')));
    $('#wm-wpm').value = t.wpm ?? ''; $('#wm-typo').value = t.typoRate ?? '';
    $('#wm-untypo').value = t.uncorrectedTypoRate ?? ''; $('#wm-stutter').value = t.stutterRate ?? '';
    $('#wm-gap').value = t.gapChance ?? ''; $('#wm-candidates').value = wm.candidates ?? '';
    $('#wm-refine').value = wm.refine ?? ''; $('#wm-python').value = wm.pythonPath || '';
    $('#wm-inksplash').value = wm.inksplashDir || '';
    refreshPythonStatus();
    syncAssistShortcutLabels();
    $('#s-status').textContent = statusText();
  }
  document.querySelectorAll('#wm-detector-seg button').forEach(b => b.addEventListener('click', () => {
    settings.writeMode = settings.writeMode || {};
    settings.writeMode.detector = b.dataset.detector;
    document.querySelectorAll('#wm-detector-seg button').forEach(x => x.classList.toggle('on', x === b));
  }));
  document.querySelectorAll('#wm-humanizer-seg button').forEach(b => b.addEventListener('click', () => {
    settings.writeMode = settings.writeMode || {};
    settings.writeMode.humanizer = b.dataset.humanizer;
    document.querySelectorAll('#wm-humanizer-seg button').forEach(x => x.classList.toggle('on', x === b));
  }));
  async function refreshPythonStatus() {
    const el = $('#wm-python-status'); if (!el) return; el.textContent = 'Checking Python…';
    try {
      const st = await wingman.writePythonStatus();
      el.textContent = st.ok
        ? `Python ready: ${st.pythonPath}${st.inksplashDir ? ' · humaniser: ' + st.inksplashDir : ' · set a humaniser folder below'}`
        : st.runnable
          ? `Missing: ${(st.missing || []).join(', ')} — install them with pip, or set a Python path.`
          : 'No suitable Python found. Install python3 and the humaniser deps (torch, transformers, spacy, nltk, textstat).';
    } catch { el.textContent = 'Could not check Python.'; }
  }
  $('#clear-resume').addEventListener('click', async () => {
    $('#resume-context').value = '';
    settings.resumeContext = '';
    await wingman.settingsSet({ resumeContext: '' });
  });
function statusText() {
    const k = settings.apiKeys;
    const has = [k.openai && 'OpenAI', k.anthropic && 'Anthropic', k.gemini && 'Gemini', k.nvidia && 'Nvidia', k.groq && 'Groq', k.tavily && 'Tavily'].filter(Boolean);
    const stt = settings.provider === 'ollama' || settings.sttProvider === 'local' ? 'local Whisper' : (k.openai ? 'Whisper' : (k.gemini ? 'Gemini' : 'none'));
    return 'Active: ' + settings.provider + ' · keys: ' + (has.join(', ') || 'none set') + ' · transcription: ' + stt;
  }
  function updateModelHint(provider) {
    $('#codex-account-row').classList.toggle('hidden', provider !== 'codex-cli');
    $('#codex-account-hint').classList.toggle('hidden', provider !== 'codex-cli');
    $('#codex-separate-account').checked = !!settings.codexSeparateAccount;
    $('#codex-login-row').classList.toggle('hidden', provider !== 'codex-cli');
    if (provider === 'codex-cli') refreshCodexLogin();
    const hint = $('#model-hint');
    if (provider === 'nvidia') {
      hint.textContent = 'Nvidia NIM: use a vision model like meta/llama-3.2-90b-vision-instruct or meta/llama-3.2-11b-vision-instruct. Text-only models (e.g. nemotron-mini) can\'t see screenshots and will refuse.';
    } else if (provider === 'ollama') {
      hint.textContent = 'Enter an installed Ollama model name. Screen features need a vision-capable model.';
    } else if (provider === 'claude-cli' || provider === 'codex-cli') {
      hint.textContent = 'Uses the installed, signed-in CLI. Leave both model fields empty to use its default model.';
    } else {
      hint.textContent = '';
    }
  }
  async function refreshCodexLogin() {
    const signedIn = await wingman.codexLoginStatus();
    $('#codex-login-state').textContent = signedIn ? 'Aether profile: signed in' : 'Aether profile: signed out';
    $('#codex-login').textContent = signedIn ? 'Sign in again' : 'Sign in to Codex';
  }
  $('#codex-login').addEventListener('click', async () => {
    const button = $('#codex-login');
    button.disabled = true;
    $('#codex-login-state').textContent = 'Finish signing in in the new window…';
    try { await wingman.codexLogin(); }
    catch { $('#codex-login-state').textContent = 'Sign-in did not finish. Try again.'; button.disabled = false; return; }
    button.disabled = false;
    await refreshCodexLogin();
  });
  function updateSttControls() {
    if (settings.provider === 'ollama') settings.sttProvider = 'local';
    document.querySelectorAll('#stt-seg button').forEach(button => {
      button.classList.toggle('on', button.dataset.stt === (settings.sttProvider || 'cloud'));
      button.disabled = settings.provider === 'ollama' && button.dataset.stt === 'cloud';
    });
  }
  document.querySelectorAll('#stt-seg button').forEach(button => button.addEventListener('click', () => {
    settings.sttProvider = button.dataset.stt;
    updateSttControls();
    $('#s-status').textContent = statusText();
  }));
  document.querySelectorAll('#provider-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.provider = b.dataset.provider;
    document.querySelectorAll('#provider-seg button').forEach((x) => x.classList.toggle('on', x === b));
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    updateModelHint(settings.provider);
    updateSttControls();
    $('#s-status').textContent = statusText();
  }));
async function saveSettings() {
    settings.codexSeparateAccount = $('#codex-separate-account').checked;
    settings.autoRefresh = $('#auto-refresh').checked;
    settings.notchAutoHide = $('#notch-auto-hide').checked;
    const notchDelay = Number.parseInt($('#notch-hide-delay').value, 10);
    settings.notchHideDelay = Number.isInteger(notchDelay) ? Math.max(2, Math.min(60, notchDelay)) : 8;
    settings.apiKeys.openai = $('#key-openai').value.trim();
    settings.apiKeys.anthropic = $('#key-anthropic').value.trim();
    settings.apiKeys.gemini = $('#key-gemini').value.trim();
    settings.apiKeys.nvidia = $('#key-nvidia').value.trim();
    settings.apiKeys.groq = $('#key-groq').value.trim();
    settings.apiKeys.tavily = $('#key-tavily').value.trim();
    settings.whisperModelPath = $('#whisper-model-path').value.trim();
    settings.resumeContext = $('#resume-context').value.trim();
    if (!settings.models[settings.provider]) settings.models[settings.provider] = {};
    settings.models[settings.provider].fast = $('#model-fast').value.trim();
    settings.models[settings.provider].smart = $('#model-smart').value.trim();
    settings.writeMode = settings.writeMode || {}; settings.writeMode.typing = settings.writeMode.typing || {};
    const wmNum = (sel, def) => { const v = parseFloat($(sel).value); return Number.isFinite(v) ? v : def; };
    if (!settings.writeMode.detector) settings.writeMode.detector = 'local';
    settings.writeMode.typing.wpm = wmNum('#wm-wpm', settings.writeMode.typing.wpm);
    settings.writeMode.typing.typoRate = wmNum('#wm-typo', settings.writeMode.typing.typoRate);
    settings.writeMode.typing.uncorrectedTypoRate = wmNum('#wm-untypo', settings.writeMode.typing.uncorrectedTypoRate);
    settings.writeMode.typing.stutterRate = wmNum('#wm-stutter', settings.writeMode.typing.stutterRate);
    settings.writeMode.typing.gapChance = wmNum('#wm-gap', settings.writeMode.typing.gapChance);
    settings.writeMode.candidates = wmNum('#wm-candidates', settings.writeMode.candidates);
    settings.writeMode.refine = wmNum('#wm-refine', settings.writeMode.refine);
    settings.writeMode.pythonPath = $('#wm-python').value.trim();
    settings.writeMode.inksplashDir = $('#wm-inksplash').value.trim();
    await wingman.settingsSet(settings);
    syncAutoRefreshIndicator();
  }

  // Assist shortcut recorder. The renderer captures a key combination and the
  // main process only saves it after Electron confirms the global registration.
  const shortcutBtn = $('#shortcut-assist');
  const shortcutHint = $('#shortcut-hint');

  function setShortcutHint(message, kind) {
    shortcutHint.textContent = message;
    shortcutHint.classList.toggle('error', kind === 'error');
    shortcutHint.classList.toggle('success', kind === 'success');
  }

  function cancelShortcutRecording() {
    recordingShortcut = false;
    document.querySelectorAll('.shortcut-record').forEach(button => button.classList.remove('recording'));
    syncAssistShortcutLabels();
  }

  function keyEventToAccelerator(e) {
    const modifierKeys = new Set(['Meta', 'Control', 'Alt', 'Shift']);
    if (modifierKeys.has(e.key)) return { error: 'Press a modifier together with another key.' };

    const parts = [];
    const primaryDown = wingman.platform === 'darwin' ? e.metaKey : e.ctrlKey;
    if (primaryDown) parts.push('CommandOrControl');
    if (wingman.platform === 'darwin' && e.ctrlKey) parts.push('Control');
    if (wingman.platform !== 'darwin' && e.metaKey) parts.push('Super');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    const named = {
      Enter: 'Return', ' ': 'Space', Tab: 'Tab', Backspace: 'Backspace',
      Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
      PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down',
      ArrowLeft: 'Left', ArrowRight: 'Right'
    };
    const punctuation = { '+': 'Plus', '-': '-', '=': '=', ',': ',', '.': '.', '/': '/', ';': ';', "'": "'", '[': '[', ']': ']', '\\': '\\', '`': '`' };
    let key = named[e.key] || punctuation[e.key] || '';
    if (!key && /^[a-z]$/i.test(e.key)) key = e.key.toUpperCase();
    if (!key && /^[0-9]$/.test(e.key)) key = e.key;
    if (!key && /^Digit[0-9]$/.test(e.code)) key = e.code.slice(-1);
    if (!key && /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(e.key)) key = e.key;
    if (!key) return { error: 'Use a letter, number, function key, arrow, or common navigation key.' };
    if (!parts.length && !/^F/.test(key)) return { error: 'Include Command/Ctrl, Alt, or Shift in the shortcut.' };
    parts.push(key);
    return { accelerator: parts.join('+') };
  }

  async function applyShortcut(action, accelerator) {
    const shortcutBtn = $('#shortcut-' + action);
    const wasRecording = recordingShortcut;
    recordingShortcut = false;
    shortcutBtn.classList.remove('recording');
    shortcutBtn.textContent = 'Saving…';
    let result;
    try {
      result = await (action === 'assist' ? wingman.shortcutAssistSet(accelerator) : wingman.shortcutToggleSet(accelerator));
    } catch (_) {
      result = { ok: false, error: 'Aether could not update the shortcut. Please try again.' };
    }
    if (!result.ok) {
      setShortcutHint(result.error, 'error');
      recordingShortcut = wasRecording;
      shortcutBtn.classList.toggle('recording', recordingShortcut);
      if (recordingShortcut) shortcutBtn.textContent = 'Press keys…';
      else syncAssistShortcutLabels();
      return;
    }
    if (action === 'assist') assistShortcut = result.accelerator;
    else toggleShortcut = result.accelerator;
    if (action === 'toggle') $('#share-hide-btn').disabled = false;
    if (!settings.shortcuts) settings.shortcuts = {};
    settings.shortcuts[action] = result.accelerator;
    cancelShortcutRecording();
    setShortcutHint((action === 'assist' ? 'Assist' : 'Show / hide') + ' shortcut updated.', 'success');
  }

  for (const action of ['assist', 'toggle']) {
    $('#shortcut-' + action).addEventListener('click', () => {
      cancelShortcutRecording();
      recordingShortcut = action;
      const button = $('#shortcut-' + action);
      button.classList.add('recording');
      button.textContent = 'Press keys…';
      setShortcutHint('Press Escape to cancel.', '');
    });
  }
  $('#shortcut-reset').addEventListener('click', () => applyShortcut('assist', DEFAULT_ASSIST_SHORTCUT));
  $('#shortcut-toggle-reset').addEventListener('click', () => applyShortcut('toggle', DEFAULT_TOGGLE_SHORTCUT));

  document.addEventListener('keydown', (e) => {
    if (!recordingShortcut) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape') {
      cancelShortcutRecording();
      setShortcutHint('Shortcut change cancelled.', '');
      return;
    }
    const captured = keyEventToAccelerator(e);
    if (captured.error) {
      setShortcutHint(captured.error, 'error');
      return;
    }
    applyShortcut(recordingShortcut, captured.accelerator);
  }, true);

  // ---- example conversation (matches the reference screenshot) ------------
  function showExample() {
    clearMessages();
    const ai = document.createElement('div');
    ai.className = 'ai-text idle';
    ai.textContent = 'Ready. Ask about your screen, press F1 for Assist, or type a task and Run Auto.';
    messages.appendChild(ai);
  }

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !scrim.classList.contains('hidden')) closeSettings();
    if (isCmdOrCtrl(e)) {
      if (e.key === ',') { e.preventDefault(); openSettings(); }
    }
    // F1-F5 press the mode keys, unless a dialog is open or a shortcut is being recorded.
    const fkey = /^F([1-5])$/.exec(e.key);
    if (fkey && !recordingShortcut && scrim.classList.contains('hidden') && obScrim.classList.contains('hidden') && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault(); document.querySelectorAll('#action-row .act[data-mode]')[Number(fkey[1]) - 1]?.click();
    }
  });

  // UI Zoom buttons (text only)
  let currentZoom = 1;
  function updateZoom(delta) {
    currentZoom = Math.max(0.5, Math.min(3, currentZoom + delta));
    document.documentElement.style.setProperty('--text-zoom', currentZoom);
  }
  $('#zoom-in-btn').addEventListener('click', () => updateZoom(0.1));
  $('#zoom-out-btn').addEventListener('click', () => updateZoom(-0.1));

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  let ignoring = null;
  function setIgnore(v) {
    // Linux cannot forward mousemove from an ignored window to re-enable input.
    const next = wingman.platform === 'linux' ? false : v;
    if (next !== ignoring) { ignoring = next; wingman.setIgnoreMouse(next); }
  }
  document.addEventListener('mousemove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const overUI = !!(el && el.closest && el.closest('#plate, #settings-scrim, #onboard-scrim, .resize-corner, #notch-hit, #notch-shape'));
    setIgnore(!overUI);
  });
  setIgnore(true); // supported platforms re-enable input when the pointer enters UI

  if (wingman.compositorMoves) {
    const toolbar = $('#toolbar');
    let moving = false;
    toolbar.addEventListener('pointerdown', async event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      event.preventDefault();
      moving = true;
      toolbar.setPointerCapture(event.pointerId);
      try { if (!await wingman.moveStart()) moving = false; }
      catch { moving = false; showStatus('Could not move the window. Try the desktop window move controls.'); }
    });
    toolbar.addEventListener('pointermove', () => { if (moving) wingman.moveUpdate(); });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) toolbar.addEventListener(event, () => {
      if (!moving) return;
      moving = false; wingman.resizeEnd({ cancel: event !== 'pointerup' });
    });
  }

  let resizing = null;
  for (const corner of document.querySelectorAll('.resize-corner')) {
    const endResize = (cancel = false) => {
      if (resizing !== corner) return;
      resizing = null; wingman.resizeEnd({ cancel });
    };
    corner.addEventListener('pointerdown', async event => {
      if (event.button !== 0) return;
      event.preventDefault();
      setIgnore(false);
      resizing = corner;
      corner.setPointerCapture(event.pointerId);
      try {
        const result = await wingman.resizeStart({ corner: corner.dataset.resize, x: event.screenX, y: event.screenY });
        if (!result || result.native) {
          resizing = null;
          if (corner.hasPointerCapture(event.pointerId)) corner.releasePointerCapture(event.pointerId);
        }
      } catch { endResize(true); showStatus('Could not start window resizing. Try the desktop window resize controls.'); }
    });
    corner.addEventListener('pointermove', event => { if (resizing === corner) wingman.resizeMove({ x: event.screenX, y: event.screenY }); });
    corner.addEventListener('pointerup', () => endResize());
    corner.addEventListener('pointercancel', () => endResize(true));
    corner.addEventListener('lostpointercapture', () => endResize(true));
  }

  // ---- onboarding / first-run tutorial -----------------------------------
  const obScrim = $('#onboard-scrim');
  const OB_STEPS = [
    {
      icon: '01 · HELLO',
      title: 'Welcome to Aether',
      body: 'Aether is an AI copilot that floats over your screen. It can <strong>see your screen</strong>, <strong>hear your meetings</strong>, and help you answer questions or solve coding problems.<br><br>This quick guide gets you running in about a minute.'
    },
    ...(wingman.platform === 'darwin' ? [{
      icon: '02 · ACCESS',
      title: 'Allow Aether to see & hear',
      body: 'Aether needs two macOS permissions. Click each button, turn <strong>Aether</strong> ON in the window that opens, then come back here.<ul><li><strong>Microphone</strong> — to hear you</li><li><strong>Screen Recording</strong> — to see your screen and hear meeting audio</li></ul>',
      buttons: [
        { label: 'Open Microphone settings', action: () => wingman.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone') },
        { label: 'Open Screen Recording settings', action: () => wingman.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') }
      ]
    }] : []),
    {
      icon: 'SETUP · PROVIDER',
      title: 'Connect an AI provider',
      body: 'Choose an AI provider in Settings: a cloud API key, local <strong>Ollama</strong>, or a signed-in <strong>Claude/Codex CLI</strong>. For factual questions, Aether searches its bundled reference library and uses Tavily web search for current topics or library gaps; web search needs a separate Tavily key.<br><br>Meeting transcription can use a local Whisper model or an OpenAI/Gemini key. Ollama always transcribes locally.',
      buttons: [{ label: 'Open Aether Settings', action: () => { finishOnboard(); openSettings(); } }]
    },
    {
      icon: 'SHARING',
      title: 'Before you share your screen',
      body: wingman.platform === 'darwin'
        ? 'Aether asks macOS to exclude its window from captures, but some sharing apps may still show it. Configure and test your <strong>Show / hide</strong> shortcut in Settings before sharing. Check the sharing app’s preview after hiding.'
        : wingman.platform === 'win32'
          ? 'Aether asks Windows to exclude its window from captures, but some sharing apps may still show it. Configure and test your <strong>Show / hide</strong> shortcut in Settings before sharing. Check the sharing app’s preview after hiding.'
          : 'Linux has no Aether window-exclusion support. Share only a selected window or tab when possible. Configure and test your <strong>Show / hide</strong> shortcut in Settings before sharing; Wayland may need a desktop binding. Check the recipient preview after hiding.'
    },
{
      icon: 'READY',
      title: 'You\'re all set',
      body: () => `How to use Aether:<ul><li>${shortcutKeycapsHtml(assistShortcut, 'kbd')} — <strong>Assist</strong> with whatever's on screen or being said</li><li>${shortcutKeycapsHtml(toggleShortcut, 'kbd')} — <strong>Show / hide</strong> Aether (test restoring before sharing)</li><li><span class="kbd">${cmdKey}</span> <span class="kbd">H</span> — solve a coding problem on screen</li><li>Press <strong>LISTEN</strong> in the panel header to start listening to a meeting</li><li>Press <span class="kbd">F1</span>–<span class="kbd">F5</span> for the mode keys; click the dock at the top to open or hide the panel, swipe it up to dismiss it</li><li>Type a question and press <span class="kbd">↵</span></li></ul>Reopen this guide anytime by clicking <strong>AETHER</strong> in the panel header. Change shortcuts in <strong>Settings</strong>. Quit with <span class="kbd">${cmdKey}</span><span class="kbd">⇧</span><span class="kbd">X</span>.`
    }
  ];
  let obIndex = 0;
  function renderOnboard() {
    const step = OB_STEPS[obIndex];
    $('#ob-icon').textContent = step.icon;
    $('#ob-title').textContent = step.title;
    $('#ob-body').innerHTML = typeof step.body === 'function' ? step.body() : step.body;
    const btns = $('#ob-buttons'); btns.innerHTML = '';
    (step.buttons || []).forEach((b) => { const el = document.createElement('button'); el.textContent = b.label; el.addEventListener('click', b.action); btns.appendChild(el); });
    const dots = $('#ob-dots'); dots.innerHTML = '';
    OB_STEPS.forEach((_, i) => { const d = document.createElement('span'); if (i === obIndex) d.className = 'on'; dots.appendChild(d); });
    $('#ob-back').style.visibility = obIndex === 0 ? 'hidden' : 'visible';
    $('#ob-next').textContent = obIndex === OB_STEPS.length - 1 ? 'Done' : 'Next';
    $('#ob-skip').style.visibility = obIndex === OB_STEPS.length - 1 ? 'hidden' : 'visible';
  }
  function showOnboard() { obIndex = 0; renderOnboard(); obScrim.classList.remove('hidden'); setIgnore(false); syncAutoRefreshPause(); }
  async function finishOnboard() {
    if (settings && !settings.onboarded) {
      try {
        await wingman.settingsSet({ onboarded: true });
        settings.onboarded = true;
      } catch (err) {
        showStatus('Could not save onboarding progress. Please try again.', true);
        return;
      }
    }
    obScrim.classList.add('hidden');
    syncAutoRefreshPause();
  }
  $('#ob-next').addEventListener('click', () => { if (obIndex === OB_STEPS.length - 1) finishOnboard(); else { obIndex++; renderOnboard(); } });
  $('#ob-back').addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderOnboard(); } });
  $('#ob-skip').addEventListener('click', finishOnboard);
  $('#logo-btn').addEventListener('click', showOnboard);

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    try {
      const st = await wingman.captureState();
      if (st.active) await wingman.captureStop(); // media tracks do not survive a renderer reload
    } catch (err) {
      wingman.log('listening state error: ' + (err && err.message));
      showStatus('Could not read listening state. Restart Aether to retry.', true);
      return;
    }
    try {
      settings = await wingman.settingsGet();
    } catch (err) {
      wingman.log('settings load error: ' + (err && err.message));
      showStatus('Settings could not be loaded. Restart Aether to retry.', true);
      return;
    }
    assistShortcut = (settings.shortcuts && settings.shortcuts.assist) || DEFAULT_ASSIST_SHORTCUT;
    toggleShortcut = (settings.shortcuts && settings.shortcuts.toggle) || DEFAULT_TOGGLE_SHORTCUT;
    const shortcuts = await wingman.shortcutStatus();
    $('#share-hide-btn').disabled = !shortcuts.toggle;
    if (!shortcuts.toggle) showStatus('Show / hide shortcut unavailable. Choose another in Settings before hiding.', true);
    syncAssistShortcutLabels();
    syncSmart();
    const refreshStatus = await wingman.autoRefreshStatus();
    autoRefreshActive = !!refreshStatus.active;
    if (typeof refreshStatus.supported === 'boolean') autoRefreshSupported = refreshStatus.supported;
    syncAutoRefreshIndicator();
    syncAutoRefreshPause();
    const autoStatus = await wingman.autoModeStatus();
    paintAutoMode(autoStatus);
    showExample();
    syncPlaceholder();
    if (!settings.onboarded) showOnboard();

  })();
})();
