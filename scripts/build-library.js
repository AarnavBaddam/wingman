// Build the bundled, attributable Wikipedia reference library.
// Run manually when refreshing sources: node scripts/build-library.js
const fs = require('node:fs');
const path = require('node:path');

const API = 'https://en.wikipedia.org/w/api.php';
const OUTPUT = path.join(__dirname, '..', 'data', 'library.json');
const CATEGORIES = [
  'Mathematics', 'Mathematical analysis', 'Abstract algebra', 'Linear algebra',
  'Geometry', 'Probability theory', 'Statistics', 'History of mathematics',
  'Computer science', 'Algorithms', 'Data structures', 'Artificial intelligence',
  'History of computing', 'Physics', 'Classical mechanics', 'Quantum mechanics',
  'Thermodynamics', 'History of physics', 'Chemistry', 'Biology', 'Scientific method'
];
const ESSENTIALS = [
  'Calculus', 'Differential calculus', 'Integral calculus', 'Real analysis', 'Complex analysis',
  'Multivariable calculus', 'Linear algebra', 'Abstract algebra', 'Group theory', 'Ring (mathematics)',
  'Field (mathematics)', 'Topology', 'Metric space', 'Banach space', 'Hilbert space',
  'Measure (mathematics)', 'Lebesgue integration', 'Fourier transform', 'Differential equation',
  'Partial differential equation', 'Probability theory', 'Bayes\' theorem', 'Statistical inference',
  'Set theory', 'Mathematical logic', 'Number theory', 'Prime number', 'Graph theory',
  'Spectral theorem', 'Eigenvalues and eigenvectors', 'History of mathematics', 'History of calculus',
  'Computer science', 'Algorithm', 'Data structure', 'Binary search tree', 'Hash table',
  'Sorting algorithm', 'Dynamic programming', 'Computational complexity theory', 'P versus NP problem',
  'Turing machine', 'Compiler', 'Operating system', 'Computer network', 'Cryptography',
  'Artificial intelligence', 'Machine learning', 'Neural network (machine learning)', 'Database',
  'Programming language', 'History of computing', 'Physics', 'Classical mechanics',
  'Newton\'s laws of motion', 'Lagrangian mechanics', 'Hamiltonian mechanics', 'Electromagnetism',
  'Maxwell\'s equations', 'Special relativity', 'General relativity', 'Quantum mechanics',
  'Quantum entanglement', 'Thermodynamics', 'Statistical mechanics', 'Particle physics',
  'Optics', 'Fluid mechanics', 'History of physics', 'Chemistry', 'Chemical bond',
  'Periodic table', 'Organic chemistry', 'Biochemistry', 'Biology', 'Cell (biology)',
  'Evolution', 'Genetics', 'Molecular biology', 'Astronomy', 'Cosmology', 'Scientific method'
];

async function api(params) {
  const url = new URL(API);
  for (const [key, value] of Object.entries({ action: 'query', format: 'json', ...params })) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { 'user-agent': 'Aether/0.1 (https://github.com/AarnavBaddam/wingman; educational reference build)' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Wikipedia API failed: ${response.status}`);
  return response.json();
}

function hash(text) {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

async function categoryTitles(category) {
  const titles = [];
  let next;
  do {
    const result = await api({ list: 'categorymembers', cmtitle: `Category:${category}`, cmnamespace: '0', cmlimit: '500', ...(next ? { cmcontinue: next } : {}) });
    titles.push(...(result.query?.categorymembers || []).map(item => item.title));
    next = result.continue?.cmcontinue;
  } while (next && titles.length < 2500);
  return titles.sort((a, b) => hash(a) - hash(b)).slice(0, 125);
}

async function main() {
  const titles = new Set([...CATEGORIES, ...ESSENTIALS]);
  for (const category of CATEGORIES) {
    for (const title of await categoryTitles(category)) titles.add(title);
    process.stdout.write(`${category}: ${titles.size} unique titles\n`);
  }
  const existing = fs.existsSync(OUTPUT) ? JSON.parse(fs.readFileSync(OUTPUT, 'utf8')).pages : [];
  const pages = new Map(existing.map(page => [page.url, page]));
  const allTitles = [...titles];
  for (let i = 0; i < allTitles.length; i += 20) {
    const result = await api({ prop: 'extracts', exlimit: '20', explaintext: '1', exintro: '1', redirects: '1', titles: allTitles.slice(i, i + 20).join('|') });
    for (const page of Object.values(result.query?.pages || {})) {
      const text = String(page.extract || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 16000);
      if (page.ns !== 0 || text.length < 180) continue;
      const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replaceAll(' ', '_'))}`;
      if ((pages.get(url)?.text.length || 0) < text.length) pages.set(url, { title: page.title, url, text });
    }
    if (i % 200 === 0) process.stdout.write(`Fetched ${i}/${allTitles.length}\n`);
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify({ source: 'Wikipedia contributors', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', fetchedAt: new Date().toISOString(), pages: [...pages.values()] }, null, 0));
  process.stdout.write(`Wrote ${pages.size} pages to ${OUTPUT}\n`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
