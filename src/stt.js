// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
const { pcmToWav } = require('./wav');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const LOCAL_TIMEOUT_MS = 120000;
const LOCAL_OUTPUT_BYTES = 64 * 1024;

async function transcribeLocal(wav, modelPath) {
  if (!modelPath || typeof modelPath !== 'string' || !path.isAbsolute(modelPath)) {
    throw new Error('Set an absolute local Whisper model path in Settings');
  }
  try {
    if (!fs.statSync(modelPath).isFile()) throw new Error();
  } catch {
    throw new Error('Local Whisper model file is unavailable');
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-stt-'));
  const file = path.join(dir, 'audio.wav');
  try {
    fs.writeFileSync(file, wav, { mode: 0o600, flag: 'wx' });
    return await new Promise((resolve, reject) => {
      const child = spawn('whisper-cli', ['-np', '-nt', '-m', modelPath, '-f', file], {
        shell: false, stdio: ['ignore', 'pipe', 'ignore']
      });
      const chunks = [];
      let bytes = 0;
      let failure = null;
      const timer = setTimeout(() => { failure = 'Local transcription timed out'; child.kill('SIGKILL'); }, LOCAL_TIMEOUT_MS);
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > LOCAL_OUTPUT_BYTES) {
          failure = 'Local transcription output exceeded the limit';
          child.kill('SIGKILL');
        } else {
          chunks.push(chunk);
        }
      });
      child.on('error', e => { failure = e.code === 'ENOENT' ? 'whisper-cli is unavailable' : 'Local transcription failed'; });
      child.on('close', code => {
        clearTimeout(timer);
        if (failure || code !== 0) reject(new Error(failure || 'Local transcription failed'));
        else resolve(Buffer.concat(chunks).toString('utf8').trim());
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function transcribeOpenAI(apiKey, wav, model) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({ file, model: model || 'whisper-1' });
  return (res.text || '').trim();
}

async function transcribeGemini(apiKey, wav) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
    ] }]
  });
  return ((res && res.text) || '').trim();
}

function createSTT(settings) {
  const keys = settings.apiKeys || {};
  const chain = [];
  if (settings.sttProvider === 'local' || settings.provider === 'ollama') {
    chain.push({ p: 'local', fn: (wav) => transcribeLocal(wav, settings.whisperModelPath) });
  } else {
    if (keys.openai) chain.push({ p: 'openai', fn: (wav) => transcribeOpenAI(keys.openai, wav, settings.sttModel) });
    if (keys.gemini) chain.push({ p: 'gemini', fn: (wav) => transcribeGemini(keys.gemini, wav) });
  }

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    async transcribe(pcm) {
      if (!chain.length || !pcm || pcm.length < 3200) return { text: '' };
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        try {
          const text = await c.fn(wav);
          return { text, provider: c.p };
        } catch (e) {
          lastErr = { status: e && e.status, code: e && e.code, message: (e && e.message) || String(e), provider: c.p };
        }
      }
      return { text: '', error: lastErr };
    }
  };
}

module.exports = { createSTT };
