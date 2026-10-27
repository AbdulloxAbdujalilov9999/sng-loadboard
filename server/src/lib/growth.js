// Growth tools and paid extras. Posting and searching stay free for everyone, forever (TIRGO lost most of its users when it
// charged for basic access); what is sold is extra reach: TOP placement and a verified badge. Payment is by Payme / Click
// links built from the owner's merchant ids - there is no merchant webhook yet, so the owner checks the payment and adds the
// credits / badge on the Members page (the same hand-run model as subscriptions, lib/subscription.js).
import { publish } from '../events.js';

export const EXTRAS_DEFAULTS = {
  enabled: false,          // shows prices and pay buttons to members; earning and using credits works either way
  boostPriceUzs: 0,        // one TOP credit
  boostPack: 1,            // credits per purchase
  verifyPriceUzs: 0,       // the verified badge (one-time)
  payText: '',             // free text: who to message after paying, bank card, etc.
  paymeMerchantId: '',
  paymeAccountField: 'order_id', // the account field name set up in the Payme merchant cabinet
  clickServiceId: '',
  clickMerchantId: '',
};

export async function loadExtras(pool) {
  const { rows: [r] } = await pool.query("SELECT value FROM app_settings WHERE key = 'extras'");
  return { ...EXTRAS_DEFAULTS, ...(r?.value ?? {}) };
}

/** Payme checkout link: base64 of "m=<merchant>;ac.<field>=<value>;a=<amount in tiyin>". */
export function paymeLink(extras, { amountUzs, order }) {
  if (!extras.paymeMerchantId || !(amountUzs > 0)) return null;
  const params = `m=${extras.paymeMerchantId};ac.${extras.paymeAccountField || 'order_id'}=${order};a=${Math.round(amountUzs * 100)}`;
  return `https://checkout.paycom.uz/${Buffer.from(params).toString('base64')}`;
}

/** Click payment link (my.click.uz). transaction_param carries our order reference back to the merchant cabinet. */
export function clickLink(extras, { amountUzs, order }) {
  if (!extras.clickServiceId || !extras.clickMerchantId || !(amountUzs > 0)) return null;
  const q = new URLSearchParams({ service_id: extras.clickServiceId, merchant_id: extras.clickMerchantId, amount: String(amountUzs), transaction_param: order });
  return `https://my.click.uz/services/pay?${q}`;
}

/** What a member may see about extras: prices + ready-made pay links that carry their member id, only while switched on. */
export function publicExtras(extras, memberId) {
  if (!extras.enabled) return { enabled: false };
  const offer = (kind, amountUzs) => {
    const order = `${kind}-${memberId}`;
    return amountUzs > 0 ? { priceUzs: amountUzs, order, payme: paymeLink(extras, { amountUzs, order }), click: clickLink(extras, { amountUzs, order }) } : null;
  };
  return { enabled: true, payText: extras.payText, boost: offer('top', extras.boostPriceUzs), boostPack: extras.boostPack, verify: offer('verify', extras.verifyPriceUzs) };
}

/** The member's growth summary for GET /api/me. */
export async function growthSummary(pool, member, config = {}) {
  const { rows: [c] } = await pool.query(
    `SELECT count(*)::int AS invited, count(*) FILTER (WHERE referral_rewarded)::int AS active FROM members WHERE referred_by = $1`, [member.id]);
  return { refCode: member.ref_code, invited: c.invited, invitedActive: c.active, boostCredits: member.boost_credits ?? 0, verified: Boolean(member.verified_at),
    rewardCredits: config.referralRewardCredits ?? 1, boostHours: config.boostHours ?? 24, repostCooldownHours: config.repostCooldownHours ?? 6 };
}

/** Member id for an invite code, or null (unknown codes are ignored: a typo must never block a sign-up). */
export async function referrerId(db, code) {
  if (!code) return null;
  const { rows: [r] } = await db.query('SELECT id FROM members WHERE ref_code = $1', [String(code).toLowerCase()]);
  return r?.id ?? null;
}

/**
 * Called inside the posting transaction: the first load of an invited member earns the inviter their credits, once. Rewarding
 * on the first load (not on sign-up) means a pile of empty fake accounts earns nothing.
 */
export async function rewardReferrer(db, member, credits) {
  if (!(credits > 0)) return null;
  const { rows: [r] } = await db.query(
    `UPDATE members SET referral_rewarded = true WHERE id = $1 AND referred_by IS NOT NULL AND NOT referral_rewarded RETURNING referred_by`, [member.id]);
  if (!r) return null;
  const { rows: [inviter] } = await db.query(
    'UPDATE members SET boost_credits = boost_credits + $2, updated_at = now() WHERE id = $1 RETURNING id, email', [r.referred_by, credits]);
  if (!inviter) return null;
  await publish(db, { entity: 'me', email: inviter.email });
  await publish(db, { entity: 'referralReward', op: 'notify', memberId: inviter.id, credits });
  return inviter;
}
