const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { profileEnv, signedOutError } = require('./codex-login');

const MAX_OUTPUT = 2 * 1024 * 1024;
const TIMEOUT_MS = 120000;

function imageParts(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new Error('Unsupported screenshot format');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('Screenshot is empty or too large');
  return { mime: match[1], bytes };
}

function run(binary, args, input, cwd, provider, onToken, signal, env) {
  if (signal?.aborted) return Promise.reject(new Error('Request cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let full = '';
    let final = '';
    let completed = false;
    let failure = null;
    let size = 0;
    const stop = (error) => { failure = error; child.kill('SIGTERM'); };
    const abort = () => stop(new Error('Request cancelled'));
    const timer = setTimeout(() => stop(new Error('Provider timed out')), TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });

    function event(line) {
      if (!line) return;
      let item;
      try { item = JSON.parse(line); }
      catch { stop(new Error('Invalid provider response')); return; }
      if (provider === 'claude-cli') {
        if (item.type === 'stream_event' && item.event?.delta?.type === 'text_delta') {
          const text = item.event.delta.text;
          full += text;
          onToken(text);
        }
        if (item.type === 'result') {
          final = item.result || '';
          completed = item.subtype === 'success' && !item.is_error;
          if (!completed) failure = new Error('Claude CLI request failed');
        }
      } else {
        if (item.type === 'item.completed' && item.item?.type === 'agent_message' && item.item.text) {
          const text = (full ? '\n\n' : '') + item.item.text;
          full += text;
          onToken(text);
        }
        if (item.type === 'turn.completed') completed = true;
        if (item.type === 'turn.failed' || item.type === 'error') failure = new Error(item.message || item.error?.message || 'Codex CLI request failed');
      }
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_OUTPUT) { stop(new Error('Provider output is too large')); return; }
      output += chunk;
      let newline;
      while ((newline = output.indexOf('\n')) !== -1) {
        event(output.slice(0, newline));
        output = output.slice(newline + 1);
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', (error) => { failure = new Error(error.code === 'ENOENT' ? `${binary} CLI was not found in PATH` : `${binary} CLI could not start`); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (output) event(output);
      if (failure) reject(failure);
      else if (code !== 0 || !completed) reject(new Error(`${binary} CLI exited without a response (${code}); check its login and model`));
      else {
        if (provider === 'claude-cli' && !full && final) { full = final; onToken(final); }
        resolve(full);
      }
    });
    child.stdin.end(input);
  });
}

async function streamCLI(provider, { model, system, turns, imageDataUrl, onToken = () => {}, signal, codexHome }) {
  const prompt = turns.map((turn) => `${turn.role}: ${turn.text}`).join('\n\n');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-llm-'));
  try {
    if (provider === 'claude-cli') {
      const content = [{ type: 'text', text: `Instructions:\n${system}\n\n${prompt}` }];
      if (imageDataUrl) {
        const image = imageParts(imageDataUrl);
        content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.bytes.toString('base64') } });
      }
      const message = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
      const input = JSON.stringify(message) + '\n';
      if (Buffer.byteLength(input) > 10 * 1024 * 1024) throw new Error('Screenshot exceeds Claude input limit');
      const args = ['-p', '--restricted', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
      if (model) args.push('--model', model);
      return await run('claude', args, input, directory, provider, onToken, signal);
    }
    if (provider === 'codex-cli') {
      const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', directory];
      let env;
      if (codexHome) {
        env = profileEnv(codexHome);
        args.push('-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"');
      }
      if (model) args.push('--model', model);
      if (imageDataUrl) {
        const image = imageParts(imageDataUrl);
        const filename = path.join(directory, 'screenshot.' + image.mime.split('/')[1]);
        fs.writeFileSync(filename, image.bytes, { mode: 0o600 });
        args.push('--image', filename);
      }
      const instructions = `Answer only from the supplied prompt and image. Do not use tools or inspect files.\n\nInstructions:\n${system}`;
      // ponytail: the warm app-server only runs on Aether's own Codex profile. It has no
      // --ignore-user-config, so the default profile keeps the isolated `codex exec` path.
      if (codexHome) {
        try {
          return await require('./codex-server').codexServerTurn({ codexHome, env, model, instructions, text: prompt, onToken, signal,
            imagePath: args.includes('--image') ? args[args.indexOf('--image') + 1] : null, timeoutMs: TIMEOUT_MS, maxOutput: MAX_OUTPUT, cwd: directory });
        } catch (error) {
          if (!error.serverFault || signal?.aborted) throw signedOutError(error);
        }
      }
      args.push('-');
      try { return await run('codex', args, `${instructions}\n\n${prompt}\n`, directory, provider, onToken, signal, env); }
      catch (error) { throw codexHome ? signedOutError(error) : error; }
    }
    throw new Error('Unknown CLI provider: ' + provider);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { streamCLI };
