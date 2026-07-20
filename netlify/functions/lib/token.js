// Lets the answer key travel through the browser between the extract and
// grade calls without the browser ever being able to read it. The client
// receives only ciphertext; without WORKSHEET_TOKEN_SECRET (server-only) it
// cannot be decoded. An expiry is embedded so a stale token can't be replayed
// indefinitely.

const crypto = require('crypto');

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const ALGO = 'aes-256-gcm';

function getKey() {
  const secret = process.env.WORKSHEET_TOKEN_SECRET;
  if (!secret) {
    throw new Error('WORKSHEET_TOKEN_SECRET is not configured');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptAnswerKey({ worksheetId, title, blocks, ttlMs = TOKEN_TTL_MS }) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const payload = JSON.stringify({
    worksheetId,
    title,
    blocks,
    exp: Date.now() + ttlMs,
  });
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64url');
}

function decryptAnswerKey(token) {
  let raw;
  try {
    raw = Buffer.from(token, 'base64url');
  } catch {
    throw new TokenError('TOKEN_INVALID', 'Token is not valid base64');
  }
  if (raw.length < 12 + 16 + 1) {
    throw new TokenError('TOKEN_INVALID', 'Token is malformed');
  }
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);

  const key = getKey();
  let decrypted;
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw new TokenError('TOKEN_INVALID', 'Token could not be decrypted');
  }

  let parsed;
  try {
    parsed = JSON.parse(decrypted);
  } catch {
    throw new TokenError('TOKEN_INVALID', 'Token payload was not valid JSON');
  }

  if (typeof parsed.exp !== 'number' || Date.now() > parsed.exp) {
    throw new TokenError('TOKEN_EXPIRED', 'This worksheet scan has expired, please scan again');
  }

  return { worksheetId: parsed.worksheetId, title: parsed.title, blocks: parsed.blocks };
}

class TokenError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

module.exports = { encryptAnswerKey, decryptAnswerKey, TokenError };
