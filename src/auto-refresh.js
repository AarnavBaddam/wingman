function createAutoRefresh({ run, isBusy = () => false, canObserve = () => true, onError = () => {}, delay = 650,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let enabled = false, timer = null, pending = false, running = false, latest = null;
  function cancelPending() { if (timer) clearTimer(timer); timer = null; pending = false; latest = null; }
  const helper = {
    setEnabled(value) { enabled = !!value; if (!enabled) cancelPending(); },
    activity(context) {
      if (!enabled || !canObserve()) return;
      cancelPending();
      latest = context;
      timer = setTimer(() => { timer = null; pending = true; void helper.flush(); }, delay);
    },
    async flush() {
      if (!enabled || !canObserve()) { cancelPending(); return; }
      if (!pending || running || isBusy()) return;
      pending = false; running = true;
      const context = latest; latest = null;
      try { await run(context); }
      catch (error) { onError(error); }
      finally { running = false; if (pending) void helper.flush(); }
    },
    cancelPending,
    stop() { enabled = false; cancelPending(); }
  };
  return helper;
}
module.exports = { createAutoRefresh };
