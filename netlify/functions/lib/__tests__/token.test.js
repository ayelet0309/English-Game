const test = require('node:test');
const assert = require('node:assert/strict');

process.env.WORKSHEET_TOKEN_SECRET = 'test-secret-do-not-use-in-production';
const { encryptAnswerKey, decryptAnswerKey, TokenError } = require('../token');

test('round-trips worksheetId/title/blocks through encrypt -> decrypt', () => {
  const blocks = [{ id: 'b1', type: 'fill_blank', items: [{ id: 'i1', correctAnswer: 'goes' }] }];
  const token = encryptAnswerKey({ worksheetId: 'ws1', title: 'Test', blocks });
  const decoded = decryptAnswerKey(token);
  assert.equal(decoded.worksheetId, 'ws1');
  assert.equal(decoded.title, 'Test');
  assert.deepEqual(decoded.blocks, blocks);
});

test('the token does not contain the plaintext answer anywhere', () => {
  const blocks = [{ id: 'b1', type: 'fill_blank', items: [{ id: 'i1', correctAnswer: 'super-secret-answer' }] }];
  const token = encryptAnswerKey({ worksheetId: 'ws1', title: 'Test', blocks });
  assert.equal(token.includes('super-secret-answer'), false);
  assert.equal(Buffer.from(token, 'base64url').toString('latin1').includes('super-secret-answer'), false);
});

test('rejects a tampered token', () => {
  const blocks = [{ id: 'b1', type: 'fill_blank', items: [] }];
  const token = encryptAnswerKey({ worksheetId: 'ws1', title: 'Test', blocks });
  const tampered = token.slice(0, -4) + (token.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  assert.throws(() => decryptAnswerKey(tampered), TokenError);
});

test('rejects an expired token', () => {
  const blocks = [{ id: 'b1', type: 'fill_blank', items: [] }];
  const token = encryptAnswerKey({ worksheetId: 'ws1', title: 'Test', blocks, ttlMs: -1 });
  assert.throws(() => decryptAnswerKey(token), (err) => err instanceof TokenError && err.code === 'TOKEN_EXPIRED');
});

test('rejects garbage input instead of throwing an unrelated error', () => {
  assert.throws(() => decryptAnswerKey('not-a-real-token'), TokenError);
});
