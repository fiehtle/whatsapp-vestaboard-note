import test from 'node:test';
import assert from 'node:assert/strict';
import { admit, deliverInbox, recoverInbox, PAGE_MS } from '../lib/inbox.mjs';
import { sendFeedback } from '../lib/feedback.mjs';
import { noteCells, noteLayout } from '../lib/note.mjs';
import { BlobPreconditionFailedError } from '@vercel/blob';

function fixture() {
  let state = {}, version = 0, now = Date.now();
  const settings = { provider: 'kapso', allowedSenders: ['123', '456'], vestaboardToken: 'test', kapsoApiKey: 'test', phoneNumberId: '12345' };
  const writes = [], replies = [], queued = [];
  const alphabet = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890!@#$()-+&=;:\'\"%,./?♥';
  const glyphs = Object.fromEntries([...alphabet].map(c => [noteCells(c)[0], c]));
  const decode = rows => rows.map(row => row.map(c => c >= 63 ? ' ' : glyphs[c] ?? '?').join('').trim()).filter(Boolean).join('\n');
  const deps = {
    getConfig: async () => settings,
    readState: async () => ({ value: structuredClone(state), etag: String(version) }),
    writeState: async (value, etag) => {
      if (etag !== String(version)) throw new BlobPreconditionFailedError();
      state = structuredClone(value); version++;
    },
    now: () => now, sleep: async ms => { now += ms; },
    boardRequest: async (_token, _method, body) => { writes.push({ text: decode(body.characters), characters: body.characters, at: now }); },
    sendFeedback: async (_settings, message, content) => { replies.push({ to: message.from, text: typeof content === 'string' ? content : '', ...(content?.type === 'image' ? { image: content.layout } : {}) }); },
    formatForBoard: async () => ({ text: 'FORMATTED TEXT', model: 'test-nano' }),
    enqueue: async (message, options) => { queued.push({ ...message, options }); },
  };
  const message = (id, text = 'HELLO', from = '123') => ({ id, text, from, timestamp: now, receivedAt: now, source: 'whatsapp', provider: 'kapso' });
  return { deps, settings, message, writes, replies, queued, state: () => state, advance: ms => { now += ms; },
    add: m => admit(m, async wake => { queued.push(wake); }, deps),
    addLegacy: async m => {
      await admit(m, async wake => { queued.push(wake); }, deps);
      const entry = state.inbox.find(x => x.id === m.id);
      entry.pages = m.text.split('\n').reduce((pages, line, index) => { const page = Math.floor(index / 3); pages[page] = pages[page] ? pages[page] + '\n' + line : line; return pages; }, []); entry.needsFormatting = false;
    } };
}

test('simultaneous admissions do not lose either sender or make duplicate entries', async () => {
  const f = fixture(); const a = f.message('a'), b = f.message('b', 'SECOND', '456');
  await Promise.all([f.add(a), f.add(b), f.add(a)]);
  assert.deepEqual(new Set(f.state().inbox.map(m => m.id)), new Set(['a', 'b']));
  assert.equal(f.state().inbox.length, 2);
});

test('queue publish failure is recoverable without creating a second admission', async () => {
  const f = fixture(); const message = f.message('a');
  await assert.rejects(admit(message, async () => { throw new Error('queue unavailable'); }, f.deps));
  await f.add(message); assert.equal(f.state().inbox.length, 1); assert.equal(f.queued.length, 1);
});

test('non-FIFO queue delivery cannot reorder two people’s messages or legacy pending pages', async () => {
  const f = fixture(); await f.addLegacy(f.message('a', 'ONE\nTWO\nTHREE\nFOUR'));
  await f.add(f.message('b', 'SECOND PERSON', '456'));
  await assert.rejects(deliverInbox('b', f.deps), /Earlier message/);
  await deliverInbox('a', f.deps); await deliverInbox('b', f.deps);
  assert.deepEqual(f.writes.map(w => w.text), ['ONE\nTWO\nTHREE', 'FOUR', 'SECOND PERSON']);
  assert.ok(f.writes.every((w, i) => !i || w.at - f.writes[i - 1].at >= PAGE_MS));
  assert.equal(f.state().inbox.length, 0); assert.equal(f.replies.length, 3);
  await deliverInbox('a', f.deps); await f.add(f.message('a'));
  assert.equal(f.writes.length, 3); assert.equal(f.state().inbox.length, 0);
});

