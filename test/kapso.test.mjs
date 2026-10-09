import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { validKapsoSignature, extractKapsoMessages } from '../lib/kapso.mjs';

const now = 1791480000000;
const settings = { provider: 'kapso', phoneNumberId: '12345', allowedSenders: ['12025550101'] };
const event = 'whatsapp.message.received';
const item = () => ({
  phone_number_id: '12345',
  conversation: { phone_number: '+12025550101' },
  message: { id: 'wamid.example', from: '12025550101', timestamp: String(now / 1000),
    type: 'text', text: { body: 'HELLO' },
    kapso: { direction: 'inbound', status: 'received', origin: 'cloud_api', has_media: false } },
});
const extract = payload => extractKapsoMessages(payload, event, settings, now);

test('Kapso HMAC verifies exact bytes and rejects missing or malformed signatures', () => {
  const body = Buffer.from('{"message":"hello"}');
  const signature = createHmac('sha256', 'secret').update(body).digest('hex');
  assert.equal(validKapsoSignature(body, signature, 'secret'), true);
  assert.equal(validKapsoSignature(Buffer.concat([body, Buffer.from(' ')]), signature, 'secret'), false);
  for (const value of [undefined, [], 'sha256=' + signature, '0'.repeat(64)]) {
    assert.equal(validKapsoSignature(body, value, 'secret'), false);
  }
  assert.equal(validKapsoSignature(body, signature, ''), false);
});

test('only fresh text from the allowed sender to the configured board number is accepted', () => {
  assert.equal(extract(item()).length, 1);
  for (const mutate of [
    p => p.phone_number_id = 'other',
    p => p.message.from = '12025550199',
    p => p.conversation.phone_number = '+12025550199',
    p => p.message.from = 'some-username',
    p => p.message.type = 'reaction',
    p => p.message.kapso.direction = 'outbound',
    p => p.message.kapso.status = 'sent',
    p => p.message.kapso.origin = 'history_sync',
    p => p.message.kapso.passive = true,
    p => p.message.timestamp = String(now / 1000 - 7 * 86400 - 1),
    p => p.message.timestamp = String(now / 1000 + 301),
    p => p.message.timestamp = 'invalid',
    p => p.message.id = '',
  ]) {
    const payload = item(); mutate(payload); assert.equal(extract(payload).length, 0);
  }
  assert.deepEqual(extractKapsoMessages(item(), 'whatsapp.message.sent', settings, now), []);
  assert.deepEqual(extractKapsoMessages(item(), event, { ...settings, provider: 'twilio' }, now), []);
});

test('allowed senders get unsupported content routed to feedback, never a media caption on the board', () => {
  for (const type of ['image', 'audio', 'video', 'sticker', 'document', 'location', 'contacts']) {
    const payload = item(); payload.message.type = type;
    assert.equal(extract(payload)[0].text, '');
  }
  const blank = item(); blank.message.text.body = ' ';
  assert.equal(extract(blank)[0].text, ' ');
  const media = item(); media.message.kapso.has_media = true;
  assert.equal(extract(media)[0].text, '');
});

test('both allowed people can write, while a third phone remains excluded', () => {
  const config = { ...settings, allowedSenders: [...settings.allowedSenders, '12025550102'] };
  const second = item(); second.message.from = '12025550102'; second.conversation.phone_number = '+12025550102';
  assert.equal(extractKapsoMessages(second, event, config, now).length, 1);
  second.message.from = '12025550199'; second.conversation.phone_number = '+12025550199';
  assert.deepEqual(extractKapsoMessages(second, event, config, now), []);
});

test('conversation phone fallback works while username-only identities fail closed', () => {
  const payload = item(); delete payload.message.from;
  assert.equal(extract(payload)[0].from, '12025550101');
  delete payload.conversation.phone_number;
  payload.message.from_user_id = '123456';
  assert.deepEqual(extract(payload), []);
});

test('production inbound delivered status is accepted without admitting outgoing receipts', () => {
  const payload = item(); payload.message.kapso.status = 'delivered';
  assert.equal(extract(payload)[0].text, 'HELLO');
  payload.message.kapso.direction = 'outbound';
  assert.deepEqual(extract(payload), []);
  payload.message.kapso.direction = 'inbound';
  assert.deepEqual(extractKapsoMessages(payload, 'whatsapp.message.delivered', settings, now), []);
});

test('batches sort messages, deduplicate and retain the same retry identity', () => {
  const newer = item(); newer.message.id = 'wamid.newer'; newer.message.timestamp = String(now / 1000 + 1);
  const result = extract({ batch: true, data: [newer, item(), item()] });
  assert.deepEqual(result.map(m => m.id), ['kapso-wamid.example', 'kapso-wamid.newer']);
  assert.deepEqual(extract(item())[0], result[0]);
  assert.deepEqual(extract({ batch: true, data: Array(101).fill(item()) }), []);
  assert.deepEqual(extract({ batch: true, data: {} }), []);
  assert.deepEqual(extract(null), []);
});

test('audio captures only media identity and optional transcript after sender authorization', () => {
  const p = item(); p.message.type = 'audio'; p.message.audio = { id: 'audio123', mime_type: 'audio/ogg; codecs=opus' };
  p.message.kapso.has_media = true; p.message.kapso.media_url = 'https://untrusted.example';
  const message = extract(p)[0];
  assert.equal(message.isVoice, true); assert.deepEqual(message.audio, { id: 'audio123', mimeType: 'audio/ogg; codecs=opus' });
  assert.equal(message.text, ''); assert.equal(message.media_url, undefined);
  p.message.kapso.transcript = { text: 'Hallo mein Schatz' };
  assert.equal(extract(p)[0].text, 'Hallo mein Schatz'); assert.equal(extract(p)[0].transcriptionModel, 'kapso');
  p.message.from = '12025550199'; assert.deepEqual(extract(p), []);
});

test('signed provider retries after a day-long outage are admitted, but old history is excluded', () => {
  const p = item(); p.message.timestamp = String(now / 1000 - 2 * 86400);
  assert.equal(extract(p).length, 1);
  p.message.kapso.origin = 'history_sync'; assert.equal(extract(p).length, 0);
});
