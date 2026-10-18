const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAutoAction, createAutoMode, AUTO_SYSTEM } = require('../src/auto-mode');
const bounds = { width: 800, height: 600, sourceIds: [3] };
const click = { type: 'click', x: 20, y: 30, label: 'Name field', intent: 'focus' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function harness(actions, overrides = {}) {
  const calls = [], updates = [];
  let index = 0;
  const engine = createAutoMode({
    capture: async signal => { calls.push('capture'); assert.equal(signal.aborted, false); return { imageDataUrl: 'data:image/png;base64,AA==', width: 800, height: 600 }; },
    decide: async () => { calls.push('decide'); return JSON.stringify(actions[index++]); },
    execute: async action => calls.push(action.type),
    research: async () => [{ number: 3, title: 'Evidence', url: 'https://example.com', content: 'Fact', origin: 'web' }],
    onUpdate: update => updates.push(update), delay: 0, ...overrides
  });
  return { engine, calls, updates };
}
test('parser accepts only strict bounded action objects and fenced JSON', () => {
  assert.deepEqual(parseAutoAction('```json\n' + JSON.stringify(click) + '\n```', bounds), click);
  for (const action of [
    { ...click, x: 800 }, { ...click, y: -1 }, { ...click, x: 1.5 },
    { ...click, intent: 'submit' }, { ...click, label: 'Send message' }, { ...click, label: 'Confirm order' },
    { ...click, key: 'Enter' }, { type: 'key', key: 'Enter' },
    { type: 'scroll', x: 1, y: 1, amount: 6, label: 'Down' },
    { type: 'scroll', x: 1, y: 1, amount: 0, label: 'Down' },
    { type: 'type', text: 'line\nnext', label: 'Answer', origin: 'user' },
    { type: 'type', text: 'é', label: 'Answer', origin: 'user' },
    { type: 'type', text: 'Fact', label: 'Answer', origin: 'sources', citations: [4] },
    { type: 'type', text: 'Fact', label: 'Answer', origin: 'sources' },
    { type: 'type', text: 'Fact', label: 'Answer', origin: 'calculation', citations: [3] }
  ]) assert.throws(() => parseAutoAction(JSON.stringify(action), bounds));
  for (const text of ['Here is JSON: ' + JSON.stringify(click), '[]', 'null', '{}', JSON.stringify(click) + '{}']) {
    assert.throws(() => parseAutoAction(text, bounds));
  }
  assert.deepEqual(parseAutoAction(JSON.stringify({ type: 'type', text: 'Fact', label: 'Answer', origin: 'sources', citations: [3] }), bounds).citations, [3]);
  assert.match(AUTO_SYSTEM, /untrusted/i);
});
test('runs one action at a time, observes after every action, and ends at review', async () => {
  const h = harness([click, { type: 'type', text: 'private value', origin: 'user', label: 'Name field' },
    { type: 'scroll', x: 20, y: 30, amount: -2, label: 'Down' }, { type: 'done', message: 'Ready for review.' }]);
  await h.engine.run('Fill the draft');
  assert.deepEqual(h.calls, ['capture', 'decide', 'click', 'capture', 'decide', 'type', 'capture', 'decide', 'scroll', 'capture', 'decide']);
  assert.equal(h.updates.at(-1).status, 'done');
  assert.equal(h.engine.active, false);
  assert.ok(h.updates.every(u => !u.message.includes('private value')));
});
test('research supplies real source IDs and history to subsequent decisions', async () => {
  const seen = [], actions = [{ type: 'research', query: 'A factual question' },
    { ...click, label: 'Answer' },
    { type: 'type', text: 'Fact', label: 'Answer', origin: 'sources', citations: [1] }, { type: 'done', message: 'Review' }];
  const h = harness([], { decide: async context => { seen.push(context); return JSON.stringify(actions.shift()); } });
  await h.engine.run('Answer the question');
  assert.equal(seen[1].sources[0].number, 1);
  assert.equal(seen[1].history[0].type, 'research');
  assert.ok(h.updates.some(u => u.status === 'researching'));
});
test('stop cancels a pending decision and late results cannot execute', async () => {
  const gate = deferred(), entered = deferred();
  const h = harness([], { decide: async () => { entered.resolve(); return gate.promise; } });
  const run = h.engine.run('Fill draft');
  await entered.promise;
  await assert.rejects(h.engine.run('Concurrent run'), /already|active|running/i);
  h.engine.stop();
  await run;
  gate.resolve(JSON.stringify(click));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!h.calls.includes('click'));
  assert.equal(h.updates.at(-1).status, 'stopped');
});
test('wall timeout aborts even a non-cooperative dependency', async () => {
  const h = harness([], { decide: () => new Promise(() => {}), maxDurationMs: 15 });
  await h.engine.run('Wait');
  assert.equal(h.updates.at(-1).status, 'paused');
  assert.equal(h.engine.active, false);
});
test('bounds steps, pauses repeated actions, and handles missing input without execution', async () => {
  const repeated = harness([click, click, click]);
  await repeated.engine.run('Fill draft');
  assert.equal(repeated.calls.filter(x => x === 'click').length, 2);
  assert.equal(repeated.updates.at(-1).status, 'paused');
  const bounded = harness([click], { maxSteps: 1 });
  await bounded.engine.run('Fill draft');
  assert.equal(bounded.updates.at(-1).status, 'paused');
  assert.equal(bounded.calls.filter(x => x === 'capture').length, 2);
  const missing = harness([{ type: 'need_input', message: 'Please provide your name.' }]);
  await missing.engine.run('Fill draft');
  assert.equal(missing.updates.at(-1).status, 'paused');
  assert.deepEqual(missing.calls, ['capture', 'decide']);
});
test('external abort stops, errors propagate with exactly one error update, invalid goals never start', async () => {
  const controller = new AbortController(); controller.abort();
  const h = harness([]); await h.engine.run('Draft', { signal: controller.signal });
  assert.deepEqual(h.calls, []); assert.equal(h.updates.at(-1).status, 'stopped');
  const broken = harness([], { capture: async () => { throw new Error('capture failed'); } });
  await assert.rejects(broken.engine.run('Draft'), /capture failed/);
  assert.equal(broken.updates.filter(u => u.status === 'error').length, 1);
  for (const goal of ['', ' ', 'x'.repeat(4001), null]) await assert.rejects(broken.engine.run(goal));
});

