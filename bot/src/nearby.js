// "Near me" in Telegram, like DAT: share your location once (Telegram's own button), then see the loads - or the trucks - within a
// radius around you, nearest first, each as its own message. The position is kept for the next search and can be deleted any time.
import { Markup } from 'telegraf';
import { ApiError } from './apiClient.js';
import { NotLinkedError } from './tokens.js';
import { dtoToRow, distanceLine, formatLoadMessage, formatTruckMessage } from './format.js';
import { mainKeyboard } from './menu.js';
import { withRetry } from './retry.js';
import { t } from './i18n.js';

const PAGE = 10;
export const RADII = [25, 50, 100, 200, 300]; // miles
const MI_KM = 1.609344;
export const miToKm = (mi) => Math.max(1, Math.round(mi * MI_KM));

/** How long ago a position was shared, in words. */
export function ageText(lang, at, now = Date.now()) {
  const min = Math.max(0, Math.round((now - new Date(at).getTime()) / 60_000));
  if (min < 2) return t(lang, 'near_age_now');
  if (min < 90) return t(lang, 'near_age_min', { n: min });
  if (min < 48 * 60) return t(lang, 'near_age_hours', { n: Math.round(min / 60) });
  return t(lang, 'near_age_days', { n: Math.round(min / 1440) });
}

