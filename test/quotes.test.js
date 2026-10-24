'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { extractUrls, htmlToText, openLinks, findQuotes, verifyQuotes, linkPrompt } = require('../src/research');

const page = (html, { status = 200, type = 'text/html; charset=utf-8' } = {}) => async () => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: name => (name.toLowerCase() === 'content-type' ? type : null) },
  text: async () => html,
});

test('extractUrls finds http(s) links and trims trailing punctuation', () => {
  assert.deepStrictEqual(
    extractUrls('See https://a.com/x, and (http://b.org/y). Also https://a.com/x again.'),
    ['https://a.com/x', 'http://b.org/y']);
  assert.deepStrictEqual(extractUrls('no links here'), []);
});

test('htmlToText drops script/style and decodes entities', () => {
  const { text } = htmlToText('<html><head><title>T &amp; U</title><style>p{}</style></head><body><script>evil()</script><p>Hello&nbsp;&ldquo;world&rdquo; &#39;x&#39;</p></body></html>');
  assert.doesNotMatch(text, /evil|p\{\}/);
  assert.match(text, /Hello “world” 'x'/);
});

test('openLinks returns page sources and names every link it could not open', async () => {
  const fetcher = async (url) => {
    if (url.includes('good')) return page('<title>Good page</title><p>The quick brown fox jumps over the lazy dog.</p>' + '<p>Filler sentence for a realistic page body.</p>'.repeat(6))();
    if (url.includes('blocked')) return page('', { status: 403 })();
    throw new Error('getaddrinfo ENOTFOUND');
  };
  const { sources, failures } = await openLinks('read https://good.com/a and https://blocked.com/b and https://gone.invalid/c', fetcher);
  assert.strictEqual(sources.length, 1);
  assert.deepStrictEqual({ number: sources[0].number, title: sources[0].title, url: sources[0].url, origin: sources[0].origin },
    { number: 1, title: 'Good page', url: 'https://good.com/a', origin: 'page' });
  assert.match(sources[0].content, /quick brown fox/);
  assert.deepStrictEqual(failures.map(f => f.url), ['https://blocked.com/b', 'https://gone.invalid/c']);
  assert.match(failures[0].reason, /403/);
  assert.match(failures[1].reason, /could not connect/i);
});

test('openLinks refuses non-text pages instead of pretending to read them', async () => {
  const { sources, failures } = await openLinks('https://x.com/file.pdf', page('%PDF', { type: 'application/pdf' }));
  assert.strictEqual(sources.length, 0);
  assert.match(failures[0].reason, /application\/pdf/);
});

test('findQuotes picks up straight and curly quotes of 4+ words, skips scare quotes', () => {
  const q = findQuotes('He said "the quick brown fox jumps" and called it “a lazy old dog indeed”, not "smart".');
  assert.deepStrictEqual(q, ['the quick brown fox jumps', 'a lazy old dog indeed']);
});

test('verifyQuotes accepts verbatim quotes and flags invented or altered ones', () => {
  const sources = [{ number: 1, content: 'The  quick brown fox — jumps over the lazy dog. It’s fast.' }];
  const r = verifyQuotes('“The quick brown fox - jumps over” and "it\'s fast." but "the slow green turtle crawls"', sources);
  assert.deepStrictEqual(r.verified, ['The quick brown fox - jumps over']);
  assert.deepStrictEqual(r.unverified, ['the slow green turtle crawls']);
  // "it's fast." is only 2 words — not checked.
});

test('verifyQuotes with no sources marks every quote unverified', () => {
  assert.deepStrictEqual(verifyQuotes('"one two three four"', []).unverified, ['one two three four']);
});

test('linkPrompt tells the model which links failed and forbids guessing', () => {
  const p = linkPrompt([{ url: 'https://blocked.com/b', reason: 'HTTP 403' }]);
  assert.match(p, /https:\/\/blocked\.com\/b/);
  assert.match(p, /HTTP 403/);
  assert.match(p, /could not open/i);
  assert.strictEqual(linkPrompt([]), '');
});
