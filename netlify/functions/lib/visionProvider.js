// Provider-agnostic entry point used by the function handlers. To switch
// vision providers later (e.g. away from OpenAI), implement the same
// `analyzeWorksheet({ imageBase64, mimeType }) -> raw JSON` contract in a new
// file under lib/providers/ and change only the require() below -- nothing
// in scan-worksheet-extract.js, schema.js, or grading.js needs to change.

const openaiProvider = require('./providers/openai');

const provider = openaiProvider;

async function analyzeWorksheet(input) {
  return provider.analyzeWorksheet(input);
}

module.exports = {
  analyzeWorksheet,
  ProviderUpstreamError: openaiProvider.ProviderUpstreamError,
  ProviderImageError: openaiProvider.ProviderImageError,
  ProviderConfigError: openaiProvider.ProviderConfigError,
};
