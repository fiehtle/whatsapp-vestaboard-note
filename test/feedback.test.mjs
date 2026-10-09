import test from 'node:test';
import assert from 'node:assert/strict';
import { sendFeedback, deliveryPreview } from '../lib/feedback.mjs';

const settings = { provider: 'kapso', phoneNumberId: '12345', kapsoApiKey: 'test', allowedSenders: ['123'] };
const message = () => ({ provider: 'kapso', source: 'whatsapp', from: '123', timestamp: Date.now(), layouts: [Array.from({ length: 3 }, () => Array(15).fill(67))] });

test('preview uploads a private PNG then sends its media ID without a public URL or text caption', async () => {
  const requests = []; const m = message();
  await sendFeedback(settings, m, deliveryPreview(m), async (url, options) => {
    requests.push({ url, ...options });
    return new Response(JSON.stringify(requests.length === 1 ? { id: '987654' } : { messages: [{ id: 'test' }] }));
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.kapso.ai/meta/whatsapp/v24.0/12345/media');
  assert.equal(requests[0].body.get('messaging_product'), 'whatsapp');
  const file = requests[0].body.get('file');
  assert.equal(file.type, 'image/png');
  assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(requests[1].url, 'https://api.kapso.ai/meta/whatsapp/v24.0/12345/messages');
  assert.deepEqual(JSON.parse(requests[1].body), { messaging_product: 'whatsapp', to: '123', type: 'image', image: { id: '987654' } });
  assert.ok(requests.every(r => r.redirect === 'error'));
});

test('unauthorized, admin and expired messages cannot render or upload household previews', async () => {
  const m = message(); let calls = 0;
  const fetcher = async () => { calls++; throw new Error('must not contact provider'); };
  for (const blocked of [{ ...m, from: '999' }, { ...m, source: 'admin' }, { ...m, provider: 'other' }, { ...m, timestamp: Date.now() - 86400000 }]) {
    await sendFeedback(settings, blocked, { type: 'image', layout: null }, fetcher);
  }
  assert.equal(calls, 0);
});

test('upload failures and malformed media IDs cannot send a false image receipt', async () => {
  for (const response of [new Response('{}', { status: 503 }), new Response('{}'), new Response('{"id":"https://example.com/private.png"}')]) {
    let calls = 0; const m = message();
    await assert.rejects(sendFeedback(settings, m, deliveryPreview(m), async url => {
      calls++; assert.ok(url.endsWith('/media')); return response;
    }));
    assert.equal(calls, 1);
  }
});

test('image send failure is surfaced without an automatic duplicate send', async () => {
  let calls = 0; const m = message();
  await assert.rejects(sendFeedback(settings, m, deliveryPreview(m), async () => {
    calls++;
    return calls === 1 ? new Response('{"id":"987654"}') : new Response('{}', { status: 503 });
  }), error => error.status === 503);
  assert.equal(calls, 2);
});
