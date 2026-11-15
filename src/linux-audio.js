const { spawn } = require('node:child_process');

function startLinuxAudio(onData, onEnd) {
  // shortcut: binds the default output at startup; restart listening after changing outputs.
  const child = spawn('parec', [
    '--device=@DEFAULT_MONITOR@', '--raw', '--format=s16le', '--rate=16000',
    '--channels=1', '--latency-msec=100', '--client-name=Aether', '--stream-name=Meeting audio'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let resolveReady, ended = false, stopping = false, killTimer;
  let remainder = Buffer.alloc(0);
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const timer = setTimeout(stop, 3000);
  timer.unref();

  function stop() {
    if (ended || stopping) return;
    stopping = true;
    clearTimeout(timer);
    resolveReady(false);
    child.kill('SIGTERM');
    killTimer = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 1000);
    killTimer.unref();
  }
  function finish() {
    if (ended) return;
    ended = true;
    clearTimeout(timer); clearTimeout(killTimer);
    resolveReady(false);
    if (!stopping) onEnd();
  }
  child.stdout.on('data', chunk => {
    if (ended || stopping) return;
    const pcm = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
    const length = pcm.length - pcm.length % 2;
    remainder = pcm.subarray(length);
    if (!length) return;
    clearTimeout(timer);
    resolveReady(true);
    onData(pcm.subarray(0, length));
  });
  child.stderr.resume();
  child.once('error', finish);
  child.once('close', finish);
  return { ready, stop };
}

module.exports = { startLinuxAudio };
