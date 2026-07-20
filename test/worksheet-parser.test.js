const test = require('node:test');
const assert = require('node:assert/strict');
const WSParser = require('../netlify-game/worksheet-parser.js');

test('detects true_false items and their trailing detected answer', () => {
  const text = `
6. The sun rises in the west.  (True / False) -> False
7. Cats are mammals.  (True / False) -> True
`;
  const result = WSParser.parseWorksheetText(text);
  assert.equal(result.recognized, true);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].type, 'true_false');
  assert.equal(result.items[0].studentAnswer, 'False');
  assert.equal(result.items[1].studentAnswer, 'True');
});

test('detects a filled-in fill_blank only via an explicit arrow marker', () => {
  const text = `1. She ______ (go) to school every day.
-> goes
2. He ______ (play) football on Sundays.
-> plays`;
  const result = WSParser.parseWorksheetText(text);
  assert.equal(result.recognized, true);
  assert.equal(result.items[0].type, 'fill_blank');
  assert.equal(result.items[0].studentAnswer, 'goes');
  assert.equal(result.items[1].studentAnswer, 'plays');
});

test('does NOT treat a sentence subject as a filled answer when OCR drops the blank (no false positive)', () => {
  // Simulates real OCR output where the underscore blank was not picked up
  // at all -- "She (go) to school" should NOT be read as "She" being the answer.
  const text = `1. She (go) to school every day.
2. They (do) their homework after dinner.`;
  const result = WSParser.parseWorksheetText(text);
  assert.equal(result.items[0].studentAnswer, null);
  assert.equal(result.items[1].studentAnswer, null);
});

test('detects an unfilled fill_blank via an underscore run', () => {
  const text = `1. She ______ (go) to school every day.
2. He ______ (play) football on Sundays.`;
  const result = WSParser.parseWorksheetText(text);
  assert.equal(result.items[0].type, 'fill_blank');
  assert.equal(result.items[0].studentAnswer, null);
});

test('detects multiple_choice options', () => {
  const text = `1. What color is the sky? a) red b) blue c) green
2. What is 2+2? a) three b) four c) five`;
  const result = WSParser.parseWorksheetText(text);
  assert.equal(result.items[0].type, 'multiple_choice');
  assert.deepEqual(result.items[0].options, ['red', 'blue', 'green']);
});

test('detects simple vocabulary lines', () => {
  const text = `1. dog - כלב
2. cat - חתול
3. house - בית`;
  const result = WSParser.parseWorksheetText(text);
  assert.equal(result.items[0].type, 'vocabulary');
  assert.equal(result.items[0].prompt, 'dog');
});

test('parses an explicit answer key section and attaches correctAnswer by number', () => {
  const text = `
1. She ______ (go) to school every day.
2. He ______ (play) football on Sundays.

Answer key:
1. goes
2. plays
`;
  const result = WSParser.parseWorksheetText(text);
  assert.equal(result.hasAnswerKey, true);
  assert.equal(result.items[0].correctAnswer, 'goes');
  assert.equal(result.items[1].correctAnswer, 'plays');
});

test('unstructured prose with no numbering or markers is not recognized', () => {
  const text = 'The quick brown fox jumps over the lazy dog near the riverbank on a sunny afternoon.';
  const result = WSParser.parseWorksheetText(text);
  assert.equal(result.recognized, false);
});

test('gradeItems only grades items that have a correctAnswer, leaves others null', () => {
  const items = [
    { number: 1, type: 'fill_blank', prompt: 'p1', studentAnswer: 'goes', correctAnswer: 'goes' },
    { number: 2, type: 'fill_blank', prompt: 'p2', studentAnswer: 'go', correctAnswer: 'goes' },
    { number: 3, type: 'fill_blank', prompt: 'p3', studentAnswer: 'foo' }, // no key -> ungraded
  ];
  const { items: graded, score } = WSParser.gradeItems(items);
  assert.equal(graded[0].isCorrect, true);
  assert.equal(graded[1].isCorrect, false);
  assert.equal(graded[2].isCorrect, null);
  assert.deepEqual(score, { correct: 1, gradable: 2, total: 3 });
});

test('gradeItems applies an answersOverride map keyed by item number (interactive mode)', () => {
  const items = [
    { number: 1, type: 'true_false', prompt: 'p1', studentAnswer: null, correctAnswer: 'True' },
  ];
  const { items: graded, score } = WSParser.gradeItems(items, { 1: 'True' });
  assert.equal(graded[0].isCorrect, true);
  assert.deepEqual(score, { correct: 1, gradable: 1, total: 1 });
});

test('fuzzyMatches tolerates minor OCR/typo noise on longer words', () => {
  assert.equal(WSParser.fuzzyMatches('beatiful', 'beautiful'), true);
  assert.equal(WSParser.fuzzyMatches('cat', 'dog'), false);
});
