const assert = require('node:assert/strict');
const test = require('node:test');
const { createLLM } = require('../src/llm');

test('response depth preserves fast and smart model selection', () => {
  for (const provider of ['openai', 'anthropic', 'gemini', 'nvidia', 'groq', 'ollama', 'claude-cli', 'codex-cli']) {
    const settings = {
      provider,
      apiKeys: { [provider]: 'test-key' },
      models: { [provider]: { fast: 'fast-model', smart: 'smart-model' } }
    };
    for (const [smart, model] of [[false, 'fast-model'], [true, 'smart-model'], ['deep', 'smart-model']]) {
      const llm = createLLM({ ...settings, smart });
      assert.equal(llm.model, model, `${provider}: ${smart}`);
      assert.equal(llm.ready, true);
    }
  }
});
