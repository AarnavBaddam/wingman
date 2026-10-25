'use strict';
// Remote Auto: `Aether --auto "goal" [--zen-url URL] [--allow-submit]` starts an Auto run in the
// running Aether (or on a cold start). Used by textAgent over WhatsApp. Local launches only:
// whoever can run this command already controls the desktop.

// Accepts `--name=value` (use this: Chromium reorders a second instance's argv and can split
// `--name value` pairs) and `--name value`. Returns undefined when the flag is absent.
function flag(argv, name) {
  const eq = argv.find(arg => typeof arg === 'string' && arg.startsWith(name + '='));
  if (eq !== undefined) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i < 0 ? undefined : String(argv[i + 1] ?? '');
}

function parseRemoteAuto(argv) {
  const rawGoal = flag(argv, '--auto');
  if (rawGoal === undefined) return null;
  const goal = rawGoal.trim();
  if (!goal || goal.startsWith('--') || goal.length > 4000) throw new Error('--auto needs a goal (max 4000 chars).');
  const rawUrl = flag(argv, '--zen-url');
  const zenUrl = rawUrl === undefined ? null : rawUrl;
  if (zenUrl !== null && (!/^https?:\/\//i.test(zenUrl) || zenUrl.length > 4000)) throw new Error('--zen-url must be an http(s) URL.');
  return { goal, zenUrl, allowSubmit: argv.includes('--allow-submit') };
}

// Same origin and the tab's path starts with the wanted path. Hostname alone is not enough:
// every Google Doc, Sheet and Form shares docs.google.com.
function sameSite(tabUrl, wanted) {
  try {
    const tab = new URL(tabUrl), want = new URL(wanted), strip = p => p.replace(/\/+$/, '');
    return tab.origin === want.origin && (strip(tab.pathname) + '/').startsWith(strip(want.pathname) + '/');
  } catch { return false; }
}

// Finds (or opens) the Zen tab, starts Auto, and reports start and end through writeResult.
async function runRemoteAuto(request, { getZen, openInZen, showPanel, startAutoMode, waitForEnd, writeResult,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), waitMs = 15000 }) {
  const report = fields => writeResult({ ...fields, goal: request.goal, zenUrl: request.zenUrl, at: new Date().toISOString() });
  try {
    let options = { target: 'desktop', allowSubmit: request.allowSubmit };
    if (request.zenUrl) {
      const zen = getZen();
      await zen.connect();
      const find = async () => (await zen.listTabs()).find(tab => sameSite(tab.url, request.zenUrl));
      let tab = await find();
      if (!tab) {
        await openInZen(request.zenUrl);
        for (let waited = 0; !tab && waited < waitMs; waited += 1000) { await sleep(1000); tab = await find(); }
      }
      if (!tab) throw new Error(`Zen tab for ${request.zenUrl} did not appear within ${waitMs / 1000}s.`);
      options = { ...options, target: 'zen', tabId: tab.id };
    }
    showPanel();
    await startAutoMode(request.goal, options);
    report({ status: 'running', message: 'Auto started.' });
    const end = await waitForEnd();
    report({ status: end?.status || 'unknown', message: end?.message || '' });
  } catch (error) {
    report({ status: 'error', message: error?.message || String(error) });
  }
}

module.exports = { parseRemoteAuto, runRemoteAuto, sameSite };
