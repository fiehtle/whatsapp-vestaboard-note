export const BOARD_URL = 'https://cloud.vestaboard.com/';
export async function boardRequest(token, method = 'GET', body, fetcher = fetch) {
  if (!token) throw new Error('Board is not configured');
  const response = await fetcher(BOARD_URL, {
    method, redirect: 'error', headers: { 'X-Vestaboard-Token': token, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    if (method === 'POST' && response.status === 409) {
      const conflict = await response.json().catch(() => null);
      // A crash after applying the text can leave its checkpoint unsaved.
      // Vestaboard explicitly confirms this exact message is already displayed.
      if (conflict?.type === 'FingerprintMatch') return { alreadyDisplayed: true };
    }
    const e = new Error(`Vestaboard returned HTTP ${response.status}`); e.status = response.status; throw e;
  }
  return response.json();
}
export function assertNote(data) {
  let layout = data?.currentMessage?.layout;
  if (typeof layout === 'string') layout = JSON.parse(layout);
  if (!Array.isArray(layout) || layout.length !== 3 || layout.some(row => !Array.isArray(row) || row.length !== 15)) {
    throw new Error('This key must belong to a single Vestaboard Note (3 x 15)');
  }
  return layout;
}
