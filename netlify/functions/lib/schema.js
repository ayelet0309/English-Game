// The one contract every vision provider must satisfy. We never trust a
// provider's raw output directly -- everything is run through this validator
// first, regardless of how "structured" the provider's own output mode claims
// to be. If a provider's response doesn't match this shape, it is rejected.

const Ajv = require('ajv');

const EXERCISE_TYPES = [
  'fill_blank',
  'multiple_choice',
  'matching',
  'true_false',
  'vocabulary',
  'grammar',
  'sentence_completion',
];

const itemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'prompt', 'correctAnswer'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 60 },
    prompt: { type: 'string', minLength: 1, maxLength: 1000 },
    options: {
      // For multiple_choice/true_false/vocabulary: the choices for this item.
      // For matching: the shared pool of right-side terms for the whole
      // block: every item in a matching block repeats the same options list,
      // and each item's correctAnswer is the one that matches its prompt.
      type: 'array',
      items: { type: 'string', maxLength: 200 },
      maxItems: 12,
    },
    studentAnswer: { type: ['string', 'null'], maxLength: 500 },
    correctAnswer: { type: 'string', minLength: 1, maxLength: 500 },
    explanation: { type: 'string', maxLength: 800 },
  },
};

const blockSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'instructions', 'items'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 60 },
    type: { type: 'string', enum: EXERCISE_TYPES },
    instructions: { type: 'string', maxLength: 500 },
    items: { type: 'array', items: itemSchema, minItems: 1, maxItems: 30 },
  },
};

const worksheetExtractionSchema = {
  $id: 'worksheetExtraction',
  type: 'object',
  additionalProperties: false,
  required: ['title', 'isWorksheet', 'blocks'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    isWorksheet: { type: 'boolean' },
    blocks: { type: 'array', items: blockSchema, minItems: 0, maxItems: 20 },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validateWorksheetExtraction = ajv.compile(worksheetExtractionSchema);

module.exports = {
  EXERCISE_TYPES,
  worksheetExtractionSchema,
  validateWorksheetExtraction,
};
