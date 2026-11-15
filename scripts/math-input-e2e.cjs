const { chromium } = require(process.env.AETHER_PLAYWRIGHT || 'playwright');
const { mathKeys } = require('../src/math-input');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');

(async () => {
  const assets = process.env.AETHER_MATH_ASSETS;
  assert(assets, 'Set AETHER_MATH_ASSETS to a directory containing jquery.js, mathquill.js and mathquill.css (MathQuill 0.10.1).');
  const server = http.createServer((req, res) => {
    const name = { '/jquery.js': 'jquery.js', '/mathquill.js': 'mathquill.js', '/mathquill.css': 'mathquill.css' }[req.url];
    res.setHeader('Content-Type', name?.endsWith('.js') ? 'text/javascript' : name ? 'text/css' : 'text/html');
    res.end(name ? fs.readFileSync(`${assets}/${name}`) : `<!doctype html><link rel="stylesheet" href="/mathquill.css">
      <style>body{padding:40px;font-size:26px}.mq-editable-field{min-width:600px;padding:12px}</style>
      <p>Exponent entry regression</p><div id="answer"></div><input id="plain">
      <script src="/jquery.js"></script><script src="/mathquill.js"></script>
      <script>window.field=MathQuill.getInterface(2).MathField(document.querySelector('#answer'));</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 500 } });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const type = async keys => {
      for (const key of keys) {
        if (key === '\uE014') await page.keyboard.press('ArrowRight');
        else await page.keyboard.type(key);
      }
    };
    const text = 'a^4+24a^3+216a^2+864a+1296';
    await page.evaluate(() => field.focus());
    await type(text);
    const broken = await page.evaluate(() => field.latex());
    assert.notEqual(broken, text);
    await page.screenshot({ path: '/tmp/aether-exponents-before.png' });
    await page.evaluate(() => field.latex('').focus());
    await type(mathKeys(text));
    assert.equal(await page.evaluate(() => field.latex()), text);
    await page.keyboard.type('+7');
    assert.equal(await page.evaluate(() => field.latex()), text + '+7');
    await page.screenshot({ path: '/tmp/aether-exponents-after.png' });
    for (const [input, expected] of [
      ['x^12+x^-2', 'x^{12}+x^{-2}'], ['x^(n+1)+x^{2^3}', 'x^{n+1}+x^{2^3}'],
      ['8t^(3/2)-60t+150sqrt(t)-125', String.raw`8t^{\frac{3}{2}}-60t+150\left(\left(t\right)^{\frac{1}{2}}\right)-125`],
      ['1024/x^5-3840y/x^4', String.raw`\frac{1024}{x^5}-\frac{3840y}{x^4}`],
      ['1/(x+1)+2', String.raw`\frac{1}{x+1}+2`]
    ]) {
      await page.evaluate(() => field.latex('').focus());
      await type(mathKeys(input));
      assert.equal(await page.evaluate(() => field.latex()), expected);
    }
    await page.locator('#plain').fill(text);
    assert.equal(await page.locator('#plain').inputValue(), text);
    console.log('PASS: reproduced nested powers; polynomial, signed/grouped/nested powers, final caret, ordinary input; before/after screenshots in /tmp');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
