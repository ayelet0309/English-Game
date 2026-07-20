const test = require('node:test');
const assert = require('node:assert/strict');
const { gradeItem, gradeWorksheet, worksheetHasAnyAnswers } = require('../grading');

test('gradeItem: exact match on fill_blank', () => {
  assert.equal(gradeItem('fill_blank', 'goes', 'goes'), true);
});

test('gradeItem: case/whitespace tolerant', () => {
  assert.equal(gradeItem('fill_blank', '  Goes  ', 'goes'), true);
});

test('gradeItem: fuzzy tolerance for a longer word with a typo', () => {
  assert.equal(gradeItem('fill_blank', 'beatiful', 'beautiful'), true); // 1 char off, len 9 -> tolerance 2
});

test('gradeItem: fuzzy tolerance does not accept a wrong short word', () => {
  assert.equal(gradeItem('fill_blank', 'cat', 'dog'), false);
});

test('gradeItem: true_false accepts hebrew and english forms', () => {
  assert.equal(gradeItem('true_false', 'נכון', 'true'), true);
  assert.equal(gradeItem('true_false', 'False', 'false'), true);
  assert.equal(gradeItem('true_false', 'true', 'false'), false);
});

test('gradeItem: multiple_choice requires exact normalized match', () => {
  assert.equal(gradeItem('multiple_choice', 'most beautiful', 'most beautiful'), true);
  assert.equal(gradeItem('multiple_choice', 'beautifulest', 'most beautiful'), false);
});

test('gradeItem: null/empty student answer is always wrong', () => {
  assert.equal(gradeItem('fill_blank', null, 'goes'), false);
  assert.equal(gradeItem('fill_blank', '', 'goes'), false);
});

test('worksheetHasAnyAnswers detects a filled item anywhere', () => {
  const blocks = [
    { id: 'b1', type: 'fill_blank', items: [{ id: 'i1', studentAnswer: null, correctAnswer: 'a' }] },
    { id: 'b2', type: 'fill_blank', items: [{ id: 'i2', studentAnswer: 'yes', correctAnswer: 'a' }] },
  ];
  assert.equal(worksheetHasAnyAnswers(blocks), true);
});

test('worksheetHasAnyAnswers is false for a fully blank worksheet', () => {
  const blocks = [
    { id: 'b1', type: 'fill_blank', items: [{ id: 'i1', studentAnswer: null, correctAnswer: 'a' }] },
  ];
  assert.equal(worksheetHasAnyAnswers(blocks), false);
});

test('gradeWorksheet scores using item.studentAnswer when no override given', () => {
  const blocks = [
    {
      id: 'b1', type: 'fill_blank', instructions: '',
      items: [
        { id: 'i1', prompt: 'p1', studentAnswer: 'goes', correctAnswer: 'goes', explanation: 'e' },
        { id: 'i2', prompt: 'p2', studentAnswer: 'go', correctAnswer: 'goes', explanation: 'e' },
      ],
    },
  ];
  const { score, blocks: graded } = gradeWorksheet(blocks);
  assert.deepEqual(score, { correct: 1, total: 2, percent: 50 });
  assert.equal(graded[0].items[0].isCorrect, true);
  assert.equal(graded[0].items[1].isCorrect, false);
});

test('gradeWorksheet scores using answersOverride when given (interactive mode)', () => {
  const blocks = [
    {
      id: 'b1', type: 'true_false', instructions: '',
      items: [
        { id: 'i1', prompt: 'p1', correctAnswer: 'true', explanation: 'e' },
        { id: 'i2', prompt: 'p2', correctAnswer: 'false', explanation: 'e' },
      ],
    },
  ];
  const answers = { i1: 'true', i2: 'true' };
  const { score } = gradeWorksheet(blocks, answers);
  assert.deepEqual(score, { correct: 1, total: 2, percent: 50 });
});

test('gradeWorksheet treats an unanswered item in answersOverride as incorrect, not a crash', () => {
  const blocks = [
    { id: 'b1', type: 'fill_blank', instructions: '', items: [{ id: 'i1', prompt: 'p1', correctAnswer: 'a', explanation: 'e' }] },
  ];
  const { score } = gradeWorksheet(blocks, {});
  assert.deepEqual(score, { correct: 0, total: 1, percent: 0 });
});
