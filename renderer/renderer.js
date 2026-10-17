/* wingman renderer — UI state, mic capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const wingman = window.wingman; // exposed by preload
  const $ = (s) => document.querySelector(s);
  const cmdKey = wingman.platform === 'darwin' ? '⌘' : 'Ctrl';
  const isCmdOrCtrl = (e) => wingman.platform === 'darwin' ? e.metaKey : e.ctrlKey;
  const DEFAULT_ASSIST_SHORTCUT = 'CommandOrControl+Return';

  // ---- paint icons -------------------------------------------------------
  $('#logo-btn').innerHTML = icon('logo', { size: 18 });
  $('.tb-hide .chev').innerHTML = icon('chevron-down', { size: 14 });
  $('#stop-btn').innerHTML = icon('stop-square', { size: 15 });
  document.querySelector('.act[data-mode="assist"] .ic').innerHTML = icon('sparkles', { size: 16 });
  document.querySelector('.act[data-mode="say"] .ic').innerHTML = icon('wand-sparkles', { size: 16 });
  document.querySelector('.act[data-mode="followup"] .ic').innerHTML = icon('message-circle', { size: 16 });
  document.querySelector('.act[data-mode="recap"] .ic').innerHTML = icon('refresh-cw', { size: 16 });
  $('#smart-toggle .ic').innerHTML = icon('zap', { size: 14 });
  $('#more-btn').innerHTML = icon('more-horizontal', { size: 18 });
  $('#send-btn').innerHTML = icon('play', { size: 15 });

  // ---- state -------------------------------------------------------------
  let settings = null;
  let busy = false;
  let aiEl = null;       // current streaming <div class="ai-text">
  let caretEl = null;
  let assistShortcut = DEFAULT_ASSIST_SHORTCUT;
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
    const placeholder = $('#placeholder');
    if (placeholder) placeholder.innerHTML = 'Ask about your screen or conversation, or ' + shortcutKeycapsHtml(assistShortcut) + ' for Assist';
  }

  function renderMath(expr, displayMode) {
    try { return katex.renderToString(expr, { throwOnError: false, displayMode }); }
    catch { return null; }
  }

  function renderMarkdown(text) {
    const lines = text.split('\n');
    let html = '', inCode = false, inList = false, inMath = false, mathBuf = [], buf = [];
    const flushP = () => { if (buf.length) { html += '<p>' + inline(buf.join(' ')) + '</p>'; buf = []; } };
    const inline = (s) => {
      s = esc(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      return s.replace(/\$([^$\n]+?)\$/g, (_, m) => {
        const r = renderMath(m, false);
        return r ? r : ('$' + m + '$');
      });
    };
    for (const raw of lines) {
      const line = raw;
      const t = line.trim();
      if (/^\$\$$/.test(t)) {
        if (!inMath) {
          flushP(); if (inList) { html += '</ul>'; inList = false; }
          inMath = true; mathBuf = [];
        } else {
          const expr = mathBuf.join('\n');
          const r = renderMath(expr, true);
          html += r ? r : ('<pre><code>' + esc(expr) + '</code></pre>');
          inMath = false;
        }
        continue;
      }
      if (inMath) { mathBuf.push(line); continue; }
      if (/^```/.test(t)) {
        if (!inCode) { flushP(); if (inList) { html += '</ul>'; inList = false; } html += '<pre><code>'; inCode = true; }
        else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += esc(line) + '\n'; continue; }
      if (/^\s*[-*]\s+/.test(line)) { flushP(); if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue; }
      if (t === '') { flushP(); if (inList) { html += '</ul>'; inList = false; } continue; }
      buf.push(line.trim());
    }
    flushP(); if (inList) html += '</ul>'; if (inCode) html += '</code></pre>';
    if (inMath) { const expr = mathBuf.join('\n'); html += '<pre><code>' + esc(expr) + '</code></pre>'; }
    return html;
  }

  function clearMessages() { messages.innerHTML = ''; aiEl = null; caretEl = null; }

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
    aiEl.dataset.raw += t;
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = t;
    aiEl.insertBefore(span, caretEl);
  }

  function finalizeAi() {
    if (!aiEl) return;
    const raw = aiEl.dataset.raw || '';
    aiEl.innerHTML = renderMarkdown(raw);
    aiEl = null; caretEl = null;
  }

  function setBusy(v) { busy = v; $('#send-btn').classList.toggle('busy', v); }

  // ---- actions -----------------------------------------------------------
  function runMode(mode, text) {
    if (busy) return;
    setBusy(true);
    wingman.ask({ mode, text: text || '' });
  }

  document.querySelectorAll('.act').forEach((btn) => {
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

  // Smart toggle
  const smartBtn = $('#smart-toggle');
  smartBtn.addEventListener('click', async () => {
    if (!settings) { showStatus('Settings are unavailable. Restart Aether to retry.', true); return; }
    settings.smart = !settings.smart;
    smartBtn.classList.toggle('on', settings.smart);
    await wingman.settingsSet({ smart: settings.smart });
  });

  // Hide / collapse
  $('#hide-btn').addEventListener('click', () => {
    const collapsed = $('#panel').classList.toggle('collapsed');
    $('#hide-btn').classList.toggle('collapsed', collapsed);
    $('#live-dot').style.display = collapsed ? 'none' : '';
  });
  $('#share-hide-btn').title = 'Hide the entire window. Restore with ' + (wingman.platform === 'darwin' ? '⌘⌥⇧9' : 'Ctrl+Alt+Shift+9') + '.';
  $('#share-hide-btn').addEventListener('click', () => wingman.hideForSharing());

  // Start getDisplayMedia directly from the click so its user gesture stays valid.
  let captureStarting = false, captureCancelled = false;
  $('#stop-btn').addEventListener('click', async () => {
    if ($('#stop-btn').classList.contains('active')) { await wingman.captureToggle(); return; }
    if (captureStarting) { captureCancelled = true; showStatus('Listening start cancelled. Close the capture prompt if it is still open.'); return; }
    captureStarting = true;
    captureCancelled = false;
    const system = startSystemAudio();
    const mic = startMic();
    const [hasSystem, hasMic] = await Promise.all([system, mic]);
    captureStarting = false;
    if (captureCancelled || (!hasSystem && !hasMic)) {
      stopMic(); stopSystemAudio();
      if (!captureCancelled) showStatus('Listening could not start. Check microphone and screen capture permissions.');
      return;
    }
    if (!hasSystem) showStatus('Listening to your microphone only. Meeting audio is unavailable.');
    if (!hasMic) showStatus('Listening to meeting audio only. Microphone is unavailable.');
    try {
      if (!await wingman.captureToggle()) throw new Error('Listening did not start');
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
  let sysStream = null, sysCtx = null, sysNode = null, sysProc = null;
  async function startSystemAudio() {
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
    if (sysProc) { sysProc.port.onmessage = null; sysProc.disconnect(); sysProc = null; }
    if (sysNode) { sysNode.disconnect(); sysNode = null; }
    if (sysCtx) { sysCtx.close(); sysCtx = null; }
    if (sysStream) { sysStream.getTracks().forEach((t) => t.stop()); sysStream = null; }
  }
  let stoppingEndedCapture = false;
  function audioTrackEnded() {
    const hadMic = !!micStream, hadSystem = !!sysStream;
    const hasMic = hadMic && micStream.getAudioTracks().some((track) => track.readyState === 'live');
    const hasSystem = hadSystem && sysStream.getAudioTracks().some((track) => track.readyState === 'live');
    if (hadMic && !hasMic) stopMic();
    if (hadSystem && !hasSystem) stopSystemAudio();
    if (!$('#stop-btn').classList.contains('active')) return;
    if (!hasMic && !hasSystem) {
      if (!stoppingEndedCapture) {
        stoppingEndedCapture = true;
        showStatus('Listening stopped because audio capture ended.');
        wingman.captureToggle().catch(() => showStatus('Could not stop listening automatically. Use the listening button.')).finally(() => { stoppingEndedCapture = false; });
      }
      return;
    }
    if (hadMic && !hasMic) showStatus('Microphone capture ended. Meeting audio continues.');
    else if (hadSystem && !hasSystem) showStatus('Meeting audio ended. Microphone continues.');
  }

  // ---- events from main --------------------------------------------------
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
    messages.appendChild(list);
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
  function openSettings() { if (!settings) { showStatus('Settings are unavailable. Restart Aether to retry.', true); return; } fillSettings(); scrim.classList.remove('hidden'); }
  async function closeSettings() {
    cancelShortcutRecording();
    try {
      await saveSettings();
      scrim.classList.add('hidden');
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
    syncAssistShortcutLabels();
    $('#s-status').textContent = statusText();
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
    await wingman.settingsSet(settings);
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
    shortcutBtn.classList.remove('recording');
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
    if (!key && /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(e.key)) key = e.key;
    if (!key) return { error: 'Use a letter, number, function key, arrow, or common navigation key.' };
    if (!parts.length && !/^F/.test(key)) return { error: 'Include Command/Ctrl, Alt, or Shift in the shortcut.' };
    parts.push(key);
    return { accelerator: parts.join('+') };
  }

  async function applyAssistShortcut(accelerator) {
    const wasRecording = recordingShortcut;
    recordingShortcut = false;
    shortcutBtn.classList.remove('recording');
    shortcutBtn.textContent = 'Saving…';
    let result;
    try {
      result = await wingman.shortcutAssistSet(accelerator);
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
    assistShortcut = result.accelerator;
    if (!settings.shortcuts) settings.shortcuts = {};
    settings.shortcuts.assist = assistShortcut;
    cancelShortcutRecording();
    setShortcutHint('Assist shortcut updated.', 'success');
  }

  shortcutBtn.addEventListener('click', () => {
    recordingShortcut = true;
    shortcutBtn.classList.add('recording');
    shortcutBtn.textContent = 'Press keys…';
    setShortcutHint('Press Escape to cancel.', '');
  });

  $('#shortcut-reset').addEventListener('click', () => applyAssistShortcut(DEFAULT_ASSIST_SHORTCUT));

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
    applyAssistShortcut(captured.accelerator);
  }, true);

  // ---- example conversation (matches the reference screenshot) ------------
  function showExample() {
    clearMessages();
    addUserBubble('What should I say?');
    const ai = document.createElement('div');
    ai.className = 'ai-text';
    ai.textContent = '“A discounted cash flow model values a company by projecting future free cash flows and discounting them to present value using the weighted average cost of capital.”';
    messages.appendChild(ai);
  }

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !scrim.classList.contains('hidden')) closeSettings();
    if (isCmdOrCtrl(e)) {
      if (e.key === ',') { e.preventDefault(); openSettings(); }
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
  function setIgnore(v) { if (v !== ignoring) { ignoring = v; wingman.setIgnoreMouse(v); } }
  document.addEventListener('mousemove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const overUI = !!(el && el.closest && el.closest('#toolbar, #panel-wrap, #settings-scrim, #onboard-scrim'));
    setIgnore(!overUI);
  });
  setIgnore(true); // start fully click-through; hovering the panel re-enables it

  // ---- onboarding / first-run tutorial -----------------------------------
  const obScrim = $('#onboard-scrim');
  const OB_STEPS = [
    {
      icon: '👋',
      title: 'Welcome to Aether',
      body: 'Aether is an AI copilot that floats over your screen. It can <strong>see your screen</strong>, <strong>hear your meetings</strong>, and help you answer questions or solve coding problems.<br><br>This quick guide gets you running in about a minute.'
    },
    ...(wingman.platform === 'darwin' ? [{
      icon: '🔐',
      title: 'Allow Aether to see & hear',
      body: 'Aether needs two macOS permissions. Click each button, turn <strong>Aether</strong> ON in the window that opens, then come back here.<ul><li><strong>Microphone</strong> — to hear you</li><li><strong>Screen Recording</strong> — to see your screen and hear meeting audio</li></ul>',
      buttons: [
        { label: 'Open Microphone settings', action: () => wingman.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone') },
        { label: 'Open Screen Recording settings', action: () => wingman.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') }
      ]
    }] : []),
    {
      icon: '🔑',
      title: 'Connect an AI provider',
      body: 'Choose an AI provider in Settings: a cloud API key, local <strong>Ollama</strong>, or a signed-in <strong>Claude/Codex CLI</strong>. For factual questions, Aether searches its bundled reference library and uses Tavily web search for current topics or library gaps; web search needs a separate Tavily key.<br><br>Meeting transcription can use a local Whisper model or an OpenAI/Gemini key. Ollama always transcribes locally.',
      buttons: [{ label: 'Open Aether Settings', action: () => { finishOnboard(); openSettings(); } }]
    },
    {
      icon: '🫥',
      title: 'Before you share your screen',
      body: wingman.platform === 'darwin'
        ? 'Aether asks macOS to exclude its window from captures, but some sharing apps may still show it. Click <strong>Hide for sharing</strong> before you share, then check the sharing app’s preview. Restore the window with <strong>⌘⌥⇧9</strong> after sharing.'
        : wingman.platform === 'win32'
          ? 'Aether asks Windows to exclude its window from captures, but some sharing apps may still show it. Click <strong>Hide for sharing</strong> before you share, then check the sharing app’s preview. Restore the window with <strong>Ctrl+Alt+Shift+9</strong> after sharing.'
          : 'Linux has no Aether window-exclusion support. Share only a selected window or tab when possible. Click <strong>Hide for sharing</strong> before sharing your whole display, and check the recipient preview. Restore the window with <strong>Ctrl+Alt+Shift+9</strong> after sharing.'
    },
{
      icon: '✨',
      title: 'You\'re all set',
      body: () => `How to use Aether:<ul><li>${shortcutKeycapsHtml(assistShortcut, 'kbd')} — <strong>Assist</strong> with whatever's on screen or being said</li><li><span class="kbd">⌘</span> <span class="kbd">⌥</span> <span class="kbd">⇧</span> <span class="kbd">9</span> — <strong>Show / hide</strong> Aether (works even when fully hidden)</li><li><span class="kbd">${cmdKey}</span> <span class="kbd">H</span> — solve a coding problem on screen</li><li>Click <strong>▢</strong> in the top bar to start listening to a meeting</li><li>Type a question and press <span class="kbd">↵</span></li></ul>Reopen this guide anytime by clicking the <strong>Aether logo</strong>. Change Assist's shortcut in <strong>Settings</strong>. Quit with <span class="kbd">${cmdKey}</span><span class="kbd">⇧</span><span class="kbd">X</span>.`
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
  function showOnboard() { obIndex = 0; renderOnboard(); obScrim.classList.remove('hidden'); setIgnore(false); }
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
  }
  $('#ob-next').addEventListener('click', () => { if (obIndex === OB_STEPS.length - 1) finishOnboard(); else { obIndex++; renderOnboard(); } });
  $('#ob-back').addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderOnboard(); } });
  $('#ob-skip').addEventListener('click', finishOnboard);
  $('#logo-btn').addEventListener('click', showOnboard);

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    try {
      const st = await wingman.captureState();
      if (st.active) await wingman.captureToggle(); // media tracks do not survive a renderer reload
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
    syncAssistShortcutLabels();
    smartBtn.classList.toggle('on', !!settings.smart);
    showExample();
    syncPlaceholder();
    if (!settings.onboarded) showOnboard();

  })();
})();