test('overlapping consumers only let one writer acquire the persistent lease', async () => {
  const f = fixture(); await f.add(f.message('a'));
  const results = await Promise.allSettled([deliverInbox('a', f.deps), deliverInbox('a', f.deps)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.writes.length, 1);
});

test('admitting a new message during a board write is preserved by checkpoints', async () => {
  const f = fixture(); await f.add(f.message('a'));
  const original = f.deps.boardRequest;
  f.deps.boardRequest = async (...args) => { await f.add(f.message('b', 'SECOND', '456')); await original(...args); };
  await deliverInbox('a', f.deps);
  assert.deepEqual(f.state().inbox.map(m => m.id), ['b']);
});

test('crashes after a successful page resume at the next page, never replay completed pages', async () => {
  const f = fixture(); await f.addLegacy(f.message('a', 'ONE\nTWO\nTHREE\nFOUR'));
  const original = f.deps.boardRequest; let calls = 0;
  f.deps.boardRequest = async (...args) => { if (++calls === 2) throw new Error('offline'); await original(...args); };
  await deliverInbox('a', f.deps);
  assert.equal(f.state().inbox[0].page, 1);
  await deliverInbox('a', f.deps); assert.equal(f.writes.length, 1);
  f.advance(360001); f.deps.boardRequest = original;
  await deliverInbox('a', f.deps);
  assert.deepEqual(f.writes.map(w => w.text), ['ONE\nTWO\nTHREE', 'FOUR']);
  assert.equal(f.replies.filter(r => r.text.startsWith('I will display this in 2 pages')).length, 1);
  assert.equal(f.replies.filter(r => r.text.includes('retry')).length, 1);
});

test('invalid content gets a reply, leaves the board untouched and does not block the next message', async () => {
  const f = fixture(); await f.add(f.message('a', '')); await f.add(f.message('b', 'VALID', '456'));
  await deliverInbox('a', f.deps); await deliverInbox('b', f.deps);
  assert.deepEqual(f.writes.map(w => w.text), ['VALID']);
  assert.match(f.replies[0].text, /Photos/); assert.equal(f.replies[0].to, '123');
});

test('accepted messages remain deliverable after a long outage without a resend', async () => {
  const f = fixture(); await f.add(f.message('a')); f.advance(2 * 86400000);
  await deliverInbox('a', f.deps);
  assert.equal(f.writes.length, 1); assert.equal(f.replies.length, 0);
  assert.equal(f.state().inbox.length, 0);
});

test('revoking access before or between pages stops remaining writes and replies', async () => {
  const f = fixture(); await f.addLegacy(f.message('a', 'ONE\nTWO\nTHREE\nFOUR'));
  const original = f.deps.boardRequest;
  f.deps.boardRequest = async (...args) => { await original(...args); f.settings.allowedSenders = ['456']; };
  await deliverInbox('a', f.deps); assert.equal(f.writes.length, 1);
  await f.add(f.message('b')); await deliverInbox('b', f.deps);
  assert.equal(f.writes.length, 1); assert.equal(f.replies.length, 1); assert.equal(f.state().inbox.length, 0);
});

test('WhatsApp feedback failure does not prevent or replay a successful board update', async () => {
  const f = fixture(); await f.addLegacy(f.message('a', 'ONE\nTWO\nTHREE\nFOUR'));
  f.deps.sendFeedback = async () => { throw new Error('feedback timeout'); };
  await deliverInbox('a', f.deps); await deliverInbox('a', f.deps);
  assert.equal(f.writes.length, 2); assert.match(f.state().lastFeedbackError, /could not/);
});

test('feedback uses the configured board and only replies to an allowed recent sender', async () => {
  const f = fixture(); const requests = [];
  const fetcher = async (url, options) => { requests.push({ url, ...options }); return { ok: true }; };
  await sendFeedback(f.settings, f.message('a'), 'Too long', fetcher);
  assert.equal(requests.length, 1); assert.match(requests[0].url, /12345\/messages$/);
  assert.equal(JSON.parse(requests[0].body).to, '123');
  await sendFeedback(f.settings, f.message('b', 'X', '999'), 'No', fetcher);
  await sendFeedback(f.settings, { ...f.message('c'), timestamp: Date.now() - 86400000 }, 'No', fetcher);
  await sendFeedback({ ...f.settings, provider: 'meta' }, f.message('d'), 'No', fetcher);
  assert.equal(requests.length, 1);
});

test('long text is formatted once, persisted before writing, and sends the exact shortened text back', async () => {
  const f = fixture(); let calls = 0;
  f.deps.formatForBoard = async () => { calls++; return { text: 'BINS OUT\nTOMORROW', model: 'test-nano' }; };
  await f.add(f.message('a', 'Please remember to take all the recycling bins outside tomorrow.'));
  const original = f.deps.boardRequest;
  f.deps.boardRequest = async () => { throw new Error('offline'); };
  await deliverInbox('a', f.deps);
  assert.ok(f.replies.every(r => !r.image));
  f.advance(360001); f.deps.boardRequest = original;
  await deliverInbox('a', f.deps);
  assert.equal(calls, 1); assert.equal(f.writes[0].text, 'BINS OUT\nTOMORROW');
  assert.deepEqual(f.replies.filter(r => r.image).map(r => r.image), [f.writes[0].characters]);
});

test('AI outage preserves the original and automatically retries without losing order or asking for edits', async () => {
  const f = fixture(); f.deps.formatForBoard = async () => { throw new Error('no credits'); };
  await f.add(f.message('a', 'This message is definitely longer than a single board can fit in its three lines.'));
  await f.add(f.message('b', 'NEXT MESSAGE', '456'));
  await deliverInbox('a', f.deps);
  assert.equal(f.writes.length, 0); assert.equal(f.state().inbox.length, 2);
  assert.match(f.replies[0].text, /No need to resend/);
  assert.equal(f.queued.at(-1).options.delaySeconds, 30);
  await assert.rejects(deliverInbox('b', f.deps), /Earlier message/);
  f.advance(30001);
  f.deps.formatForBoard = async () => ({ text: 'AUTO SHORTENED', model: 'test-mini' });
  await deliverInbox('a', f.deps); await deliverInbox('b', f.deps);
  assert.deepEqual(f.writes.map(w => w.text), ['AUTO SHORTENED', 'NEXT MESSAGE']);
  assert.equal(f.state().inbox.length, 0);
  assert.equal(f.state().lastError, null);
  assert.equal(f.replies.filter(r => r.text.includes('automatically retrying')).length, 1);
});

test('crash between saving a retry and publishing it is recovered without another formatting call', async () => {
  const f = fixture(); let calls = 0;
  f.deps.formatForBoard = async () => { calls++; throw new Error('temporary outage'); };
  await f.add(f.message('a', 'A long message that should be shortened automatically for the board.'));
  const enqueue = f.deps.enqueue;
  f.deps.enqueue = async () => { throw new Error('queue publish failed'); };
  await assert.rejects(deliverInbox('a', f.deps), /queue publish/);
  assert.equal(f.state().inbox[0].retryCount, 1); assert.equal(f.state().lease, null);
  f.deps.enqueue = enqueue;
  await deliverInbox('a', f.deps);
  assert.equal(calls, 1); assert.equal(f.queued.at(-1).options.delaySeconds, 30);
});

test('crash after completing one message still wakes the next without replaying the first', async () => {
  const f = fixture(); await f.add(f.message('a')); await f.add(f.message('b', 'SECOND', '456'));
  const enqueue = f.deps.enqueue;
  f.deps.enqueue = async () => { throw new Error('queue publish failed'); };
  await assert.rejects(deliverInbox('a', f.deps), /queue publish/);
  assert.equal(f.writes.length, 1); assert.equal(f.state().inbox[0].id, 'b');
  f.deps.enqueue = enqueue;
  await deliverInbox('a', f.deps);
  assert.equal(f.queued.at(-1).id, 'b'); assert.equal(f.writes.length, 1);
  await deliverInbox('b', f.deps); assert.equal(f.writes.length, 2);
});

test('retry backoff is bounded, notifications are not repeated, and budget pauses retain messages', async () => {
  const f = fixture(); f.deps.formatForBoard = async () => { throw new Error('temporary outage'); };
  await f.add(f.message('a', 'A long message that should be shortened automatically for the board.'));
  for (let i = 0; i < 10; i++) { await deliverInbox('a', f.deps); f.advance(3600001); }
  assert.equal(f.state().inbox.length, 1); assert.equal(f.state().inbox[0].retryCount, 10);
  assert.ok(f.queued.filter(q => q.options).every(q => q.options.delaySeconds <= 3600));
  assert.equal(f.replies.length, 1);
  const { value, etag } = await f.deps.readState();
  value.aiDaily = { day: new Date(f.deps.now()).toISOString().slice(0,10), count: 100 };
  await f.deps.writeState(value, etag);
  await deliverInbox('a', f.deps);
  assert.equal(f.state().inbox.length, 1); assert.match(f.state().lastError, /budget/);
  assert.equal(f.queued.at(-1).options.delaySeconds, 3600);
});

test('voice transcript is persisted once and parsed even when short; board retries do not retranscribe', async () => {
  const f = fixture(); let transcriptions = 0, formats = 0;
  f.deps.transcribeVoice = async () => { transcriptions++; return { text: 'Show hello with a heart', model: 'speech-test' }; };
  f.deps.formatForBoard = async text => { formats++; assert.equal(text, 'Show hello with a heart'); return { text: 'HELLO ♥', model: 'test' }; };
  await f.add({ ...f.message('v', ''), isVoice: true, audio: { id: '123' } });
  const write = f.deps.boardRequest; f.deps.boardRequest = async () => { throw new Error('offline'); };
  await deliverInbox('v', f.deps);
  assert.equal(f.state().inbox[0].text, 'Show hello with a heart');
  f.advance(360001); f.deps.boardRequest = write;
  await deliverInbox('v', f.deps);
  assert.equal(transcriptions, 1); assert.equal(formats, 1);
  assert.deepEqual(f.writes[0].characters, noteLayout('HELLO ♥', { decorate: true, seed: 'v:0' }));
  assert.equal(f.state().lastInputType, 'voice');
  assert.deepEqual(f.replies.filter(r => r.image).map(r => r.image), [f.writes[0].characters]);
});

test('voice failures retry in order; silence finishes without blocking the next message', async () => {
  const f = fixture(); f.deps.transcribeVoice = async () => { throw new Error('offline'); };
  await f.add({ ...f.message('v', ''), isVoice: true, audio: { id: '123' } });
  await f.add(f.message('next'));
  await deliverInbox('v', f.deps);
  assert.equal(f.state().inbox.length, 2); assert.equal(f.queued.at(-1).options.delaySeconds, 30);
  assert.match(f.replies[0].text, /No need to resend/);
  await assert.rejects(deliverInbox('next', f.deps), /Earlier/);
  f.advance(30001); f.deps.transcribeVoice = async () => { throw Object.assign(new Error('No speech detected'), { permanent: true }); };
  await deliverInbox('v', f.deps); await deliverInbox('next', f.deps);
  assert.equal(f.state().inbox.length, 0); assert.equal(f.writes.length, 1);
});

test('Kapso-native transcripts skip paid transcription; revoked senders never download voice media', async () => {
  const f = fixture(); f.deps.transcribeVoice = async () => { throw new Error('must not transcribe'); };
  await f.add({ ...f.message('v', 'Say hello'), isVoice: true, transcriptionModel: 'kapso', audio: { id: '123' } });
  await deliverInbox('v', f.deps); assert.equal(f.writes.length, 1);
  await f.add({ ...f.message('revoked', ''), isVoice: true, audio: { id: '123' } });
  f.settings.allowedSenders = [];
  await deliverInbox('revoked', f.deps); assert.equal(f.writes.length, 1); assert.equal(f.state().inbox.length, 0);
});

test('transcription budget exhaustion retains audio and schedules a delayed retry', async () => {
  const f = fixture(); let calls = 0;
  f.deps.transcribeVoice = async () => { calls++; };
  await f.add({ ...f.message('v', ''), isVoice: true, audio: { id: '123' } });
  const { value, etag } = await f.deps.readState();
  value.voiceDaily = { day: new Date(f.deps.now()).toISOString().slice(0, 10), count: 100 };
  await f.deps.writeState(value, etag);
  await deliverInbox('v', f.deps);
  assert.equal(calls, 0); assert.equal(f.state().inbox.length, 1);
  assert.equal(f.queued.at(-1).options.delaySeconds, 3600);
});

test('the exact centered color pattern is saved before board writes and reused after failure', async () => {
  const f = fixture(); await f.add(f.message('colored', 'ALEX,\nI LOVE YOU ♥'));
  const attempts = []; const write = f.deps.boardRequest;
  f.deps.boardRequest = async (...args) => {
    attempts.push(structuredClone(args[2].characters));
    assert.deepEqual(f.state().inbox[0].layouts[0], args[2].characters);
    if (attempts.length === 1) throw new Error('uncertain write');
    await write(...args);
  };
  await deliverInbox('colored', f.deps);
  assert.equal(f.state().inbox[0].layouts.length, 1);
  f.advance(360001); await deliverInbox('colored', f.deps);
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[1], attempts[0]);
  assert.ok(attempts[1].flat().some(code => code >= 63));
  assert.deepEqual(f.state().lastCharacters, attempts[1]);
  assert.equal(f.state().lastText, 'ALEX,\nI LOVE YOU ♥');
});