test('abort cancels the action delay before any further model request', async () => {
  const executed = deferred();
  const h = harness([click], { delay: 300, execute: async () => { executed.resolve(); } });
  const run = h.engine.run('Fill draft');
  await executed.promise;
  h.engine.stop();
  await run;
  assert.equal(h.updates.at(-1).status, 'stopped');
  assert.equal(h.calls.filter(x => x === 'decide').length, 1);
});

test('research keeps stable session IDs when separate queries reuse provider source numbers', async () => {
  const seen = [];
  const actions = [
    { type: 'research', query: 'Query A' },
    { ...click, label: 'First answer' },
    { type: 'type', text: 'Answer A', label: 'First answer', origin: 'sources', citations: [1] },
    { type: 'research', query: 'Query B' },
    { ...click, label: 'Second answer' },
    { type: 'type', text: 'Answer B', label: 'Second answer', origin: 'sources', citations: [2] },
    { type: 'research', query: 'Query A again' },
    { type: 'done', message: 'Review draft' }
  ];
  const h = harness([], {
    decide: async context => { seen.push(context); return JSON.stringify(actions.shift()); },
    research: async query => [{ number: 1, title: query, url: query === 'Query B' ? 'https://example.com/b' : 'https://example.com/a', content: query, origin: 'web' }]
  });
  await h.engine.run('Answer two questions');
  assert.deepEqual(seen[4].sources.map(({ number, url }) => ({ number, url })), [
    { number: 1, url: 'https://example.com/a' }, { number: 2, url: 'https://example.com/b' }
  ]);
  assert.equal(seen[4].sources[0].content, 'Query A');
  assert.deepEqual(seen[7].sources.map(source => source.number), [1, 2]);
  assert.equal(seen[7].history[2].citations[0], 1);
  assert.equal(seen[7].history[5].citations[0], 2);
});

