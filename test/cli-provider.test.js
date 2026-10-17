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
console.log(JSON.stringify({type:'turn.completed'}));
`;
    fs.writeFileSync(path.join(bin, 'claude'), claude, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'codex'), codex, { mode: 0o755 });
    process.env.PATH = bin + path.delimiter + originalPath;
    const tokens = [];
    assert.equal(await streamCLI('claude-cli', { system: 'private résumé', turns: [{ role: 'user', text: 'Hi' }], imageDataUrl: png, onToken: (t) => tokens.push(t) }), 'hello');
    assert.deepEqual(tokens, ['hel', 'lo']);
    assert.equal(await streamCLI('codex-cli', { system: 'Answer briefly', turns: [{ role: 'user', text: 'Hi' }], imageDataUrl: png, onToken: (t) => tokens.push(t) }), 'seen');
    assert.equal(tokens.at(-1), 'seen');
  } finally {
    process.env.PATH = originalPath;
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
