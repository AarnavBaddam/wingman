'use strict';
// Real end-to-end check of src/windows-control.js + tools/ydotool.exe against a live Chromium page,
// on every monitor. Moves the real pointer and types into its own window, so leave the mouse alone.
// Run: npm run test:input-e2e
const { app, BrowserWindow, screen } = require('electron');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { createWindowsControl } = require('../../../src/windows-control');

const TOOL = path.join(__dirname, '..', '..', '..', 'tools', 'ydotool.exe');
const PAGE = `<!doctype html><title>ydotool e2e</title><style>
body{margin:0;font:14px sans-serif;background:#fff}
#t{position:absolute;left:20px;top:20px;width:400px;height:80px}
#b{position:absolute;left:450px;top:20px;width:120px;height:40px}
#box{position:absolute;left:20px;top:130px;width:60px;height:60px;background:#39f;touch-action:none}
#src{position:absolute;left:450px;top:80px;width:80px;height:50px;background:#fa3}
#dst{position:absolute;left:600px;top:80px;width:120px;height:90px;background:#3c6}
#sc{position:absolute;left:20px;top:340px;width:300px;height:150px;overflow:auto;border:1px solid #888}
</style><textarea id=t spellcheck=false></textarea><button id=b>hit</button><div id=box></div>
<div id=src draggable=true>drag</div><div id=dst>drop</div><div id=sc><div style="height:6000px"></div></div>
<script>
window.ev=[];window.moves=[];
for(const k of ['mousedown','mouseup','click','dblclick','wheel','keydown','keyup','dragstart','drop'])
  addEventListener(k,e=>ev.push({k,x:e.screenX,y:e.screenY,trusted:e.isTrusted,btn:e.button,shift:e.shiftKey,t:e.target.id}),true);
addEventListener('pointermove',e=>moves.push([performance.now(),e.screenX,e.screenY,e.isTrusted]),true);
addEventListener('dragover',e=>e.preventDefault());
let hold=null;const box=document.getElementById('box');
box.addEventListener('pointerdown',e=>{box.setPointerCapture(e.pointerId);hold=[e.clientX-box.offsetLeft,e.clientY-box.offsetTop]});
box.addEventListener('pointermove',e=>{if(hold){box.style.left=e.clientX-hold[0]+'px';box.style.top=e.clientY-hold[1]+'px'}});
box.addEventListener('pointerup',()=>{hold=null;window.boxUp=(window.boxUp||0)+1});
</script>`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const failures = [];

