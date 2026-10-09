import { createHash, randomUUID } from 'node:crypto';
import { BlobPreconditionFailedError } from '@vercel/blob';
import { setTimeout as sleep } from 'node:timers/promises';
import { readState, writeState, getConfig } from './storage.mjs';
import { boardRequest } from './board.mjs';
import { sendFeedback } from './feedback.mjs';
import { prepareText, formatForBoard } from './format.mjs';
import { enqueue } from './queue.mjs';
import { transcribeVoice } from './voice.mjs';
import { noteLayout, displayNote } from './note.mjs';
import { MESSAGE_RETENTION_MS } from './kapso.mjs';

export const PAGE_MS = 20000;
const LEASE_MS = 360000;
const deps = overrides => ({ readState, writeState, getConfig, boardRequest, sendFeedback, formatForBoard, transcribeVoice, enqueue, now: Date.now, sleep, ...overrides });

async function wake(d, message, reason) {
  if (!message) return;
  const key = createHash('sha256').update(JSON.stringify([message.id, message.retryCount || 0, reason])).digest('hex');
  await d.enqueue({ id: message.id, source: 'inbox' }, {
    idempotencyKey: `inbox-${key}`,
    delaySeconds: Math.max(0, Math.ceil(((message.retryAt || 0) - d.now()) / 1000)),
  });
}

// Webhook admissions and worker checkpoints share one CAS-protected record.
async function change(d, update) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { value, etag } = await d.readState();
    const next = update(value);
    if (!next) return value;
    try { await d.writeState(next, etag); return next; }
    catch (error) {
      // The Blob SDK leaves .name as "Error"; use the actual error class.
      if (!(error instanceof BlobPreconditionFailedError) && error.status !== 412) throw error;
      await d.sleep(20 * (attempt + 1));
    }
  }
  throw new Error('Inbox is busy; retry');
}

export async function admit(message, enqueue, overrides = {}) {
  const d = deps(overrides);
  const prepared = message.isVoice
    ? { pages: [], error: null, needsFormatting: true, needsTranscription: !message.text?.trim() }
    : prepareText(message.text);
  const state = await change(d, state => {
    if (state.inbox?.some(m => m.id === message.id) || state.completedIds?.includes(message.id) || state.inboxCompleted?.[message.id]) return null;
    if ((state.inbox?.length || 0) >= 50) throw new Error('Inbox is full; retry');
    return { ...state, inbox: [...(state.inbox || []), { ...message, ...prepared, page: 0, admittedAt: d.now() }] };
  });
  // A publish failure must fail the webhook. Its retry reuses the existing admission.
  if (state.inbox?.some(m => m.id === message.id)) await wake({ ...d, enqueue }, state.inbox[0], `admission-${message.id}`);
}

// A cloud cron and new admissions can revive jobs after queue delivery exhaustion.
// Publishing does not take or clear the worker's lease; duplicate wakes are safe.
export async function recoverInbox(overrides = {}) {
  const d = deps(overrides);
  const { value: state } = await d.readState();
  const head = state.inbox?.[0];
  const requeued = Boolean(head && !(state.leaseUntil > d.now()) && !(head.retryAt > d.now()));
  if (requeued) await wake(d, head, `recovery-${Math.floor(d.now() / 60000)}`);
  await change(d, current => ({ ...current, lastRecoveryAt: d.now() }));
  return { pendingMessages: state.inbox?.length || 0, requeued };
}

