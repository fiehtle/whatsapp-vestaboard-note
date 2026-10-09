import { timingSafeEqual, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function encryptionKey() {
  const key = Buffer.from(process.env.CONFIG_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('Configuration encryption is unavailable');
  return key;
}
export function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
}
export function decrypt(value) {
  const data = JSON.parse(value);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(data.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.data, 'base64')), decipher.final()]).toString('utf8'));
}
