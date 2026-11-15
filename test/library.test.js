const test = require('node:test');
const assert = require('node:assert/strict');
const { searchLibrary } = require('../src/library');

test('bundled reference library retrieves core concepts with article links', () => {
  for (const concept of ['Banach space', 'Binary search tree', 'Quantum entanglement', 'History of calculus']) {
    const result = searchLibrary(concept);
    assert.equal(result[0].title.toLowerCase(), concept.toLowerCase());
    assert.match(result[0].url, /^https:\/\/en\.wikipedia\.org\/wiki\//);
    assert.ok(result[0].content.length >= 500);
  }
});