test('cloud recovery revives the oldest saved job after callback exhaustion without replaying completed jobs', async () => {
  const f = fixture(); await f.add(f.message('first')); await f.add(f.message('second'));
  f.queued.length = 0; f.advance(8 * 86400000);
  const result = await recoverInbox(f.deps);
  assert.deepEqual(result, { pendingMessages: 2, requeued: true }); assert.equal(f.queued[0].id, 'first');
  assert.ok(f.state().lastRecoveryAt);
  await deliverInbox('first', f.deps); await deliverInbox('second', f.deps);
  const queued = f.queued.length;
  assert.deepEqual(await recoverInbox(f.deps), { pendingMessages: 0, requeued: false });
  assert.equal(f.queued.length, queued); assert.equal(f.writes.length, 2);
});

test('recovery respects active leases and backoff, and failed publication does not report success', async () => {
  const f = fixture(); await f.add(f.message('first'));
  const { value, etag } = await f.deps.readState(); value.lease = 'active'; value.leaseUntil = f.deps.now() + 360000;
  await f.deps.writeState(value, etag);
  assert.equal((await recoverInbox(f.deps)).requeued, false); assert.equal(f.state().lease, 'active');
  f.advance(360001); const snapshot = await f.deps.readState(); snapshot.value.inbox[0].retryAt = f.deps.now() + 10000;
  await f.deps.writeState(snapshot.value, snapshot.etag);
  assert.equal((await recoverInbox(f.deps)).requeued, false);
  f.advance(10001); const lastChecked = f.state().lastRecoveryAt;
  f.deps.enqueue = async () => { throw new Error('queue offline'); };
  await assert.rejects(recoverInbox(f.deps), /queue offline/);
  assert.equal(f.state().lastRecoveryAt, lastChecked); assert.equal(f.state().inbox.length, 1);
});

