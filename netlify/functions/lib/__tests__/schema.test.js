const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWorksheetExtraction } = require('../schema');

test('accepts a well-formed worksheet extraction', () => {
  const valid = {
    title: 'Present Simple Practice',
    isWorksheet: true,
    blocks: [
      {
        id: 'b1',
        type: 'fill_blank',
        instructions: 'Fill in the blank',
        items: [
          { id: 'b1_i1', prompt: 'She ___ to school.', studentAnswer: null, correctAnswer: 'goes', explanation: 'Third person singular adds -s/-es.' },
        ],
      },
    ],
  };
  assert.equal(validateWorksheetExtraction(valid), true);
});

test('rejects an unknown exercise type', () => {
  const invalid = {
    title: 'x',
    isWorksheet: true,
    blocks: [{ id: 'b1', type: 'essay_writing', instructions: '', items: [{ id: 'i1', prompt: 'p', correctAnswer: 'a' }] }],
  };
  assert.equal(validateWorksheetExtraction(invalid), false);
});

test('rejects a missing correctAnswer', () => {
  const invalid = {
    title: 'x',
    isWorksheet: true,
    blocks: [{ id: 'b1', type: 'true_false', instructions: '', items: [{ id: 'i1', prompt: 'p' }] }],
  };
  assert.equal(validateWorksheetExtraction(invalid), false);
});

test('rejects unexpected top-level properties', () => {
  const invalid = {
    title: 'x',
    isWorksheet: true,
    blocks: [],
    extraField: 'should not be here',
  };
  assert.equal(validateWorksheetExtraction(invalid), false);
});

test('accepts isWorksheet:false with empty blocks', () => {
  const valid = { title: 'Not a worksheet', isWorksheet: false, blocks: [] };
  assert.equal(validateWorksheetExtraction(valid), true);
});
