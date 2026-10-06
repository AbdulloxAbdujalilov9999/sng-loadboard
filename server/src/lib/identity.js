// Who is a member, regardless of how they signed in?
//  * Google / email+password -> their VERIFIED e-mail address (lower-case).
//  * Phone (SMS code)        -> a synthetic, un-spoofable key  p<digits>@phone.sng  (".sng" is not a real TLD, so
//                               nobody can own a mailbox that collides with it). The real contact e-mail, if any,
//                               lives in members.contact_email.
// Everything inside the server (rows, caches, live events, owner check) keys on this one string.
const PHONE_DOMAIN = '@phone.sng';

export const phoneIdentity = (e164) => `p${String(e164).replace(/\D/g, '')}${PHONE_DOMAIN}`;
export const isPhoneIdentity = (identity) => String(identity).endsWith(PHONE_DOMAIN);

/** What to show as "how you sign in": the e-mail, or the phone number in +E.164 form. */
export const loginLabel = (identity) => (isPhoneIdentity(identity) ? `+${identity.slice(1, -PHONE_DOMAIN.length)}` : identity);

/** The member's real login e-mail ('' for phone sign-in - never the synthetic key). */
export const realEmail = (identity) => (isPhoneIdentity(identity) ? '' : identity);

/** The address other members see / mailto: - the chosen contact e-mail, else the login e-mail, never the synthetic key. */
export const publicEmail = (identity, contactEmail = '') => contactEmail || realEmail(identity);
