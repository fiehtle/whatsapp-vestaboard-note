import { getConfig, readState } from './storage.mjs';

export async function health(overrides = {}) {
  const d = { getConfig, readState, now: Date.now, ...overrides };
  try {
    const [settings, { value: state }] = await Promise.all([d.getConfig(), d.readState()]);
    const configured = Boolean(settings.provider === 'kapso' && settings.vestaboardToken && settings.kapsoWebhookSecret && settings.kapsoApiKey && settings.phoneNumberId && settings.allowedSenders?.length);
    const head = state.inbox?.[0];
    const stalled = Boolean(head && d.now() - head.admittedAt > 15 * 60000);
    const recoveryStale = Boolean(state.lastRecoveryAt && d.now() - state.lastRecoveryAt > 26 * 3600000);
    return { service: 'vestaboard-whatsapp', status: configured && !stalled && !recoveryStale ? 'ready' : 'degraded', storage: 'ok' };
  } catch {
    return { service: 'vestaboard-whatsapp', status: 'unavailable', storage: 'unavailable' };
  }
}
