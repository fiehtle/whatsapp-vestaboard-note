import { getConfig } from '../lib/storage.mjs';
import { rawBody, json, safeError } from '../lib/http.mjs';
import { enqueue } from '../lib/queue.mjs';
import { admit } from '../lib/inbox.mjs';
import { validKapsoSignature, extractKapsoMessages } from '../lib/kapso.mjs';
export const config = { api: { bodyParser: false } };

export function createHandler(overrides = {}) {
  const d = { getConfig, admit, enqueue, ...overrides };
  return async function handler(req, res) {
    try {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'Expected JSON' });
      const settings = await d.getConfig();
      if (settings.provider !== 'kapso' || !settings.kapsoWebhookSecret) return json(res, 503, { error: 'Kapso is not connected yet' });
      const body = await rawBody(req);
      if (!validKapsoSignature(body, req.headers['x-webhook-signature'], settings.kapsoWebhookSecret)) return json(res, 401, { error: 'Invalid signature' });
      let payload;
      try { payload = JSON.parse(body.toString('utf8')); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
      const messages = extractKapsoMessages(payload, req.headers['x-webhook-event'], settings);
      if (messages.length && !settings.vestaboardToken) return json(res, 503, { error: 'Board is not connected yet' });
      for (const message of messages) await d.admit(message, d.enqueue);
      return json(res, 200, { received: true });
    } catch (error) { safeError(error); return json(res, error.status === 413 ? 413 : 503, { error: 'Please retry' }); }
  };
}
export default createHandler();
