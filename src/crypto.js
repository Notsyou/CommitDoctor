'use strict';
const crypto = require('crypto');

// Encrypts personal access tokens at rest in the tracked_repos table.
// AES-256-GCM: random 12-byte IV per value, 16-byte auth tag, stored together
// as "iv:tag:ciphertext" in base64. Requires TOKEN_ENCRYPTION_KEY (32 raw bytes,
// given as a 64-char hex string in .env) — generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

function loadKey(hex) {
  if (!hex) return null;
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
  }
  return buf;
}

function encryptToken(plainText, keyHex) {
  const key = loadKey(keyHex);
  if (!key) throw new Error('TOKEN_ENCRYPTION_KEY is not configured on the server.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function decryptToken(stored, keyHex) {
  const key = loadKey(keyHex);
  if (!key) throw new Error('TOKEN_ENCRYPTION_KEY is not configured on the server.');
  const [ivB64, tagB64, dataB64] = String(stored).split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Stored token is malformed.');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { encryptToken, decryptToken };