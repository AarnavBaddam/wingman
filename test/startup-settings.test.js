const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
test('normal relaunch restores the dock and panel while Auto handoff keeps its own visibility',()=>{
 let relaunch,auto=false;const shown=[];
 const context=vm.createContext({app:{requestSingleInstanceLock:()=>true,on:(_name,fn)=>{relaunch=fn;}},
  handleRemoteAuto:()=>auto,showDock:()=>shown.push('dock'),showWindow:()=>shown.push('panel')});
 const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
 vm.runInContext(source.slice(source.indexOf('// One Aether per desktop:'),source.indexOf('// -------- lifecycle')),context);
 relaunch(null,[]);assert.deepEqual(shown,['dock','panel']);
 shown.length=0;auto=true;relaunch(null,['--auto=task']);assert.deepEqual(shown,[]);
});
test('unavailable saved settings do not interrupt startup lifecycle registration',async()=>{
 let start;const registered=[],messages=[];
 const context=vm.createContext({process:{platform:'linux'},console,autoRefreshChange:Promise.resolve(),
  app:{whenReady:()=>({then:fn=>start=fn}),commandLine:{getSwitchValue:()=>''},on:name=>registered.push(name)},
  session:{defaultSession:{setPermissionRequestHandler(){},setPermissionCheckHandler(){},setDisplayMediaRequestHandler(){}}},
  createWindow(){},createDock(){},registerShortcuts(){},initializeHyprShortcut(){},configureAutoRefresh:async()=>{},publishAutoRefreshState(){},store:{getSettings(){throw Error('Keyring unavailable');}},send:(_channel,data)=>messages.push(data.message)
 });
 const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
 vm.runInContext(source.slice(source.indexOf('// -------- lifecycle')),context);
 await assert.doesNotReject(Promise.resolve().then(()=>start()));
 await vm.runInContext('autoRefreshChange',context);
 assert(registered.includes('activate'));assert(messages.includes('Keyring unavailable'));
});
