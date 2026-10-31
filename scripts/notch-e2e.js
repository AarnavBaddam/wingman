'use strict';
// Drives the real Aether notch on the real desktop with tools/ydotool.exe and asserts live state.
// Moves the pointer and types into Aether only; leave the mouse alone. Needs HeyClicky closed
// (it owns the same screen spot). Run: npm run test:notch-e2e
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..');
const TOOL = path.join(root, 'tools', 'ydotool.exe');
const ELECTRON = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const y = (...args) => execFileSync(TOOL, args.map(String), { encoding: 'utf8' });
const fg = () => JSON.parse(y('fg')).handle;

function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); pending.delete(d.id); };
  const ready = new Promise(r => { ws.onopen = r; });
  return {
    ws,
    async eval(expression) {
      await ready;
      const n = ++id;
      ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true } }));
      const d = await new Promise(r => pending.set(n, r));
      if (d.result?.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 300));
      return d.result?.result?.value;
    }
  };
}
async function until(fn, ms = 3000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out waiting for ' + what);
}

(async () => {
  const start = y('debug') && execFileSync('powershell', ['-NoProfile', '-c', 'Add-Type -A System.Windows.Forms;$p=[Windows.Forms.Cursor]::Position;"$($p.X) $($p.Y)"'], { encoding: 'utf8' }).trim().split(' ').map(Number);
  y('mousemove', '-a', '--instant', 1280, 900);
  const app = spawn(ELECTRON, ['.', '--remote-debugging-port=9333', '--inspect=9339'], { cwd: root, env: { ...process.env, AETHER_QA_CAPTURE: '1' }, stdio: 'ignore' });
  let passed = 0; const failures = [];
  let settle = async () => {}; // becomes a wait for a still pointer once main is reachable
  const check = async (name, fn) => {
    await settle();
    try { await fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}: ${e.message}`); }
  };
  try {
    await sleep(5000);
    const targets = await until(async () => { try { return await (await fetch('http://127.0.0.1:9333/json')).json(); } catch { return null; } }, 8000, 'renderer debugger');
    const page = cdp(targets.find(t => t.type === 'page' && /index\.html/.test(t.url)).webSocketDebuggerUrl);
    const inspector = await until(async () => { try { return await (await fetch('http://127.0.0.1:9339/json')).json(); } catch { return null; } }, 8000, 'main debugger');
    const main = cdp(inspector[0].webSocketDebuggerUrl);
    // Auto-hide would remove the window between checks. Sent to the renderer only, so the saved setting is untouched.
    await main.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.send('notch:settings',{autoHide:false})`);
    // A person using the machine trips interference detection, so each check waits for a still pointer.
    settle = async () => {
      const at = () => main.eval(`JSON.stringify(process.mainModule.require('electron').screen.getCursorScreenPoint())`);
      let last = await at(), since = Date.now();
      const end = Date.now() + 120000;
      while (Date.now() - since < 2000 && Date.now() < end) {
        await sleep(100);
        const now = await at();
        if (now !== last) { last = now; since = Date.now(); }
      }
    };
    const view = () => page.eval(`document.getElementById('notch-shape').dataset.view`);
    const size = () => page.eval(`(()=>{const r=document.getElementById('notch-shape').getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})()`);
    const bounds = () => main.eval(`(()=>{const {BrowserWindow}=process.mainModule.require('electron');const b=BrowserWindow.getAllWindows()[0].getBounds();return b})()`);
    const emit = state => main.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.send('notch:state',${JSON.stringify(state)})`);
    const home = async () => { y('mousemove', '-a', '--duration', 120, 1280, 900); await until(async () => (await view()) === 'rest', 2500, 'rest'); };
    const hover = async () => { y('mousemove', '-a', '--duration', 120, 1280, 3); await until(async () => (await view()) === 'peek', 2000, 'peek'); };
    const prior = fg();

    await check('rests as a tiny bar in a fixed window', async () => {
      assert.equal(await view(), 'rest');
      await until(async () => { const s = await size(); return s[0] === 64 && s[1] === 8; }, 1500, '64x8');
      const b = await bounds();
      assert.deepEqual([b.width, b.y], [1120, 0]);
    });

    await check('resting window is click-through and takes no focus', async () => {
      const ignored = await page.eval(`document.elementFromPoint(40,500)?.closest('#notch-shape,#notch-hit') ? 'hit' : 'pass'`);
      assert.equal(ignored, 'pass');
      assert.equal(fg(), prior);
    });

    await check('hover opens the peek without stealing focus or resizing the window', async () => {
      const before = await bounds();
      await hover();
      await until(async () => { const s = await size(); return s[0] === 548 && s[1] === 212; }, 1500, 'peek size');
      assert.deepEqual(await bounds(), before);
      assert.equal(fg(), prior);
    });

    await check('peek open runs at display rate, no long frames', async () => {
      await home(); await sleep(300);
      await page.eval(`window.__f=[];(function t(n){window.__f.push([n,document.getElementById('notch-shape').getBoundingClientRect().width]);if(window.__f.length<140)requestAnimationFrame(t)})(performance.now());0`);
      await hover();
      await sleep(500);
      const frames = (await page.eval('window.__f')).filter((f, i, a) => i && (a[i - 1][1] !== f[1]));
      const gaps = frames.slice(1).map((f, i) => f[0] - frames[i][0]).sort((a, b) => a - b);
      const median = gaps[gaps.length >> 1], worst = gaps.at(-1), span = frames.at(-1)[0] - frames[0][0];
      console.log(`       ${frames.length} animated frames in ${span.toFixed(0)}ms, median ${median.toFixed(1)}ms, worst ${worst.toFixed(1)}ms`);
      assert.ok(frames.length > 12); assert.ok(worst < 40, 'long frame ' + worst);
    });

    await check('leaving tucks back to rest', async () => { await home(); });

    await check('interrupting a close mid-way reverses smoothly', async () => {
      await hover();
      y('mousemove', '-a', '--instant', 1280, 900);
      await until(async () => (await size())[1] < 170, 1500, 'closing');
      y('mousemove', '-a', '--instant', 1280, 3);
      await until(async () => (await view()) === 'peek' && (await size())[1] === 212, 2000, 'reopened');
    });

    await check('Escape closes and stays closed until the pointer leaves', async () => {
      await home(); await hover();
      y('click-at', 1280, 72);
      await until(async () => (await view()) === 'sheet', 1500, 'sheet');
      await sleep(250);
      y('key', '1:1', '1:0');
      await until(async () => (await view()) === 'rest', 1500, 'closed');
      await sleep(500);
      assert.equal(await view(), 'rest', 'reopened under a still pointer');
      await home();
    });

    await check('clicking Ask opens the sheet focused; typed text reaches the composer', async () => {
      await hover();
      y('click-at', 1280, 72);
      await until(async () => (await view()) === 'sheet', 1500, 'sheet');
      await until(async () => (await page.eval(`document.activeElement.id`)) === 'input', 1500, 'focus in composer');
      y('type', '-d', 3, '-H', 3, 'hello notch');
      await until(async () => (await page.eval(`document.getElementById('input').value`)) === 'hello notch', 1500, 'text');
    });

    await check('a draft holds the sheet open after the pointer leaves', async () => {
      y('mousemove', '-a', '--duration', 120, 1280, 900);
      await sleep(900);
      assert.equal(await view(), 'sheet');
    });

    await check('clearing the draft lets it tuck, and focus returns', async () => {
      await page.eval(`(()=>{const i=document.getElementById('input');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));i.blur();})()`);
      await until(async () => (await view()) === 'rest', 2000, 'tuck');
      await until(() => fg() === prior, 1500, 'focus back on the previous app');
    });

    await check('pin keeps the sheet open and is remembered', async () => {
      await hover(); y('click-at', 1280, 72);
      await until(async () => (await view()) === 'sheet', 1500, 'sheet');
      await sleep(200);
      await page.eval(`document.getElementById('notch-pin').click()`);
      y('mousemove', '-a', '--duration', 120, 1280, 900);
      await sleep(800);
      assert.equal(await view(), 'sheet');
      assert.equal(await page.eval(`localStorage.getItem('aether.notch.pin')`), 'true');
      await page.eval(`document.getElementById('notch-pin').click()`);
      await page.eval(`document.getElementById('notch-collapse').click()`);
      await until(async () => (await view()) === 'rest', 1500, 'collapsed');
    });

    await check('Show / hide path opens and closes from main', async () => {
      await main.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.send('notch:set',{open:true,focus:false})`);
      await until(async () => (await view()) === 'sheet', 1500, 'sheet');
      await sleep(700);
      assert.equal(await view(), 'sheet', 'must not tuck before the pointer has ever entered');
      await main.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.send('notch:set',{open:false,focus:false})`);
      await until(async () => (await view()) === 'rest', 1500, 'rest');
    });

    await check('edge resize grows evenly and persists', async () => {
      await hover(); y('click-at', 1280, 72);
      await until(async () => (await view()) === 'sheet', 1500, 'sheet');
      await until(async () => (await size())[0] === 600, 1500, 'sheet width');
      await sleep(250);
      await page.eval(`document.getElementById('notch-pin').click()`);
      y('drag', 1280 + 300, 300, 1280 + 350, 300);
      await until(async () => (await size())[0] === 700, 1500, 'width 700');
      assert.equal(await page.eval(`JSON.parse(localStorage.getItem('aether.notch.size')).w`), 700);
      await page.eval(`localStorage.removeItem('aether.notch.size');document.getElementById('notch-pin').click();document.getElementById('notch-collapse').click()`);
      await until(async () => (await view()) === 'rest', 1500, 'rest');
    });

    await check('Auto running: live status shows, hover stays out, clicks pass through', async () => {
      await home();
      await emit({ auto: { active: true, step: 3, message: 'Clicking the next button', target: 'desk' }, listening: false, toggleLabel: 'Ctrl' });
      await until(async () => (await size())[1] === 34, 1500, 'live height');
      assert.equal(await page.eval(`document.getElementById('n-text').textContent`), 'Clicking the next button');
      assert.equal(await page.eval(`document.body.classList.contains('notch-busy')`), true);
      y('mousemove', '-a', '--duration', 120, 1280, 3);
      await sleep(600);
      assert.equal(await view(), 'rest', 'Auto pointer must not open the notch');
      y('mousemove', '-a', '--duration', 120, 1280, 900);
    });

    await check('finished status expires back to the bar', async () => {
      await emit({ auto: { status: 'error', message: 'Could not reach the target.' }, listening: false, toggleLabel: 'Ctrl' });
      await until(async () => (await page.eval(`document.getElementById('n-key').textContent`)) === 'OPEN', 1000, 'error status');
      assert.equal(await page.eval(`document.body.classList.contains('notch-busy')`), false);
      await emit({ auto: {}, listening: false, toggleLabel: 'Ctrl' });
      await until(async () => (await size())[1] === 8, 1500, 'bar');
    });

    const text = () => page.eval(`document.getElementById('n-text').textContent`);
    await check('answer stages update the notch live, then ANSWERED, then back to the bar', async () => {
      await home();
      await until(async () => (await size())[1] === 8, 1500, 'bar');
      await emit({ answer: { status: 'working', message: 'Thinking', at: Date.now() }, auto: {}, listening: false, toggleLabel: '' });
      await until(async () => (await text()) === 'Thinking' && (await size())[1] === 34, 1500, 'Thinking');
      assert.equal(await page.eval(`document.getElementById('notch-shape').dataset.sweep`), '1');
      await emit({ answer: { status: 'working', message: 'Reading your screen…', at: Date.now() }, auto: {}, listening: false, toggleLabel: '' });
      await until(async () => (await text()) === 'Reading your screen', 1000, 'phase');
      await emit({ answer: { status: 'done', at: Date.now() - 9000 }, auto: {}, listening: false, toggleLabel: '' });
      await until(async () => (await text()) === 'ANSWERED', 1000, 'ANSWERED');
      assert.equal(await page.eval(`document.getElementById('notch-shape').dataset.sweep`), '');
      await until(async () => (await size())[1] === 8, 2500, 'expired back to bar');
    });

    await check('a finished status does not come back on the next update', async () => {
      await emit({ auto: { status: 'done', message: 'All set', at: Date.now() - 9000 }, answer: {}, listening: false, toggleLabel: '' });
      await sleep(400);
      assert.equal((await size())[1], 8);
    });

    await check('an event through main reaches the notch and re-shows an auto-hidden window', async () => {
      const focused = fg();
      const shown = () => main.eval("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].isVisible()");
      await main.eval("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].hide()");
      await until(async () => !(await shown()), 1000, 'hidden');
      // An empty research question fails inside main before any provider is called.
      await page.eval("wingman.ask({ mode: 'research', text: '' })");
      await until(shown, 1500, 'window back');
      await until(async () => (await text()) === 'Type a research question first', 1500, 'error status');
      assert.equal(fg(), focused, 'must not take focus');
      await emit({ answer: {}, auto: {}, listening: false, toggleLabel: '' });
    });

    await check('settings keeps the sheet open; closing it lets it tuck', async () => {
      await hover();
      await page.eval(`document.querySelector('[data-open="#more-btn"]').click()`);
      await until(async () => !(await page.eval(`document.getElementById('settings-scrim').classList.contains('hidden')`)), 1500, 'settings');
      y('mousemove', '-a', '--duration', 120, 1280, 900);
      await sleep(800);
      assert.equal(await view(), 'sheet');
      await page.eval(`document.getElementById('s-close').click()`);
      await until(async () => (await view()) === 'rest', 2000, 'tuck');
    });
  } catch (e) { failures.push('aborted: ' + e.message); }
  finally {
    app.kill();
    try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    y('release');
    y('mousemove', '-a', '--instant', '--', start[0], start[1]);
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  failures.forEach(f => console.log('  ' + f));
  process.exit(failures.length ? 1 : 0);
})();
