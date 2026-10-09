import { randomUUID } from 'node:crypto';
import { equal } from '../lib/security.mjs';
import { getConfig, saveConfig, readState, readPrivate } from '../lib/storage.mjs';
import { rawBody, json, safeError } from '../lib/http.mjs';
import { boardRequest, assertNote } from '../lib/board.mjs';
import { enqueue } from '../lib/queue.mjs';
import { admit, recoverInbox } from '../lib/inbox.mjs';
import { TRANSCRIPTION_MODEL, TRANSCRIPTION_FALLBACK } from '../lib/voice.mjs';
import { prepareText, FORMAT_MODEL, FALLBACK_MODEL } from '../lib/format.mjs';
export const config = { api: { bodyParser: false } };

export function createHandler(overrides = {}) {
  const d = { getConfig, saveConfig, readState, readPrivate, boardRequest, enqueue, admit, recoverInbox, ...overrides };
  return async function handler(req, res) {
    if (!equal(req.headers.authorization, `Bearer ${process.env.ADMIN_TOKEN || ''}`) || !process.env.ADMIN_TOKEN) return json(res, 401, { error: 'Invalid admin token' });
    try {
      const settings = await d.getConfig();
      if (req.method === 'GET') {
        const { value: state } = await d.readState();
        const diagnostic = await d.readPrivate('queue-diagnostic.json');
        return json(res, 200, {
          boardConnected: Boolean(settings.vestaboardToken),
          whatsappConfigured: Boolean(settings.allowedSenders?.length && settings.kapsoWebhookSecret && settings.kapsoApiKey && settings.phoneNumberId && settings.boardNumber),
          provider: 'kapso', phoneNumberId: settings.phoneNumberId || '', boardNumber: settings.boardNumber || '',
          allowedSenders: settings.allowedSenders || [], lastRecoveryAt: state.lastRecoveryAt || null,
          lastText: state.lastText || null, acceptedAt: state.acceptedAt || null, lastError: state.lastError || null,
          lastCharacters: state.lastCharacters || null,
          pendingMessages: state.inbox?.length || 0,
          lastPage: state.lastPage || 1, lastPageCount: state.lastPageCount || 1,
          lastFeedbackError: state.lastFeedbackError || null,
          repliesConfigured: Boolean(settings.kapsoApiKey),
          lastInputType: state.lastInputType || null,
          lastTranscriptionModel: state.lastTranscriptionModel || null,
          transcriptionModel: TRANSCRIPTION_MODEL, transcriptionFallbackModel: TRANSCRIPTION_FALLBACK,
          formattingModel: FORMAT_MODEL,
          formattingFallbackModel: FALLBACK_MODEL,
          queueDiagnostic: diagnostic ? JSON.parse(diagnostic.text) : null,
        });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'Expected JSON' });
      let body;
      try { body = JSON.parse((await rawBody(req, 16384)).toString('utf8')); } catch { return json(res, 400, { error: 'Invalid request' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Invalid request' });
      if (body.action === 'diagnostic') {
        const id = `diagnostic-${randomUUID()}`;
        await d.enqueue({ id, source: 'diagnostic' });
        return json(res, 202, { id });
      }
      if (body.action === 'retryPending') {
        return json(res, 202, await d.recoverInbox());
      }
      if (body.action === 'save') {
        if (body.allowedSenders !== undefined && !Array.isArray(body.allowedSenders)) return json(res, 400, { error: 'Allowed senders must be a list' });
        const next = { ...settings, provider: 'kapso' };
        for (const key of ['vestaboardToken', 'phoneNumberId', 'boardNumber', 'kapsoWebhookSecret', 'kapsoApiKey']) {
          if (body[key] !== undefined && typeof body[key] !== 'string') return json(res, 400, { error: 'Invalid configuration field' });
          if (typeof body[key] === 'string' && body[key].trim()) next[key] = body[key].trim();
        }
        if (Array.isArray(body.allowedSenders)) {
          next.allowedSenders = [...new Set(body.allowedSenders.map(x => String(x).replace(/[+\s()-]/g, '')).filter(Boolean))];
          if (next.allowedSenders.length > 10 || next.allowedSenders.some(x => !/^[1-9]\d{6,14}$/.test(x))) return json(res, 400, { error: 'Use full international phone numbers' });
        }
        if (next.phoneNumberId && !/^\d{5,30}$/.test(next.phoneNumberId)) return json(res, 400, { error: 'Invalid WhatsApp phone number ID' });
        if (next.boardNumber) {
          next.boardNumber = next.boardNumber.replace(/[+\s()-]/g, '');
          if (!/^[1-9]\d{6,14}$/.test(next.boardNumber)) return json(res, 400, { error: 'Invalid board phone number' });
        }
        if (body.vestaboardToken?.trim()) {
          try { assertNote(await d.boardRequest(next.vestaboardToken)); }
          catch (error) { return json(res, 400, { error: error.message }); }
        }
        await d.saveConfig(next);
        return json(res, 200, { saved: true });
      }
      if (body.action === 'test') {
        if (!settings.vestaboardToken) return json(res, 409, { error: 'Connect your board first' });
        const prepared = prepareText(body.text);
        if (prepared.error) return json(res, 400, { error: prepared.error });
        const now = Date.now();
        const message = { id: `admin-${randomUUID()}`, text: body.text, timestamp: now, receivedAt: now, source: 'admin' };
        await d.admit(message, d.enqueue);
        return json(res, 202, { queued: true, messageId: message.id });
      }
      if (body.action === 'read') {
        return json(res, 200, { characters: assertNote(await d.boardRequest(settings.vestaboardToken)) });
      }
      if (body.action === 'preview') {
        const layout = assertNote(await d.boardRequest(settings.vestaboardToken));
        const { renderNotePng } = await import('../lib/preview.mjs');
        const png = renderNotePng(layout);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'private, no-store');
        return res.end(png);
      }
      return json(res, 400, { error: 'Unknown action' });
    } catch (error) { safeError(error); return json(res, 503, { error: 'Service temporarily unavailable; retry shortly' }); }
  };
}
export default createHandler();
