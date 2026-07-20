// POST /.netlify/functions/scan-worksheet-extract
// Body: { imageBase64: string, mimeType: string }
//
// Takes a photo of a worksheet, asks the vision provider to read it, and
// returns either:
//  - mode: "graded"      -- the worksheet already had answers written on it,
//                            so it's graded immediately (nothing to hide,
//                            the answers are already fixed in the photo).
//  - mode: "interactive"  -- the worksheet is blank; the child will answer
//                            on-screen, so correctAnswer/explanation are
//                            stripped from the response and instead sealed
//                            into an encrypted `token` the client must send
//                            back unmodified to /scan-worksheet-grade.
//
// The image itself is only ever held in memory for the duration of this
// request; it is never written to disk, logged, or returned to the client.

const crypto = require('crypto');
const { ok, fail, RequestError } = require('./lib/response');
const { validateWorksheetExtraction } = require('./lib/schema');
const { gradeWorksheet, worksheetHasAnyAnswers } = require('./lib/grading');
const { encryptAnswerKey } = require('./lib/token');
const visionProvider = require('./lib/visionProvider');

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// ~4MB decoded image, base64 inflates size by ~4/3.
const MAX_BASE64_CHARS = 5_600_000;

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
  const { imageBase64, mimeType } = body;
  if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
    throw new RequestError('INVALID_REQUEST', 'imageBase64 is required');
  }
  if (imageBase64.length > MAX_BASE64_CHARS) {
    throw new RequestError('INVALID_REQUEST', 'Image is too large -- please use a smaller photo');
  }
  if (typeof mimeType !== 'string' || !ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new RequestError('INVALID_REQUEST', 'mimeType must be one of image/jpeg, image/png, image/webp');
  }
  return { imageBase64, mimeType };
}

async function callProviderAndValidate(input) {
  // The provider's own "structured output" claims are not trusted on their
  // own -- every response is independently validated against our schema
  // here, with one retry before giving up.
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw;
    try {
      raw = await visionProvider.analyzeWorksheet(input);
    } catch (err) {
      if (err instanceof visionProvider.ProviderImageError) {
        throw new RequestError('UNREADABLE_IMAGE', 'This photo could not be read -- try better lighting or a closer, straighter shot');
      }
      throw new RequestError('UPSTREAM_ERROR', 'The vision service is unavailable right now, please try again shortly');
    }
    if (validateWorksheetExtraction(raw)) {
      return raw;
    }
    // fall through to retry once
  }
  throw new RequestError('VALIDATION_FAILED', "We couldn't reliably read this worksheet -- please try again with a clearer photo");
}

function buildPublicBlocks(blocks) {
  return blocks.map((block) => ({
    id: block.id,
    type: block.type,
    instructions: block.instructions,
    items: block.items.map((item) => ({
      id: item.id,
      prompt: item.prompt,
      options: item.options,
    })),
  }));
}

exports.handler = async (event) => {
  try {
    const input = parseAndValidateRequest(event);
    const extracted = await callProviderAndValidate(input);

    if (!extracted.isWorksheet || extracted.blocks.length === 0) {
      throw new RequestError('UNSUPPORTED_WORKSHEET', "We couldn't find a worksheet in this photo -- try a clearer, fuller shot of the page");
    }

    const worksheetId = crypto.randomUUID();

    if (worksheetHasAnyAnswers(extracted.blocks)) {
      const { blocks, score } = gradeWorksheet(extracted.blocks);
      return ok({ mode: 'graded', worksheetId, title: extracted.title, score, blocks });
    }

    const token = encryptAnswerKey({ worksheetId, title: extracted.title, blocks: extracted.blocks });
    return ok({
      mode: 'interactive',
      worksheetId,
      title: extracted.title,
      blocks: buildPublicBlocks(extracted.blocks),
      token,
    });
  } catch (err) {
    if (err instanceof RequestError) {
      return fail(err.code, err.message);
    }
    console.error('scan-worksheet-extract unexpected error:', err.message);
    return fail('INTERNAL_ERROR', 'Something went wrong processing this worksheet');
  }
};