test('new admissions revive a stranded head and completed IDs remain deduplicated for seven days', async () => {
  const f = fixture(); await f.add(f.message('first')); f.queued.length = 0;
  await f.add(f.message('second')); assert.equal(f.queued[0].id, 'first');
  await deliverInbox('first', f.deps); await deliverInbox('second', f.deps);
  f.advance(2 * 86400000);
  const snapshot = await f.deps.readState(); snapshot.value.completedIds = [];
  await f.deps.writeState(snapshot.value, snapshot.etag);
  await f.add(f.message('first')); assert.equal(f.state().inbox.length, 0);
  await f.add(f.message('third')); await deliverInbox('third', f.deps);
  assert.ok(f.state().inboxCompleted.first); assert.equal(f.writes.length, 3);
});

test('short messages confirm to each original sender only after board acceptance is persisted', async () => {
  const f = fixture(); await f.add(f.message('a')); await f.add(f.message('b', 'SECOND', '456'));
  const reply = f.deps.sendFeedback;
  f.deps.sendFeedback = async (settings, message, text) => {
    assert.equal(f.state().lastMessageId, message.id);
    assert.equal(f.state().inbox[0].page, message.pages.length);
    assert.ok(f.writes.some(w => w.text === message.pages.at(-1)));
    await reply(settings, message, text);
  };
  await deliverInbox('a', f.deps); await deliverInbox('b', f.deps);
  await deliverInbox('a', f.deps); await deliverInbox('b', f.deps);
  assert.deepEqual(f.replies, [
    { to: '123', text: '', image: f.writes[0].characters },
    { to: '456', text: '', image: f.writes[1].characters },
  ]);
  assert.equal(f.writes.length, 2);
});

