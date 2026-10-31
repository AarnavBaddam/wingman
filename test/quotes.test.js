'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { extractUrls, htmlToText, openLinks, fetchPage, isPrivateAddress, findQuotes, verifyQuotes, linkPrompt } = require('../src/research');

const page = (html, { status = 200, type = 'text/html; charset=utf-8', headers = {} } = {}) => async () =>
  new Response(status === 204 || (status >= 300 && status < 400) ? null : html, { status, headers: { 'content-type': type, ...headers } });
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const BODY = '<title>Good page</title><p>The quick brown fox jumps over the lazy dog.</p>' + '<p>Filler sentence for a realistic page body.</p>'.repeat(6);

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
    if (url.includes('good')) return page(BODY)();
    if (url.includes('blocked')) return page('', { status: 403 })();
    throw new Error('getaddrinfo ENOTFOUND');
  };
  const lookup = async host => { if (host.endsWith('.invalid')) throw new Error('ENOTFOUND'); return publicDns(); };
  const { sources, failures } = await openLinks('read https://good.com/a and https://blocked.com/b and https://gone.invalid/c', fetcher, lookup);
  assert.strictEqual(sources.length, 1);
  assert.deepStrictEqual({ number: sources[0].number, title: sources[0].title, url: sources[0].url, origin: sources[0].origin },
    { number: 1, title: 'Good page', url: 'https://good.com/a', origin: 'page' });
  assert.match(sources[0].content, /quick brown fox/);
  assert.deepStrictEqual(failures.map(f => f.url), ['https://blocked.com/b', 'https://gone.invalid/c']);
  assert.match(failures[0].reason, /403/);
  assert.match(failures[1].reason, /could not connect/i);
});

test('openLinks refuses non-text pages instead of pretending to read them', async () => {
  const { sources, failures } = await openLinks('https://x.com/file.pdf', page('%PDF', { type: 'application/pdf' }), publicDns);
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

test('private, local, and odd-port links are refused before any request is sent', async () => {
  let fetched = 0;
  const fetcher = async () => { fetched++; return page(BODY)(); };
  for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/', 'http://192.168.1.1/', 'https://good.com:8080/', 'https://user:pw@good.com/'])
    await assert.rejects(() => fetchPage(url, fetcher, publicDns), /private|local|port|password/);
  await assert.rejects(() => fetchPage('https://intranet.example/', fetcher, async () => [{ address: '10.1.2.3', family: 4 }]), /private or local/);
  assert.strictEqual(fetched, 0);
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
});

test('every redirect hop is re-checked, and redirect chains are capped', async () => {
  const toLocal = async url => url.includes('good.com') ? page('', { status: 302, headers: { location: 'http://127.0.0.1/admin' } })() : page(BODY)();
  await assert.rejects(() => fetchPage('https://good.com/', toLocal, publicDns), /private or local/);
  const loop = async () => page('', { status: 301, headers: { location: 'https://good.com/again' } })();
  await assert.rejects(() => fetchPage('https://good.com/', loop, publicDns), /too many redirects/);
  const ok = async url => url.endsWith('/final') ? page(BODY)() : page('', { status: 302, headers: { location: '/final' } })();
  assert.match((await fetchPage('https://good.com/', ok, publicDns)).text, /quick brown fox/);
});

test('oversized pages are refused or truncated while streaming, not after', async () => {
  await assert.rejects(() => fetchPage('https://good.com/', page(BODY, { headers: { 'content-length': '50000000' } }), publicDns), /too large/);
  const huge = BODY + '<p>' + 'x'.repeat(3_000_000) + '</p>';
  const { text } = await fetchPage('https://good.com/', page(huge), publicDns);
  assert.ok(text.length <= 1_000_000);
});

test('htmlToText stays linear on hostile markup', () => {
  for (const hostile of ['<!--'.repeat(200000), '<p'.repeat(200000), '<script>'.repeat(100000), '<title>'.repeat(100000), '&' + 'a'.repeat(400000)]) {
    const t = Date.now(); htmlToText(hostile);
    assert.ok(Date.now() - t < 1000, `slow on ${hostile.slice(0, 8)}…`);
  }
});

test('the real connection refuses a name that resolves to a local address (DNS rebinding)', async () => {
  const server = require('node:http').createServer((req, res) => res.end('secret')).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const { port } = server.address();
  try {
    // checkPublicUrl is bypassed here on purpose: this is the connect-time guard alone.
    await assert.rejects(() => require('../src/research').pinnedFetch(`http://localhost:${port}/`), /private or local/);
  } finally { server.close(); }
});
