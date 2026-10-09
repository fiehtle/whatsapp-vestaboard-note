export async function sendFeedback(settings, message, text, fetcher = fetch) {
  if (message.source !== 'whatsapp' || message.provider !== 'kapso' ||
      settings.provider !== 'kapso' || !settings.kapsoApiKey ||
      !settings.allowedSenders?.includes(message.from) ||
      Date.now() - message.timestamp > 23 * 3600000) return;
  const response = await fetcher(`https://api.kapso.ai/meta/whatsapp/v24.0/${settings.phoneNumberId}/messages`, {
    method: 'POST', redirect: 'error', headers: { 'X-API-Key': settings.kapsoApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: message.from, type: 'text', text: { body: text } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) { const error = new Error('WhatsApp feedback failed'); error.status = response.status; throw error; }
}
