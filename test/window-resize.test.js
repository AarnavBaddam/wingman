const test = require('node:test');
const assert = require('node:assert/strict');
const { resizeBounds } = require('../src/window-resize');
const initial = {x:100,y:80,width:700,height:420};
test('bottom corner resizing keeps the opposite corner anchored',()=>{
  assert.deepEqual(resizeBounds(initial,'bottom-right',100,60),{x:100,y:80,width:800,height:480});
  assert.deepEqual(resizeBounds(initial,'bottom-left',100,60),{x:200,y:80,width:600,height:480});
});
test('resizing clamps dimensions and rejects invalid coordinates or corners',()=>{
  assert.deepEqual(resizeBounds(initial,'bottom-left',10000,-10000),{x:280,y:80,width:520,height:300});
  assert.deepEqual(resizeBounds(initial,'bottom-right',10000,10000),{x:100,y:80,width:2000,height:1600});
  for(const args of [['top',0,0],['bottom-left',NaN,0],['bottom-right',Infinity,0]]) assert.throws(()=>resizeBounds(initial,...args),/Invalid resize/);
});
