const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAutoAction, createAutoMode, AUTO_SYSTEM, profileFromText, surfaceToProfile } = require('../src/auto-mode');
const { buildAutoSystem, CORE } = require('../src/auto-profiles');

const bounds = { width: 800, height: 600 };

// Build an engine that records the decide context per step and plays scripted actions.
function harness(actions, goal, runOpts = {}) {
  const contexts = [], executed = [], updates = [];
  let i = 0;
  const engine = createAutoMode({
    capture: async () => ({ imageDataUrl: 'data:image/png;base64,AA==', width: 800, height: 600 }),
    decide: async ctx => { contexts.push(ctx); return JSON.stringify(actions[i++]); },
    execute: async a => executed.push(a.type),
    onUpdate: u => updates.push(u), delay: 0
  });
  return { run: () => engine.run(goal, runOpts), contexts, executed, updates };
}

test('form profile is the untouched original prompt; document/generic are separate packs', () => {
  assert.equal(buildAutoSystem('form'), AUTO_SYSTEM);
  assert.match(buildAutoSystem('document'), /DOCUMENT/);
  assert.match(buildAutoSystem('document'), /no .*Submit|do not look for them/i);
  assert.match(buildAutoSystem('unknown'), /classify the surface/i);
  // Every pack keeps the universal trust boundary and the safety rule.
  for (const p of ['form', 'document', 'generic', 'unknown']) {
    assert.match(buildAutoSystem(p), /untrusted/i);
  }
  assert.match(CORE, /allowSubmit/);
});

test('a plain-text surface word in the goal overrides classification', () => {
  assert.equal(profileFromText('fill this google doc with the answers'), 'document');
  assert.equal(profileFromText('answer the gdoc'), 'document');
  assert.equal(profileFromText('complete the quiz form'), 'form');
  assert.equal(profileFromText('do the worksheet'), 'form');
  assert.equal(profileFromText('just do the thing on screen'), null);
  assert.equal(surfaceToProfile('document'), 'document');
  assert.equal(surfaceToProfile('webpage'), 'generic');
  assert.equal(surfaceToProfile('form'), 'form');
});

test('a classification map carries only surface/question/status; bad surfaces are rejected', () => {
  const classify = { type: 'map', surface: 'document', question: 'worksheet in a doc', status: 'incomplete' };
  assert.deepEqual(parseAutoAction(JSON.stringify(classify), bounds), classify);
  // The original form map (with layout/navigation/scroll) still validates.
  const formMap = { type: 'map', layout: 'single-page', question: 'Q1', navigation: 'submit-form', scroll: 'none', status: 'answer-verified' };
  assert.deepEqual(parseAutoAction(JSON.stringify(formMap), bounds), formMap);
  assert.throws(() => parseAutoAction(JSON.stringify({ ...classify, surface: 'pdf' }), bounds), /surface/i);
});

test('a plain-text "google doc" goal runs under the document profile with no form gating', async () => {
  const h = harness([
    { type: 'click', x: 40, y: 50, label: 'Answer line under Q1', intent: 'focus' },
    { type: 'type', text: '42', label: 'Answer line under Q1', origin: 'user' },
    { type: 'done', message: 'Typed each answer under its question' }
  ], 'Fill this google doc with the answers');
  await h.run();
  assert.equal(h.contexts[0].profile, 'document');            // forced from the goal, step 1
  assert.deepEqual(h.executed, ['click', 'type']);            // type was NOT blocked by form gating
  assert.equal(h.updates.at(-1).status, 'done');
  assert.ok(h.updates.some(u => /document/i.test(u.message))); // classified, said, proceeded
});

test('with no surface word, the model classifies on its first map, then the profile switches', async () => {
  const h = harness([
    { type: 'map', surface: 'document', question: 'a doc with questions', status: 'incomplete' },
    { type: 'click', x: 40, y: 50, label: 'Answer line', intent: 'focus' },
    { type: 'type', text: 'yes', label: 'Answer line', origin: 'user' },
    { type: 'done', message: 'Answers in place' }
  ], 'answer every question you see');
  await h.run();
  assert.equal(h.contexts[0].profile, 'unknown');   // before classification
  assert.equal(h.contexts[1].profile, 'document');  // after the surface map
  assert.equal(h.updates.at(-1).status, 'done');
});