test('a crash after board acceptance resumes the receipt without repeating the board update', async () => {
  const f = fixture(); await f.add(f.message('a'));
  const persist = f.deps.writeState;
  f.deps.writeState = async (value, etag) => {
    if (value.inbox?.[0]?.notified?.includes('delivered')) throw new Error('crashed before receipt');
    await persist(value, etag);
  };
  await assert.rejects(deliverInbox('a', f.deps), /crashed before receipt/);
  assert.equal(f.state().inbox[0].page, 1);
  assert.equal(f.writes.length, 1); assert.equal(f.replies.length, 0);
  f.deps.writeState = persist; f.advance(360001);
  await deliverInbox('a', f.deps);
  assert.equal(f.writes.length, 1); assert.equal(f.replies.length, 1);
  assert.deepEqual(f.replies[0].image, f.writes[0].characters);
  assert.equal(f.state().inbox.length, 0);
});

test('a crash after sending the receipt does not duplicate the receipt or board update', async () => {
  const f = fixture(); await f.add(f.message('a'));
  const persist = f.deps.writeState;
  f.deps.writeState = async (value, etag) => {
    if (!value.inbox?.length) throw new Error('crashed before completion');
    await persist(value, etag);
  };
  await assert.rejects(deliverInbox('a', f.deps), /crashed before completion/);
  assert.equal(f.writes.length, 1); assert.equal(f.replies.length, 1);
  f.deps.writeState = persist; f.advance(360001);
  await deliverInbox('a', f.deps);
  assert.equal(f.writes.length, 1); assert.equal(f.replies.length, 1);
  assert.equal(f.state().inbox.length, 0);
});

