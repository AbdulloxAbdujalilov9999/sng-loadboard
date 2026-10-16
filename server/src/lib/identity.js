// Who is a member, regardless of how they signed in?
//  * Google / email+password -> their VERIFIED e-mail address (lower-case).
//  * Phone (SMS code)        -> a synthetic, un-spoofable key  p<digits>@phone.sng  (".sng" is not a real TLD, so
//                               nobody can own a mailbox that collides with it). The real contact e-mail, if any,
//                               lives in members.contact_email.
//  * Telegram Mini App       -> a synthetic key  t<telegram user id>@telegram.sng , proven by Telegram's signed
//                               initData (see lib/telegramAuth.js) instead of a password.
// Everything inside the server (rows, caches, live events, owner check) keys on this one string.
const PHONE_DOMAIN = '@phone.sng';
const TELEGRAM_DOMAIN = '@telegram.sng';

export const phoneIdentity = (e164) => `p${String(e164).replace(/\D/g, '')}${PHONE_DOMAIN}`;
export const isPhoneIdentity = (identity) => String(identity).endsWith(PHONE_DOMAIN);

export const telegramIdentity = (telegramUserId) => `t${telegramUserId}${TELEGRAM_DOMAIN}`;
export const isTelegramIdentity = (identity) => String(identity).endsWith(TELEGRAM_DOMAIN);

/** What to show as "how you sign in": the e-mail, the phone number in +E.164 form, or "Telegram". */
export const loginLabel = (identity) => {
  if (isPhoneIdentity(identity)) return `+${identity.slice(1, -PHONE_DOMAIN.length)}`;
  if (isTelegramIdentity(identity)) return 'Telegram';
  return identity;
};

/** The member's real login e-mail ('' for phone / Telegram sign-in - never a synthetic key). */
export const realEmail = (identity) => (isPhoneIdentity(identity) || isTelegramIdentity(identity) ? '' : identity);

/** The address other members see / mailto: - the chosen contact e-mail, else the login e-mail, never the synthetic key. */
export const publicEmail = (identity, contactEmail = '') => contactEmail || realEmail(identity);