test('research pauses at the source cap without evicting cited evidence', async () => {
  const prior = Array.from({ length: 20 }, (_, index) => ({ number: index + 1, title: `Source ${index}`, url: `https://example.com/${index}`, content: 'Fact', origin: 'web' }));
  let count = 0;
  const h = harness([
    { type: 'research', query: 'First batch' },
    { ...click, label: 'Answer' },
    { type: 'type', text: 'Fact', label: 'Answer', origin: 'sources', citations: [1] },
    { type: 'research', query: 'Second batch' }
  ], { research: async () => ++count === 1 ? prior : [{ ...prior[0], url: 'https://example.com/new' }] });
  await h.engine.run('Gather evidence');
  const final = h.updates.at(-1);
  assert.equal(final.status, 'paused');
  assert.match(final.message, /source limit/i);
  assert.equal(final.sources.length, 20);
  assert.equal(final.sources[0].url, prior[0].url);
  assert.equal(final.sources[0].number, 1);
});

test('rejects unfocused typing, blocks premature done, and recovers with a matching focus click', async () => {
  const executed = [], contexts = [];
  const result = { type: 'type', text: '42', origin: 'calculation', label: 'Result' };
  const actions = [
    click, { type: 'type', text: 'Aether QA', origin: 'user', label: 'Name field' },
    { ...click, label: 'Blue', intent: 'select' },
    { type: 'scroll', x: 20, y: 30, amount: 4, label: 'Form' }, result,
    { type: 'done', message: 'Ready' }, { ...click, label: ' result ' }, result,
    { type: 'done', message: 'Verified draft ready' }
  ];
  const h = harness([], { decide: async context => { contexts.push(context); return JSON.stringify(actions.shift()); }, execute: async action => executed.push(action) });
  await h.engine.run('Fill draft');
  assert.deepEqual(executed.map(action => action.type), ['click', 'type', 'click', 'scroll', 'click', 'type']);
  assert.equal(executed.filter(action => action.text === '42').length, 1);
  assert.equal(contexts[5].history.at(-1).type, 'feedback');
  assert.match(contexts[5].history.at(-1).message, /Typing was not performed/);
  assert.equal(contexts[6].history.at(-1).type, 'feedback');
  assert.equal(h.updates.filter(update => update.status === 'done').length, 1);
  assert.equal(h.calls.filter(call => call === 'capture').length, 9);
});

test('scroll, selection, and typing each consume the previous field focus', async () => {
  const typed = { type: 'type', text: 'draft', origin: 'user', label: 'Name field' };
  for (const intervening of [
    { type: 'scroll', x: 20, y: 30, amount: 1, label: 'Form' },
    { ...click, intent: 'select' }, typed
  ]) {
    const executed = [];
    const h = harness([click, intervening, typed, { type: 'need_input', message: 'Review needed' }], { execute: async action => executed.push(action) });
    await h.engine.run('Fill draft');
    assert.equal(executed.filter(action => action.type === 'type').length, intervening.type === 'type' ? 1 : 0);
    assert.ok(h.updates.some(update => update.status === 'deciding' && /focus/i.test(update.message)));
  }
});


test('sensitive input labels are rejected and pause without typing', async () => {
  for (const label of ['Password', 'Passcode', 'OTP', 'API key', 'Access token', 'Creditcard', 'Credit card', 'CVV']) {
    const action = { type: 'type', text: 'private', origin: 'user', label };
    assert.throws(() => parseAutoAction(JSON.stringify(action), bounds), /Sensitive fields/);
    const h = harness([{ ...click, label }, action]);
    await h.engine.run('Fill draft');
    assert.equal(h.updates.at(-1).status, 'paused');
    assert.ok(!h.calls.includes('type'));
  }
});

test('pending input labels prevent ambiguous alias typing before any duplicate input', async () => {
  const executed = [], contexts = [];
  const result = { type: 'type', text: '42', label: 'Result', origin: 'calculation' };
  const actions = [result, { ...click, label: 'Result field' }, { ...result, label: 'Result field' },
    { type: 'done', message: 'Ready' }, { ...click, label: 'Result' }, result, { type: 'done', message: 'Ready' }];
  const h = harness([], { decide: async context => { contexts.push(context); return JSON.stringify(actions.shift()); }, execute: async action => executed.push(action) });
  await h.engine.run('Fill Result');
  assert.deepEqual(executed.filter(action => action.type === 'type'), [result]);
  assert.match(contexts[1].history.at(-1).message, /Outstanding field labels: \["Result"\]/);
  assert.match(contexts[3].history.at(-1).message, /Outstanding field labels: \["Result"\]/);
  assert.match(contexts[4].history.at(-1).message, /Outstanding field labels: \["Result"\]/);
  assert.equal(h.updates.at(-1).status, 'done');
});
