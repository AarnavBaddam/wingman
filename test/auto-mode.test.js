const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAutoAction, createAutoMode, AUTO_SYSTEM } = require('../src/auto-mode');
const bounds = { width: 800, height: 600, sourceIds: [3] };
const click = { type: 'click', x: 20, y: 30, label: 'Name field', intent: 'focus' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('native dropdown options can be selected after inspection at the same point', async () => {
  const inspect = { ...click, intent: 'select', label: 'Sequence definition' };
  const choose = { ...inspect, option: 'recursive' };
  assert.deepEqual(parseAutoAction(JSON.stringify(choose), bounds), choose);
  for (const patch of [{ intent: 'submit' }, { clicks: 2 }, { option: '' }]) {
    assert.throws(() => parseAutoAction(JSON.stringify({ ...choose, ...patch }), bounds));
  }
  const contexts = [], actions = [inspect, choose, { type: 'done', message: 'Review' }];
  const h = harness([], { decide: async c => { contexts.push(c); return JSON.stringify(actions.shift()); },
    execute: async a => { h.calls.push(a.type); return a.option ? undefined : { dropdown: ['explicit', 'recursive'] }; } });
  await h.engine.run('Choose recursive');
  assert.equal(h.calls.filter(c => c === 'click').length, 2);
  assert(contexts[1].history.some(a => a.type === 'feedback' && /recursive/.test(a.message)));
});
test('drag accepts bounded endpoints and rejects malformed destinations', () => {
  const drag = { type: 'drag', x: 100, y: 100, toX: 300, toY: 400, label: 'Weight to acts on car' };
  assert.deepEqual(parseAutoAction(JSON.stringify(drag), bounds), drag);
  for (const patch of [{ toX: 800 }, { toY: -1 }, { toX: 1.5 }, { toY: null }, { x: -1 }, { label: '' }, { label: 'Drag to Submit' }, { script: 'drop()' }]) {
    assert.throws(() => parseAutoAction(JSON.stringify({ ...drag, ...patch }), bounds));
  }
});
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
test('drag invalidates verified answers and requires fresh verification before submit', async () => {
  const verified = { layout: 'single-page', question: 'Sort forces', navigation: 'submit-form', scroll: 'none', status: 'answer-verified' };
  const seen = [], executed = [];
  const actions = [{ type: 'drag', x: 100, y: 100, toX: 200, toY: 300, label: 'Weight to acts on car', form: verified },
    { type: 'click', x: 20, y: 30, label: 'Submit', intent: 'submit' },
    { type: 'click', x: 20, y: 30, label: 'Submit', intent: 'submit', form: verified },
    { type: 'done', message: 'Receipt confirmed', form: { ...verified, navigation: 'none', status: 'complete' } }];
  const h = harness([], { decide: async context => { seen.push(context); return JSON.stringify(actions.shift()); }, execute: async a => executed.push(a.type) });
  await h.engine.run('Sort and submit', { allowSubmit: true });
  assert.equal(seen[1].form.status, 'incomplete');
  assert.equal(seen[1].observation.action, 'drag');
  assert.ok(seen[2].history.some(a => a.type === 'feedback' && /Before submission/.test(a.message)));
  assert.deepEqual(executed, ['drag', 'click']);
  assert.equal(h.updates.at(-1).status, 'done');
});
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
test('bounds steps, gives recovery before pausing repeated actions, and handles missing input', async () => {
  const repeated = harness([click, click, click, click]);
  await repeated.engine.run('Fill draft');
  assert.equal(repeated.calls.filter(x => x === 'click').length, 2);
  assert.equal(repeated.updates.at(-1).status, 'paused');
  assert.ok(repeated.updates.some(u => /No repeated input was sent/.test(u.message)));
  assert.match(repeated.updates.at(-1).message, /click.*focus/i);
  const bounded = harness([click], { maxSteps: 1 });
  await bounded.engine.run('Fill draft');
  assert.equal(bounded.updates.at(-1).status, 'paused');
  assert.equal(bounded.calls.filter(x => x === 'capture').length, 2);
  const missing = harness([{ type: 'need_input', message: 'Please provide your name.' }]);
  await missing.engine.run('Fill draft');
  assert.equal(missing.updates.at(-1).status, 'paused');
  assert.deepEqual(missing.calls, ['capture', 'decide']);
});

test('a repeated selection is not clicked twice and can recover by scrolling', async () => {
  const option={...click,intent:'select',label:'Straight-line paths'};
  const contexts=[], actions=[option,option,formMap,{type:'scroll',x:700,y:500,amount:2,label:'Find next button'},{type:'need_input',message:'Stop'}];
  const h=harness([], {decide:async c=>{contexts.push(c);return JSON.stringify(actions.shift());}});
  await h.engine.run('Answer and advance');
  assert.equal(h.calls.filter(c=>c==='click').length,1);
  assert.equal(h.calls.filter(c=>c==='scroll').length,1);
  assert.match(contexts[2].history.at(-1).message,/selected|selection/i);
});

test('identical Next clicks on changed pages are progress, not a repetition failure', async () => {
  let frames=0;
  const next={...click,intent:'navigate',label:'Next'};
  const h=harness([next,next,next,{type:'done',message:'Ready'}],{capture:async()=>({...bounds,imageDataUrl:'frame'+(++frames)})});
  await h.engine.run('Move through pages');
  assert.equal(h.calls.filter(c=>c==='click').length,3);
  assert.equal(h.updates.at(-1).status,'done');
});

test('cycle clicks advance the same control across fresh changed screens', async () => {
  const cycle = { ...click, intent: 'cycle', label: 'Direction arrow' };
  assert.deepEqual(parseAutoAction(JSON.stringify(cycle), bounds), cycle);
  assert.throws(() => parseAutoAction(JSON.stringify({ ...cycle, clicks: 2 }), bounds));
  assert.throws(() => parseAutoAction(JSON.stringify({ ...cycle, label: 'Submit answer' }), bounds));
  let frames = 0;
  const h = harness([cycle, cycle, cycle, { type: 'done', message: 'Target direction visible' }], {
    capture: async () => ({ ...bounds, imageDataUrl: 'frame' + (++frames) })
  });
  await h.engine.run('Cycle the arrow to the target direction');
  assert.equal(h.calls.filter(c => c === 'click').length, 3);
  assert.equal(frames, 4);
  assert.equal(h.updates.at(-1).status, 'done');
});

test('cycle clicks still stop when the control does not change', async () => {
  const cycle = { ...click, intent: 'cycle', label: 'Direction arrow' };
  const h = harness([cycle, cycle, cycle, cycle]);
  await h.engine.run('Cycle the arrow to the target direction');
  assert.equal(h.calls.filter(c => c === 'click').length, 2);
  assert.equal(h.updates.at(-1).status, 'paused');
  assert.match(h.updates.at(-1).message, /unchanged screen/);
});

test('cycle scan collects choices without a model call per click and keeps captures fresh', async () => {
  const scan = { ...click, intent: 'cycle', label: 'Next diagram', steps: 5,
    region: { x: 10, y: 10, width: 300, height: 300 } };
  assert.deepEqual(parseAutoAction(JSON.stringify(scan), bounds), scan);
  for (const patch of [{ steps: 13 }, { steps: 0 }, { steps: 1.5 }, { intent: 'select' },
    { region: { x: 700, y: 0, width: 300, height: 300 } }]) {
    assert.throws(() => parseAutoAction(JSON.stringify({ ...scan, ...patch }), bounds));
  }
  let frames = 0, fresh = false;
  const contexts = [];
  const actions = [scan, { type: 'done', message: 'Compared six choices' }];
  const h = harness([], {
    capture: async () => { fresh = true; return { ...bounds, imageDataUrl: 'frame' + ++frames }; },
    execute: async a => { assert(fresh); fresh = false; h.calls.push(a.type); },
    decide: async c => { contexts.push(c); return JSON.stringify(actions.shift()); }
  });
  await h.engine.run('Compare the six diagrams');
  assert.equal(h.calls.filter(c => c === 'click').length, 5);
  assert.equal(contexts.length, 2);
  assert.equal(contexts[1].choices.images.length, 6);
  assert.deepEqual(contexts[1].choices.region, scan.region);
});

test('cycle scan stops immediately when an input changes nothing', async () => {
  const scan = { ...click, intent: 'cycle', steps: 5, region: { x: 0, y: 0, width: 100, height: 100 } };
  const contexts = [], actions = [scan, { type: 'done', message: 'Review blocked control' }];
  const h = harness([], { decide: async c => { contexts.push(c); return JSON.stringify(actions.shift()); } });
  await h.engine.run('Inspect options');
  assert.equal(h.calls.filter(c => c === 'click').length, 1);
  assert.equal(contexts[1].choices.images.length, 1);
});

test('cycle scans stop on cancellation and changed geometry before further clicks', async () => {
  const scan = { ...click, intent: 'cycle', steps: 5, region: { x: 0, y: 0, width: 100, height: 100 } };
  for (const cancel of [true, false]) {
    let captures = 0, inputs = 0;
    const h = harness([scan], {
      capture: async () => ({ width: ++captures > 1 && !cancel ? 700 : 800, height: 600, imageDataUrl: 'frame' + captures }),
      execute: async () => { inputs++; if (cancel) h.engine.stop(); }
    });
    if (cancel) await h.engine.run('Inspect choices');
    else await assert.rejects(h.engine.run('Inspect choices'), /geometry changed/);
    assert.equal(inputs, 1);
    assert.equal(h.updates.at(-1).status, cancel ? 'stopped' : 'error');
  }
});

test('a verified map can accompany the submission action in one model response', async () => {
  const {type,...form}=formMap;
  const h=harness([{...submit,form:{...form,navigation:'submit-form'}},
    {...{type:'done',message:'Confirmed'},form:{...form,navigation:'none',status:'complete'}}]);
  await h.engine.run('Submit test form',{allowSubmit:true});
  assert.equal(h.calls.filter(c=>c==='click').length,1);
  assert.equal(h.updates.at(-1).status,'done');
  assert.throws(()=>parseAutoAction(JSON.stringify({...submit,form:{...form,extra:'bad'}}),{...bounds,allowSubmit:true}));
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

test('scroll and selection consume field focus; typing continues in the same field only', async () => {
  const typed = { type: 'type', text: 'draft', origin: 'user', label: 'Name field' };
  const other = { type: 'type', text: 'x', origin: 'user', label: 'Email field' };
  const h2 = harness([click, typed, { ...typed, text: ' more' }, other, { type: 'need_input', message: 'Review needed' }]);
  await h2.engine.run('Fill draft');
  assert.deepEqual(h2.calls.filter(c => c === 'type').length, 2);
  for (const intervening of [
    { type: 'scroll', x: 20, y: 30, amount: 1, label: 'Form' },
    { ...click, intent: 'select' }
  ]) {
    const executed = [];
    const h = harness([click, intervening, typed, { type: 'need_input', message: 'Review needed' }], { execute: async action => executed.push(action) });
    await h.engine.run('Fill draft');
    assert.equal(executed.filter(action => action.type === 'type').length, 0);
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

const formMap = { type: 'map', layout: 'per-question', question: 'Question 1', navigation: 'submit-answer', scroll: 'none', status: 'answer-verified' };
const submit = { type: 'click', x: 30, y: 40, label: 'Submit answer', intent: 'submit' };
test('submission permission cannot come from the model or a misleading click intent', () => {
  assert.throws(() => parseAutoAction(JSON.stringify(submit), bounds), /submission/i);
  assert.deepEqual(parseAutoAction(JSON.stringify(submit), { ...bounds, allowSubmit: true }), submit);
  assert.throws(() => parseAutoAction(JSON.stringify({ ...submit, intent: 'navigate' }), { ...bounds, allowSubmit: true }), /intent/i);
  assert.throws(() => parseAutoAction(JSON.stringify({ ...submit, label: 'Pay now' }), { ...bounds, allowSubmit: true }), /sensitive/i);
  assert.throws(() => parseAutoAction(JSON.stringify({ ...formMap, layout: 'whatever' }), bounds));
});
test('maps questions, requires verified answers before submission and observes completion', async () => {
  const seen = [], executed = [];
  const actions = [submit, { ...formMap, status: 'incomplete', scroll: 'down' }, submit,
    { ...formMap, navigation: 'submit-form' }, submit, { type: 'done', message: 'Submitted' },
    { ...formMap, question: 'Confirmation', navigation: 'none', status: 'complete' },
    { type: 'done', message: 'Submission confirmed' }];
  const h = harness([], { decide: async c => { seen.push(c); return JSON.stringify(actions.shift()); }, execute: async a => executed.push(a) });
  await h.engine.run('Complete and submit this test form', { allowSubmit: true });
  assert.deepEqual(executed, [submit]);
  assert.equal(seen[2].form.scroll, 'down');
  assert.equal(seen[5].form, null, 'navigation invalidates old question verification');
  assert.match(seen[6].history.at(-1).message, /confirmation/i);
  assert.equal(h.updates.at(-1).status, 'done');
});
test('question map survives bounded action history and navigation needs a new map', async () => {
  const contexts = [], actions = [formMap, { ...click, intent: 'navigate', label: 'Next' }, submit, { type: 'need_input', message: 'Stop' }];
  const h = harness([], { decide: async c => { contexts.push(c); return JSON.stringify(actions.shift()); } });
  await h.engine.run('Complete and submit test form', { allowSubmit: true });
  assert.equal(contexts[2].form, null);
  assert.match(contexts[3].history.at(-1).message, /map/i);
});
test('unchanged screenshot after a click gives feedback rather than silently advancing', async () => {
  const contexts = [], actions = [click, { type: 'need_input', message: 'Stop' }];
  const h = harness([], { decide: async c => { contexts.push(c); return JSON.stringify(actions.shift()); } });
  await h.engine.run('Focus name');
  assert.match(contexts[1].observation.message, /unchanged/i);
});
test('malformed model output receives bounded correction without executing it', async () => {
  const contexts=[]; const replies=['not JSON', JSON.stringify({type:'need_input',message:'Stop'})];
  const h=harness([], {decide:async c=>{contexts.push(c); return replies.shift();}});
  await h.engine.run('Fill form');
  assert.match(contexts[1].history.at(-1).message,/JSON/);
  assert.ok(!h.calls.includes('click'));
  assert.equal(h.updates.at(-1).status,'paused');
  const bad=harness([], {decide:async()=> 'not JSON'});
  await assert.rejects(bad.engine.run('Fill form'), /JSON/);
  assert.equal(bad.calls.filter(c=>c==='capture').length,3);
});
test('graph questions are skipped, Next is allowed, and instructions reach the final message', async () => {
  const skip = { type: 'skip', question: 'Q2 plot y=2x+1', instructions: 'Pick the line tool, plot (0,1) and (2,5).',
    form: { layout: 'multi-step', question: 'Q2 plot y=2x+1', navigation: 'next', scroll: 'none', status: 'incomplete' } };
  assert.deepEqual(parseAutoAction(JSON.stringify(skip), bounds), skip);
  assert.throws(() => parseAutoAction(JSON.stringify({ ...skip, instructions: '' }), bounds), /skip/i);
  const executed = [];
  const actions = [skip, { type: 'click', x: 30, y: 40, label: 'Next', intent: 'navigate' },
    { type: 'click', x: 30, y: 40, label: 'Next', intent: 'navigate', form: skip.form },
    { type: 'done', message: 'Draft ready' }];
  const h = harness([], { decide: async () => JSON.stringify(actions.shift()), execute: async a => executed.push(a.label) });
  await h.engine.run('Fill the test form');
  assert.deepEqual(executed, ['Next'], 'skip unlocks only one Next; the following question needs verification');
  assert.equal(h.updates.at(-1).status, 'done');
  assert.match(h.updates.at(-1).message, /Skipped for you to answer:\n1\. Q2 plot y=2x\+1: Pick the line tool/);
  assert.equal(h.updates.at(-1).skipped.length, 1);
});
test('vector draws from axis calibration and corrects from the tool readout', async () => {
  const draw = { type: 'vector', label: 'Fn', magnitude: 3, angle: 90, origin: { x: 400, y: 300 }, tick: { x: 440, y: 300, value: 1 } };
  assert.deepEqual(parseAutoAction(JSON.stringify(draw), bounds), draw);
  for (const patch of [{ magnitude: 0 }, { angle: 'up' }, { tick: { x: 400, y: 300, value: 1 } }, { tick: { x: 440, y: 300, value: 0 } },
    { origin: { x: 900, y: 1 } }, { readout: { magnitude: 3, angle: 90 } }, { label: 'Submit' }]) {
    assert.throws(() => parseAutoAction(JSON.stringify({ ...draw, ...patch }), bounds));
  }
  const seenTip = { type: 'vector', label: 'Fn', magnitude: 3, angle: 90, readout: { magnitude: 2, angle: 90 }, tip: { x: 400, y: 200 } };
  assert.deepEqual(parseAutoAction(JSON.stringify(seenTip), bounds), seenTip);
  assert.throws(() => parseAutoAction(JSON.stringify({ ...draw, tip: { x: 1, y: 1 } }), bounds));
  assert.throws(() => parseAutoAction(JSON.stringify({ ...seenTip, tip: { x: 1, y: 900 } }), bounds));
  const fix = { type: 'vector', label: 'Fn', magnitude: 3, angle: 90 };
  const executed = [], seen = [];
  const actions = [
    { ...fix, readout: { magnitude: 2, angle: 90 } }, // nothing drawn yet
    draw, // 3 units * 40px up: (400,300) -> (400,180)
    draw, // re-draw refused
    // Tool really draws 30px per unit and its angle is 5 deg higher than the screen angle.
    { ...fix, readout: { magnitude: 4, angle: 95 } },
    { type: 'vector', label: 'Fg', magnitude: 2, angle: 270, origin: { x: 400, y: 300 }, tick: { x: 400, y: 260, value: 1 } },
    { ...fix, readout: { magnitude: 3.1, angle: 90 } }, { ...fix, readout: { magnitude: 3.1, angle: 90 } },
    { ...fix, readout: { magnitude: 3.2, angle: 90 } }, { ...fix, readout: { magnitude: 3.3, angle: 90 } },
    { type: 'done', message: 'FBD drawn' }];
  const h = harness([], { decide: async c => { seen.push(c); return JSON.stringify(actions.shift()); }, execute: async a => executed.push([a.type, a.x, a.y, a.toX, a.toY]) });
  await h.engine.run('Draw the free-body diagram');
  assert.match(seen[1].history.at(-1).message, /No drawn Fn/);
  assert.deepEqual(executed[0], ['drag', 400, 300, 400, 180]);
  assert.match(seen[3].history.at(-1).message, /already drawn/);
  // Scale 120px/4 = 30px per unit, aim 85 deg on screen: tip = 400+90cos85, 300-90sin85.
  assert.deepEqual(executed[1], ['drag', 400, 180, 408, 210]);
  assert.deepEqual(executed[2], ['drag', 400, 300, 400, 380]);
  assert.equal(executed.length, 5, 'corrections stop after three per label');
  assert.match(seen.at(-1).history.at(-1).message, /correction limit/);
  assert.equal(h.updates.at(-1).status, 'done');
});
test('double click is accepted for any intent except submit', () => {
  const dbl = { type: 'click', x: 20, y: 30, label: 'Mass and weight have different units', intent: 'select', clicks: 2 };
  assert.deepEqual(parseAutoAction(JSON.stringify(dbl), bounds), dbl);
  for (const intent of ['focus', 'navigate', 'insert']) assert.equal(parseAutoAction(JSON.stringify({ ...dbl, intent }), bounds).clicks, 2);
  for (const patch of [{ intent: 'submit', label: 'Submit' }, { clicks: 3 }, { clicks: '2' }]) {
    assert.throws(() => parseAutoAction(JSON.stringify({ ...dbl, ...patch }), { ...bounds, allowSubmit: true }));
  }
  assert.match(AUTO_SYSTEM, /clicks 2/);
});
test('a second map of an unchanged screen is recorded but nudged toward a real action', async () => {
  const map = { type: 'map', layout: 'per-question', question: 'Q1', navigation: 'submit-answer', scroll: 'none', status: 'answer-verified' };
  const { engine, updates } = harness([map, { ...map, status: 'incomplete' }, { type: 'done', message: 'ok' }]);
  await engine.run('Answer');
  const nudges = updates.filter(u => /Do not map again/.test(u.message));
  assert.equal(nudges.length, 1);
  assert.equal(updates.at(-1).status, 'done');
});
test('repeated maps of an unchanged screen pause instead of stalling', async () => {
  const map = { type: 'map', layout: 'per-question', question: 'Q1', navigation: 'submit-answer', scroll: 'none', status: 'incomplete' };
  const { engine, updates } = harness([map, { ...map, question: 'Q1 ' }, { ...map, status: 'answer-verified' }, { ...map, question: 'Q 1' }, { type: 'done', message: 'x' }]);
  await engine.run('Answer');
  assert.equal(updates.at(-1).status, 'paused');
  assert.match(updates.at(-1).message, /re-reading the same screen/);
});
test('a submitted form mapped complete finishes without another done turn', async () => {
  const verified = { layout: 'single-page', question: 'Q1', navigation: 'submit-form', scroll: 'none', status: 'answer-verified' };
  const { engine, updates, calls } = harness([{ type: 'click', x: 20, y: 30, label: 'Submit', intent: 'submit', form: verified },
    { type: 'map', layout: 'single-page', question: 'Thank you!', navigation: 'none', scroll: 'none', status: 'complete' }]);
  await engine.run('Submit it', { allowSubmit: true });
  assert.equal(updates.at(-1).status, 'done');
  assert.equal(calls.filter(c => c === 'decide').length, 2);
});
test('a failed research lookup becomes feedback instead of ending the run', async () => {
  const { engine, updates } = harness([{ type: 'research', query: 'SI unit of force' }, { type: 'done', message: 'ok' }],
    { research: async () => { throw new Error('Add a Tavily search API key in Settings to research the web.'); } });
  await engine.run('Answer');
  assert.ok(updates.some(u => /Research failed \(Add a Tavily/.test(u.message)));
  assert.equal(updates.at(-1).status, 'done');
});
const zlib = require('node:zlib');
// Minimal RGB PNG writer; paint(x, y) returns [r, g, b]. Uses Sub filter so the decoder's unfiltering is exercised.
function png(width, height, paint) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3); row[0] = 1;
    for (let x = 0; x < width; x++) {
      const px = paint(x, y);
      for (let k = 0; k < 3; k++) row[1 + x * 3 + k] = (px[k] - (x ? paint(x - 1, y)[k] : 0)) & 255;
    }
    rows.push(row);
  }
  const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4); return Buffer.concat([head, data, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const white = [255, 255, 255], ink = [20, 20, 20];
test('blank frames: flat page and tooltip strip are blank; a sparse question page is not', () => {
  const { isBlankFrame } = require('../src/auto-mode');
  assert.equal(isBlankFrame(png(120, 200, () => white)), true);
  assert.equal(isBlankFrame(png(120, 200, (x, y) => y > 195 && x < 60 ? ink : white)), true);
  assert.equal(isBlankFrame(png(120, 200, (x, y) => !y || !x || x === 119 || (y > 185 && x < 60) ? ink : white)), true, 'border plus tooltip');
  assert.equal(isBlankFrame(png(120, 200, (x, y) => ((y > 20 && y < 40) || (y > 70 && y < 90)) && x % 7 < 3 ? ink : white)), false);
  assert.equal(isBlankFrame('data:image/png;base64,AA=='), false);
});
test('math symbols in typed answers become ASCII instead of failing the run', () => {
  const typed = parseAutoAction(JSON.stringify({ type: 'type', text: '15(cos(5π/12) + i sin(5π/12)) √2 x²', label: 'z', origin: 'calculation' }), bounds);
  assert.equal(typed.text, '15(cos(5pi/12) + i sin(5pi/12)) sqrt2 x^2');
  assert.throws(() => parseAutoAction(JSON.stringify({ type: 'type', text: 'é', label: 'z', origin: 'user' }), bounds), /pi, sqrt/);
});
test('after Next, unchanged and blank loading frames are waited out without a model call', async () => {
  const page1 = png(40, 40, (x, y) => y < 20 && x % 3 ? ink : white), page2 = png(40, 40, (x, y) => y > 20 && x % 3 ? ink : white);
  const frames = [page1, page1, png(40, 40, () => white), page2], seen = [];
  const actions = [{ type: 'click', x: 5, y: 5, label: 'Next', intent: 'navigate' }, { type: 'done', message: 'Draft ready' }];
  const h = harness([], { delay: 1, capture: async () => ({ imageDataUrl: frames.shift(), width: 40, height: 40 }),
    decide: async context => { seen.push(context.screen.imageDataUrl); return JSON.stringify(actions.shift()); } });
  await h.engine.run('Next page');
  assert.deepEqual(seen, [page1, page2]);
  assert.ok(h.updates.some(u => /finish loading/.test(u.message)));
});
test('palette insert keeps the math field focused so typing continues without refocus', async () => {
  const actions = [{ type: 'click', x: 10, y: 10, label: 'z answer', intent: 'focus' }, { type: 'type', text: '15(cos(5', label: 'z answer', origin: 'calculation' },
    { type: 'click', x: 30, y: 10, label: 'pi symbol in palette', intent: 'insert' }, { type: 'type', text: '/12)', label: 'z answer', origin: 'calculation' },
    { type: 'click', x: 30, y: 10, label: 'Answer choice', intent: 'select' }, { type: 'type', text: 'x', label: 'z answer', origin: 'calculation' },
    { type: 'need_input', message: 'stop' }];
  const executed = [];
  const h = harness(actions, { execute: async a => executed.push(a.type === 'type' ? a.text : a.intent) });
  await h.engine.run('Answer z');
  assert.deepEqual(executed, ['focus', '15(cos(5', 'insert', '/12)', 'select']);
  assert.ok(h.updates.some(u => /Click intended field with intent focus/.test(u.message)));
});
test('type with palette symbols types ASCII runs and clicks each symbol in text order', async () => {
  const pi = { x: 62, y: 176 }, executed = [];
  const h = harness([{ type: 'click', x: 10, y: 10, label: 'z', intent: 'focus' },
    { type: 'type', text: '15(cos(5π/12))', label: 'z', origin: 'calculation', symbols: { 'π': pi } }, { type: 'need_input', message: 'stop' }],
  { execute: async a => executed.push(a.type === 'type' ? a.text : `${a.intent}@${a.x},${a.y}`) });
  await h.engine.run('Answer z');
  assert.deepEqual(executed, ['focus@10,10', '15(cos(5', 'insert@62,176', '/12))']);
  for (const symbols of [{ '\n': pi }, { ' ': pi }, { 'π': { x: 900, y: 1 } }, { 'ππ': pi }, {}]) {
    assert.throws(() => parseAutoAction(JSON.stringify({ type: 'type', text: 'π', label: 'z', origin: 'calculation', symbols }), bounds));
  }
});
test('on-screen keypad: one type action clicks every keypad button in order, repeated digits included', async () => {
  // User report 2026-10-24: a numpad-only form (keyboard ignored) burned the 80-step limit on 3 fields,
  // and repeated digits (the zeros in 3000) were blocked as duplicate selection clicks.
  const k = { '3': { x: 30, y: 30 }, '0': { x: 0, y: 40 }, '.': { x: 20, y: 40 } }, executed = [];
  const h = harness([{ type: 'click', x: 10, y: 10, label: 'Ftens', intent: 'focus' },
    { type: 'type', text: '30.03', label: 'Ftens', origin: 'calculation', symbols: k }, { type: 'need_input', message: 'stop' }],
  { execute: async a => executed.push(a.type === 'type' ? a.text : `${a.intent}@${a.x},${a.y}`) });
  await h.engine.run('Fill the form with the keypad');
  assert.deepEqual(executed, ['focus@10,10', 'insert@30,30', 'insert@0,40', 'insert@20,40', 'insert@0,40', 'insert@30,30']);
  // Keyboard typing that changes nothing points the model at the keypad.
  const seen = [];
  const typed = harness([{ type: 'click', x: 10, y: 10, label: 'm', intent: 'focus' },
    { type: 'type', text: '250', label: 'm', origin: 'calculation' }, { type: 'need_input', message: 'stop' }],
  { decide: async ({ observation }) => { seen.push(observation?.message); return JSON.stringify([{ type: 'click', x: 10, y: 10, label: 'm', intent: 'focus' }, { type: 'type', text: '250', label: 'm', origin: 'calculation' }, { type: 'need_input', message: 'stop' }][seen.length - 1]); } });
  await typed.engine.run('Fill m');
  assert.match(seen[2], /on-screen keypad/);
});
test('a second Submit with no answer change since the first is not sent', async () => {
  const verified = { layout: 'per-question', question: 'Q1', navigation: 'submit-answer', scroll: 'none', status: 'answer-verified' };
  const submit = { type: 'click', x: 66, y: 244, label: 'Submit', intent: 'submit', form: verified };
  const executed = [];
  const h = harness([submit, submit, { type: 'click', x: 9, y: 9, label: 'Choice B', intent: 'select' }, submit, { type: 'need_input', message: 'stop' }],
    { execute: async a => executed.push(a.intent) });
  await h.engine.run('Answer', { allowSubmit: true });
  assert.deepEqual(executed, ['submit', 'select', 'submit']);
  assert.ok(h.updates.some(u => /already clicked/.test(u.message)));
});
test('clear runs only on the field just focused, and typing may follow it', async () => {
  const executed = [];
  const h = harness([{ type: 'clear', label: 'z' }, { type: 'click', x: 10, y: 10, label: 'z', intent: 'focus' }, { type: 'clear', label: 'z' },
    { type: 'type', text: '15', label: 'z', origin: 'calculation' }, { type: 'need_input', message: 'stop' }], { execute: async a => executed.push(a.type) });
  await h.engine.run('Fix z');
  assert.deepEqual(executed, ['click', 'clear', 'type']);
  assert.ok(h.updates.some(u => /Clear was not performed/.test(u.message)));
});

test('"don\'t scroll" in the goal is enforced by the engine, not left to the model', async () => {
  const seen = [], executed = [];
  const actions = [{ type: 'scroll', x: 10, y: 10, amount: 3, label: 'page' },
    { type: 'click', x: 20, y: 30, label: 'Next', intent: 'navigate', form: { layout: 'multi-step', question: 'Q1', navigation: 'next', scroll: 'down', status: 'answer-verified' } },
    { type: 'done', message: 'ok' }];
  const h = harness([], { decide: async c => { seen.push(c); return JSON.stringify(actions.shift()); }, execute: async a => executed.push(a.type) });
  await h.engine.run("Answer the quiz. Don't scroll.");
  assert.deepEqual(seen[0].userRules, ['Never scroll. Work only with what is visible; use need_input if something required is off screen.']);
  assert.ok(seen[1].history.some(a => a.type === 'feedback' && /user told you not to scroll/.test(a.message)));
  // form.scroll "down" would normally block Next; with scrolling forbidden it cannot.
  assert.deepEqual(executed, ['click']);
});

test('"double click" in the goal upgrades every select click to clicks 2', async () => {
  const sent = [];
  const h = harness([{ type: 'click', x: 20, y: 30, label: 'Answer B', intent: 'select' }, { type: 'done', message: 'ok' }],
    { execute: async a => sent.push(a) });
  await h.engine.run('Double click each answer to mark it sure');
  assert.equal(sent[0].clicks, 2);
  const plain = [];
  await harness([{ type: 'click', x: 20, y: 30, label: 'Answer B', intent: 'select' }, { type: 'done', message: 'ok' }],
    { execute: async a => plain.push(a) }).engine.run("Answer it, don't double click");
  assert.equal(plain[0].clicks, undefined);
});
test('a run with no real progress for stallSteps pauses early with the last feedback', async () => {
  // Scrolling and focus clicks alone are not progress; the 80-step cap was the only stop before.
  const actions = [];
  for (let i = 0; i < 30; i++) actions.push(i % 2 ? { type: 'scroll', x: 5, y: 5, amount: 1, label: 'page' } : { type: 'click', x: 10 + i, y: 10, label: 'f' + i, intent: 'focus' });
  const h = harness(actions, { stallSteps: 6 });
  await h.engine.run('Fill form');
  const last = h.updates.at(-1);
  assert.equal(last.status, 'paused'); assert.equal(last.step, 7);
  assert.match(last.message, /No progress in 6 steps/);
  // A typed value resets the count.
  const typed = [{ type: 'click', x: 1, y: 1, label: 'a', intent: 'focus' }, { type: 'type', text: '1', label: 'a', origin: 'user' }];
  const g = harness([...actions.slice(0, 4), ...typed, ...actions.slice(0, 5), { type: 'done', message: 'ok' }], { stallSteps: 6 });
  await g.engine.run('Fill form');
  assert.equal(g.updates.at(-1).status, 'done');
});
// Real executors (zen-control, desktop-control) accept one input per capture.
function strictIO() {
  let fresh = false; const executed = [];
  return { executed,
    capture: async () => { fresh = true; return { imageDataUrl: 'data:image/png;base64,AA==', width: 800, height: 600 }; },
    execute: async a => { if (!fresh) throw new Error('Capture the locked Zen tab before acting.'); fresh = false; executed.push(a.type === 'type' ? a.text : `${a.intent}@${a.x},${a.y}`); } };
}
test('keypad presses each get a fresh capture, as the real executors require', async () => {
  const io = strictIO(), k = { '3': { x: 30, y: 30 }, '0': { x: 0, y: 40 } };
  const h = harness([{ type: 'click', x: 10, y: 10, label: 'F', intent: 'focus' },
    { type: 'type', text: '300', label: 'F', origin: 'calculation', symbols: k }, { type: 'done', message: 'ok' }], io);
  await h.engine.run('Fill F');
  assert.equal(h.updates.at(-1).status, 'done');
  assert.deepEqual(io.executed, ['focus@10,10', 'insert@30,30', 'insert@0,40', 'insert@0,40']);
});
test('fill enters several fields from one decision: focus click then value, in order', async () => {
  const io = strictIO(), k = { '2': { x: 20, y: 20 }, '5': { x: 50, y: 50 }, '0': { x: 0, y: 40 } };
  const fill = { type: 'fill', fields: [
    { x: 100, y: 100, label: 'm', text: '250', origin: 'calculation', symbols: k },
    { x: 100, y: 200, label: 'note', text: 'ok', origin: 'user' }] };
  let decisions = 0;
  const h = harness([fill, { type: 'done', message: 'ok' }], { ...io, decide: async () => JSON.stringify([fill, { type: 'done', message: 'ok' }][decisions++]) });
  await h.engine.run('Fill the form');
  assert.equal(decisions, 2); assert.equal(h.updates.at(-1).status, 'done');
  assert.deepEqual(io.executed, ['focus@100,100', 'insert@20,20', 'insert@50,50', 'insert@0,40', 'focus@100,200', 'ok']);
  const bounds = { width: 800, height: 600 };
  for (const fields of [[], [{ x: 900, y: 1, label: 'a', text: '1', origin: 'user' }], [{ x: 1, y: 1, label: 'Password', text: 'x', origin: 'user' }],
    [{ x: 1, y: 1, label: 'a', text: '1' }], Array(11).fill({ x: 1, y: 1, label: 'a', text: '1', origin: 'user' })]) {
    assert.throws(() => parseAutoAction(JSON.stringify({ type: 'fill', fields }), bounds));
  }
});
test('clearButton empties a keypad field before entry, and pressed buttons are remembered for later decisions', async () => {
  // Live run 2026-10-24: positions for the same keypad key drifted between decisions (5 sent as the 2 and 8 keys),
  // and retyping without Clear appended digits.
  const io = strictIO(), seen = [];
  const k = { '5': { x: 50, y: 50 }, '0': { x: 0, y: 40 } };
  const acts = [{ type: 'fill', fields: [{ x: 100, y: 100, label: 'Fapp', text: '50', origin: 'user', symbols: k, clearButton: { x: 70, y: 5 } }] },
    { type: 'scroll', x: 5, y: 5, amount: 1, label: 'page' }, { type: 'done', message: 'ok' }];
  const h = harness(acts, { ...io, decide: async ({ knownButtons }) => { seen.push(knownButtons); return JSON.stringify(acts[seen.length - 1]); } });
  await h.engine.run('Fill');
  assert.deepEqual(io.executed, ['focus@100,100', 'insert@70,5', 'insert@50,50', 'insert@0,40', 'undefined@5,5']); // the scroll
  assert.deepEqual(seen[0], {});
  assert.deepEqual(seen[1], k);
  assert.deepEqual(seen[2], {}, 'a scroll moves the keypad, so remembered points are dropped');
  assert.throws(() => parseAutoAction(JSON.stringify({ type: 'type', text: '1', label: 'a', origin: 'user', clearButton: { x: 900, y: 1 } }), { width: 800, height: 600 }));
});
test('after entering values the model is told exactly what was entered, to compare digit by digit', async () => {
  // Live run 2026-10-24: 24000 went in as 84000 (the 8 key pressed for 2) and the model's check missed it.
  const fill = { type: 'fill', fields: [{ x: 100, y: 100, label: 'Fnorm', text: '24000', origin: 'calculation' }, { x: 100, y: 200, label: 'm', text: '2400', origin: 'user' }] };
  const seen = [], acts = [fill, { type: 'done', message: 'ok' }];
  let n = 0;
  const h = harness(acts, { capture: async () => ({ imageDataUrl: 'data:image/png;base64,' + (n++ ? 'BB==' : 'AA=='), width: 800, height: 600 }),
    decide: async ({ observation }) => { seen.push(observation?.message); return JSON.stringify(acts[seen.length - 1]); } });
  await h.engine.run('Fill');
  assert.match(seen[1], /Fnorm = 24000; m = 2400/);
  assert.match(seen[1], /digit by digit/);
});
test('keypad buttons found on the page replace the model points; a keypad field with a missing key is not started', async () => {
  const io = strictIO(), asked = [];
  const page = { '2': { x: 200, y: 200 }, '4': { x: 100, y: 100 }, '0': { x: 0, y: 300 } };
  const acts = [{ type: 'fill', fields: [
      { x: 10, y: 10, label: 'Fnorm', text: '24000', origin: 'calculation', symbols: { '2': { x: 200, y: 50 }, '4': { x: 1, y: 1 }, '0': { x: 2, y: 2 } } },
      { x: 10, y: 60, label: 'a', text: '20', origin: 'user', keypad: true }] },
    { type: 'fill', fields: [{ x: 10, y: 90, label: 'v', text: '9', origin: 'user', keypad: true }] },
    { type: 'done', message: 'ok' }];
  const h = harness(acts, { ...io, locate: async chars => { asked.push(chars.join('')); return Object.fromEntries(chars.filter(c => page[c]).map(c => [c, page[c]])); } });
  await h.engine.run('Fill');
  assert.deepEqual(asked, ['240', '9']); // one page lookup per action
  assert.deepEqual(io.executed, ['focus@10,10', 'insert@200,200', 'insert@100,100', 'insert@0,300', 'insert@0,300', 'insert@0,300',
    'focus@10,60', 'insert@200,200', 'insert@0,300']);
  assert.ok(h.updates.some(u => /not found on the page: 9/.test(u.message)));
  // Without a page lookup (desktop mode), a keypad field needs symbols.
  const d = harness([{ type: 'fill', fields: [{ x: 10, y: 60, label: 'a', text: '20', origin: 'user', keypad: true }] }, { type: 'done', message: 'ok' }], strictIO());
  await d.engine.run('Fill');
  assert.ok(d.updates.some(u => /not found on the page: 2, 0/.test(u.message)));
});
test('a clearButton is replaced by the page Clear button when found', async () => {
  const io = strictIO();
  const h = harness([{ type: 'fill', fields: [{ x: 10, y: 10, label: 'a', text: '7', origin: 'user', keypad: true, clearButton: { x: 431, y: 93 } }] }, { type: 'done', message: 'ok' }],
    { ...io, locate: async keys => { assert.deepEqual(keys, ['7', 'Clear']); return { '7': { x: 70, y: 70 }, Clear: { x: 348, y: 93 } }; } });
  await h.engine.run('Fill');
  assert.deepEqual(io.executed, ['focus@10,10', 'insert@348,93', 'insert@70,70']);
});
test('two inputs in a row that change nothing tell the model to switch method', async () => {
  const seen = [], acts = [{ type: 'scroll', x: 5, y: 5, amount: 1, label: 'page' }, { type: 'scroll', x: 5, y: 5, amount: 2, label: 'page' },
    { type: 'scroll', x: 5, y: 5, amount: 3, label: 'page' }, { type: 'done', message: 'ok' }];
  const h = harness(acts, { decide: async ({ observation }) => { seen.push(observation?.message || ''); return JSON.stringify(acts[seen.length - 1]); } });
  await h.engine.run('Read');
  assert.doesNotMatch(seen[1], /change method/);
  assert.match(seen[2], /2 inputs in a row changed nothing.*does not scroll further/);
  assert.match(seen[3], /3 inputs in a row/);
});

test('no-question pages (task lists, start screens) may navigate without verified answers', async () => {
  const listMap = { layout: 'single-page', question: 'Tasks list; Mission NL7', navigation: 'none', scroll: 'down', status: 'no-question' };
  assert.deepEqual(parseAutoAction(JSON.stringify({ type: 'map', ...listMap }), bounds), { type: 'map', ...listMap });
  const start = { type: 'click', x: 30, y: 40, label: 'Start This Task', intent: 'navigate', form: listMap };
  const h = harness([start, { type: 'need_input', message: 'Stop' }]);
  await h.engine.run('Open mission NL7 and complete it');
  assert.ok(h.calls.includes('click'), 'the Start click was executed');
  // The strict rule still holds on question pages.
  const blocked = harness([{ ...start, form: { ...listMap, status: 'incomplete', scroll: 'none' } }, { type: 'need_input', message: 'Stop' }]);
  await blocked.engine.run('Open mission NL7 and complete it');
  assert.ok(!blocked.calls.includes('click'), 'an incomplete question page cannot navigate');
});
test('no-question cannot be used to submit', async () => {
  const listMap = { layout: 'single-page', question: 'Start page', navigation: 'submit-form', scroll: 'none', status: 'no-question' };
  const h = harness([{ ...submit, form: listMap }, { type: 'need_input', message: 'Stop' }]);
  await h.engine.run('Submit it', { allowSubmit: true });
  assert.ok(!h.calls.includes('click'));
});

test('fill does not re-click a keypad field the previous step focused (a second click closes the keypad)', async () => {
  const io = strictIO();
  const page = { '3': { x: 300, y: 300 }, '2': { x: 200, y: 200 } };
  const acts = [{ type: 'click', x: 50, y: 50, label: 'Answer field', intent: 'focus' },
    { type: 'fill', fields: [{ x: 51, y: 50, label: 'Answer field', text: '32', origin: 'calculation', keypad: true }] },
    { type: 'done', message: 'ok' }];
  const h = harness(acts, { ...io, locate: async chars => Object.fromEntries(chars.filter(c => page[c]).map(c => [c, page[c]])) });
  await h.engine.run('Fill');
  assert.deepEqual(io.executed, ['focus@50,50', 'insert@300,300', 'insert@200,200']);
  // Without a prior focus click, fill still opens the keypad itself.
  const io2 = strictIO();
  const h2 = harness([acts[1], acts[2]], { ...io2, locate: async chars => Object.fromEntries(chars.filter(c => page[c]).map(c => [c, page[c]])) });
  await h2.engine.run('Fill');
  assert.deepEqual(io2.executed, ['focus@51,50', 'insert@300,300', 'insert@200,200']);
});
const graded = { layout: 'per-question', question: 'Mug falls', navigation: 'submit-answer', scroll: 'none', status: 'answer-verified', answer: 'Eg 1 to Eint 1, no transfer' };
const checkAnswer = { type: 'click', x: 40, y: 50, label: 'Check Answer', intent: 'submit', form: graded };
test('Continue on the result page right after a submit is allowed without a verified map (live stall 2026-10-30)', async () => {
  const result = { layout: 'multi-step', question: 'Incorrect-answer feedback', navigation: 'next', scroll: 'none', status: 'incomplete' };
  const h = harness([checkAnswer, { type: 'click', x: 60, y: 70, label: 'Continue', intent: 'navigate', form: result }, { type: 'done', message: 'x', form: { ...result, status: 'complete' } }]);
  await h.engine.run('Complete the quiz', { allowSubmit: true });
  assert.equal(h.calls.filter(c => c === 'click').length, 2);
  assert(!h.updates.some(u => /Verify the current answers/.test(u.message)));
});
test('adjust presses each stepper the requested number of times from one decision, fresh capture per press', async () => {
  const adjust = { type: 'adjust', taps: [{ x: 10, y: 20, label: 'Initial Eg up', times: 2 }, { x: 30, y: 20, label: 'Final Eint up', times: 1 }] };
  assert.deepEqual(parseAutoAction(JSON.stringify(adjust), bounds), adjust);
  for (const taps of [[], [{ ...adjust.taps[0], times: 0 }], [{ ...adjust.taps[0], times: 11 }], [{ ...adjust.taps[0], label: 'Submit' }], [{ ...adjust.taps[0], x: 800 }], [{ ...adjust.taps[0], times: 10 }, { ...adjust.taps[1], times: 10 }, { ...adjust.taps[1], times: 1 }]]) {
    assert.throws(() => parseAutoAction(JSON.stringify({ ...adjust, taps }), bounds));
  }
  const sent = [];
  const h = harness([adjust, { type: 'done', message: 'x' }], { execute: async a => { sent.push(a); h.calls.push(a.type); } });
  await h.engine.run('Set the bars');
  assert.deepEqual(sent.map(a => [a.x, a.type]), [[10, 'click'], [10, 'click'], [30, 'click']]);
  assert.deepEqual(h.calls.slice(0, 7), ['capture', 'decide', 'click', 'capture', 'click', 'capture', 'click']);
});
test('an independent check that disagrees blocks Submit and feeds its fix back; agreement submits', async () => {
  const verdicts = ['{"verdict":"wrong","expected":"no transfer","onScreen":"transfer out 3","fix":"cycle the system to no transfer"}', '{"verdict":"correct","fix":""}'];
  const seen = [];
  const h = harness([checkAnswer, checkAnswer, { type: 'done', message: 'x', form: { ...graded, status: 'complete' } }],
    { verify: async c => { seen.push(c); return verdicts.shift(); } });
  await h.engine.run('Complete the quiz', { allowSubmit: true });
  assert.equal(seen.length, 2);
  assert.equal(h.calls.filter(c => c === 'click').length, 1);
  assert(h.updates.some(u => /cycle the system to no transfer/.test(u.message)));
});
test('a failing or unreadable check does not block Submit', async () => {
  const h = harness([checkAnswer, { type: 'done', message: 'x', form: { ...graded, status: 'complete' } }], { verify: async () => 'not json' });
  await h.engine.run('Complete the quiz', { allowSubmit: true });
  assert.equal(h.calls.filter(c => c === 'click').length, 1);
});
test('after two rejections on one question the third Submit goes through instead of stalling', async () => {
  let checks = 0;
  // Shifted x: an identical click on an unchanged screen is the repeat guard's job, not this one's.
  const h = harness([checkAnswer, { ...checkAnswer, x: 41 }, { ...checkAnswer, x: 42 }, { type: 'done', message: 'x', form: { ...graded, status: 'complete' } }],
    { verify: async () => { checks++; return '{"verdict":"wrong","fix":"x"}'; } });
  await h.engine.run('Complete the quiz', { allowSubmit: true });
  assert.equal(checks, 2);
  assert.equal(h.calls.filter(c => c === 'click').length, 1);
});
test('the site\'s grade on a result page is paired with the submitted answer and shown to actor and checker', async () => {
  const resultPage = r => ({ type: 'click', x: 60, y: 70, label: 'Continue', intent: 'navigate', form: { layout: 'multi-step', question: 'Result screen', navigation: 'next', scroll: 'none', status: 'no-question', result: r } });
  const contexts = [], checks = [];
  const h = harness([], {
    decide: async c => { contexts.push(c); return JSON.stringify([checkAnswer, resultPage('incorrect'), { ...checkAnswer, x: 41 }, { type: 'done', message: 'x', form: { ...graded, status: 'complete' } }][contexts.length - 1]); },
    verify: async c => { checks.push(c); return '{"verdict":"correct"}'; } });
  await h.engine.run('Complete the quiz', { allowSubmit: true });
  assert.deepEqual(contexts[2].siteResults, [{ question: 'Mug falls', answer: graded.answer, result: 'incorrect' }]);
  assert.deepEqual(checks[1].siteResults, contexts[2].siteResults);
  assert.throws(() => parseAutoAction(JSON.stringify({ type: 'map', ...resultPage('maybe').form }), bounds));
});
test('a response with stray closing braces is accepted; other junk is not', () => {
  const ok = JSON.stringify({ type: 'click', x: 1, y: 2, label: 'Energy transfer arrow', intent: 'cycle' });
  assert.equal(parseAutoAction(ok + '}}', bounds).label, 'Energy transfer arrow');
  assert.throws(() => parseAutoAction(ok + '{"type":"done"}', bounds));
  // Only "energy transfer" is carved out of the money-transfer guard; every other transfer stays blocked.
  for (const label of ['Wire transfer funds', 'Transfer', 'Confirm transfer', 'Transfer $50', 'Energy transfer funds to savings', 'energy transfer $20', 'energy-transfer to account']) assert.throws(() => parseAutoAction(JSON.stringify({ type: 'click', x: 1, y: 2, label, intent: 'select' }), bounds));
  assert.equal(parseAutoAction(JSON.stringify({ type: 'click', x: 1, y: 2, label: 'energy-transfer arrows', intent: 'cycle' }), bounds).intent, 'cycle');
});
test('a result page the model describes but does not grade is still recorded from its text', async () => {
  const page = { type: 'click', x: 60, y: 70, label: 'Continue', intent: 'navigate', form: { layout: 'multi-step', question: "Result page: the answer was marked incorrect (O' Drats)", navigation: 'next', scroll: 'none', status: 'no-question' } };
  const contexts = [];
  const h = harness([], { decide: async c => { contexts.push(c); return JSON.stringify([checkAnswer, page, { type: 'done', message: 'x', form: { ...graded, status: 'complete' } }][contexts.length - 1]); } });
  await h.engine.run('Complete the quiz', { allowSubmit: true });
  assert.equal(contexts[2].siteResults[0].result, 'incorrect');
});
test('adjust taps with times 0 are dropped instead of rejecting the whole action', () => {
  const action = parseAutoAction(JSON.stringify({ type: 'adjust', taps: [{ x: 1, y: 2, label: 'Ek up', times: 2 }, { x: 3, y: 2, label: 'Eg up', times: 0 }] }), bounds);
  assert.deepEqual(action.taps.map(t => t.label), ['Ek up']);
  assert.throws(() => parseAutoAction(JSON.stringify({ type: 'adjust', taps: [{ x: 3, y: 2, label: 'Eg up', times: 0 }] }), bounds));
});
