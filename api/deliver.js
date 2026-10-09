import { queue } from '../lib/queue.mjs';
import { deliverInbox } from '../lib/inbox.mjs';
import { readPrivate, writePrivate } from '../lib/storage.mjs';
export const config = { api: { bodyParser: false } };
export default queue.handleNodeCallback(async (message) => {
  if (message.source === 'diagnostic') {
    const existing = await readPrivate('queue-diagnostic.json');
    await writePrivate('queue-diagnostic.json', JSON.stringify({ id: message.id, processedAt: Date.now() }), existing?.etag);
    return;
  }
  if (message.source === 'inbox') await deliverInbox(message.id);
  else throw new Error('Unknown queue message source');
}, {
  visibilityTimeoutSeconds: 360,
  retry: (error, metadata) => {
    // Structured diagnostics without bodies, phone numbers or credentials.
    const reason = { 'Earlier message is pending': 'waiting_for_turn', 'Board delivery is busy': 'lease_busy', 'Delivery lease changed': 'lease_changed', 'Inbox is busy; retry': 'storage_conflict' }[error?.message] || 'request_failed';
    console.warn(JSON.stringify({ event: 'delivery_retry', reason, type: error?.constructor?.name || 'Error', status: error?.status, attempt: metadata.deliveryCount }));
    return { afterSeconds: Math.min(300, 30 * metadata.deliveryCount) };
  },
});
