// OpenAI-specific implementation of the vision provider contract:
//   async analyzeWorksheet({ imageBase64, mimeType }) -> raw parsed JSON
// Nothing outside this file (and lib/visionProvider.js, which dispatches to
// it) knows this is OpenAI. Swapping providers later means adding a sibling
// file here and changing one line in visionProvider.js.

const { EXERCISE_TYPES } = require('../schema');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';
const REQUEST_TIMEOUT_MS = 25000;

const SYSTEM_PROMPT = `You are an assistant that reads photographs of English-language school worksheets for a Hebrew-speaking child and converts them into strict JSON.

Respond with ONLY a single JSON object, no prose, no markdown fences, matching exactly this shape:
{
  "title": string (a short title/description of the worksheet),
  "isWorksheet": boolean (false if the photo is not a recognizable worksheet/exercise sheet, or is too blurry/unreadable to make out any exercise),
  "blocks": [
    {
      "id": string (short unique id, e.g. "b1"),
      "type": one of ${JSON.stringify(EXERCISE_TYPES)},
      "instructions": string (the exercise instructions, translated/kept as printed),
      "items": [
        {
          "id": string (short unique id, e.g. "b1_i1"),
          "prompt": string (the question, sentence with a blank, or word being tested),
          "options": string[] (for multiple_choice / true_false / vocabulary-with-choices: this item's choices. For matching: the SAME shared list of right-side terms repeated on every item in the block; each item's "correctAnswer" is the one term from that list that matches its "prompt". Omit "options" for fill_blank / grammar / sentence_completion.),
          "studentAnswer": string or null (if the child has already handwritten/filled in an answer for this item, transcribe it; otherwise null),
          "correctAnswer": string (the single correct answer, even if the worksheet is blank -- you must determine it yourself from context/grammar rules),
          "explanation": string (a short, encouraging, age-appropriate explanation of why that is the correct answer, suitable to show a child after they answer)
        }
      ]
    }
  ]
}

Rules:
- If the photo is not a worksheet at all, or is unreadable, set "isWorksheet": false and "blocks": [].
- Only use the exercise types listed above. Pick the closest match if unsure.
- Never leave "correctAnswer" empty, even for blank worksheets -- infer the correct answer from context and standard English grammar.
- Keep "explanation" short (1-2 sentences), simple, and positive in tone.
- Output valid JSON only.`;

async function analyzeWorksheet({ imageBase64, mimeType }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ProviderConfigError('OPENAI_API_KEY is not configured');
  }
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        max_tokens: 3000,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read this worksheet photo and produce the JSON described in your instructions.' },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new ProviderUpstreamError('The vision provider took too long to respond');
    }
    throw new ProviderUpstreamError(`Network error calling vision provider: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* ignore */ }
    if (res.status === 400 && /image/i.test(detail)) {
      throw new ProviderImageError(detail || 'The image could not be processed');
    }
    throw new ProviderUpstreamError(`Vision provider returned ${res.status}: ${detail}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new ProviderUpstreamError('Vision provider returned an empty response');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ProviderUpstreamError('Vision provider did not return valid JSON');
  }
  return parsed;
}

class ProviderUpstreamError extends Error {}
class ProviderImageError extends Error {}
class ProviderConfigError extends Error {}

module.exports = { analyzeWorksheet, ProviderUpstreamError, ProviderImageError, ProviderConfigError };
