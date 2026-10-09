const $ = id => document.getElementById(id);
$('callbackUrl').textContent = location.origin + '/api/kapso';
$('webhookInstructions').textContent = 'In Kapso, use this callback, the saved webhook secret, and the whatsapp.message.received event.';
let token = sessionStorage.getItem('noteAdminKey');
function notice(message, error = false) { $('notice').textContent = message; $('notice').dataset.error = String(error); }
async function api(body) {
  const response = await fetch('/api/admin', { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function refresh() {
  const activeToken = token;
  const state = await api();
  if (!activeToken || token !== activeToken) return;
  $('controls').hidden = false;
  $('boardStatus').textContent = state.boardConnected ? '● Board connected' : '○ Board not connected';
  $('whatsappStatus').textContent = state.whatsappConfigured ? '● WhatsApp configured' : '○ WhatsApp not configured';
  for (const key of ['phoneNumberId', 'boardNumber']) if (document.activeElement !== $(key) && !$(key).value) $(key).value = state[key];
  if (document.activeElement !== $('allowedSenders') && !$('allowedSenders').value) $('allowedSenders').value = state.allowedSenders.join(', ');
  $('testButton').disabled = !state.boardConnected;
  $('lastText').textContent = state.lastText || 'No message sent yet';
  $('lastTime').textContent = state.acceptedAt ? new Date(state.acceptedAt).toLocaleString() + ` · Page ${state.lastPage} of ${state.lastPageCount}` : '';
  $('queueStatus').textContent = state.pendingMessages ? `${state.pendingMessages} message(s) waiting or being displayed.` : 'No messages waiting.';
  $('feedbackError').textContent = state.lastFeedbackError || '';
  $('lastError').textContent = state.lastError || '';
  $('chatLink').hidden = !state.boardNumber;
  if (state.boardNumber) $('chatLink').href = 'https://wa.me/' + state.boardNumber;
  return state;
}
async function submit(form, payload, success) {
  const button = form.querySelector('button'); button.disabled = true;
  try { await api(payload); await refresh(); notice(success); }
  catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
}
$('boardForm').addEventListener('submit', async event => {
  event.preventDefault(); await submit(event.currentTarget, { action: 'save', vestaboardToken: $('vestaboardToken').value }, 'Note connected. You can now send a real test message.'); $('vestaboardToken').value = '';
});
$('whatsappForm').addEventListener('submit', async event => {
  event.preventDefault(); await submit(event.currentTarget, { action: 'save', kapsoWebhookSecret: $('kapsoWebhookSecret').value, kapsoApiKey: $('kapsoApiKey').value, phoneNumberId: $('phoneNumberId').value, boardNumber: $('boardNumber').value, allowedSenders: $('allowedSenders').value.split(/[,\n]/).map(x => x.trim()) }, 'Settings saved. Configure the callback, then text the board number.'); $('kapsoWebhookSecret').value = ''; $('kapsoApiKey').value = '';
});
$('testForm').addEventListener('submit', async event => {
  event.preventDefault(); await submit(event.currentTarget, { action: 'test', text: $('testText').value }, 'Queued for your physical Note. Updates stay at least 20 seconds apart.');
});
function lock() {
  token = null; sessionStorage.removeItem('noteAdminKey');
  $('controls').hidden = true; $('locked').hidden = false;
  for (const input of document.querySelectorAll('input, textarea')) input.value = '';
  for (const id of ['lastText', 'lastTime', 'lastError', 'feedbackError', 'queueStatus']) $(id).textContent = '';
  $('chatLink').removeAttribute('href'); $('chatLink').hidden = true;
  notice('Enter your admin token to configure this deployment.');
}
$('unlockForm').addEventListener('submit', async event => {
  event.preventDefault(); token = $('adminToken').value.trim();
  const attemptToken = token;
  try { await refresh(); if (!token || token !== attemptToken) return; sessionStorage.setItem('noteAdminKey', token); $('locked').hidden = true; notice('Private setup is ready.'); }
  catch (error) { lock(); notice(error.message, true); }
  finally { $('adminToken').value = ''; }
});
$('lockButton').addEventListener('click', lock);
if (!token) lock();
else refresh().then(() => notice('Private setup is ready.')).catch(error => { lock(); notice(error.message, true); });
setInterval(() => { if (token && !document.hidden) refresh().catch(() => {}); }, 15000);
