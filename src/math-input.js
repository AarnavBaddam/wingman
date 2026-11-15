// WebDriver Right Arrow leaves one MathQuill/MathType structure without adding text.
const RIGHT = '\uE014';
function mathKeys(text) {
  function root(start) {
    const argument = slot(start + 4);
    return { keys: `((${argument.keys})^1/2${RIGHT}${RIGHT})`, end: argument.end };
  }
  function slot(start, denominator = false) {
    let prefix = '';
    if (text[start] === '+' || text[start] === '-') prefix = text[start++];
    const open = text[start];
    let result;
    if (open === '{' || open === '(') {
      const close = open === '{' ? '}' : ')';
      let depth = 1, end = start + 1;
      for (; end < text.length && depth; end++) {
        if (text[end] === open) depth++;
        if (text[end] === close) depth--;
      }
      if (depth || end === start + 2) throw new Error('Use a complete, nonempty exponent or denominator before typing a math answer.');
      result = { keys: mathKeys(text.slice(start + 1, end - 1)), end };
    } else if (text.startsWith('sqrt(', start)) {
      result = root(start);
    } else {
      const value = text.slice(start).match(/^(?:\d+(?:\.\d+)?|[a-zA-Z])/);
      if (!value) throw new Error('Use a complete exponent or denominator before typing a math answer.');
      result = { keys: value[0], end: start + value[0].length };
    }
    result.keys = prefix + result.keys;
    if (denominator && text[result.end] === '^') {
      const power = slot(result.end + 1);
      result = { keys: result.keys + '^' + power.keys + RIGHT, end: power.end };
    }
    return result;
  }
  let keys = '';
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('sqrt(', i) && !/[a-zA-Z]/.test(text[i - 1] || '')) {
      const value = root(i); keys += value.keys; i = value.end - 1;
    } else if (text[i] === '^' || text[i] === '/') {
      const value = slot(i + 1, text[i] === '/');
      keys += text[i] + value.keys + RIGHT; i = value.end - 1;
    } else keys += text[i];
  }
  return keys;
}
module.exports = { mathKeys };
