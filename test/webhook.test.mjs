import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { createHandler } from '../api/kapso.js';
const settings = { provider: 'kapso', phoneNumberId: '12345', kapsoWebhookSecret: 'test-secret', vestaboardToken: 'test-token', allowedSenders: ['12025550101'] };
const payload = () => ({ phone_number_id: '12345', message: { id: 'wamid.integration', from: '12025550101', timestamp: String(Date.now() / 1000), type: 'text', text: { body: 'HELLO' }, kapso: { direction: 'inbound', status: 'delivered', has_media: false } } });
async function request({ body = JSON.stringify(payload()), method = 'POST', contentType = 'application/json', signed = true, admit = async () => {} } = {}) {
  const req = Readable.from([Buffer.from(body)]); req.method = method;
  req.headers = { 'content-type': contentType, 'x-webhook-event': 'whatsapp.message.received', ...(signed ? { 'x-webhook-signature': createHmac('sha256', settings.kapsoWebhookSecret).update(body).digest('hex') } : {}) };
  const res = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
  await createHandler({ getConfig: async () => settings, admit, enqueue: async () => {} })(req, res);
  return res;
}

test('webhook acknowledges only after durable admission and requests retry on publication/storage failure', async () => {
  let saved = false;
  assert.equal((await request({ admit: async message => { assert.equal(message.text, 'HELLO'); saved = true; } })).statusCode, 200);
  assert.equal(saved, true);
  const failed = await request({ admit: async () => { throw new Error('private-token'); } });
  assert.equal(failed.statusCode, 503); assert.equal(JSON.stringify(failed.body).includes('private-token'), false);
});

test('unsigned, malformed, oversized and unsupported requests cannot reach admission', async () => {
  let calls = 0; const admit = async () => { calls++; };
  assert.equal((await request({ admit, signed: false })).statusCode, 401);
  assert.equal((await request({ admit, body: '{invalid' })).statusCode, 400);
  assert.equal((await request({ admit, body: ' '.repeat(131073) })).statusCode, 413);
  assert.equal((await request({ admit, method: 'GET' })).statusCode, 405);
  assert.equal((await request({ admit, contentType: 'text/plain' })).statusCode, 415);
  const p = payload(); p.message.from = '12025550199';
  assert.equal((await request({ admit, body: JSON.stringify(p) })).statusCode, 200);
  assert.equal(calls, 0);
});
