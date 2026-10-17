const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const audioCode = renderer.slice(
  renderer.indexOf('  // Start getDisplayMedia directly'),
  renderer.indexOf("  wingman.on('llm:start'")
);

function audioStream(count = 1) {
  const tracks = Array.from({ length: count }, () => ({
    readyState: 'live',
    addEventListener(_event, callback) { this.onEnded = callback; },
    end() { this.readyState = 'ended'; this.onEnded?.(); },
    stop() { this.readyState = 'ended'; }
  }));
  return { getAudioTracks: () => tracks, getVideoTracks: () => [], getTracks: () => tracks };
}

function harness({ microphone, system }) {
  const listeners = {};
  const statuses = [];
  let toggles = 0;
  const active = new Set();
  const button = {
    classList: { contains: (name) => active.has(name), toggle: (name, on) => on ? active.add(name) : active.delete(name) },
    addEventListener: (_event, handler) => { button.click = handler; }
  };
  const dot = { classList: { toggle() {} } };
  const wingman = {
    on: (name, callback) => { listeners[name] = callback; },
    captureToggle: async () => { toggles++; const next = !active.has('active'); listeners['capture:state']({ active: next }); return next; },
    log() {}, micPcm() {}, systemPcm() {}
  };
  class AudioContext {
    audioWorklet = { addModule: async () => {} };
    destination = {};
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    close() { return Promise.resolve(); }
  }
  class AudioWorkletNode { port = {}; connect() {} disconnect() {} }
  const context = vm.createContext({
    $: (selector) => selector === '#stop-btn' ? button : dot,
    wingman, showStatus: (message) => statuses.push(message),
    navigator: { mediaDevices: { getUserMedia: microphone, getDisplayMedia: system } },
    AudioContext, AudioWorkletNode, MediaStream: class {}, Promise
  });
  vm.runInContext(audioCode, context);
  return { button, active, statuses, get toggles() { return toggles; } };
}

test('listening stays off when both audio permissions fail', async () => {
  const denied = async () => { throw new Error('denied'); };
  const audio = harness({ microphone: denied, system: denied });
  const { button, active, statuses } = audio;
  await button.click();
  assert.equal(active.has('active'), false);
  assert.equal(audio.toggles, 0);
  assert.match(statuses.at(-1), /could not start/i);
});

test('listening starts only after a usable track resolves and reports partial capture', async () => {
  let allowMic;
  const mic = new Promise((resolve) => { allowMic = resolve; });
  const { button, active, statuses } = harness({
    microphone: () => mic,
    system: async () => audioStream(0)
  });
  const starting = button.click();
  assert.equal(active.has('active'), false);
  allowMic(audioStream());
  await starting;
  assert.equal(active.has('active'), true);
  assert.match(statuses.at(-1), /microphone only/i);
  await button.click();
  assert.equal(active.has('active'), false);
});

test('system-only listening stops when its audio track ends', async () => {
  const systemAudio = audioStream();
  const { button, active, statuses } = harness({
    microphone: async () => { throw new Error('denied'); },
    system: async () => systemAudio
  });
  await button.click();
  assert.equal(active.has('active'), true);
  assert.match(statuses.at(-1), /meeting audio only/i);
  systemAudio.getAudioTracks()[0].end();
  assert.equal(active.has('active'), false);
  assert.match(statuses.at(-1), /capture ended/i);
});
