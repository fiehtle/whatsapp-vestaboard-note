import { json } from '../lib/http.mjs';
import { health } from '../lib/health.mjs';
export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const result = await health();
  return json(res, result.status === 'ready' ? 200 : 503, result);
}
