const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/screen.js'),'utf8');
function harness({hypr=false,fail=false}={}){
 const calls=[];const displays=[{id:1,size:{width:1920,height:1080},scaleFactor:1},{id:2,size:{width:1920,height:1080},scaleFactor:1}];
 const context=vm.createContext({module:{exports:{}},Buffer,process:{platform:'linux',env:hypr?{HYPRLAND_INSTANCE_SIGNATURE:'session'}:{}},require:name=>{
  if(name==='electron')return {app:{commandLine:{getSwitchValue:()=>''}},screen:{getPrimaryDisplay:()=>displays[0],getCursorScreenPoint:()=>({x:2000,y:100}),getDisplayNearestPoint:p=>p.x>=1920?displays[1]:displays[0]},desktopCapturer:{getSources:async()=>displays.map(d=>({display_id:String(d.id),thumbnail:{isEmpty:()=>false,toDataURL:()=>`display:${d.id}`}}))}};
  if(name==='node:child_process')return {execFile(){}};
  if(name==='node:util')return {promisify:()=>async(cmd,args,options)=>{calls.push([cmd,args,options]);if(fail)throw Error('Unavailable');return {stdout:cmd==='grim'?(options.encoding==='buffer'?Buffer.from('89504e470d0a1a0a00','hex'):'invalid UTF-8 screenshot'):JSON.stringify(args[1]==='cursorpos'?{x:100,y:100}:[{name:'LEFT',x:0,y:0,width:1920,height:1080,scale:1},{name:'RIGHT',x:1920,y:0,width:1920,height:1080,scale:1}])};}};
  return require(name);
 }});
 vm.runInContext(source,context);return {capture:context.module.exports.captureScreenshot,calls};
}
test('screen capture uses the current or supplied interaction display instead of always primary',async()=>{
 const h=harness();assert.equal(await h.capture(),'display:2');assert.equal(await h.capture({x:100,y:100}),'display:1');
});
test('Hyprland captures the interaction monitor even after cursor moves elsewhere',async()=>{
 const h=harness({hypr:true});await h.capture({x:2200,y:100});
 assert(h.calls.some(([cmd,args])=>cmd==='grim'&&args.includes('RIGHT')));
 assert(h.calls.some(([cmd,,options])=>cmd==='grim'&&options.encoding==='buffer'));
 assert(!h.calls.some(([,args])=>args[1]==='cursorpos'));
});
test('Hyprland setup errors fail closed with useful capture guidance',async()=>{
 await assert.rejects(harness({hypr:true,fail:true}).capture(),/grim|Hyprland/);
});