async function suite(win, other, display) {
  const js = code => win.webContents.executeJavaScript(code);
  const control = createWindowsControl({ getSkipPids: () => [], getDisplay: () => screen.getDisplayMatching(win.getBounds()) });
  const signal = new AbortController().signal;
  const label = `${display.bounds.x},${display.bounds.y} @${display.scaleFactor}x`;
  const check = async (name, fn) => {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { failures.push(`[${label}] ${name}: ${e.message}`); console.log(`  FAIL ${name}: ${e.message}`); }
  };
  const focus = async () => { win.show(); win.focus(); win.webContents.focus(); await sleep(250); };
  await focus();
  const target = await control.lockTarget(signal);
  const hwnd = Number(win.getNativeWindowHandle().readBigUInt64LE());
  const shot = await control.capture(target, signal);
  const k = (display.size.width * display.scaleFactor) / shot.width;
  // Element centre in screenshot pixels, exactly what a model would hand back.
  const centre = async (id, ox = 0, oy = 0) => {
    const r = await js(`(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    const c = win.getContentBounds();
    return { x: (c.x + r.x + ox - display.bounds.x) * display.scaleFactor / k, y: (c.y + r.y + oy - display.bounds.y) * display.scaleFactor / k, dipX: c.x + r.x + ox, dipY: c.y + r.y + oy };
  };
  const reset = () => js(`ev.length=0;moves.length=0;t.value='';sc.scrollTop=0;box.style.left='20px';box.style.top='130px';0`);
  const events = (name) => js(`ev.filter(e=>e.k==='${name}')`);

  await check('fg resolves the real HWND', () => assert.equal(target.handle, hwnd));

  await check('click lands on element, trusted, within 1px', async () => {
    await reset(); const p = await centre('b');
    await control.execute(target, { type: 'click', x: p.x, y: p.y }, signal); await sleep(120);
    const [c] = await events('click');
    assert.ok(c, 'no click event'); assert.equal(c.t, 'b'); assert.equal(c.trusted, true);
    assert.ok(Math.abs(c.x - p.dipX) <= 1 && Math.abs(c.y - p.dipY) <= 1, `at ${c.x},${c.y} want ${p.dipX},${p.dipY}`);
  });

  await check('pointer path has many intermediate trusted moves, no jump', async () => {
    const m = await js('moves');
    assert.ok(m.length >= 8, `only ${m.length} moves`);
    assert.ok(m.every(v => v[3]));
    const total = Math.hypot(m.at(-1)[1] - m[0][1], m.at(-1)[2] - m[0][2]);
    const worst = Math.max(...m.slice(1).map((v, i) => Math.hypot(v[1] - m[i][1], v[2] - m[i][2])));
    assert.ok(total < 40 || worst < total * 0.5, `largest step ${worst} of ${total}`);
  });

  await check('double click fires dblclick', async () => {
    await reset(); const p = await centre('b');
    await control.execute(target, { type: 'click', x: p.x, y: p.y, clicks: 2 }, signal); await sleep(120);
    assert.equal((await events('dblclick')).length, 1); assert.equal((await events('click')).length, 2);
  });

  const text = 'Hello, World! 123 ~`!@#$%^&*()_+-={}[]|\\:;"\'<>,.?/';
  await check('type is character-exact', async () => {
    await reset(); const p = await centre('t');
    await control.execute(target, { type: 'click', x: p.x, y: p.y }, signal); await sleep(80);
    await control.execute(target, { type: 'type', text }, signal); await sleep(120);
    assert.equal(await js('t.value'), text);
    assert.ok((await events('keydown')).every(e => e.trusted));
  });

  await check('clear empties the field', async () => {
    await control.execute(target, { type: 'clear' }, signal); await sleep(120);
    assert.equal(await js('t.value'), '');
  });

  await check('pointer drag moves the box exactly', async () => {
    await reset(); const a = await centre('box');
    const dx = 170, dy = 110;
    await control.execute(target, { type: 'drag', x: a.x, y: a.y, toX: a.x + dx * display.scaleFactor / k, toY: a.y + dy * display.scaleFactor / k }, signal); await sleep(150);
    const left = await js('box.offsetLeft'), top = await js('box.offsetTop');
    assert.ok(Math.abs(left - 190) <= 1 && Math.abs(top - 240) <= 1, `box at ${left},${top}`);
  });

  await check('native HTML5 drag and drop', async () => {
    await reset(); const a = await centre('src'), b = await centre('dst');
    await control.execute(target, { type: 'drag', x: a.x, y: a.y, toX: b.x, toY: b.y }, signal); await sleep(300);
    assert.equal((await events('dragstart')).length, 1, 'no dragstart');
    const [d] = await events('drop'); assert.ok(d, 'no drop'); assert.equal(d.trusted, true);
  });

  await check('scroll moves the right element in the right direction', async () => {
    await reset(); const p = await centre('sc');
    await control.execute(target, { type: 'scroll', x: p.x, y: p.y, amount: 3 }, signal); await sleep(350);
    const down = await js('sc.scrollTop');
    assert.ok(down > 0, `scrollTop ${down}`);
    await control.execute(target, { type: 'scroll', x: p.x, y: p.y, amount: -3 }, signal); await sleep(350);
    assert.ok((await js('sc.scrollTop')) < down);
    assert.equal((await events('wheel')).length, 6);
  });

  await check('nudge via capture puts the pointer back exactly', async () => {
    const before = screen.getCursorScreenPoint();
    await control.capture(target, signal);
    const after = screen.getCursorScreenPoint();
    assert.deepEqual(after, before);
  });

  await check('focus drift: locked window comes back, click still lands', async () => {
    await reset(); const p = await centre('b');
    other.show(); other.focus(); await sleep(300);
    await control.execute(target, { type: 'click', x: p.x, y: p.y }, signal); await sleep(150);
    other.hide();
    assert.equal((await events('click')).length, 1);
  });

  await check('activate restores a minimized target', async () => {
    await reset(); win.setAlwaysOnTop(false); win.minimize(); await sleep(500);
    await control.capture(target, signal).catch(() => {}); await sleep(200);
    win.setAlwaysOnTop(true);
    assert.equal(win.isMinimized(), false); assert.equal(win.isFocused(), true);
  });

  await check('abort mid-drag lifts the button', async () => {
    await focus(); await reset(); const a = await centre('box');
    const ac = new AbortController();
    const run = control.execute(target, { type: 'drag', x: a.x, y: a.y, toX: a.x + 500, toY: a.y + 300 }, ac.signal);
    await sleep(420); ac.abort();
    await assert.rejects(run); await sleep(250);
    assert.equal((await js('window.boxUp||0')) > 0, true);
    const m = await events('mouseup'), d = await events('mousedown');
    assert.equal(d.length, 1, 'abort landed before button down; timing needs adjusting'); assert.equal(m.length, 1, 'button still down');
  });

  await check('abort mid-type: exact prefix, Shift not stuck', async () => {
    await focus(); await reset(); const p = await centre('t');
    await control.execute(target, { type: 'click', x: p.x, y: p.y }, signal); await sleep(80);
    const long = 'ABCDEFGH'.repeat(40);
    const ac = new AbortController();
    const run = control.execute(target, { type: 'type', text: long }, ac.signal);
    await sleep(700); ac.abort();
    await assert.rejects(run); await sleep(200);
    const got = await js('t.value');
    assert.ok(got.length > 0 && got.length < long.length && long.startsWith(got), `got ${got.length} chars`);
    await control.execute(target, { type: 'clear' }, signal); await sleep(100);
    await control.execute(target, { type: 'type', text: 'abc' }, signal); await sleep(150);
    assert.equal(await js('t.value'), 'abc', 'modifier stuck');
  });

  await check('1000 char type: exact, in budget', async () => {
    await reset(); const p = await centre('t');
    await control.execute(target, { type: 'click', x: p.x, y: p.y }, signal); await sleep(80);
    const long = 'The quick brown fox, jumps over 13 lazy dogs! '.repeat(22).slice(0, 1000);
    const t0 = Date.now();
    await control.execute(target, { type: 'type', text: long }, signal);
    console.log(`       1000 chars in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await sleep(200);
    assert.equal(await js('t.value'), long);
  });
}

app.whenReady().then(async () => {
  const start = screen.getCursorScreenPoint();
  const win = new BrowserWindow({ width: 800, height: 560, show: false, alwaysOnTop: true, frame: true, title: 'ydotool e2e', webPreferences: { backgroundThrottling: false } });
  const other = new BrowserWindow({ width: 300, height: 200, show: false, title: 'ydotool e2e distractor' });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  await other.loadURL('data:text/html,distractor');
  try {
    for (const display of screen.getAllDisplays()) {
      console.log(`display ${display.bounds.width}x${display.bounds.height} at ${display.bounds.x},${display.bounds.y} scale ${display.scaleFactor}`);
      win.setBounds({ x: display.workArea.x + 60, y: display.workArea.y + 60, width: 800, height: 560 });
      other.setBounds({ x: display.workArea.x + 200, y: display.workArea.y + 200, width: 300, height: 200 });
      await suite(win, other, display);
    }
  } catch (e) { failures.push(`suite aborted: ${e.stack}`); }
  try { execFileSync(TOOL, ['release']); execFileSync(TOOL, ['mousemove', '-a', '--instant', '--', String(start.x), String(start.y)]); } catch {}
  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  ' + f);
  app.exit(failures.length ? 1 : 0);
});
