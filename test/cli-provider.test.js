const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { streamCLI } = require('../src/cli-provider');
const { createLLM } = require('../src/llm');

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/sZkAAAAASUVORK5CYII=';

test('keyless providers are ready with the expected model requirement', () => {
  const settings = { apiKeys: {}, models: { ollama: { fast: 'local-vision' }, 'claude-cli': {}, 'codex-cli': {} }, smart: false };
  assert.equal(createLLM({ ...settings, provider: 'ollama' }).ready, true);
  assert.equal(createLLM({ ...settings, provider: 'claude-cli' }).ready, true);
  assert.equal(createLLM({ ...settings, provider: 'codex-cli' }).ready, true);
  assert.equal(createLLM({ ...settings, provider: 'openai' }).ready, false);
});

test('CLI adapters stream text and pass screenshots without exposing tool access', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-cli-test-'));
  const originalPath = process.env.PATH;
  try {
    const claude = `#!/usr/bin/env node
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const args = process.argv.slice(2);
const valid = args.includes('--restricted') && args.includes('--strict-mcp-config') && args[args.indexOf('--tools') + 1] === '' && !args.includes('private résumé') && input.message.content.some(x => x.type === 'image' && x.source.media_type === 'image/png') && input.message.content.some(x => x.type === 'text' && x.text.includes('private résumé'));
if (!valid) process.exit(2);
for (const text of ['hel', 'lo']) console.log(JSON.stringify({type:'stream_event',event:{delta:{type:'text_delta',text}}}));
console.log(JSON.stringify({type:'result',subtype:'success',result:'hello'}));
`;
    const codex = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const image = args[args.indexOf('--image') + 1];
if (!args.includes('read-only') || !args.includes('--ephemeral') || !fs.existsSync(image)) process.exit(2);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'seen'}}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'  next message  '}}));
console.log(JSON.stringify({type:'turn.completed'}));
`;
    fs.writeFileSync(path.join(bin, 'claude'), claude, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'codex'), codex, { mode: 0o755 });
    process.env.PATH = bin + path.delimiter + originalPath;
    const tokens = [];
    assert.equal(await streamCLI('claude-cli', { system: 'private résumé', turns: [{ role: 'user', text: 'Hi' }], imageDataUrl: png, onToken: (t) => tokens.push(t) }), 'hello');
    assert.deepEqual(tokens, ['hel', 'lo']);
    assert.equal(await streamCLI('codex-cli', { system: 'Answer briefly', turns: [{ role: 'user', text: 'Hi' }], imageDataUrl: png, onToken: (t) => tokens.push(t) }), 'seen\n\n  next message  ');
    assert.equal(tokens.slice(2).join(''), 'seen\n\n  next message  ');
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('isolated Codex forwards its account home without changing default or Claude authentication', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-cli-account-test-'));
  const names = ['PATH', 'CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const inherited = { CODEX_HOME: path.join(bin, 'default-profile'), OPENAI_API_KEY: 'fake-openai', CODEX_API_KEY: 'fake-codex', CODEX_ACCESS_TOKEN: 'fake-token' };
  try {
    const script = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'app-server') process.exit(1); // exercise the exec fallback
fs.readFileSync(0, 'utf8');
const text = JSON.stringify({ args: process.argv.slice(2), env: Object.fromEntries(['CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'].map(name => [name, process.env[name] ?? null])) });
if (process.argv[1].endsWith('claude')) {
  console.log(JSON.stringify({type:'result',subtype:'success',result:text}));
} else {
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
  console.log(JSON.stringify({type:'turn.completed'}));
}
`;
    for (const binary of ['codex', 'claude']) fs.writeFileSync(path.join(bin, binary), script, { mode: 0o755 });
    Object.assign(process.env, inherited, { PATH: bin + path.delimiter + original.PATH });
    const settings = { provider: 'codex-cli', models: { 'codex-cli': {} }, apiKeys: {}, smart: false };
    const params = { system: 'Answer briefly', turns: [{ role: 'user', text: 'Hi' }] };
    const defaultResult = JSON.parse(await createLLM(settings).stream(params));
    assert.deepEqual(defaultResult.env, inherited);
    assert.ok(!defaultResult.args.includes('cli_auth_credentials_store="file"'));
    assert.ok(!defaultResult.args.includes('forced_login_method="chatgpt"'));

    const codexHome = path.join(bin, 'separate-profile');
    const isolated = JSON.parse(await createLLM({ ...settings, codexHome }).stream(params));
    assert.deepEqual(isolated.env, { CODEX_HOME: codexHome, OPENAI_API_KEY: null, CODEX_API_KEY: null, CODEX_ACCESS_TOKEN: null });
    for (const flag of ['cli_auth_credentials_store="file"', 'forced_login_method="chatgpt"']) {
      assert.equal(isolated.args[isolated.args.indexOf(flag) - 1], '-c');
    }
    assert.deepEqual(Object.fromEntries(Object.keys(inherited).map(name => [name, process.env[name]])), inherited);

    const claude = JSON.parse(await streamCLI('claude-cli', { ...params, codexHome }));
    assert.deepEqual(claude.env, inherited);
    assert.ok(!claude.args.includes('forced_login_method="chatgpt"'));
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('CLI adapter cancels the child process', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-cli-test-'));
  const originalPath = process.env.PATH;
  try {
    fs.writeFileSync(path.join(bin, 'claude'), '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o755 });
    process.env.PATH = bin + path.delimiter + originalPath;
    const controller = new AbortController();
    const pending = streamCLI('claude-cli', { system: 'Answer briefly', turns: [{ role: 'user', text: 'Hi' }], signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /cancelled/);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('Codex profile requests reuse one warm app-server with fresh threads, and fall back to exec when it dies', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-codex-server-'));
  const log = path.join(bin, 'log');
  const originalPath = process.env.PATH;
  const codex = `#!/usr/bin/env node
const fs = require('fs'), log = ${JSON.stringify(log)};
if (process.argv[2] !== 'app-server') { fs.appendFileSync(log, 'exec\\n'); process.stdin.resume(); process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'from exec' } })); console.log(JSON.stringify({ type: 'turn.completed' })); }); return; }
if (fs.existsSync(log + '.broken')) process.exit(1);
fs.appendFileSync(log, 'server\\n'); let threads = 0;
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line), send = o => process.stdout.write(JSON.stringify(o) + '\\n');
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'thread/start') { fs.appendFileSync(log, 'thread ' + m.params.ephemeral + ' ' + m.params.sandbox + ' ' + m.params.baseInstructions.includes('Be brief') + '\\n'); send({ id: m.id, result: { thread: { id: 't' + ++threads } } }); }
  if (m.method === 'turn/start') { const threadId = m.params.threadId; fs.appendFileSync(log, 'image ' + m.params.input.some(i => i.type === 'localImage') + '\\n');
    send({ id: m.id, result: { turn: { id: 'u1' } } });
    send({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', text: 'answer ' + threadId } } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: 'u1', status: 'completed' } } }); }
});`;
  try {
    fs.writeFileSync(path.join(bin, 'codex'), codex, { mode: 0o755 });
    process.env.PATH = bin + path.delimiter + originalPath;
    const params = { system: 'Be brief', turns: [{ role: 'user', text: 'Hi' }], imageDataUrl: png, codexHome: path.join(bin, 'profile') };
    assert.equal(await streamCLI('codex-cli', params), 'answer t1');
    assert.equal(await streamCLI('codex-cli', params), 'answer t2');
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['server', 'thread true read-only true', 'image true', 'thread true read-only true', 'image true']);
    fs.writeFileSync(log + '.broken', '');
    assert.equal(await streamCLI('codex-cli', { ...params, codexHome: path.join(bin, 'other-profile') }), 'from exec');
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1), 'exec');
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
