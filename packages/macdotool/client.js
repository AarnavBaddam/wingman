const { spawn: nodeSpawn } = require('node:child_process');

const MAX_LINE = 80 * 1024 * 1024, ACK_MS = 150;
const abortError = () => { const error = new Error('Desktop action cancelled.'); error.name = 'AbortError'; return error; };

// One lazy `macdotool serve` daemon (newline-delimited JSON). call() mirrors run() in
// src/desktop-control.js: a promise only settles once the operation has really stopped, so
// cleanup cannot race input still in flight. shortcut: one daemon per client, so the first
// call's binary/env win; upgrade if two binaries must coexist.
function createClient({ binary, spawn = nodeSpawn } = {}) {
  let cur = null, nextId = 1;
  function start(command, env) {
    const child = spawn(binary || command, ['serve'], { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const s = { child, pending: new Map(), buf: '', dead: false };
    s.closed = new Promise(resolve => { s.done = resolve; });
    const kill = () => { s.dead = true; try { child.kill('SIGKILL'); } catch {} };
    s.kill = kill;
    const fail = error => { for (const e of s.pending.values()) e.failure ||= error; kill(); };
    const end = error => {
      s.dead = true; if (cur === s) cur = null;
      for (const e of [...s.pending.values()]) e.settle(() => e.reject(e.failure || error));
      s.done();
    };
    child.on('error', end);
    child.on('close', () => end(new Error('Desktop helper failed')));
    child.unref?.(); for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.unref?.();
    child.stdin.on('error', () => {}); child.stderr.resume(); child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      s.buf += chunk;
      let at;
      while ((at = s.buf.indexOf('\n')) >= 0) {
        const line = s.buf.slice(0, at); s.buf = s.buf.slice(at + 1);
        if (line.length > MAX_LINE) { fail(new Error('Desktop helper output exceeded limit')); return; }
        let reply;
        try { reply = JSON.parse(line); } catch { fail(new Error('Desktop helper protocol error')); return; }
        const e = s.pending.get(reply?.id);
        if (e) e.settle(() => reply.ok && !e.failure ? e.finish(reply.out) : e.reject(e.failure || (reply.cancelled ? abortError() : Object.assign(new Error(reply.error || 'Desktop helper failed'), { code: reply.code }))));
      }
      if (s.buf.length > MAX_LINE) fail(new Error('Desktop helper output exceeded limit'));
    });
    return s;
  }

  async function call(command, args, options = {}) {
    const { input, timeout, signal, maxBuffer, env } = options;
    if (signal?.aborted) throw abortError();
    while (cur?.dead) await cur.closed;
    cur ||= start(command, env);
    const s = cur, id = nextId++;
    return new Promise((resolve, reject) => {
      let timer, ack;
      const e = s.pending.set(id, {
        failure: null, reject,
        settle(fn) { clearTimeout(timer); clearTimeout(ack); signal?.removeEventListener('abort', abort); s.pending.delete(id); fn(); },
        finish(out) {
          const bytes = Buffer.from(typeof out === 'string' ? out : '', 'base64');
          if (maxBuffer && bytes.length > maxBuffer) reject(new Error('Desktop helper output exceeded limit')); else resolve({ stdout: bytes });
        }
      }).get(id);
      // Ask the daemon to stop, wait for its reply; SIGKILL it if it stays silent.
      const stop = error => {
        if (e.failure) return;
        e.failure = error;
        try { s.child.stdin.write(JSON.stringify({ cancel: id }) + '\n'); } catch {}
        ack = setTimeout(s.kill, ACK_MS);
      };
      const abort = () => stop(abortError());
      if (timeout) timer = setTimeout(() => stop(new Error('Desktop helper timed out')), timeout);
      signal?.addEventListener('abort', abort, { once: true });
      try { s.child.stdin.write(JSON.stringify({ id, argv: args, ...(input ? { input: String(input) } : {}) }) + '\n'); }
      catch (error) { s.kill(); e.failure ||= error; }
    });
  }
  return { call };
}

let shared;
module.exports = { createClient, call: (...args) => (shared ||= createClient()).call(...args) };
