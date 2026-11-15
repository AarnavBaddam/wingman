const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { createZenControl } = require('../src/zen-control');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const events = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/state?')) {
      events.push(Object.fromEntries(new URL(req.url, 'http://localhost').searchParams)); res.end('ok'); return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<p>TOP MATCH: x^5</p><div style="height:1600px"></div><p>Bottom question</p>
      <input id="answer"><div style="height:1200px"></div><script>
      const report=()=>{const a=document.querySelector('#answer'),r=a.getBoundingClientRect();
        fetch('/state?'+new URLSearchParams({y:scrollY,w:innerWidth,h:innerHeight,active:document.activeElement.localName,value:a.value,x:r.x,top:r.y}));};
      for(const event of ['scroll','resize','focusin','input'])addEventListener(event,report);
      setTimeout(()=>{scrollTo(0,1450);document.body.tabIndex=-1;document.body.focus({preventScroll:true});report()},300);
      </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const portServer = net.createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-focus-qa-'));
  fs.writeFileSync(path.join(profile, 'user.js'), `user_pref("marionette.port", ${port});
    user_pref("focusmanager.testmode", true);
    user_pref("browser.shell.checkDefaultBrowser", false);
    user_pref("browser.startup.homepage_override.mstone", "ignore");
    user_pref("browser.aboutwelcome.enabled", false);`);
  const log = fs.openSync(path.join(profile, 'browser.log'), 'w');
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = spawn(process.env.AETHER_ZEN_BINARY || '/opt/zen-browser-bin/zen-bin',
    ['--headless', '--no-remote', '--profile', profile, '--marionette', url], { stdio: ['ignore', log, log] });
  const control = createZenControl({ port, timeoutMs: 3000 });
  try {
    for (let n = 0; ; n++) {
      try { await control.connect(); break; } catch (error) { if (n === 59) throw error; await wait(200); }
    }
    let tab;
    for (let n = 0; n < 50 && !tab; n++) {
      tab = (await control.listTabs()).find(t => t.url.startsWith(url));
      if (!tab) await wait(100);
    }
    assert(tab, 'owned QA page must load');
    for (let n = 0; n < 50 && events.at(-1)?.y !== '1450'; n++) await wait(100);
    const before = events.at(-1);
    assert.equal(before?.active, 'body');
    assert.equal(before.y, '1450');
    const target = await control.lockTarget(tab.id);
    await control.capture(target);
    const text = '1024/x^5-3840y/x^4';
    await assert.rejects(control.execute(target, { type: 'type', text }), { code: 'INPUT_FOCUS' });
    await wait(100);
    assert.deepEqual(events.at(-1), before, 'blocked text must not open Quick Find or move the page');
    await control.capture(target);
    await control.execute(target, { type: 'click', x: Number(before.x) + 20, y: Number(before.top) + 10, intent: 'focus' });
    await control.capture(target);
    await control.execute(target, { type: 'type', text });
    for (let n = 0; n < 50 && events.at(-1)?.value !== text; n++) await wait(100);
    const after = events.at(-1);
    assert.equal(after.value, text);
    assert.equal(after.y, before.y);
    assert.equal(after.h, before.h);
    console.log(`PASS: native Zen blocked unfocused fraction, preserved scroll/viewport, and entered full text after focus (${before.w}x${before.h})`);
  } finally {
    await control.close(); browser.kill('SIGTERM');
    await new Promise(resolve => server.close(resolve));
    fs.closeSync(log);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
