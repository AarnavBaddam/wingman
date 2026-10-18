const test = require('node:test');
const assert = require('node:assert/strict');
const { searchWeb, researchPrompt, getEvidence, validateGroundedAnswer, needsWebFollowup } = require('../src/research');

test('research uses a real search response and preserves numbered evidence', async () => {
  let request;
  const sources = await searchWeb('current weather in Chicago', 'secret', async (_url, options) => {
    request = options;
    return { ok: true, json: async () => ({ results: [
      { title: 'Forecast', url: 'https://example.com/forecast', content: 'High 60 F' },
      { title: 'Bad', url: 'javascript:alert(1)', content: 'ignore' }
    ] }) };
  });
  assert.equal(request.headers.authorization, 'Bearer secret');
  assert.equal(JSON.parse(request.body).query, 'current weather in Chicago');
  assert.deepEqual(sources.map(({ number, url }) => [number, url]), [[1, 'https://example.com/forecast']]);
  assert.match(researchPrompt(sources), /\[1\] Forecast/);
});

test('research fails closed without a key, results, or network', async () => {
  await assert.rejects(searchWeb('question', ''), /Tavily/);
  await assert.rejects(searchWeb('', 'secret'), /Type a research question/);
  await assert.rejects(searchWeb('question', 'secret', async () => ({ ok: true, json: async () => ({ results: [] }) })), /no usable sources/);
  await assert.rejects(searchWeb('question', 'secret', async () => { throw new Error('offline'); }), /failed to connect/);
});

test('local library is first, while current and thin evidence use the web', async () => {
  const collection = [{ title: 'Banach space', url: 'https://en.wikipedia.org/wiki/Banach_space', content: 'A'.repeat(700), words: new Set(['banach', 'space']), titleWords: new Set(['banach', 'space']) }];
  let requests = 0;
  const fetcher = async () => { requests++; return { ok: true, json: async () => ({ results: [{ title: 'Live', url: 'https://example.org/live', content: 'Current fact' }] }) }; };
  const local = await getEvidence('Banach space', 'secret', { collection, fetcher });
  assert.equal(local[0].origin, 'library');
  assert.equal(requests, 0);
  const current = await getEvidence('current Banach space research', 'secret', { collection, fetcher });
  assert.equal(current[0].origin, 'web');
  assert.equal(requests, 1);
  collection[0].content = 'Short';
  const thin = await getEvidence('Banach space', 'secret', { collection, fetcher });
  assert.equal(thin[0].origin, 'web');
  assert.equal(requests, 2);
});

test('research answers must cite retrieved sources or state uncertainty', () => {
  const sources = [{ number: 1 }];
  assert.equal(validateGroundedAnswer('The result is supported [1].', sources), 'The result is supported [1].');
  assert.equal(validateGroundedAnswer('The evidence is insufficient.', sources), 'The evidence is insufficient.');
  assert.throws(() => validateGroundedAnswer('The result is known.', sources), /without source citations/);
  assert.throws(() => validateGroundedAnswer('The result is known [2].', sources), /not retrieved/);
});

test('grouped and ranged citations validate every referenced source and normalize markers', () => {
  const sources = [1, 2, 3, 4, 5].map(number => ({ number }));
  assert.equal(validateGroundedAnswer('Supported [3, 2-4, 5].', sources), 'Supported [3][2][4][5].');
  for (const citation of ['[1, 99]', '[2–99]', '[1—99]', '[1, 99 and 2]', '[0, 1]', '[1-999999999999]', '[1,,2]', '[3-1]', '[-1]']) {
    assert.throws(() => validateGroundedAnswer('One claim [1]. Another claim ' + citation + '.', sources), /citation|not retrieved/);
  }
});

test('citation validation preserves math and code literals and uses actual source numbers', () => {
  const answer = 'The interval $[0,1]$, equation \\[x \\in [0,1]\\], and `[99]` are literals [1].';
  assert.equal(validateGroundedAnswer(answer, [{ number: 1 }]), answer);
  assert.throws(() => validateGroundedAnswer('Unsupported [2].', [{ number: 1 }, { number: 3 }]), /not retrieved/);
  assert.equal(validateGroundedAnswer('Supported [3].', [{ number: 1 }, { number: 3 }]), 'Supported [3].');
});

test('research prompt distinguishes retrieval date from evidence of currentness', () => {
  const prompt = researchPrompt([{ number: 1, title: 'Dated release', url: 'https://example.org/releases', content: 'A release from last month.' }]);
  assert.match(prompt, /retrieved on \d{4}-\d{2}-\d{2} UTC/);
  assert.match(prompt, /retrieval date does not establish/i);
  assert.match(prompt, /newest.*retrieved.*latest overall/i);
});

test('a narrower article is not sufficient local evidence for a general topic', async () => {
  const collection = ['Intrinsic DNA fluorescence', 'DNA'].map(title => ({
    title, url: `https://example.org/${encodeURIComponent(title)}`, content: 'A'.repeat(700),
    words: new Set(title.toLowerCase().split(' ')), titleWords: new Set(title.toLowerCase().split(' ')), origin: 'library'
  }));
  const exact = await getEvidence('Explain DNA', '', { collection });
  assert.deepEqual(exact.map(source => source.title), ['DNA']);
  collection.pop();
  await assert.rejects(getEvidence('Explain DNA', '', { collection }), /Tavily/);
});

test('explicit local uncertainty requests a single web follow-up', () => {
  assert.equal(needsWebFollowup('The supplied sources are insufficient.', [{ origin: 'library' }]), true);
  assert.equal(needsWebFollowup('The supplied sources are insufficient.', [{ origin: 'web' }]), false);
  assert.equal(needsWebFollowup('This is supported [1].', [{ origin: 'library' }]), false);
});
