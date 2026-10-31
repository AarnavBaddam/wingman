const test = require('node:test');
const assert = require('node:assert/strict');
const { Marked } = require('marked');
const katex = require('katex');
const { createAnswerFormatter } = require('../renderer/answer-format');

// Browser QA exercises the real sanitizer; these tests isolate Markdown/math parsing.
const render = createAnswerFormatter({ Marked, katex, DOMPurify: { sanitize: html => html } });
test('chunk concatenation preserves spaces, indentation, headings and ordered lists', () => {
  const text = ['## Answer\n\nHello', ' ', '**world**', '!\n\n1. First\n2. Second\n\n', '```js\n  const s = "a  b";\n```'].join('');
  const html = render(text);
  assert.match(html, /<h2>Answer<\/h2>/);
  assert.match(html, /Hello <strong>world<\/strong>!/);
  assert.match(html, /<ol>/);
  assert.match(html, /  const s = &quot;a  b&quot;;/);
});
test('math reads raw symbols and supports dollar and LaTeX delimiters', () => {
  for (const text of ['$x < y$', '\\(x < y\\)', '$$x < y$$', '\\[x < y\\]', '$$\n\\begin{matrix}a&b\\\\c&d\\end{matrix}\n$$']) {
    const html = render(text);
    assert.match(html, /class="katex/);
    assert.doesNotMatch(html, /katex-error/);
  }
});
test('code and inline code preserve math delimiters literally', () => {
  const html = render('`$x$`\n\n```tex\n$x < y$\n```');
  assert.doesNotMatch(html, /class="katex/);
  assert.match(html, /<code>\$x\$<\/code>/);
});
test('tables render and sanitization is required for every answer', () => {
  let options;
  const safe = createAnswerFormatter({ Marked, katex, DOMPurify: { sanitize(html, config) { options = config; return 'sanitized'; } } });
  assert.match(render('| A | B |\n| - | - |\n| 1 | 2 |'), /<table>/);
  assert.equal(safe('<script>unsafe</script>'), 'sanitized');
  assert(options.FORBID_TAGS.includes('img'));
});
