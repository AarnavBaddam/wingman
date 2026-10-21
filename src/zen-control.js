const net = require('node:net');

const MAX_FRAME = 40 * 1024 * 1024;
const VIEWPORT_SCRIPT = 'return {width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio};';
// Gecko's native wheel default action does not scroll hidden tabs. Only this
// fixed, bounded hit-test script scrolls; click and keyboard input remain native.
const SCROLL_SCRIPT = `
const [x, y, delta] = arguments;
if (![x,y,delta].every(Number.isFinite) || x<0 || y<0 || x>=innerWidth || y>=innerHeight || Math.abs(delta)>600) throw Error('Invalid scroll coordinates');
let el = document.elementFromPoint(x,y);
while (el?.shadowRoot?.elementFromPoint) {
  const child = el.shadowRoot.elementFromPoint(x,y); if (!child || child===el) break; el=child;
}
if (el?.localName==='iframe' || el?.localName==='frame') {
  const rect=el.getBoundingClientRect(), scaleX=rect.width/el.offsetWidth, scaleY=rect.height/el.offsetHeight;
  return {frame:el,x:(x-rect.left)/scaleX-el.clientLeft,y:(y-rect.top)/scaleY-el.clientTop};
}
for (let depth=0;el && depth<100;depth++,el=el.parentElement || el.getRootNode()?.host) {
  const root=el===document.scrollingElement, overflow=getComputedStyle(el).overflowY;
  if (!(root || /^(auto|scroll)$/.test(overflow)) || /^(hidden|clip)$/.test(overflow)) continue;
  const available=el.scrollHeight-el.clientHeight, before=el.scrollTop;
  if (available>0 && (delta>0 ? before<available : before>0)) {
    el.scrollBy({top:delta,left:0,behavior:'instant'}); return {scrolled:el.scrollTop!==before};
  }
}
return {scrolled:false};`;
// Hidden Gecko tabs start native HTML drags without completing drop. Keep this
// fixed adapter limited to explicit HTML draggable elements, not arbitrary code.
const HTML_DRAG_SCRIPT = `
const [x,y,toX,toY]=arguments;
if (![x,y,toX,toY].every(Number.isFinite) || x<0 || y<0 || toX<0 || toY<0 || x>=innerWidth || toX>=innerWidth || y>=innerHeight || toY>=innerHeight) throw Error('Drag points must be visible in the same frame');
function hit(x,y) {
  let el=document.elementFromPoint(x,y);
  for(let i=0;i<20 && el?.shadowRoot?.elementFromPoint;i++) { const child=el.shadowRoot.elementFromPoint(x,y);if(!child || child===el)break;el=child; }
  return el;
}
let source=hit(x,y);
if (source?.localName==='iframe' || source?.localName==='frame') {
  const rect=source.getBoundingClientRect(),sx=rect.width/source.offsetWidth,sy=rect.height/source.offsetHeight;
  return {frame:source,x:(x-rect.left)/sx-source.clientLeft,y:(y-rect.top)/sy-source.clientTop,toX:(toX-rect.left)/sx-source.clientLeft,toY:(toY-rect.top)/sy-source.clientTop};
}
for(let i=0;source && !source.draggable && i<100;i++)source=source.parentElement || source.getRootNode()?.host;
if(!source?.draggable)return {handled:false};
const target=hit(toX,toY);if(!target)throw Error('Drag destination unavailable');
const dataTransfer=new DataTransfer();
const emit=(el,type,px,py)=>el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,composed:true,clientX:px,clientY:py,dataTransfer}));
let accepted=false;
if(emit(source,'dragstart',x,y)) {
  emit(target,'dragenter',toX,toY);
  accepted=!emit(target,'dragover',toX,toY);
  dataTransfer.dropEffect=accepted?'move':'none';
  if(accepted)emit(target,'drop',toX,toY);
  emit(source,'dragend',toX,toY);
}
// Mouse-driven widgets can also carry draggable=true. A rejected HTML drop
// must fall through to the native mouse gesture instead of swallowing it.
return {handled:accepted};`;
// Gecko sends hidden-tab pointer motion but omits hover transitions. Legacy
// mouse widgets use mouseover on drop shims to recognize the destination.
const DRAG_HOVER_SCRIPT = `
const [x,y]=arguments;
if(![x,y].every(Number.isFinite)||x<0||y<0||x>=innerWidth||y>=innerHeight)throw Error('Drag destination must be visible');
let el=document.elementFromPoint(x,y);
for(let i=0;i<20&&el?.shadowRoot?.elementFromPoint;i++){const child=el.shadowRoot.elementFromPoint(x,y);if(!child||child===el)break;el=child;}
if(el?.localName==='iframe'||el?.localName==='frame'){
 const r=el.getBoundingClientRect();return {frame:el,x:(x-r.left)/(r.width/el.offsetWidth)-el.clientLeft,y:(y-r.top)/(r.height/el.offsetHeight)-el.clientTop};
}
if(document.visibilityState==='hidden'&&el){
 el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,buttons:1,button:0,relatedTarget:null}));
}
return {hovered:true};`;
function cancelled(signal) { if (signal?.aborted) { const error = new Error('Zen action cancelled.'); error.name = 'AbortError'; throw error; } }