test('a failed success reply does not resend the board update or prevent the next sender', async () => {
  const f = fixture(); await f.add(f.message('a')); await f.add(f.message('b', 'NEXT', '456'));
  let attempts = 0;
  f.deps.sendFeedback = async () => { attempts++; throw new Error('WhatsApp timeout'); };
  await deliverInbox('a', f.deps); await deliverInbox('a', f.deps); await deliverInbox('b', f.deps);
  assert.equal(attempts, 2); assert.equal(f.writes.length, 2);
  assert.equal(f.state().inbox.length, 0); assert.match(f.state().lastFeedbackError, /could not/);
});

test('legacy multi-page messages get a single success receipt after the final page', async () => {
  const f = fixture(); await f.addLegacy(f.message('a', 'ONE\nTWO\nTHREE\nFOUR'));
  const reply = f.deps.sendFeedback;
  f.deps.sendFeedback = async (settings, message, text) => {
    if (text?.type === 'image') { assert.equal(f.writes.length, 2); assert.equal(message.page, 2); }
    await reply(settings, message, text);
  };
  await deliverInbox('a', f.deps);
  assert.deepEqual(f.replies.filter(r => r.image), [
    { to: '123', text: '', image: f.writes[1].characters },
  ]);
});

test('admin updates never send WhatsApp receipts', async () => {
  const f = fixture(); await f.add({ ...f.message('admin'), source: 'admin' });
  await deliverInbox('admin', f.deps);
  assert.equal(f.writes.length, 1); assert.equal(f.replies.length, 0);
});
