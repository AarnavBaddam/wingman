const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAutoAction, createAutoMode, AUTO_SYSTEM } = require('../src/auto-mode');
const bounds = { width: 800, height: 600, sourceIds: [3] };
const click = { type: 'click', x: 20, y: 30, label: 'Name field', intent: 'focus' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
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
test('double click is accepted only for select intent', () => {
  const dbl = { type: 'click', x: 20, y: 30, label: 'Mass and weight have different units', intent: 'select', clicks: 2 };
  assert.deepEqual(parseAutoAction(JSON.stringify(dbl), bounds), dbl);
  for (const patch of [{ intent: 'submit' }, { intent: 'navigate' }, { clicks: 3 }, { clicks: '2' }]) {
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