// Second cursor: a fixed, page-inert marker where Auto acts in the Zen tab, so the user
// can watch a background run. pointer-events:none keeps it out of hit tests and input.
// Built with DOM calls, not innerHTML, so Trusted Types pages accept it.
const CURSOR_SCRIPT = `
const [mode,x,y]=arguments, id='__aether_cursor';
let host=document.getElementById(id);
if(mode==='remove'){host?.remove();return true;}
if(mode==='hide'||mode==='show'){if(host)host.style.visibility=mode==='hide'?'hidden':'visible';return !!host;}
if(![x,y].every(Number.isFinite)||x<0||y<0||x>=innerWidth||y>=innerHeight)return false;
if(!host){
 const ns='http://www.w3.org/2000/svg';
 host=document.createElement('div');host.id=id;host.setAttribute('aria-hidden','true');
 host.style.cssText='position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;transition:transform .18s ease-out;';
 const ring=document.createElement('div');ring.setAttribute('data-ring','1');
 ring.style.cssText='position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid #e9692f;opacity:0;';
 const svg=document.createElementNS(ns,'svg');svg.setAttribute('width','22');svg.setAttribute('height','26');svg.setAttribute('viewBox','0 0 22 26');
 svg.style.cssText='display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));';
 const path=document.createElementNS(ns,'path');path.setAttribute('d','M2 2 L2 21 L7.5 16 L11 24 L14.5 22.5 L11 14.8 L18.5 14.8 Z');
 path.setAttribute('fill','#e9692f');path.setAttribute('stroke','#fff');path.setAttribute('stroke-width','1.6');path.setAttribute('stroke-linejoin','round');
 svg.appendChild(path);
 const tag=document.createElement('span');tag.textContent='Aether';
 tag.style.cssText='position:absolute;left:18px;top:20px;font:600 11px system-ui,sans-serif;color:#fff;background:#e9692f;padding:1px 6px;border-radius:8px;white-space:nowrap;';
 host.append(ring,svg,tag);document.documentElement.appendChild(host);
}
host.style.transform='translate('+x+'px,'+y+'px)';
if(mode==='click')host.querySelector('[data-ring]')?.animate([{transform:'scale(.6)',opacity:.9},{transform:'scale(1.8)',opacity:0}],{duration:450,easing:'ease-out',fill:'forwards'});
return true;`;
function createZenControl({ host = '127.0.0.1', port = 2828, timeoutMs = 10000, connectSocket = options => net.createConnection(options) } = {}) {
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Zen automation requires a bounded loopback connection.');
  let socket = null, buffer = Buffer.alloc(0), pending = null, greeting = null, serial = Promise.resolve(), nextId = 0, ready = false;
  const targets = new WeakMap();
  const enqueue = operation => { const result = serial.then(operation); serial = result.catch(() => {}); return result; };
  function fail(error) {
    ready = false;
    const connection = socket; socket = null;
    const waiter = pending || greeting; pending = null; greeting = null;
    if (waiter) { clearTimeout(waiter.timer); waiter.reject(error); }
    connection?.destroy();
  }
  function receive(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_FRAME + 32) return fail(new Error('Zen response exceeded limit.'));
    while (buffer.length) {
      const colon = buffer.indexOf(58);
      if (colon < 0) { if (buffer.length > 10) fail(new Error('Invalid Zen frame.')); return; }
      const prefix = buffer.subarray(0, colon).toString('ascii');
      const length = Number(prefix);
      if (!/^\d{1,10}$/.test(prefix) || !Number.isSafeInteger(length) || length < 1 || length > MAX_FRAME) return fail(new Error('Invalid Zen frame length.'));
      if (buffer.length < colon + 1 + length) return;
      let value;
      try { value = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length).toString('utf8')); }
      catch { return fail(new Error('Invalid Zen response.')); }
      buffer = buffer.subarray(colon + 1 + length);
      if (greeting) {
        if (value?.applicationType !== 'gecko' || value?.marionetteProtocol !== 3) return fail(new Error('Unsupported Zen automation protocol.'));
        const waiter = greeting; greeting = null; clearTimeout(waiter.timer); waiter.resolve();
      } else if (Array.isArray(value) && value[0] === 1 && pending && value[1] === pending.id) {
        const waiter = pending; pending = null; clearTimeout(waiter.timer);
        if (value[2]) waiter.reject(new Error(`Zen: ${String(value[2].error || 'command failed')}. ${String(value[2].message || '').slice(0, 200)}`));
        else waiter.resolve(value[3] && Object.hasOwn(value[3], 'value') ? value[3].value : value[3]);
      } else return fail(new Error('Unexpected Zen response.'));
    }
  }
  function command(name, params = {}, signal) {
    cancelled(signal);
    if (!socket || pending) return Promise.reject(new Error('Connect Zen automation first.'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => fail(new Error('Zen command timed out. Reconnect before continuing.')), timeoutMs);
      pending = { id, timer, resolve, reject };
      const json = JSON.stringify([0, id, name, params]);
      socket.write(`${Buffer.byteLength(json)}:${json}`);
    }).then(result => { cancelled(signal); return result; });
  }
  async function connectInternal(signal) {
    cancelled(signal); if (ready) return;
    if (socket) throw new Error('Zen connection already pending.');
    buffer = Buffer.alloc(0);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('Zen automation unavailable. Restart Zen with --marionette and retry.')), timeoutMs);
      greeting = { timer, resolve, reject };
      try {
        const connection = connectSocket({ host, port }); socket = connection;
        connection.on('data', chunk => { if (socket === connection) receive(chunk); });
        connection.on('error', () => { if (socket === connection) fail(new Error('Zen automation unavailable. Restart Zen with --marionette and retry.')); });
        connection.on('close', () => { if (socket === connection) fail(new Error('Zen automation disconnected.')); });
      } catch { fail(new Error('Zen automation connection failed.')); }
    });
    try {
      cancelled(signal);
      await command('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: false, unhandledPromptBehavior: 'ignore' } } }, signal);
      ready = true;
    } catch (error) { fail(error); throw error; }
  }
  function requireReady() { if (!ready) throw new Error('Connect Zen automation first.'); }
  async function handles(signal) {
    requireReady();
    const ids = await command('WebDriver:GetWindowHandles', {}, signal);
    if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('Invalid Zen tab list.');
    return ids;
  }
  async function select(id, signal) {
    if (typeof id !== 'string' || !(await handles(signal)).includes(id)) throw new Error('Selected Zen tab closed or unavailable.');
    await command('WebDriver:SwitchToWindow', { handle: id, focus: false }, signal);
  }
  async function viewport(signal) {
    const view = await command('WebDriver:ExecuteScript', { script: VIEWPORT_SCRIPT, args: [], newSandbox: true, sandbox: 'aether-viewport' }, signal);
    if (!view || ![view.width, view.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 32768) || !Number.isFinite(view.dpr) || view.dpr < 0.25 || view.dpr > 8) throw new Error('Zen viewport unavailable.');
    return view;
  }
  async function validate(target, signal) {
    cancelled(signal);
    const state = targets.get(target);
    if (!state) throw new Error('Lock an exact Zen tab first.');
    await select(target.id, signal);
    const view = await viewport(signal);
    if (view.width !== state.view.width || view.height !== state.view.height || view.dpr !== state.view.dpr) throw new Error('Zen viewport changed. Select the tab and start again.');
    return state;
  }
  async function listTabs(signal) {
    cancelled(signal);
    const ids = await handles(signal), tabs = [];
    for (const id of ids) {
      await command('WebDriver:SwitchToWindow', { handle: id, focus: false }, signal);
      const title = await command('WebDriver:GetTitle', {}, signal);
      const url = await command('WebDriver:GetCurrentURL', {}, signal);
      tabs.push({ id, title: String(title).slice(0, 500), url: String(url).slice(0, 4000) });
    }
    return tabs;
  }
  async function lockTarget(id, signal) {
    await select(id, signal); const view = await viewport(signal);
    const width = Math.floor(view.width * view.dpr), height = Math.floor(view.height * view.dpr);
    const target = Object.freeze({ id, width, height, size: Object.freeze([width, height]) });
    targets.set(target, { view, fresh: false }); return target;
  }
  async function capture(target, signal) {
    const previous = targets.get(target); if (previous) previous.fresh = false;
    const state = await validate(target, signal);
    // The model must see the page, not Aether's own cursor.
    await cursor('hide');
    let encoded;
    try { encoded = await command('WebDriver:TakeScreenshot', { full: false, scroll: false }, signal); }
    finally { await cursor('show'); }
    if (typeof encoded !== 'string' || encoded.length > MAX_FRAME || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid Zen screenshot.');
    const png = Buffer.from(encoded, 'base64');
    if (png.length < 33 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid Zen screenshot.');
    // Gecko renders viewport screenshots at devicePixelRatio, except under some
    // fractional desktop scaling where it stays at 1x CSS pixels. It may also omit
    // classic scrollbars. Detect the real scale and map coordinates with it.
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20), { view } = state;
    const fits = k => width <= Math.floor(view.width * k) && height <= Math.floor(view.height * k) &&
      width >= Math.floor(view.width * k) - Math.ceil(32 * k) && height >= Math.floor(view.height * k) - Math.ceil(32 * k);
    const scale = [view.dpr, 1].find(fits);
    if (!scale || !width || !height) throw new Error('Zen screenshot dimensions changed. Start again.');
    await validate(target, signal); state.fresh = true; state.width = width; state.height = height; state.scale = scale;
    return { imageDataUrl: `data:image/png;base64,${encoded}`, width, height };
  }
  async function scroll(target, action, state, signal) {
    let x = action.x / state.scale, y = action.y / state.scale;
    try {
      for (let depth = 0; depth < 5; depth++) {
        cancelled(signal);
        const result = await command('WebDriver:ExecuteScript', { script: SCROLL_SCRIPT, args: [x, y, action.amount * 120], newSandbox: true, sandbox: 'aether-scroll' }, signal);
        if (result?.frame) {
          if (depth === 4 || ![result.x, result.y].every(Number.isFinite)) throw new Error('Zen scroll frame depth or coordinates unsupported.');
          await command('WebDriver:SwitchToFrame', { element: result.frame }, signal);
          x = result.x; y = result.y;
        } else {
          if (typeof result?.scrolled !== 'boolean') throw new Error('Zen scroll target unavailable.');
          return;
        }
      }
    } finally {
      if (socket) await command('WebDriver:SwitchToFrame', { id: null });
    }
  }
  // Cosmetic only: a cursor failure never blocks or fails real input.
  async function cursor(mode, x, y) {
    if (!socket) return;
    try { await command('WebDriver:ExecuteScript', { script: CURSOR_SCRIPT, args: [mode, x, y], newSandbox: true, sandbox: 'aether-cursor' }); } catch {}
  }
  async function execute(target, action, signal) {
    const state = targets.get(target);
    const point = (x, y) => [x / state.scale, y / state.scale];
    const pointed = state?.fresh && ['click', 'drag', 'scroll'].includes(action?.type) && [action.x, action.y].every(Number.isFinite);
    if (pointed) await cursor('move', ...point(action.x, action.y));
    const result = await act(target, action, signal);
    if (pointed && action.type === 'click') await cursor('click', ...point(action.x, action.y));
    if (pointed && action.type === 'drag') await cursor('move', ...point(action.toX, action.toY));
    return result;
  }
  async function act(target, action, signal) {
    const state = targets.get(target), fresh = state?.fresh;
    if (state) state.fresh = false;
    cancelled(signal);
    if (!fresh) throw new Error('Capture the locked Zen tab before acting.');
    if (!action || !['click', 'type', 'scroll', 'drag', 'clear'].includes(action.type)) throw new Error('Unsupported Zen action.');
    if (action.type === 'clear') {
    } else if (action.type === 'type') {
      if (typeof action.text !== 'string' || !action.text.length || action.text.length > 1000 || /[^\x20-\x7e]/.test(action.text)) throw new Error('Type accepts printable ASCII text only, without Enter or Tab.');
    } else {
      if (![action.x, action.y].every(Number.isFinite) || action.x < 0 || action.y < 0 || action.x >= state.width || action.y >= state.height) throw new Error('Zen coordinates are outside the captured viewport.');
      if (action.type === 'drag' && (![action.toX, action.toY].every(Number.isFinite) || action.toX < 0 || action.toY < 0 || action.toX >= state.width || action.toY >= state.height)) throw new Error('Zen drag destination is outside the captured viewport.');
      if (action.type === 'scroll' && (!Number.isSafeInteger(action.amount) || action.amount === 0 || Math.abs(action.amount) > 5)) throw new Error('Scroll amount must be a nonzero integer between -5 and 5.');
    }
    let attempted = false;
    try {
      if (action.type === 'drag') {
        await validate(target, signal);
        let points = [action.x, action.y, action.toX, action.toY].map(n => n / state.scale);
        let handled = false;
        try {
          for (let depth = 0; depth < 5; depth++) {
            const result = await command('WebDriver:ExecuteScript', { script: HTML_DRAG_SCRIPT, args: points, newSandbox: true, sandbox: 'aether-drag' }, signal);
            if (result?.frame) {
              if (depth === 4 || ![result.x, result.y, result.toX, result.toY].every(Number.isFinite)) throw new Error('Zen drag frame depth or coordinates unsupported.');
              await command('WebDriver:SwitchToFrame', { element: result.frame }, signal);
              points = [result.x, result.y, result.toX, result.toY];
            } else {
              if (typeof result?.handled !== 'boolean') throw new Error('Zen drag target unavailable.');
              handled = result.handled; break;
            }
          }
        } finally { if (socket) await command('WebDriver:SwitchToFrame', { id: null }); }
        if (handled) return;
      }
      if (action.type === 'scroll') {
        await validate(target, signal);
        return await scroll(target, action, state, signal);
      }
      if (action.type === 'clear') {
        // Fixed Ctrl+A then Backspace in the focused field; never a model-chosen key.
        await validate(target, signal); attempted = true;
        await command('WebDriver:PerformActions', { actions: [{ type: 'key', id: 'aether-keys', actions: [
          { type: 'keyDown', value: '\uE009' }, { type: 'keyDown', value: 'a' }, { type: 'keyUp', value: 'a' }, { type: 'keyUp', value: '\uE009' },
          { type: 'keyDown', value: '\uE003' }, { type: 'keyUp', value: '\uE003' }] }] }, signal);
        return;
      }
      const chunks = action.type === 'type' ? action.text.match(/.{1,8}/g) : [null];
      for (const chunk of chunks) {
        await validate(target, signal);
        let source;
        if (chunk !== null) source = { type: 'key', id: 'aether-keys', actions: [...chunk].flatMap(value => [{ type: 'keyDown', value }, { type: 'keyUp', value }]) };
        else {
          const x = Math.min(state.view.width - 1, Math.floor(action.x / state.scale));
          const y = Math.min(state.view.height - 1, Math.floor(action.y / state.scale));
          source = { type: 'pointer', id: 'aether-pointer', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', origin: 'viewport', duration: 0, x, y }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] };
          if (action.type === 'click' && action.clicks === 2) source.actions.push({ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 });
          if (action.type === 'drag') {
            const toX = Math.min(state.view.width - 1, Math.floor(action.toX / state.scale));
            const toY = Math.min(state.view.height - 1, Math.floor(action.toY / state.scale));
            // A short hold plus multiple moves crosses drag thresholds for both
            // HTML draggable elements and pointer/mouse-driven sorting widgets.
            source.actions.splice(2, 0, { type: 'pause', duration: 120 },
              ...Array.from({ length: 12 }, (_, i) => ({ type: 'pointerMove', origin: 'viewport', duration: 40,
                x: Math.round(x + (toX - x) * (i + 1) / 12), y: Math.round(y + (toY - y) * (i + 1) / 12) })),
              { type: 'pause', duration: 120 });
          }
        }
        attempted = true;
        // A sent action drains before cancellation is reported; never queue a late
        // action or release input while an earlier command can still press it.
        if (action.type === 'drag') {
          // Supply missing hidden-tab hover while held, before releasing.
          await command('WebDriver:PerformActions', { actions: [{ ...source, actions: source.actions.slice(0, -1) }] }, signal);
          let point = [action.toX, action.toY].map(n => n / state.scale);
          try {
            for (let depth = 0; depth < 5; depth++) {
              const result = await command('WebDriver:ExecuteScript', { script: DRAG_HOVER_SCRIPT, args: point, newSandbox: true, sandbox: 'aether-drag-hover' }, signal);
              if (result?.frame) {
                if (depth === 4 || ![result.x, result.y].every(Number.isFinite)) throw new Error('Zen drag hover frame depth or coordinates unsupported.');
                await command('WebDriver:SwitchToFrame', { element: result.frame }, signal);
                point = [result.x, result.y];
              } else {
                if (result?.hovered !== true) throw new Error('Zen drag hover target unavailable.');
                break;
              }
            }
          } finally { if (socket) await command('WebDriver:SwitchToFrame', { id: null }); }
          cancelled(signal);
          // Legacy widgets (YUI DD) register the target on the next move after hover.
          const end = source.actions.findLast(a => a.type === 'pointerMove');
          await command('WebDriver:PerformActions', { actions: [{ ...source, actions: [{ ...end, x: end.x ? end.x - 1 : 1 }, end, { type: 'pointerUp', button: 0 }] }] }, signal);
        } else await command('WebDriver:PerformActions', { actions: [source] }, signal);
      }
    } finally {
      if (attempted) {
        try {
          if (!socket) throw new Error('Zen connection closed during input.');
          await command('WebDriver:ReleaseActions');
        }
        catch (error) { const failure = new Error('Zen input release failed. Reconnect before continuing.', { cause: error }); failure.code = 'INPUT_CLEANUP'; fail(failure); throw failure; }
      }
    }
  }
  return {
    connect: signal => enqueue(() => connectInternal(signal)),
    listTabs: signal => enqueue(() => listTabs(signal)),
    lockTarget: (id, signal) => enqueue(() => lockTarget(id, signal)),
    capture: (target, signal) => enqueue(() => capture(target, signal)),
    execute: (target, action, signal) => enqueue(() => execute(target, action, signal)),
    // Run end: take the second cursor off the page.
    release: target => enqueue(async () => { if (targets.has(target)) { try { await select(target.id); } catch { return; } await cursor('remove'); } }),
    // Dropping the transport releases Marionette's session; never Quit/DeleteSession.
    close: () => enqueue(() => { ready = false; const connection = socket; socket = null; connection?.destroy(); })
  };
}

module.exports = { createZenControl };
