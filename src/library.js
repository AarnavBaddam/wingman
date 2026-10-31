// Local lexical retrieval over the bundled, attributed reference library.
const fs = require('node:fs');
const path = require('node:path');

const LIBRARY = path.join(__dirname, '..', 'data', 'library.json');
const STOP = new Set('a an and are as at be by can concept define definition did do does explain for from how i in is it me of on or principle the to was were what when where which who why with work works you your give tell show about into between using use'.split(' '));
let passages;

function terms(text) {
  return [...new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).filter(word => !STOP.has(word)))];
}

function splitText(text) {
  const parts = text.split(/\n\s*\n/);
  const chunks = [];
  let chunk = '';
  for (const part of parts) {
    if (chunk.length + part.length > 2200 && chunk) { chunks.push(chunk); chunk = ''; }
    // Long sections are split to keep source evidence within model context.
    for (let i = 0; i < part.length; i += 2200) {
      const slice = part.slice(i, i + 2200);
      if (chunk.length + slice.length > 2200 && chunk) { chunks.push(chunk); chunk = ''; }
      chunk += (chunk ? '\n\n' : '') + slice;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function load() {
  if (passages) return passages;
  const library = JSON.parse(fs.readFileSync(LIBRARY, 'utf8'));
  passages = library.pages.flatMap(page => splitText(page.text).map(content => ({
    title: page.title, url: page.url, content, words: new Set(terms(content)), titleWords: new Set(terms(page.title)), origin: 'library'
  })));
  return passages;
}

function isCurrentQuery(query) {
  return /\b(today|yesterday|tomorrow|latest|current|currently|recent|recently|this week|this month|this year|right now|breaking|live|newest|price|weather|forecast|version|release|update|202[4-9])\b/i.test(query);
}

function searchLibrary(query, collection = load()) {
  const words = terms(query);
  if (!words.length) return [];
  const ranked = [];
  for (const passage of collection) {
    let hits = 0, titleHits = 0;
    for (const word of words) {
      if (passage.words.has(word) || passage.titleWords.has(word)) hits++;
      if (passage.titleWords.has(word)) titleHits++;
    }
    const coverage = hits / words.length;
    if (coverage < 0.7 || (!titleHits && hits < Math.min(2, words.length))) continue;
    ranked.push({ ...passage, score: coverage * 10 + titleHits * 3 + hits });
  }
  ranked.sort((a, b) => b.score - a.score);
  const selected = [], used = new Set();
  for (const passage of ranked) {
    if (used.has(passage.url)) continue;
    used.add(passage.url);
    selected.push({ title: passage.title, url: passage.url, content: passage.content, origin: 'library' });
    if (selected.length === 4) break;
  }
  return selected.map((source, i) => ({ ...source, number: i + 1 }));
}

module.exports = { searchLibrary, isCurrentQuery, terms, splitText };
