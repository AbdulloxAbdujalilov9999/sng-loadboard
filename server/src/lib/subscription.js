// Subscription state. Off by default: the owner switches it on (Members page). While it is on, a member has access when
// they are in their free trial or have paid time left. The owner is never charged.
export const DEFAULTS = { enabled: false, trialDays: 14, enabledAt: null, priceText: '', payText: '' };
const DAY = 86_400_000;

export async function loadSettings(pool) {
  const { rows: [r] } = await pool.query("SELECT value FROM app_settings WHERE key = 'subscription'");
  return { ...DEFAULTS, ...(r?.value ?? {}) };
}

/** When a NEW member's trial ends, or null when subscriptions are still off (their trial then starts the day they are switched on). */
export const trialEndFor = (settings, now = new Date()) => (settings.enabled ? new Date(now.getTime() + settings.trialDays * DAY) : null);

/** { state: 'off' | 'trial' | 'paid' | 'expired', until, daysLeft } for one member row. */
export function stateOf(member, settings, now = new Date()) {
  if (!settings.enabled || member?.role === 'owner') return { state: 'off', until: null, daysLeft: null };
  const paid = member.paid_until ? new Date(member.paid_until) : null;
  const trial = member.trial_ends_at ? new Date(member.trial_ends_at)
    : (settings.enabledAt ? new Date(new Date(settings.enabledAt).getTime() + settings.trialDays * DAY) : null);
  const left = (d) => Math.max(0, Math.ceil((d.getTime() - now.getTime()) / DAY));
  if (paid && paid > now) return { state: 'paid', until: paid.toISOString(), daysLeft: left(paid) };
  if (trial && trial > now) return { state: 'trial', until: trial.toISOString(), daysLeft: left(trial) };
  const last = [paid, trial].filter(Boolean).sort((a, b) => b - a)[0];
  return { state: 'expired', until: last ? last.toISOString() : null, daysLeft: 0 };
}

/** What a member may read about subscriptions (price + how to pay), only while it is switched on. */
export const publicInfo = (settings) => (settings.enabled ? { priceText: settings.priceText, payText: settings.payText, trialDays: settings.trialDays } : {});
