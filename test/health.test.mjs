import test from 'node:test';
import assert from 'node:assert/strict';
import { health } from '../lib/health.mjs';
import { createHandler } from '../api/recover.js';
const now = 200000000;
const settings = { provider: 'kapso', vestaboardToken: 'secret', kapsoWebhookSecret: 'secret', kapsoApiKey: 'secret', phoneNumberId: '123', allowedSenders: ['456'] };
const deps = state => ({ getConfig: async () => settings, readState: async () => ({ value: state }), now: () => now });

test('health checks real configuration and storage without exposing any private information', async () => {
  assert.deepEqual(await health(deps({})), { service: 'vestaboard-whatsapp', status: 'ready', storage: 'ok' });
  assert.equal((await health({ ...deps({}), getConfig: async () => ({}) })).status, 'degraded');
  assert.deepEqual(await health({ ...deps({}), readState: async () => { throw new Error('secret-token backend failed'); } }), { service: 'vestaboard-whatsapp', status: 'unavailable', storage: 'unavailable' });
});

test('stalled inboxes and missed daily recovery become unhealthy while normal processing stays ready', async () => {
  assert.equal((await health(deps({ inbox: [{ admittedAt: now - 1000 }] }))).status, 'ready');
  assert.equal((await health(deps({ inbox: [{ admittedAt: now - 16 * 60000 }] }))).status, 'degraded');
  assert.equal((await health(deps({ lastRecoveryAt: now - 27 * 3600000 }))).status, 'degraded');
  assert.equal((await health(deps({ lastRecoveryAt: now - 25 * 3600000 }))).status, 'ready');
});

test('cloud recovery rejects unsigned calls and returns failure when recovery fails', async () => {
  const previous = process.env.CRON_SECRET; process.env.CRON_SECRET = 'cron-secret';
  let calls = 0;
  const run = async (method, authorization, fn) => {
    const res = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
    await createHandler(fn || (async () => { calls++; return { requeued: true, pendingMessages: 1 }; }))({ method, headers: { authorization } }, res);
    return res;
  };
  try {
    assert.equal((await run('POST', 'Bearer cron-secret')).statusCode, 405);
    assert.equal((await run('GET', undefined)).statusCode, 401);
    assert.equal((await run('GET', 'Bearer wrong')).statusCode, 401); assert.equal(calls, 0);
    assert.equal((await run('GET', 'Bearer cron-secret')).statusCode, 200); assert.equal(calls, 1);
    assert.equal((await run('GET', 'Bearer cron-secret', async () => { throw new Error('private'); })).statusCode, 503);
    delete process.env.CRON_SECRET; assert.equal((await run('GET', 'Bearer undefined')).statusCode, 401);
  } finally { if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous; }
});
