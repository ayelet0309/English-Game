// POST /.netlify/functions/scan-worksheet-grade
// Body: { worksheetId: string, token: string, answers: { [itemId]: string } }
//
// Used after scan-worksheet-extract returned mode "interactive" (a blank
// worksheet). The child has now answered on-screen; this decrypts the
// answer key sealed in `token` (never exposed to the client until now),
// grades the submitted answers, and returns the same "graded" shape that
// scan-worksheet-extract returns for an already-filled-in worksheet.

const { ok, fail, RequestError } = require('./lib/response');
const { decryptAnswerKey, TokenError } = require('./lib/token');
const { gradeWorksheet } = require('./lib/grading');

const MAX_ANSWER_LENGTH = 500;
const MAX_ANSWERS = 200;

function parseAndValidateRequest(event) {
  if (event.httpMethod !== 'POST') {
    throw new RequestError('METHOD_NOT_ALLOWED', 'Only POST is supported');
  }
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    throw new RequestError('INVALID_REQUEST', 'Request body must be valid JSON');
  }
  const { worksheetId, token, answers } = body;
  if (typeof worksheetId !== 'string' || !worksheetId) {
    throw new RequestError('INVALID_REQUEST', 'worksheetId is required');
  }
  if (typeof token !== 'string' || !token) {
    throw new RequestError('INVALID_REQUEST', 'token is required');
  }
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) {
    throw new RequestError('INVALID_REQUEST', 'answers must be an object keyed by item id');
  }
  const keys = Object.keys(answers);
  if (keys.length > MAX_ANSWERS) {
    throw new RequestError('INVALID_REQUEST', 'Too many answers submitted');
  }
  const sanitizedAnswers = {};
  for (const key of keys) {
    const value = answers[key];
    if (typeof value === 'string') {
      sanitizedAnswers[key] = value.slice(0, MAX_ANSWER_LENGTH);
    }
  }
  return { worksheetId, token, answers: sanitizedAnswers };
}

exports.handler = async (event) => {
  try {
    const { worksheetId, token, answers } = parseAndValidateRequest(event);

    let decrypted;
    try {
      decrypted = decryptAnswerKey(token);
    } catch (err) {
      if (err instanceof TokenError) {
        throw new RequestError(err.code, err.message);
      }
      throw err;
    }

    if (decrypted.worksheetId !== worksheetId) {
      throw new RequestError('TOKEN_INVALID', 'This token does not match the submitted worksheet');
    }

    const { blocks, score } = gradeWorksheet(decrypted.blocks, answers);
    return ok({ mode: 'graded', worksheetId, title: decrypted.title, score, blocks });
  } catch (err) {
    if (err instanceof RequestError) {
      return fail(err.code, err.message);
    }
    console.error('scan-worksheet-grade unexpected error:', err.message);
    return fail('INTERNAL_ERROR', 'Something went wrong grading this worksheet');
  }
};
