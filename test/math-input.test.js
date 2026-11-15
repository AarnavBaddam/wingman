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

test('fractions exit denominators before leaving exponents or continuing a sum', () => {
  assert.equal(mathKeys('8t^(3/2)-60t+150t^(1/2)-125'), `8t^3/2${right}${right}-60t+150t^1/2${right}${right}-125`);
  assert.equal(mathKeys('1024/x^5-3840y/x^4'), `1024/x^5${right}${right}-3840y/x^4${right}${right}`);
  assert.equal(mathKeys('1/(x+1)+2'), `1/x+1${right}+2`);
});

test('sqrt is entered as an equivalent grouped fractional power, never literal letters', () => {
  assert.equal(mathKeys('sqrt(t)'), `((t)^1/2${right}${right})`);
  assert.equal(mathKeys('sqrt(t+1)^3'), `((t+1)^1/2${right}${right})^3${right}`);
  for (const text of ['sqrt()', 'sqrt(t', '1/', '1/()']) assert.throws(() => mathKeys(text));
});
