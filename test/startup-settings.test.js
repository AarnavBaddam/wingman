const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
test('unavailable saved settings do not interrupt startup lifecycle registration',async()=>{
 let start;const registered=[],messages=[];
 const context=vm.createContext({process:{platform:'linux'},console,autoRefreshChange:Promise.resolve(),
  app:{whenReady:()=>({then:fn=>start=fn}),commandLine:{getSwitchValue:()=>''},on:name=>registered.push(name)},
  session:{defaultSession:{setPermissionRequestHandler(){},setPermissionCheckHandler(){},setDisplayMediaRequestHandler(){}}},
  createWindow(){},registerShortcuts(){},initializeHyprShortcut(){},configureAutoRefresh:async()=>{},publishAutoRefreshState(){},store:{getSettings(){throw Error('Keyring unavailable');}},send:(_channel,data)=>messages.push(data.message)
 });
 const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
 vm.runInContext(source.slice(source.indexOf('// -------- lifecycle')),context);
 await assert.doesNotReject(Promise.resolve().then(()=>start()));
 await vm.runInContext('autoRefreshChange',context);
 assert(registered.includes('activate'));assert(messages.includes('Keyring unavailable'));
});
