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
    console.log('PASS: real MathType reproduced nesting; paced corrected answer has all coefficients, eight separate powers, no nesting, and baseline final caret');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
