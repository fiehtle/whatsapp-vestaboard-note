import { createHmac } from 'node:crypto';
import { equal } from './security.mjs';
export const MESSAGE_RETENTION_MS = 7 * 86400000;

export function validKapsoSignature(body, signature, secret) {
  if (!secret || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
  return equal(signature, createHmac('sha256', secret).update(body).digest('hex'));
}

function phone(value) {
  if (typeof value !== 'string' || !/^\+?[1-9]\d{6,14}$/.test(value)) return null;
  return value.replace(/^\+/, '');
}

export function extractKapsoMessages(payload, event, settings, now = Date.now()) {
  if (settings.provider !== 'kapso' || !settings.phoneNumberId || event !== 'whatsapp.message.received') return [];
  const allowed = new Set(settings.allowedSenders || []);
  const items = payload?.batch === true ? payload.data : [payload];
  if (!Array.isArray(items) || items.length > 100) return [];
  const messages = new Map();
  for (const item of items) {
    if (item?.phone_number_id !== settings.phoneNumberId) continue;
    const m = item.message;
    if (!m) continue;
    // Production inbound messages use "delivered"; documentation examples use "received".
    if (m.kapso?.direction !== 'inbound' || !['received', 'delivered'].includes(m.kapso.status) || m.kapso.origin === 'history_sync' || m.kapso.passive) continue;
    // Ignore control events/reactions. Unsupported user content gets a helpful reply.
    if (!['text', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts'].includes(m.type)) continue;
    const sender = phone(m.from);
    const contact = phone(item.conversation?.phone_number);
    // Never authorize on a display name or username. Missing phone identity fails closed.
    if (m.from !== undefined && !sender) continue;
    if (sender && contact && sender !== contact) continue;
    const from = sender || contact;
    const timestamp = Number(m.timestamp) * 1000;
    if (!allowed.has(from) || typeof m.id !== 'string' || !m.id.startsWith('wamid.') || m.id.length > 256 ||
      !Number.isFinite(timestamp) || now - timestamp > MESSAGE_RETENTION_MS || timestamp > now + 300000) continue;
    const id = 'kapso-' + m.id;
    const isVoice = m.type === 'audio';
    const transcript = typeof m.kapso.transcript?.text === 'string' ? m.kapso.transcript.text.trim() : '';
    messages.set(id, { id, from,
      text: isVoice ? transcript : m.type === 'text' && !m.kapso.has_media && typeof m.text?.body === 'string' ? m.text.body : '',
      ...(isVoice ? { isVoice: true, audio: { id: m.audio?.id || '', mimeType: m.audio?.mime_type || '' }, ...(transcript ? { transcriptionModel: 'kapso' } : {}) } : {}),
      timestamp, receivedAt: timestamp, source: 'whatsapp', provider: 'kapso' });
  }
  return [...messages.values()].sort((a, b) => a.timestamp - b.timestamp);
}
