const { createAutoMode, AUTO_SYSTEM } = require('./auto-mode');

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Auto stopped.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function createAutoSession({ getSettings, createLLM, getCodexHome, createDesktopControl, createBrowserControl, createStopWatcher,
  research, onUpdate = () => {}, onEnd = () => {}, countdownMs = 3000 }) {
  let current = null, completion = Promise.resolve();
  let last = { active: false, status: 'idle', message: '' };
  const manager = {
    get active() { return current !== null; },
    get target() { return current?.targetType || null; },
    get completion() { return completion; },
    get status() { return last; },
    stop(reason = 'Auto stopped.') {
      if (!current) return;
      current.reason = reason; current.controller.abort(); current.engine?.stop();
    },
    start(goal, { allowSubmit = false, target: targetType = 'desktop', tabId } = {}) {
      if (current) throw new Error('Auto is already running.');
      if (typeof goal !== 'string' || !goal.trim() || goal.length > 4000) throw new Error('Type an Auto task first (maximum 4,000 characters).');
      if (!['desktop', 'zen'].includes(targetType)) throw new Error('Invalid Auto target.');
      if (targetType === 'zen' && (typeof tabId !== 'string' || !tabId.trim() || tabId.length > 200)) throw new Error('Connect Zen and select a target tab first.');
      const session = { controller: new AbortController(), reason: 'Auto stopped.', targetType };
      current = session;
      const signal = session.controller.signal;
      const publish = update => { last = { ...update, active: true }; onUpdate(last); };
      completion = (async () => {
        let terminal = { status: 'stopped', message: 'Auto stopped.' };
        try {
          const settings = getSettings();
          const llm = createLLM({ ...settings, codexHome: getCodexHome(settings) });
          if (!llm.ready) throw new Error('Configure a vision-capable answer provider in Settings before Auto.');
          const desktop = targetType === 'zen' ? createBrowserControl?.() : createDesktopControl();
          if (!desktop) throw new Error('Zen tab control is unavailable. Connect Zen first.');
          session.watcher = createStopWatcher({ onStop: reason => manager.stop(reason) });
          publish({ status: 'starting', message: 'Preparing Auto. Escape stops it.' });
          await session.watcher.start(); signal.throwIfAborted();
          if (targetType === 'desktop') {
            publish({ status: 'countdown', message: 'Focus the target app within 3 seconds. Escape stops Auto.' });
            await wait(countdownMs, signal);
          } else publish({ status: 'starting', message: 'Locking the selected Zen tab. You can work elsewhere; Escape stops Auto.' });
          const target = targetType === 'zen' ? await desktop.lockTarget(tabId, signal) : await desktop.lockTarget(signal);
          signal.throwIfAborted();
          session.engine = createAutoMode({
            capture: innerSignal => desktop.capture(target, innerSignal),
            execute: (action, innerSignal) => {
              session.pendingInput = desktop.execute(target, action, innerSignal);
              return session.pendingInput;
            },
            research: (query, innerSignal) => research(query, settings, innerSignal),
            decide: ({ goal, screen, history, sources, form, observation, allowSubmit, signal: innerSignal }) => llm.stream({
              system: AUTO_SYSTEM,
              turns: [{ role: 'user', text: JSON.stringify({ goal, screen: { width: screen.width, height: screen.height },
                allowSubmit, form, observation, history, sources: sources.map(source => ({ ...source, content: String(source.content || '').slice(0, 4000) })) }) }],
              imageDataUrl: screen.imageDataUrl, maxTokens: 1200, signal: innerSignal, onToken() {}
            }),
            onUpdate(update) {
              if (['done', 'paused', 'stopped', 'error'].includes(update.status)) terminal = update;
              publish(update);
            }
          });
          await session.engine.run(goal, { signal, allowSubmit: allowSubmit === true });
        } catch (error) {
          terminal = signal.aborted ? { status: 'stopped', message: session.reason } :
            { status: 'error', message: error?.message || 'Auto could not continue. Review the screen.' };
        } finally {
          if (signal.aborted) terminal = { status: 'stopped', message: session.reason };
          // Input teardown must finish before releasing the busy lock for another task.
          try { await session.pendingInput; }
          catch (error) { if (error?.code === 'INPUT_CLEANUP') terminal = { status: 'error', message: error.message }; }
          try { session.watcher?.stop(); } catch { terminal = { status: 'error', message: 'Auto stopped; restart Aether to clear its Escape binding.' }; }
          if (current === session) current = null;
          last = { ...terminal, active: false }; onUpdate(last); onEnd();
        }
      })();
      return { started: true };
    }
  };
  return manager;
}
module.exports = { createAutoSession };
