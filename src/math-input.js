// WebDriver Right Arrow leaves a MathQuill/MathType superscript without adding text.
const RIGHT = '\uE014';
function mathKeys(text) {
  let keys = '';
  for (let i = 0; i < text.length; i++) {
    keys += text[i];
    if (text[i] !== '^') continue;
    const start = i + 1, open = text[start];
    if (open === '{' || open === '(') {
      const close = open === '{' ? '}' : ')';
      let depth = 1, end = start + 1;
      for (; end < text.length && depth; end++) {
        if (text[end] === open) depth++;
        if (text[end] === close) depth--;
      }
      if (depth || end === start + 2) throw new Error('Use a complete, nonempty exponent before typing a math answer.');
      keys += mathKeys(text.slice(start + 1, end - 1)) + RIGHT;
      i = end - 1;
    } else {
      const exponent = text.slice(start).match(/^[+-]?(?:\d+(?:\.\d+)?|[a-zA-Z])/);
      if (!exponent) throw new Error('Use a complete exponent before typing a math answer.');
      keys += exponent[0] + RIGHT;
      i += exponent[0].length;
    }
  }
  return keys;
}
module.exports = { mathKeys };
