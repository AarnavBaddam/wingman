const test = require('node:test'), assert = require('node:assert/strict');
const { parseRemoteAuto, runRemoteAuto, sameSite } = require('../src/remote-auto');

test('parse: ignores normal launches, reads goal, url and submit flag', () => {
  assert.equal(parseRemoteAuto(['aether']), null);
  assert.deepEqual(parseRemoteAuto(['aether', '--auto', ' fill the form ', '--zen-url', 'https://a.com/x', '--allow-submit']),
    { goal: 'fill the form', zenUrl: 'https://a.com/x', allowSubmit: true });
  assert.deepEqual(parseRemoteAuto(['--auto', 'g']), { goal: 'g', zenUrl: null, allowSubmit: false });
  // Chromium-reordered second-instance argv keeps --name=value pairs intact.
  assert.deepEqual(parseRemoteAuto(['aether', '--allow-submit', '--zen-url=https://a.com', '--auto=log in, then stop', 'stray']),
    { goal: 'log in, then stop', zenUrl: 'https://a.com', allowSubmit: true });
  assert.throws(() => parseRemoteAuto(['--auto=']), /needs a goal/);
  assert.throws(() => parseRemoteAuto(['--auto']), /needs a goal/);
  assert.throws(() => parseRemoteAuto(['--auto', '--zen-url', 'https://a.com']), /needs a goal/);
  assert.throws(() => parseRemoteAuto(['--auto', 'g', '--zen-url', 'file:///etc/passwd']), /http/);
});

test('sameSite matches origin plus path prefix and tolerates bad urls', () => {
  assert.ok(sameSite('https://a.com/', 'https://a.com'));
  assert.ok(sameSite('https://a.com/login?x=1', 'https://a.com/login'));
  assert.ok(!sameSite('https://a.com/', 'https://a.com/login'));
  const form = 'https://docs.google.com/forms/d/e/ABC/viewform';
  assert.ok(sameSite(form + '?usp=sf_link', form));
  assert.ok(!sameSite('https://docs.google.com/document/d/XYZ/edit', form));  // an open Doc must not match a Form
  assert.ok(!sameSite('https://docs.google.com/forms/d/e/ABCD/viewform', 'https://docs.google.com/forms/d/e/ABC'));
  assert.ok(!sameSite('https://b.com/', 'https://a.com'));
  assert.ok(!sameSite('about:blank', 'https://a.com'));
});

function deps(over = {}) {
  const results = [], started = [], opened = []; let tabs = over.tabs || [];
  return { results, started, opened, d: {
    getZen: () => ({ connect: async () => {}, listTabs: async () => tabs }),
    openInZen: async url => { opened.push(url); if (over.appearOnOpen) tabs = [{ id: 't9', url: url + '/' }]; },
    showPanel: () => {}, startAutoMode: async (goal, options) => { started.push({ goal, options }); },
    waitForEnd: async () => ({ status: 'done', message: 'Submitted.' }),
    writeResult: r => results.push(r), sleep: async () => {}, waitMs: 3000, ...over.d } };
}

test('uses an existing matching Zen tab', async () => {
  const h = deps({ tabs: [{ id: 't1', url: 'https://a.com/page' }] });
  await runRemoteAuto({ goal: 'g', zenUrl: 'https://a.com', allowSubmit: false }, h.d);
  assert.deepEqual(h.started, [{ goal: 'g', options: { target: 'zen', allowSubmit: false, tabId: 't1' } }]);
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.results.map(r => r.status), ['running', 'done']);
});

test('opens the url when no tab matches, then waits for it', async () => {
  const h = deps({ appearOnOpen: true });
  await runRemoteAuto({ goal: 'g', zenUrl: 'https://a.com', allowSubmit: true }, h.d);
  assert.deepEqual(h.opened, ['https://a.com']);
  assert.equal(h.started[0].options.tabId, 't9');
  assert.equal(h.started[0].options.allowSubmit, true);
});

test('reports an error when the tab never appears or Zen is unreachable', async () => {
  const h = deps();
  await runRemoteAuto({ goal: 'g', zenUrl: 'https://a.com', allowSubmit: false }, h.d);
  assert.equal(h.started.length, 0);
  assert.match(h.results.at(-1).message, /did not appear/);
  const z = deps({ d: { getZen: () => ({ connect: async () => { throw new Error('Restart Zen with --marionette'); } }) } });
  await runRemoteAuto({ goal: 'g', zenUrl: 'https://a.com', allowSubmit: false }, z.d);
  assert.equal(z.results.at(-1).status, 'error');
  assert.match(z.results.at(-1).message, /marionette/);
});

test('desktop target when no url is given', async () => {
  const h = deps();
  await runRemoteAuto({ goal: 'g', zenUrl: null, allowSubmit: false }, h.d);
  assert.deepEqual(h.started[0].options, { target: 'desktop', allowSubmit: false });
});
