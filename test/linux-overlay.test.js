const test = require('node:test');
const assert = require('node:assert/strict');
const { configureLinuxOverlay, createHyprGesture } = require('../src/linux-overlay');

test('native Hyprland configures a narrowly matched floating overlay before mapping', () => {
  const calls = [];
  assert.equal(configureLinuxOverlay({ platform: 'linux', env: { HYPRLAND_INSTANCE_SIGNATURE: 'session' }, call: args => { calls.push(args); return 'ok\n'; } }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'eval');
  assert.match(calls[0][1], /class = "\^dev\\\\\.prahladv\\\\\.aether\$"/);
  assert.match(calls[0][1], /float = true/);
  assert.match(calls[0][1], /pin = false/);
  assert.match(calls[0][1], /aether_overlay_rule_v2:set_enabled\(false\)/);
  assert.match(calls[0][1], /no_blur = true/);
  assert.match(calls[0][1], /size = \{700, 420\}/);
  assert.match(calls[0][1], /if not .* then/);
});

test('headless, other desktops, and other platforms do not change Hyprland', () => {
  const call = () => { throw Error('Must not invoke compositor'); };
  for (const options of [
    {platform:'linux',env:{}},
    {platform:'linux',env:{HYPRLAND_INSTANCE_SIGNATURE:'session'},headless:true},
    {platform:'darwin',env:{HYPRLAND_INSTANCE_SIGNATURE:'session'}},
    {platform:'win32',env:{HYPRLAND_INSTANCE_SIGNATURE:'session'}}
  ]) assert.equal(configureLinuxOverlay({...options,call}), false);
});

test('compositor refusal or missing helper produces useful setup guidance', () => {
  for (const call of [() => 'Lua error', () => {throw Error('ENOENT');}]) {
    assert.throws(() => configureLinuxOverlay({platform:'linux',env:{HYPRLAND_INSTANCE_SIGNATURE:'session'},call}), /Hyprland.*floating.*0\.55/);
  }
});

test('Hyprland gestures use compositor coordinates, preserve the far corner, and target only Aether', async () => {
  const scripts=[];
  const options={platform:'linux',env:{HYPRLAND_INSTANCE_SIGNATURE:'session'},pid:42,
    callSync:args=>JSON.stringify(args[1]==='clients'?[{pid:42,class:'dev.prahladv.aether',address:'0xabc',floating:true,at:[100,80],size:[700,420]}]:{x:200,y:200}),
    call:async args=>{if(args[1]==='cursorpos')return JSON.stringify({x:250,y:230});scripts.push(args[1]);return 'ok\n';}};
  for(const mode of ['move','bottom-left','bottom-right']){
    const gesture=createHyprGesture(mode,options);await gesture.update();gesture.stop();
  }
  assert.match(scripts[0],/x=150,y=110,relative=false,window=w/);
  assert.match(scripts[1],/x=650,y=450,relative=false,window=w/);
  assert.match(scripts[1],/x=150,y=80,relative=false,window=w/);
  assert.match(scripts[2],/x=750,y=450,relative=false,window=w/);
  assert(scripts.every(script=>script.includes('w.pid == 42 and w.class == "dev.prahladv.aether"')));
  assert.equal(createHyprGesture('move',{platform:'linux',env:{}}),null);
  assert.throws(()=>createHyprGesture('move',{...options,pid:0}),/Invalid window process/);
});

test('ending a Hyprland gesture cancels pending motion before changing any window', async () => {
  let resolveCursor;
  const scripts=[];
  const gesture=createHyprGesture('move',{platform:'linux',env:{HYPRLAND_INSTANCE_SIGNATURE:'session'},pid:42,
    callSync:args=>JSON.stringify(args[1]==='clients'?[{pid:42,class:'dev.prahladv.aether',address:'0xabc',floating:true,at:[100,80],size:[700,420]}]:{x:200,y:200}),
    call:args=>args[1]==='cursorpos'?new Promise(resolve=>{resolveCursor=resolve;}):(scripts.push(args[1]),Promise.resolve('ok'))});
  const pending=gesture.update();gesture.stop();resolveCursor('{"x":250,"y":230}');await pending;
  assert.deepEqual(scripts,[]);
});

test('releasing flushes the final cursor position even before the first motion read completes', async () => {
  let resolveCursor;
  const scripts=[];
  let cursorReads=0;
  const gesture=createHyprGesture('move',{platform:'linux',env:{HYPRLAND_INSTANCE_SIGNATURE:'session'},pid:42,
    callSync:args=>JSON.stringify(args[1]==='clients'?[{pid:42,class:'dev.prahladv.aether',address:'0xabc',floating:true,at:[100,80],size:[700,420]}]:cursorReads++?{x:280,y:240}:{x:200,y:200}),
    call:args=>args[1]==='cursorpos'?new Promise(resolve=>{resolveCursor=resolve;}):(scripts.push(args[1]),Promise.resolve('ok'))});
  const pending=gesture.update();
  const finished=gesture.finish();
  resolveCursor('{"x":250,"y":230}');
  await Promise.all([pending,finished]);
  assert.match(scripts.at(-1),/x=180,y=120,relative=false,window=w/);
  assert.match(scripts.at(-1),/get_monitor_at\(530, 330\).*follow=false/);
});