export async function deliverInbox(id, overrides = {}) {
  const d = deps(overrides);
  let settings = await d.getConfig();
  const lease = randomUUID();
  const reserved = await change(d, state => {
    if (!state.inbox?.some(m => m.id === id)) return null;
    if (state.inbox[0].id !== id) throw new Error('Earlier message is pending');
    if (state.inbox[0].retryAt > d.now()) return null;
    if (state.leaseUntil > d.now()) throw new Error('Board delivery is busy');
    return { ...state, lease, leaseUntil: d.now() + LEASE_MS };
  });
  if (reserved.lease !== lease) {
    // Also repairs a crash after checkpointing a completion or retry but before
    // publishing its next wake-up. A retry is never acknowledged without one.
    await wake(d, reserved.inbox?.[0], reserved.inbox?.[0]?.id === id ? 'retry' : `after-${id}`);
    return;
  }
  const update = fn => change(d, state => {
    if (state.lease !== lease) throw new Error('Delivery lease changed');
    return fn(state);
  });
  let message = reserved.inbox[0];
  const authorized = () => message.source === 'admin' ||
    (settings.provider === message.provider && settings.allowedSenders?.includes(message.from));
  const finish = async error => {
    const finished = await update(state => ({
      ...state, inbox: state.inbox.filter(m => m.id !== id), lease: null, leaseUntil: 0,
      completedIds: [...(state.completedIds || []), id].slice(-500),
      inboxCompleted: { ...Object.fromEntries(Object.entries(state.inboxCompleted || {}).filter(([, at]) => d.now() - at < MESSAGE_RETENTION_MS)), [id]: d.now() },
      ...(error ? { lastError: error, lastRejectedAt: d.now() } : {}),
    }));
    // Successors get a fresh wake-up even if their original callback exhausted
    // its delivery attempts while waiting behind a long provider outage.
    await wake(d, finished.inbox?.[0], `after-${id}`);
  };
  const notify = async (kind, text) => {
    if (!authorized() || message.source !== 'whatsapp' || message.notified?.includes(kind)) return;
    // Claim before sending: an uncertain WhatsApp response must not spam duplicates.
    const claimed = await update(state => ({ ...state, inbox: state.inbox.map(m => m.id === id ? { ...m, notified: [...(m.notified || []), kind] } : m) }));
    message = claimed.inbox[0];
    try {
      await d.sendFeedback(settings, message, text);
      await update(state => ({ ...state, lastFeedbackError: null }));
    }
    catch (error) {
      console.error(JSON.stringify({ event: 'feedback_failed', status: error.status || 503 }));
      await update(state => ({ ...state, lastFeedbackError: 'A WhatsApp reply could not be delivered.', lastFeedbackErrorAt: d.now() }));
    }
  };
  const defer = async (reason, { minimumMs = 0, retainLease = false } = {}) => {
    const retryCount = (message.retryCount || 0) + 1;
    const delayMs = Math.max(minimumMs, Math.min(3600000, 30000 * 2 ** Math.min(retryCount - 1, 7)));
    const deferred = await update(state => ({
      ...state, lastError: reason, lastFailedAt: d.now(),
      lease: retainLease ? lease : null,
      leaseUntil: retainLease ? d.now() + LEASE_MS : 0,
      inbox: state.inbox.map(m => m.id === id ? { ...m, retryCount, retryAt: d.now() + delayMs } : m),
    }));
    // Each failure publishes a fresh delayed callback. The persisted inbox
    // survives queue-message expiry; backoff is bounded to one hour.
    await wake(d, deferred.inbox[0], 'retry');
  };
  if (!authorized()) { await finish(); return; }
  if (message.error) { await notify('invalid', message.error); await finish(message.error); return; }
  if (message.needsTranscription) {
    const day = new Date(d.now()).toISOString().slice(0, 10);
    let allowed = false;
    await update(state => {
      const count = state.voiceDaily?.day === day ? state.voiceDaily.count : 0;
      allowed = count < 100;
      return allowed ? { ...state, voiceDaily: { day, count: count + 1 } } : state;
    });
    if (!allowed) {
      await notify('voice-limit', 'Your voice note is saved. Transcription is temporarily paused and will resume automatically. No need to resend.');
      await defer('Transcription budget paused; automatic retry scheduled.', { minimumMs: 3600000 }); return;
    }
    let transcript;
    try { transcript = await d.transcribeVoice(settings, message); }
    catch (error) {
      if (error.permanent) { await notify('voice-invalid', error.message); await finish(error.message); return; }
      console.error(JSON.stringify({ event: 'transcription_failed', status: error.status || null }));
      await notify('voice-retrying', 'Your voice note is saved. I am automatically retrying transcription. No need to resend.');
      await defer('Transcription temporarily unavailable; automatic retry scheduled.'); return;
    }
    const saved = await update(state => ({ ...state, lastTranscriptionModel: transcript.model, lastError: null,
      inbox: state.inbox.map(m => m.id === id ? { ...m, text: transcript.text, needsTranscription: false, transcriptionModel: transcript.model, retryCount: 0, retryAt: 0 } : m) }));
    message = saved.inbox[0];
  }
  if (message.needsFormatting) {
    const day = new Date(d.now()).toISOString().slice(0, 10);
    let formattingAllowed = false;
    await update(state => {
      const count = state.aiDaily?.day === day ? state.aiDaily.count : 0;
      const attempts = state.inbox[0].formatAttempts || 0;
      formattingAllowed = count < 100;
      if (!formattingAllowed) return state;
      return { ...state, aiDaily: { day, count: count + 1 }, inbox: state.inbox.map(m => m.id === id ? { ...m, formatAttempts: attempts + 1 } : m) };
    });
    if (!formattingAllowed) {
      await notify('format-limit', 'Your message is saved. Formatting is temporarily paused and will resume automatically. No need to resend.');
      await defer('Formatting budget paused; automatic retry scheduled.', { minimumMs: 3600000 }); return;
    }
    let formatted;
    try { formatted = await d.formatForBoard(message.text, { spoken: Boolean(message.isVoice) }); }
    catch (error) {
      console.error(JSON.stringify({ event: 'formatting_failed', code: ['FORMAT_AUTH', 'FORMAT_HTTP', 'FORMAT_INVALID'].includes(error.code) ? error.code : 'FORMAT_UNAVAILABLE', status: error.status || null }));
      await notify('format-retrying', 'Your message is saved. I am automatically retrying the formatting and will update the board when it is ready. No need to resend.');
      await defer('Formatting temporarily unavailable; automatic retry scheduled.'); return;
    }
    const saved = await update(state => ({ ...state, lastFormatModel: formatted.model, lastError: null, inbox: state.inbox.map(m => m.id === id ? { ...m, pages: [formatted.text], needsFormatting: false, formatted: true, formatModel: formatted.model, retryCount: 0, retryAt: 0 } : m) }));
    message = saved.inbox[0];
  }
  if (!message.layouts) {
    const layouts = message.pages.map((page, index) => noteLayout(page, { decorate: true, seed: `${message.id}:${index}` }));
    const saved = await update(state => ({ ...state, inbox: state.inbox.map(m => m.id === id ? { ...m, layouts } : m) }));
    message = saved.inbox[0];
  }
  if (message.formatted) await notify('formatted', `${message.isVoice ? 'From your voice note' : 'Formatted for the board'}:\n${displayNote(message.pages[0])}`);
  if (message.pages.length > 1) await notify('pages', `I will display this in ${message.pages.length} pages, at least 20 seconds each. The last page stays on the board.`);
  while (message.page < message.pages.length) {
    const current = (await d.readState()).value;
    // Full wait even for the first write protects legacy writes and uncertain retries.
    await d.sleep(Math.max(PAGE_MS, (current.nextWriteAt || 0) - d.now()));
    settings = await d.getConfig();
    if (!authorized()) { await finish(); return; }
    const state = (await d.readState()).value;
    if (state.lease !== lease || state.leaseUntil <= d.now()) throw new Error('Delivery lease changed');
    try { await d.boardRequest(settings.vestaboardToken, 'POST', { characters: message.layouts[message.page] }); }
    catch (error) {
      await notify('retrying', 'Vestaboard is not accepting updates right now. Your message is saved and will retry automatically. No need to resend.');
      // A timeout may have applied the write. Retain the lease before retrying.
      await defer('Vestaboard is unavailable; automatic retry scheduled.', { minimumMs: LEASE_MS, retainLease: true }); return;
    }
    const accepted = await update(state => ({
      ...state, inbox: state.inbox.map(m => m.id === id ? { ...m, page: m.page + 1 } : m),
      lastMessageId: id, lastText: displayNote(message.pages[message.page]), acceptedAt: d.now(),
      lastCharacters: message.layouts[message.page],
      lastInputType: message.isVoice ? 'voice' : 'text', lastTranscriptionModel: message.transcriptionModel || null,
      lastPage: message.page + 1, lastPageCount: message.pages.length,
      timestamp: message.timestamp, receivedAt: message.receivedAt,
      nextWriteAt: d.now() + PAGE_MS, lastError: null,
    }));
    message = accepted.inbox[0];
  }
  await finish();
}
