import { get, put } from '@vercel/blob';
import { encrypt, decrypt } from './security.mjs';

export async function readPrivate(path) {
  // Compression changes the response ETag to W/"...", which cannot be used
  // with Blob's strong If-Match writes. Read the identity representation.
  const blob = await get(path, { access: 'private', useCache: false, headers: { 'Accept-Encoding': 'identity' } });
  if (!blob) return null;
  if (blob.statusCode !== 200) throw new Error('Storage read failed');
  return { text: await new Response(blob.stream).text(), etag: blob.blob.etag };
}
export async function writePrivate(path, text, etag) {
  return put(path, text, {
    access: 'private', addRandomSuffix: false, allowOverwrite: Boolean(etag),
    ...(etag ? { ifMatch: etag } : {}), contentType: 'application/json', cacheControlMaxAge: 60,
  });
}
export async function getConfig() {
  const stored = await readPrivate('config.encrypted.json');
  return stored ? decrypt(stored.text) : {};
}
export async function saveConfig(config) {
  const existing = await readPrivate('config.encrypted.json');
  await writePrivate('config.encrypted.json', encrypt(config), existing?.etag);
}
export async function readState() {
  const stored = await readPrivate('delivery-state.json');
  return { value: stored ? JSON.parse(stored.text) : {}, etag: stored?.etag };
}
export async function writeState(value, etag) {
  return writePrivate('delivery-state.json', JSON.stringify(value), etag);
}
