const { chromium } = require(process.env.AETHER_PLAYWRIGHT || 'playwright');
const { mathKeys } = require('../src/math-input');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');

(async () => {
  assert(process.env.AETHER_WIRIS_EDITOR, 'Set AETHER_WIRIS_EDITOR to the downloaded https://www.wiris.net/demo/editor/editor script.');
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<div id="editor"></div><script src="https://www.wiris.net/demo/editor/editor"></script>
      <script>window.editor=com.wiris.jsEditor.JsEditor.newInstance({language:'en',autoformat:'true'});
      editor.insertInto(document.querySelector('#editor'));editor.setToolbarHidden(true);</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1100, height: 600 } });
    await page.route('https://www.wiris.net/demo/editor/editor', route => route.fulfill({
      contentType: 'text/javascript', body: fs.readFileSync(process.env.AETHER_WIRIS_EDITOR, 'utf8')
    }));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('.wrs_focusElement').waitFor();
    const reset = async () => {
      await page.evaluate(() => new Promise(resolve => editor.setMathMLWithCallback('<math xmlns="http://www.w3.org/1998/Math/MathML"/>', resolve)));
      await page.locator('.wrs_focusElement').focus();
    };
    const type = async text => {
      for (const key of text) {
        if (key === '\uE014') await page.keyboard.press('ArrowRight');
        else await page.keyboard.type(key);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const read = () => page.evaluate(() => {
      const doc = new DOMParser().parseFromString(editor.getMathML(), 'text/xml');
      return { text: doc.documentElement.textContent, powers: [...doc.querySelectorAll('msup')].map(el => el.lastElementChild.textContent), nested: doc.querySelectorAll('msup msup').length };
    });
    const answer = '243x^5-405x^4y+270x^3y^2-90x^2y^3+15xy^4-y^5';
    await reset(); await type(answer);
    assert((await read()).nested > 0, 'original input must reproduce nested powers');
    await page.screenshot({ path: '/tmp/aether-wiris-exponents-before.png' });
    await reset(); await type(mathKeys(answer));
    assert.deepEqual(await read(), { text: '243x5-405x4y+270x3y2-90x2y3+15xy4-y5', powers: ['5', '4', '3', '2', '2', '3', '4', '5'], nested: 0 });
    await type('+7');
    assert.equal((await read()).text, '243x5-405x4y+270x3y2-90x2y3+15xy4-y5+7');
    await page.screenshot({ path: '/tmp/aether-wiris-exponents-after.png' });
    const cases = [
      ['8t^(3/2)-60t+150sqrt(t)-125', '8t32-60t+150t12-125', [['3', '2'], ['1', '2']], ['-', '+', '-']],
      ['8*t*sqrt(t)-60*t+150*sqrt(t)-125', '8·t·t12-60·t+150·t12-125', [['1', '2'], ['1', '2']], ['-', '+', '-']],
      ['1024/x^5-3840y/x^4', '1024x5-3840yx4', [['1024', 'x5'], ['3840y', 'x4']], ['-']]
    ];
    for (const [input, text, fractions, signs] of cases) {
      await reset(); await type(mathKeys(input));
      const structure = await page.evaluate(() => {
        const doc = new DOMParser().parseFromString(editor.getMathML(), 'text/xml');
        return {
          text: doc.documentElement.textContent,
          fractions: [...doc.querySelectorAll('mfrac')].map(el => [...el.children].map(child => child.textContent)),
          signs: [...doc.documentElement.children].filter(el => el.localName === 'mo' && /^[+-]$/.test(el.textContent)).map(el => el.textContent),
          trappedTerms: !!doc.querySelector('mfrac mo, msup mo'),
          literalSqrt: [...doc.querySelectorAll('mi')].map(el => el.textContent).join('').includes('sqrt')
        };
      });
      assert.deepEqual(structure, { text, fractions, signs, trappedTerms: false, literalSqrt: false });
      await type('+7');
      assert.equal((await read()).text, text + '+7');
      if (input === cases[0][0]) await page.screenshot({ path: '/tmp/aether-wiris-roots-fractions-after.png' });
    }
    console.log('PASS: real MathType reproduced nesting; paced corrected answer has all coefficients, eight separate powers, no nesting, and baseline final caret');
    console.log('PASS: fractional exponents, equivalent square roots, powered denominators, baseline sum terms and final caret');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
