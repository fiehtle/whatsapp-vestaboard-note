export function json(res, status, data) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = status;
  res.end(JSON.stringify(data));
}
export async function rawBody(req, limit = 131072) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk); size += buffer.length;
    if (size > limit) { const e = new Error('Request too large'); e.status = 413; throw e; }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
export function safeError(error) {
  // Never log request bodies, tokens, phone numbers or vendor response bodies.
  console.error(JSON.stringify({ event: 'request_failed', type: error?.name || 'Error', status: error?.status || 503 }));
}