export function makeNearby({ apiClient, tokens, store, config, log = console }) {
  const sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const gap = config.nearGapMs ?? 250; // a pause between the cards (Telegram allows about one message a second to a chat)
  const retry = (fn) => withRetry(fn, { sleep });

  async function token(ctx) {
    try { return await tokens.getIdToken(ctx.from.id); } catch (err) {
      await ctx.reply(t(ctx.lang, err instanceof NotLinkedError ? 'near_not_linked' : 'postload_session_error'));
      return null;
    }
  }

  async function askLocation(ctx, kind) {
    ctx.session.near = { kind };
    await ctx.reply(t(ctx.lang, kind === 'trucks' ? 'near_ask_trucks' : 'near_ask_loads'), Markup.keyboard([
      [Markup.button.locationRequest(t(ctx.lang, 'near_share_btn'))], [t(ctx.lang, 'near_cancel_btn')],
    ]).oneTime().resize());
  }

  /** The menu button / command: results around the saved position, or the question when there is none yet. */
  async function start(ctx, kind) {
    if (ctx.chat.type !== 'private') { await ctx.reply(t(ctx.lang, 'link_dm_only')); return; }
    if (!(await token(ctx))) return;
    const geo = await store.getGeo(ctx.from.id);
    if (geo.lat == null) { await askLocation(ctx, kind); return; }
    ctx.session.near = { kind };
    await show(ctx, kind, geo);
  }

  /** The person shared a location (the button, or the paperclip - either way it is their own answer). */
  async function onLocation(ctx) {
    const { latitude, longitude } = ctx.message.location;
    const lat = Math.round(latitude * 1e4) / 1e4;
    const lng = Math.round(longitude * 1e4) / 1e4;
    await store.setGeo(ctx.from.id, { lat, lng, language: ctx.lang });
    const kind = ctx.session?.near?.kind ?? 'loads';
    await ctx.reply(t(ctx.lang, 'near_saved'), mainKeyboard(ctx.lang)); // the share keyboard goes away, the menu comes back
    if (!(await token(ctx))) return;
    await show(ctx, kind, await store.getGeo(ctx.from.id));
  }

  function controls(ctx, kind, miles, { withLocation = true } = {}) {
    const radius = RADII.map((mi) => Markup.button.callback(mi === miles ? `✓ ${mi}` : String(mi), `near:mi:${kind}:${mi}`));
    return Markup.inlineKeyboard([
      radius,
      ...(withLocation ? [[Markup.button.callback(t(ctx.lang, 'near_btn_update'), `near:upd:${kind}`), Markup.button.callback(t(ctx.lang, 'near_btn_forget'), 'near:del')]] : []),
    ]);
  }

  function cardButtons(ctx, kind, item) {
    const row = [];
    const tg = String(item.contactTelegram ?? '').replace(/^@/, '');
    if (/^[A-Za-z0-9_]{4,32}$/.test(tg)) row.push(Markup.button.url('✈️ Telegram', `https://t.me/${tg}`));
    if (kind === 'loads' && config.webUrlIsPublic !== false) row.push(Markup.button.url(t(ctx.lang, 'near_view_board'), `${config.webBaseUrl}/?load=${item.id}`));
    return row.length ? Markup.inlineKeyboard([row]) : {};
  }

  /** One page of results (the first page also sends the header with the radius buttons). */
  async function show(ctx, kind, geo, { cursor } = {}) {
    const idToken = await token(ctx);
    if (!idToken) return;
    const miles = geo.miles ?? 100;
    const params = { nearLat: geo.lat, nearLng: geo.lng, sort: 'nearest', dir: 'asc', limit: PAGE, cursor, ...(kind === 'trucks' ? { locRadius: miToKm(miles) } : { originRadius: miToKm(miles) }) };
    let res;
    try { res = await (kind === 'trucks' ? apiClient.searchTrucks(idToken, params) : apiClient.searchLoads(idToken, params)); } catch (err) {
      if (err instanceof ApiError && err.code === 'subscription_required') { await ctx.reply(t(ctx.lang, 'paste_subscription_required')); return; }
      log.error?.(`near search failed: ${err.message}`);
      await ctx.reply(t(ctx.lang, 'postload_unreachable'));
      return;
    }
    ctx.session.near = { kind, cursor: res.nextCursor ?? null, shown: (cursor ? (ctx.session.near?.shown ?? 0) : 0) + res.items.length };
    if (!cursor) {
      if (!res.items.length) { await ctx.reply(`${t(ctx.lang, kind === 'trucks' ? 'near_empty_trucks' : 'near_empty_loads', { mi: miles })}\n(${ageText(ctx.lang, geo.at)})`, controls(ctx, kind, miles)); return; }
      await ctx.reply(`${t(ctx.lang, kind === 'trucks' ? 'near_header_trucks' : 'near_header_loads', { mi: miles, n: res.total ?? res.items.length })}\n${ageText(ctx.lang, geo.at)}\n${t(ctx.lang, 'near_radius')}`, controls(ctx, kind, miles));
    }
    for (const item of res.items) {
      const text = kind === 'trucks' ? formatTruckMessage(item, ctx.lang, { km: item.dho }) : `${distanceLine(item.dho, ctx.lang)}\n\n${formatLoadMessage(dtoToRow(item), ctx.lang)}`;
      await retry(() => ctx.reply(text, { parse_mode: 'HTML', ...cardButtons(ctx, kind, item) }));
      if (gap > 0) await sleep(gap);
    }
    if (res.nextCursor) {
      const left = Math.max(1, (res.total ?? 0) - ctx.session.near.shown);
      await ctx.reply(t(ctx.lang, 'near_more_text', { n: res.total ? left : '10+' }), Markup.inlineKeyboard([[Markup.button.callback(t(ctx.lang, 'near_more_btn'), `near:more:${kind}`)]]));
    }
  }

  async function more(ctx, kind) {
    await ctx.answerCbQuery().catch(() => {});
    const near = ctx.session?.near;
    const geo = await store.getGeo(ctx.from.id);
    if (geo.lat == null) { await askLocation(ctx, kind); return; }
    ctx.editMessageReplyMarkup?.({ inline_keyboard: [] }).catch(() => {});
    if (near?.kind === kind && near.cursor) await show(ctx, kind, geo, { cursor: near.cursor });
    else await show(ctx, kind, geo);
  }

  async function setRadius(ctx, kind, miles) {
    await ctx.answerCbQuery().catch(() => {});
    if (!RADII.includes(miles)) return;
    await store.setGeoMiles(ctx.from.id, miles, ctx.lang);
    const geo = await store.getGeo(ctx.from.id);
    if (geo.lat == null) { await askLocation(ctx, kind); return; }
    await show(ctx, kind, geo);
  }

  async function update(ctx, kind) { await ctx.answerCbQuery().catch(() => {}); await askLocation(ctx, kind); }

  async function forget(ctx) {
    await ctx.answerCbQuery().catch(() => {});
    await store.clearGeo(ctx.from.id);
    delete ctx.session.near;
    await ctx.reply(t(ctx.lang, 'near_forgot'), mainKeyboard(ctx.lang));
  }

  async function cancel(ctx) { delete ctx.session.near; await ctx.reply(t(ctx.lang, 'near_cancelled'), mainKeyboard(ctx.lang)); }

  return { start, onLocation, more, setRadius, update, forget, cancel };
}
