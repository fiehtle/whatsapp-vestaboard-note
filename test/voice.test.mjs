import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeAudio, transcribeVoice, TRANSCRIPTION_MODEL, TRANSCRIPTION_FALLBACK, MAX_AUDIO_BYTES } from '../lib/voice.mjs';
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const settings = { phoneNumberId: '12345', kapsoApiKey: 'kapso-secret' };
const voice = { audio: { id: '123456', mimeType: 'audio/ogg; codecs=opus' } };
const metadata = { download_url: 'https://api.kapso.ai/meta/whatsapp/media_download?token=test', file_size: '4', mime_type: 'audio/ogg; codecs=opus' };

test('native WhatsApp Ogg is downloaded only from Kapso and transcribed without leaking its key', async () => {
  const calls = [];
  const result = await transcribeVoice(settings, voice, { token: 'gateway-token', fetcher: async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return json(metadata);
    if (calls.length === 2) return new Response(Buffer.from('OggS'));
    return json({ text: 'Hallo mein Schatz', durationInSeconds: 2 });
  } });
  assert.equal(result.text, 'Hallo mein Schatz'); assert.equal(result.model, TRANSCRIPTION_MODEL);
  assert.match(calls[0].url, /123456\?phone_number_id=12345$/);
  assert.equal(calls[0].options.headers['X-API-Key'], 'kapso-secret');
  assert.equal(calls[1].options.headers, undefined); assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[2].options.headers.Authorization, 'Bearer gateway-token');
  assert.equal(calls[2].options.headers['X-API-Key'], undefined);
  assert.deepEqual(JSON.parse(calls[2].options.body), { audio: Buffer.from('OggS').toString('base64'), mediaType: 'audio/ogg' });
});

test('media IDs, download destinations, and streamed size are bounded before transcription', async () => {
  let calls = 0;
  await assert.rejects(transcribeVoice(settings, { audio: { id: '../private' } }, { fetcher: async () => { calls++; } }), /attachment/);
  assert.equal(calls, 0);
  for (const url of ['http://api.kapso.ai/meta/whatsapp/media_download', 'https://evil.example/audio', 'https://api.kapso.ai/other', 'https://user:secret@api.kapso.ai/meta/whatsapp/media_download']) {
    await assert.rejects(transcribeVoice(settings, voice, { fetcher: async () => { calls++; return json({ ...metadata, download_url: url }); } }), /download URL/);
  }
  assert.equal(calls, 4);
  await assert.rejects(transcribeVoice(settings, voice, { fetcher: async () => json({ ...metadata, file_size: MAX_AUDIO_BYTES + 1 }) }), /16 MB/);
  let downloaded = false;
  await assert.rejects(transcribeVoice(settings, voice, { fetcher: async () => {
    if (!downloaded) { downloaded = true; return json(metadata); }
    return new Response(Buffer.alloc(MAX_AUDIO_BYTES + 1));
  } }), /16 MB/);
});

test('provider failure falls back; unsupported primary formats go directly to compatible fallback', async () => {
  const models = [];
  const fetcher = async (_url, options) => {
    models.push(options.headers['ai-model-id']);
    return models.length === 1 ? new Response('', { status: 503 }) : json({ text: 'Dinner at seven' });
  };
  assert.equal((await transcribeAudio(Buffer.from('audio'), 'audio/ogg', { token: 'test', fetcher })).text, 'Dinner at seven');
  assert.deepEqual(models, [TRANSCRIPTION_MODEL, TRANSCRIPTION_FALLBACK]);
  await transcribeAudio(Buffer.from('audio'), 'audio/mp4', { token: 'test', fetcher: async (_url, options) => {
    assert.equal(options.headers['ai-model-id'], TRANSCRIPTION_FALLBACK); return json({ text: 'Hello' });
  } });
});

test('silence and oversized audio are terminal; account failures do not burn repeated calls', async () => {
  await assert.rejects(transcribeAudio(Buffer.from('audio'), 'audio/ogg', { token: 'test', fetcher: async () => json({ text: '' }) }), error => error.permanent === true);
  await assert.rejects(transcribeAudio(Buffer.alloc(MAX_AUDIO_BYTES + 1), 'audio/ogg'), error => error.permanent === true);
  let calls = 0;
  await assert.rejects(transcribeAudio(Buffer.from('audio'), 'audio/ogg', { token: 'test', fetcher: async () => { calls++; return new Response('', { status: 402 }); } }));
  assert.equal(calls, 1);
});
