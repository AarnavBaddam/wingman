const test = require('node:test');
const assert = require('node:assert/strict');
const { mathKeys } = require('../src/math-input');
const right = '\uE014';
test('math powers preserve multi-digit, signed, grouped and nested exponents', () => {
  assert.equal(mathKeys('x^12+x^-2+x^n+1'), `x^12${right}+x^-2${right}+x^n${right}+1`);
  assert.equal(mathKeys('x^(n+1)+x^{2^3}'), `x^n+1${right}+x^2^3${right}${right}`);
  assert.equal(mathKeys('(x+1)^2+3'), `(x+1)^2${right}+3`);
  for (const text of ['x^', 'x^{}', 'x^(2']) assert.throws(() => mathKeys(text), /exponent/);
});
