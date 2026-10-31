const { spawn, execFile } = require('node:child_process');

// Sign-in for Aether's own Codex profile. OpenAI can end a ChatGPT session at any
// time (refresh_token_invalidated), so re-login has to be one click, not a terminal trip.
const FLAGS = ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"'];
const LOGIN_MS = 10 * 60 * 1000;
const SIGNED_OUT = /not logged in|log in again|session has ended|unauthori[sz]ed|\b401\b|token_(?:revoked|expired)|refresh_token/i;
let active = null;

function profileEnv(codexHome) {
  const env = { ...process.env, CODEX_HOME: codexHome };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CODEX_ACCESS_TOKEN;
  return env;
}

function codexLoginStatus(codexHome) {
  return new Promise(resolve => execFile('codex', ['login', 'status', ...FLAGS], { env: profileEnv(codexHome), timeout: 15000 },
    error => resolve(!error)));
}

// Runs `codex login` with the browser suppressed and hands its sign-in URL to openUrl,
// so the caller can show it in a window that never sees the user's other ChatGPT account.
function startCodexLogin(codexHome, openUrl) {
  active?.kill('SIGTERM'); // a second click restarts; codex holds port 1455 while waiting
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['login', ...FLAGS], { env: { ...profileEnv(codexHome), BROWSER: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    active = child;
    let output = '', opened = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), LOGIN_MS);
    const read = chunk => {
      output = (output + chunk).slice(-8192);
      const url = !opened && /https:\/\/auth\.openai\.com\/\S+/.exec(output)?.[0];
      if (url) { opened = true; openUrl(url); }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', error => reject(new Error(error.code === 'ENOENT' ? 'codex CLI was not found in PATH' : 'codex login could not start')));
    child.on('close', code => {
      clearTimeout(timer);
      if (active === child) active = null;
      // codex exits 0 even when killed mid-login, so trust the saved login, not the exit code.
      const fail = () => reject(new Error('Codex sign-in did not finish'));
      if (code !== 0) fail(); else codexLoginStatus(codexHome).then(ok => ok ? resolve() : fail());
    });
  });
}

function cancelCodexLogin() { active?.kill('SIGTERM'); }

function signedOutError(error) {
  if (!SIGNED_OUT.test(error?.message || '')) return error;
  const friendly = new Error('Codex is signed out. Open Settings and press "Sign in to Codex".');
  friendly.codexSignedOut = true;
  return friendly;
}

module.exports = { profileEnv, codexLoginStatus, startCodexLogin, cancelCodexLogin, signedOutError };
