import { QueueClient } from '@vercel/queue';
export const queue = new QueueClient({ region: 'fra1' });
export function enqueue(message, options = {}) {
  return queue.send('board-messages', message, { idempotencyKey: options.idempotencyKey || message.id, retentionSeconds: 604800, ...(options.delaySeconds !== undefined ? { delaySeconds: options.delaySeconds } : {}) });
}
