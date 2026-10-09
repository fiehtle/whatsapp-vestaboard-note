export function deliveryPreview(message) {
  return { type: 'image', layout: message.layouts.at(-1) };
}

export async function sendFeedback(settings, message, content, fetcher = fetch) {
  if (message.source !== 'whatsapp' || message.provider !== 'kapso' ||
      settings.provider !== 'kapso' || !settings.kapsoApiKey ||
      !settings.allowedSenders?.includes(message.from) ||
      Date.now() - message.timestamp > 23 * 3600000) return;
  const base = `https://api.kapso.ai/meta/whatsapp/v24.0/${settings.phoneNumberId}`;
  let payload;
  if (typeof content === 'string') payload = { type: 'text', text: { body: content } };
  else {
    if (content?.type !== 'image') throw new Error('Invalid WhatsApp feedback');
    const { renderNotePng } = await import('./preview.mjs');
    const body = new FormData();
    body.set('messaging_product', 'whatsapp');
    body.set('file', new Blob([renderNotePng(content.layout)], { type: 'image/png' }), 'vestaboard.png');
    // Upload directly to WhatsApp. The household layout never needs a public URL.
    const upload = await fetcher(`${base}/media`, {
      method: 'POST', headers: { 'X-API-Key': settings.kapsoApiKey }, body,
      redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    if (!upload.ok) throw Object.assign(new Error('WhatsApp preview upload failed'), { status: upload.status });
    const { id } = await upload.json();
    if (typeof id !== 'string' || !/^\d{1,64}$/.test(id)) throw new Error('Invalid WhatsApp media ID');
    payload = { type: 'image', image: { id } };
  }
  const response = await fetcher(`${base}/messages`, {
    method: 'POST', headers: { 'X-API-Key': settings.kapsoApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: message.from, ...payload }),
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) { const error = new Error('WhatsApp feedback failed'); error.status = response.status; throw error; }
}
