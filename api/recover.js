import { equal } from '../lib/security.mjs';
import { json, safeError } from '../lib/http.mjs';
import { recoverInbox } from '../lib/inbox.mjs';

export function createHandler(recover = recoverInbox) {
  return async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    if (!process.env.CRON_SECRET || !equal(req.headers.authorization, `Bearer ${process.env.CRON_SECRET}`)) return json(res, 401, { error: 'Unauthorized' });
    try { return json(res, 200, { ok: true, ...await recover() }); }
    catch (error) { safeError(error); return json(res, 503, { error: 'Recovery temporarily unavailable' }); }
  };
}
export default createHandler();
