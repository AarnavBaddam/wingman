const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const DESCRIPTION = 'Aether: Show / hide';

function combination(accelerator) {
  const parts = accelerator.split('+');
  const key = parts.pop();
  const modifiers = { CommandOrControl: ['CTRL', 4], Control: ['CTRL', 4], Ctrl: ['CTRL', 4], Shift: ['SHIFT', 1], Alt: ['ALT', 8], Option: ['ALT', 8], Super: ['SUPER', 64] };
  if (parts.some(part => !modifiers[part]) || !/^(?:[a-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Return|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right)$/i.test(key)) {
    throw new Error('On Hyprland, choose a letter, number, function key, Space, or navigation key.');
  }
  const keys = { PageUp: 'Page_Up', PageDown: 'Page_Down' };
  const symbol = keys[key] || key;
  return { keys: [...parts.map(part => modifiers[part][0]), symbol].join(' + '), symbol, mask: parts.reduce((mask, part) => mask | modifiers[part][1], 0), portal: accelerator.replace(/CommandOrControl|Control/g, 'Ctrl').replace(/Option/g, 'Alt') };
}

function createHyprShortcut({ call = async args => (await run('hyprctl', args, { timeout: 1500, maxBuffer: 1024 * 1024 })).stdout, callSync = args => execFileSync('hyprctl', args, { timeout: 1500, encoding: 'utf8' }), pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let current;
  const matches = (bind, combo) => bind.modmask === combo.mask && bind.key.toLowerCase() === combo.symbol.toLowerCase();
  async function remove(combo) {
    const bindings = JSON.parse(await call(['-j', 'binds'])).filter(bind => matches(bind, combo));
    if (bindings.length && bindings.every(bind => bind.description === DESCRIPTION)) await call(['eval', 'hl.unbind(' + JSON.stringify(combo.keys) + ')']);
  }
  return {
    async bind(accelerator) {
      const next = combination(accelerator);
      const bindings = JSON.parse(await call(['-j', 'binds']));
      if (bindings.some(bind => matches(bind, next) && bind.description !== DESCRIPTION)) throw new Error('That shortcut is already bound in Hyprland. Choose another combination.');
      let shortcut;
      for (let attempt = 0; attempt < 50; attempt++) {
        shortcut = JSON.parse(await call(['-j', 'globalshortcuts'])).find(item => item.name.startsWith('dev.prahladv.aether:') && item.name.endsWith('-' + next.portal));
        if (shortcut) break;
        await pause(100);
      }
      if (!shortcut) throw new Error('Wayland could not bind those keys. Install Aether’s Linux launcher and try another combination.');
      if (!/^dev\.prahladv\.aether:[A-F0-9]+-[A-Za-z0-9+]+$/.test(shortcut.name)) throw new Error('Unexpected Wayland shortcut identifier.');
      if (bindings.some(bind => matches(bind, next))) await remove(next);
      const result = await call(['eval', 'hl.bind(' + JSON.stringify(next.keys) + ', hl.dsp.global(' + JSON.stringify(shortcut.name) + '), { description = "' + DESCRIPTION + '" })']);
      if (result.trim() !== 'ok') throw new Error('Hyprland could not bind those keys.');
      const previous = current;
      current = next;
      if (previous && previous.keys !== next.keys) await remove(previous);
    },
    stop() {
      if (!current) return;
      const bindings = JSON.parse(callSync(['-j', 'binds'])).filter(bind => matches(bind, current));
      if (bindings.length && bindings.every(bind => bind.description === DESCRIPTION)) callSync(['eval', 'hl.unbind(' + JSON.stringify(current.keys) + ')']);
      current = undefined;
    }
  };
}

// shortcut: Hyprland config reload clears runtime bindings; restart Aether after reload.
module.exports = { createHyprShortcut, combination };
