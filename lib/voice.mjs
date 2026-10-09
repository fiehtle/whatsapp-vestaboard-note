import { getVercelOidcToken } from '@vercel/oidc';

export const TRANSCRIPTION_MODEL = 'microsoft/mai-transcribe-2';
export const TRANSCRIPTION_FALLBACK = 'openai/gpt-4o-mini-transcribe';
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const permanent = message => Object.assign(new Error(message), { permanent: true });
const httpError = status => Object.assign(new Error('Voice service temporarily unavailable'), { status });

export async function transcribeAudio(audio, mediaType, options = {}) {
  if (!audio.length) throw permanent('This voice note contains no audio. The board was not changed.');
  if (audio.length > MAX_AUDIO_BYTES) throw permanent('This audio exceeds the 16 MB voice-note limit. The board was not changed.');
  const fetcher = options.fetcher || fetch;
  const token = options.token || process.env.AI_GATEWAY_API_KEY || await getVercelOidcToken();
  const models = ['audio/ogg', 'audio/opus', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/flac'].includes(mediaType)
    ? [TRANSCRIPTION_MODEL, TRANSCRIPTION_FALLBACK] : [TRANSCRIPTION_FALLBACK];
  let lastError;
  for (const model of models) {
    try {
      const response = await fetcher('https://ai-gateway.vercel.sh/v4/ai/transcription-model', {
        method: 'POST', redirect: 'error', headers: {
          Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          'ai-gateway-protocol-version': '0.0.1', 'ai-transcription-model-specification-version': '4', 'ai-model-id': model,
        },
        body: JSON.stringify({ audio: audio.toString('base64'), mediaType }),
        signal: AbortSignal.timeout(50000),
      });
      if (!response.ok) throw httpError(response.status);
      const result = await response.json();
      if (typeof result.text !== 'string') throw new Error('Invalid transcription response');
      if (!result.text.trim()) throw permanent('I could not hear speech in that voice note. The board was not changed.');
      return { text: result.text.trim(), model, durationInSeconds: result.durationInSeconds || null };
    } catch (error) {
      if (error.permanent || [401, 402, 403].includes(error.status)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

export async function transcribeVoice(settings, message, options = {}) {
  const fetcher = options.fetcher || fetch;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(message.audio?.id || '')) throw permanent('This voice note has no readable audio attachment. The board was not changed.');
  const response = await fetcher(`https://api.kapso.ai/meta/whatsapp/v24.0/${encodeURIComponent(message.audio.id)}?phone_number_id=${encodeURIComponent(settings.phoneNumberId)}`, {
    headers: { 'X-API-Key': settings.kapsoApiKey }, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw httpError(response.status);
  const meta = await response.json();
  if (Number(meta.file_size) > MAX_AUDIO_BYTES) throw permanent('This audio exceeds the 16 MB voice-note limit. The board was not changed.');
  // Use only Kapso's authenticated short-lived URL, never a URL from message text.
  const url = new URL(meta.download_url);
  if (url.origin !== 'https://api.kapso.ai' || url.pathname !== '/meta/whatsapp/media_download' || url.username || url.password) throw new Error('Invalid media download URL');
  const mediaType = String(meta.mime_type || message.audio.mimeType || '').split(';')[0].trim().toLowerCase();
  if (!['audio/ogg', 'audio/opus', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/flac', 'audio/mp4', 'audio/webm', 'audio/aac', 'audio/amr'].includes(mediaType)) throw permanent('That audio format is not supported. The board was not changed.');
  const download = await fetcher(url.href, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!download.ok) throw httpError(download.status);
  if (Number(download.headers.get('content-length')) > MAX_AUDIO_BYTES) {
    await download.body?.cancel();
    throw permanent('This audio exceeds the 16 MB voice-note limit. The board was not changed.');
  }
  const chunks = []; let size = 0;
  for await (const chunk of download.body) {
    size += chunk.length;
    if (size > MAX_AUDIO_BYTES) throw permanent('This audio exceeds the 16 MB voice-note limit. The board was not changed.');
    chunks.push(chunk);
  }
  // Bytes live only in this invocation; the saved inbox retains the transcript.
  return transcribeAudio(Buffer.concat(chunks), mediaType, options);
}
