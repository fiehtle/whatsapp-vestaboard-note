import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareText, validateFormat, formatForBoard, FORMAT_MODEL, FALLBACK_MODEL } from '../lib/format.mjs';

test('production formatting authenticates with the request-scoped OIDC token', async () => {
  const contextKey = Symbol.for('@vercel/request-context');
  const previousContext = globalThis[contextKey];
  const previousKey = process.env.AI_GATEWAY_API_KEY;
  const previousToken = process.env.VERCEL_OIDC_TOKEN;
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200 })).toString('base64url')}.signature`;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;
  globalThis[contextKey] = { get: () => ({ headers: { 'x-vercel-oidc-token': token } }) };
  try {
    const result = await formatForBoard('Take bins out', { fetcher: async (_url, init) => {
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"fits":true,"lines":["TAKE BINS OUT"]}' } }] }) };
    } });
    assert.equal(result.text, 'TAKE BINS OUT');
  } finally {
    if (previousContext === undefined) delete globalThis[contextKey]; else globalThis[contextKey] = previousContext;
    if (previousKey === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previousKey;
    if (previousToken === undefined) delete process.env.VERCEL_OIDC_TOKEN; else process.env.VERCEL_OIDC_TOKEN = previousToken;
  }
});

test('short messages bypass AI; long text and emoji are formatted without requesting edits', () => {
  assert.deepEqual(prepareText('hello from whatsapp').pages, ['HELLO FROM\nWHATSAPP']);
  assert.equal(prepareText('hello').needsFormatting, false);
  assert.equal(prepareText('A'.repeat(50)).needsFormatting, true);
  assert.equal(prepareText('I love you 💚').needsFormatting, true);
  assert.match(prepareText('').error, /text message/);
  assert.equal(prepareText('A'.repeat(4096)).needsFormatting, true);
});

test('AI output must fit the exact physical grid and preserve numeric and negative details', () => {
  const valid = { fits: true, lines: ['DOG: NO FOOD', 'BEFORE 19:30'] };
  assert.equal(validateFormat(valid, 'Please do not feed the dog before 19:30'), 'DOG: NO FOOD\nBEFORE 19:30');
  for (const data of [
    { fits: true, lines: ['1234567890123456'] },
    { fits: true, lines: ['A','B','C','D'] },
    { fits: true, lines: [''] },
    { fits: true, lines: ['HELLO 💚'] },
    { fits: false, lines: [] },
    { fits: true, lines: ['FEED DOG 19:30'] },
    { fits: true, lines: ['NO FOOD 19:00'] },
  ]) assert.throws(() => validateFormat(data, 'Do not feed the dog before 19:30'));
  assert.throws(() => validateFormat({ fits: true, lines: ['BINS TOMORROW'] }, 'Bins tomorrow morning'), /Timing/);
  assert.throws(() => validateFormat({ fits: true, lines: ['WATER THE PLANTS', 'BEFORE LEAVING TOMORROW MORNING'] }, 'Reminder'), error => /WATER THE PLANTS/.test(error.message) && /BEFORE LEAVING TOMORROW MORNING/.test(error.message));
});

test('invalid output is repaired and escalated, never truncated or returned as a resend request', async () => {
  let calls = 0;
  const models = [];
  let repairMessages;
  const fetcher = async (_url, init) => {
    calls++;
    models.push(JSON.parse(init.body).model);
    if (calls === 2) repairMessages = JSON.parse(init.body).messages;
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ fits: true, lines: ['MUCH TOO LONG FOR THIS DISPLAY'] }) } }] }) };
  };
  await assert.rejects(formatForBoard('Reminder', { token: 'test', fetcher }), /automatic retry/); assert.equal(calls, 4);
  assert.deepEqual(models, [FORMAT_MODEL, FORMAT_MODEL, FALLBACK_MODEL, FALLBACK_MODEL]);
  assert.equal(repairMessages.at(-2).role, 'assistant');
  assert.match(repairMessages.at(-1).content, /has 30 cells; maximum is 15/);
});

test('stronger model automatically summarizes after failed small-model repairs', async () => {
  const models = [];
  const fetcher = async (_url, init) => {
    const request = JSON.parse(init.body), model = request.model; models.push(model);
    assert.equal(request.reasoning_effort, model === FALLBACK_MODEL ? 'low' : 'none');
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(model === FORMAT_MODEL ? { fits: false, lines: [] } : { fits: true, lines: ['DINNER AT 19:30'] }) } }] }) };
  };
  const result = await formatForBoard('Dinner at 19:30. Secondary timetable: 12:00, 14:00, 16:00.', { token: 'test', fetcher });
  assert.equal(result.text, 'DINNER AT 19:30'); assert.equal(result.model, FALLBACK_MODEL);
  assert.equal(models.length, 3);
  assert.throws(() => validateFormat({ fits: true, lines: ['DINNER AT 20:00'] }, 'Dinner at 19:30', { summary: true }), /Numeric/);
  assert.equal(validateFormat({ fits: true, lines: ['TAKE BINS OUT'] }, "Don't forget to take bins out"), 'TAKE BINS OUT');
});

test('a valid repair is returned with model usage and unsupported API calls are not retried', async () => {
  let calls = 0;
  const fetcher = async () => ({ ok: true, json: async () => ({ id: 'example', usage: { cost: 0.0001 }, choices: [{ message: { content: ++calls === 1 ? 'invalid' : '{"fits":true,"lines":["TAKE BINS OUT"]}' } }] }) });
  assert.equal((await formatForBoard('Take bins out', { token: 'test', fetcher })).text, 'TAKE BINS OUT');
  assert.equal(calls, 2);
  let failures = 0;
  await assert.rejects(formatForBoard('X', { token: 'test', fetcher: async () => { failures++; return { ok: false, status: 402 }; } }));
  assert.equal(failures, 1);
});

test('fallback repairs lost morning timing instead of accepting a polite but incomplete summary', async () => {
  const input = 'Laura, please water the plants before leaving tomorrow morning.';
  const incomplete = { fits: true, lines: ['LAURA, TOMORROW', 'PLEASE WATER', 'THE PLANTS'] };
  const complete = { fits: true, lines: ['LAURA: TOMORROW', 'MORNING: WATER', 'PLANTS'] };
  assert.throws(() => validateFormat(incomplete, input, { summary: true }), /Timing detail was lost: MORNING/);
  let calls = 0;
  const result = await formatForBoard(input, { token: 'test', fetcher: async (_url, init) => {
    const request = JSON.parse(init.body);
    calls++;
    if (calls === 4) assert.match(request.messages.at(-1).content, /MORNING/);
    const data = calls < 3 ? { fits: false, lines: [] } : calls === 3 ? incomplete : complete;
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(data) } }] }) };
  } });
  assert.equal(result.text, complete.lines.join('\n'));
  assert.equal(calls, 4);
  // A crowded multi-day schedule may still reduce to its main request.
  assert.equal(validateFormat({ fits: true, lines: ['DINNER TONIGHT'] }, 'Dinner tonight. Tomorrow morning, errands; today, shopping.', { summary: true }), 'DINNER TONIGHT');
});
