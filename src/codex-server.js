const { spawn } = require('node:child_process');
const readline = require('node:readline');

// One long-lived `codex app-server` per Codex profile. Each request still runs in
// a fresh ephemeral thread (one screenshot, no growing history), so usage matches
// `codex exec`; only process startup and login are paid once.
const IDLE_MS = 5 * 60 * 1000;
const START_MS = 15000;
const servers = new Map();

function serverFault(message) { const error = new Error(message); error.serverFault = true; return error; }

function startServer(env) {
  const child = spawn('codex', ['app-server', '-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"'],
    { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let nextId = 0, dead = null, idle = null, busy = 0;
  const pending = new Map(), listeners = new Set();
  const die = error => {
    if (dead) return; dead = error; clearTimeout(idle);
    for (const p of pending.values()) p.reject(error);
    for (const listener of listeners) listener({ method: 'server/dead' });
    pending.clear(); child.kill('SIGTERM');
  };
  child.on('error', () => die(serverFault('codex app-server could not start')));
  child.on('close', () => die(serverFault('codex app-server exited')));
  child.stdin.on('error', () => {});
  // An idle warm server must never keep the host process alive; requests in flight do.
  const keepAlive = on => { for (const handle of [child, child.stdin, child.stdout]) on ? handle.ref?.() : handle.unref?.(); };
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && message.method) {
      // Approval or input requests: Aether never grants tools to the model.
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Not supported by Aether' } }) + '\n');
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const p = pending.get(message.id); pending.delete(message.id);
      if (message.error) p.reject(new Error(message.error.message || 'Codex request failed')); else p.resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (dead) { reject(dead); return; }
    const id = ++nextId; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const server = {
    get dead() { return dead; }, listeners, request, kill: () => die(serverFault('codex app-server stopped')),
    hold() { busy++; clearTimeout(idle); keepAlive(true); },
    release() { if (--busy === 0 && !dead) { keepAlive(false); idle = setTimeout(server.kill, IDLE_MS); idle.unref(); } }
  };
  const timer = setTimeout(() => die(serverFault('codex app-server did not start in time')), START_MS);
  server.ready = request('initialize', { clientInfo: { name: 'aether', title: 'Aether', version: '0.1.0' }, capabilities: null })
    .then(() => { clearTimeout(timer); child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n'); return server; },
      error => { clearTimeout(timer); die(error.serverFault ? error : serverFault(error.message)); throw dead; });
  return server;
}

async function codexServerTurn({ codexHome, env, model, instructions, text, imagePath, onToken = () => {}, signal, timeoutMs, maxOutput, cwd }) {
  let server = servers.get(codexHome);
  if (!server || server.dead) { server = startServer(env); servers.set(codexHome, server); }
  server.hold();
  try {
    await server.ready;
    if (signal?.aborted) throw new Error('Request cancelled');
    const { thread } = await server.request('thread/start', { cwd, model: model || null, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true, baseInstructions: instructions });
    let full = '', turnId = null, fail;
    const result = new Promise((resolve, reject) => {
      const finish = (error, value) => { server.listeners.delete(listener); clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
      const stop = error => { if (turnId) server.request('turn/interrupt', { threadId: thread.id, turnId }).catch(() => {}); finish(error); };
      const abort = () => stop(new Error('Request cancelled'));
      fail = finish;
      const timer = setTimeout(() => stop(new Error('Provider timed out')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      const listener = message => {
        if (message.method === 'server/dead') { finish(server.dead); return; }
        const params = message.params || {};
        if (params.threadId !== thread.id) return;
        if (message.method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.text) {
          const chunk = (full ? '\n\n' : '') + params.item.text;
          full += chunk;
          if (Buffer.byteLength(full) > maxOutput) { stop(new Error('Provider output is too large')); return; }
          onToken(chunk);
        }
        if (message.method === 'turn/completed') {
          if (params.turn?.status === 'completed' && full) finish(null, full);
          else finish(new Error(params.turn?.error?.message || 'Codex CLI request failed'));
        }
      };
      server.listeners.add(listener);
    });
    const input = [{ type: 'text', text, text_elements: [] }];
    if (imagePath) input.push({ type: 'localImage', path: imagePath });
    server.request('turn/start', { threadId: thread.id, input }).then(r => { turnId = r?.turn?.id; }, error => fail(error));
    try { return await result; }
    finally { server.request('thread/unsubscribe', { threadId: thread.id }).catch(() => {}); }
  } finally { server.release(); }
}

function stopCodexServer(codexHome) { servers.get(codexHome)?.kill(); servers.delete(codexHome); }

process.once('exit', () => { for (const server of servers.values()) server.kill(); });

module.exports = { codexServerTurn, stopCodexServer };
