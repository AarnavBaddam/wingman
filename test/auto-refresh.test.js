const test=require('node:test');
const assert=require('node:assert/strict');
const {createAutoRefresh}=require('../src/auto-refresh');
function harness(run=async()=>{}) {
  const timers=new Set();let busy=false,visible=true,runs=0;
  const helper=createAutoRefresh({run:async context=>{runs++;await run(context);},isBusy:()=>busy,canObserve:()=>visible,
    setTimer:fn=>(timers.add(fn),fn),clearTimer:fn=>timers.delete(fn)});
  return {helper,timers,fire:async()=>{const pending=[...timers];timers.clear();for(const fn of pending)fn();await Promise.resolve();await Promise.resolve();},get runs(){return runs;},set busy(v){busy=v;},set visible(v){visible=v;}};
}
test('auto refresh is off by default and debounces a burst into one Assist',async()=>{
  const h=harness();h.helper.activity();await h.fire();assert.equal(h.runs,0);
  h.helper.setEnabled(true);h.helper.activity();h.helper.activity();h.helper.activity();assert.equal(h.timers.size,1);
  await h.fire();assert.equal(h.runs,1);
});
test('busy requests coalesce into one pending refresh without concurrent generations',async()=>{
  let release;const h=harness(()=>new Promise(resolve=>release=resolve));h.helper.setEnabled(true);
  h.helper.activity();await h.fire();assert.equal(h.runs,1);
  h.helper.activity();h.helper.activity();await h.fire();assert.equal(h.runs,1);
  release();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.runs,2);
  h.helper.stop();release();
});
test('manual busy state can flush the latest refresh, while hidden and disabled states drop it',async()=>{
  const h=harness();h.helper.setEnabled(true);h.busy=true;h.helper.activity();await h.fire();assert.equal(h.runs,0);
  h.busy=false;await h.helper.flush();assert.equal(h.runs,1);
  h.visible=false;h.helper.activity();assert.equal(h.timers.size,0);
  h.visible=true;h.helper.activity();h.helper.setEnabled(false);await h.fire();assert.equal(h.runs,1);
});
test('the latest interaction point survives debounce and a busy model',async()=>{
  const seen=[],h=harness(async point=>seen.push(point));h.helper.setEnabled(true);h.busy=true;
  h.helper.activity({x:100,y:100});h.helper.activity({x:2200,y:200});await h.fire();
  h.busy=false;await h.helper.flush();assert.deepEqual(seen,[{x:2200,y:200}]);
});
