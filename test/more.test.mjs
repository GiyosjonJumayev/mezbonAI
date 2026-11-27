// Theme pages, paid promotion, give 10% get 10%, and group requests with quotes.
import test from "node:test";
import assert from "node:assert/strict";
import { addDays, isoWeekday } from "../src/lib/util.mjs";
import { UI } from "../src/lib/i18n.mjs";
import { day, req, serve, settle, setup, status } from "./helpers.mjs";

const MAIL = { SMTP_URL: "smtp://mail.test", MAIL_FROM: "SilkRoad <x@example.com>" };
const weekday = (n) => { let d = day(n); while (isoWeekday(d) > 5) d = addDays(d, 1); return d; };
async function mailing() {
  const sent = [], s = await serve({ env: MAIL, mailer: { sendMail: async (m) => { sent.push(m); }, close() {} } });
  const h = await s.core.createHost("Rustam"), l = await s.publishListing(h.key);
  return { s, h, l, sent, flush: async () => { await settle(80); await s.mail.work(); } };
}

test("a theme has its own page for search engines, listing its offers, and appears in the sitemap only when it has offers", async () => {
  const s = await serve(), h = await s.core.createHost("Rustam");
  await s.publishListing(h.key);
  const html = await (await fetch(`${s.base}/?theme=crafts&lang=ru`)).text();
  assert.match(html, new RegExp(`<title>${UI.th_crafts.ru} \\| SilkRoad</title>`));
  assert.equal(JSON.parse(/<script type="application\/ld\+json">([^<]+)</.exec(html)[1]).itemListElement.length, 1);
  const map = await (await fetch(`${s.base}/sitemap.xml`)).text();
  assert.equal((map.match(/theme=crafts&amp;lang=/g) ?? []).length, 10);
  assert.equal((map.match(/theme=food/g) ?? []).length, 0, "an empty theme is not offered to search engines");
  assert.doesNotMatch(await (await fetch(`${s.base}/?theme=nope`)).text(), /ItemList/);
  assert.ok((await s.get("/api/config")).themes.crafts.categories.includes("pottery"));
});

test("paid promotion: a week at the top, added up, marked everywhere, counted as revenue", async () => {
  const s = await setup(), draft = await s.core.createDraft(s.host.key, "Samarqandda palov, 3 soat, 180 ming so'm, 8 kishi");
  await status(s.payments.startBoost(s.host.key, draft.id, "test"), 409);
  await status(s.payments.startBoost("nope", s.l.id, "test"), 401);
  assert.equal((await s.core.search({ log: false }))[0].promoted, false);
  await s.payments.startBoost(s.host.key, s.l.id, "test");
  const first = new Date((await s.db.one("SELECT promoted_until FROM listings WHERE id=?", s.l.id)).promoted_until);
  assert.ok(Math.abs(first - Date.now() - 7 * 864e5) < 60e3);
  await s.payments.startBoost(s.host.key, s.l.id, "test");
  assert.ok(Math.abs(new Date((await s.db.one("SELECT promoted_until FROM listings WHERE id=?", s.l.id)).promoted_until) - first - 7 * 864e5) < 60e3, "a second week is added, not overwritten");
  assert.equal((await s.core.search({ log: false }))[0].promoted, true);
  assert.equal((await s.db.one("SELECT amount_uzs FROM payments WHERE kind='boost' LIMIT 1")).amount_uzs, 99000);
  assert.equal((await s.metrics.investor({ sample: true })).money.boosts, 198000);
  await s.db.run("UPDATE listings SET promoted_until = now() - interval '1 minute'");
  assert.equal((await s.core.search({ log: false }))[0].promoted, false, "it ends by itself");
});

test("give 10%, get 10%: a friend saves, the guest is rewarded once per paying friend, never for themselves", async () => {
  const { s, l, sent, flush } = await mailing(), d = weekday(3);
  const mine = await s.core.book(req(l, { date: d, email: "anna@example.com", lang: "de" }));
  await status(s.post(`/api/bookings/${mine.token}/referral`, {}).then((r) => { if (!r.ok) throw Object.assign(new Error(), { status: r.status }); }), 404);
  await s.payTest(mine.token);
  const { code } = await (await s.post(`/api/bookings/${mine.token}/referral`, {})).json();
  assert.match(code, /^F[0-9A-F]{8}$/);
  assert.equal((await (await s.post(`/api/bookings/${mine.token}/referral`, {})).json()).code, code, "always the same code");
  const self = await s.core.book(req(l, { date: d, time: "15:00", guests: 1, email: "ANNA@example.com", promo: code }));
  await s.payTest(self.token);
  const friend = await s.core.book(req(l, { date: addDays(d, 7), guests: 2, email: "ben@example.com", promo: code }));
  assert.equal(friend.discount_uzs, 30000);
  await s.payTest(friend.token);
  await s.core.markPaid(await s.core.bookingId(friend.token)); // the payment company says it twice
  await flush();
  const rewards = sent.filter((m) => m.subject === UI.rewardTitle.de);
  assert.equal(rewards.length, 1, "once, and not for booking with one's own code");
  const reward = /: (T[0-9A-F]{8})/.exec(rewards[0].text)[1];
  assert.equal(rewards[0].to, "anna@example.com");
  const next = await s.core.book(req(l, { date: addDays(d, 7), time: "15:00", guests: 1, email: "anna@example.com", promo: reward }));
  assert.equal(next.discount_uzs, 15000);
  await assert.rejects(s.core.book(req(l, { date: addDays(d, 14), guests: 1, promo: reward })), { code: "promo" }, "a reward is used once");
  const t = (await (await s.get("/api/config")) && (await s.promos.referralTotals()));
  assert.deepEqual([t.codes, t.friends], [1, 2]);
  assert.ok(!(await s.promos.promos()).some((p) => ["referral", "reward"].includes(p.note)), "guest codes stay out of the campaign list");
});

test("group requests: the host quotes a time and one price, the guest books it, and it is confirmed when paid", async () => {
  const { s, h, l, sent, flush } = await mailing(), d = weekday(5);
  for (const bad of [{ email: "" }, { date: day(0) }, { guests: 0 }, { name: "" }]) await status(s.core.askGroup(l.id, { date: d, guests: 12, name: "School 7", email: "t@example.com", lang: "fr", ...bad }), 400);
  const { token } = await s.core.askGroup(l.id, { date: d, guests: 12, private: true, name: "School 7", email: "t@example.com", lang: "fr", note: "Two teachers" });
  await settle();
  const [r] = await s.core.groupRequests(h.key);
  assert.deepEqual([r.guests, r.private, r.status], [12, true, "new"]);
  assert.ok(!JSON.stringify(r).includes("t@example.com"), "the provider does not see the guest's address");
  await status(s.core.answerGroup(h.key, r.id, { time: "11:11", total_uzs: 1500000 }), 400);
  const other = await s.core.createHost("Other");
  await status(s.core.answerGroup(other.key, r.id, { time: "10:00", total_uzs: 1500000 }), 404);
  await s.core.answerGroup(h.key, r.id, { time: "10:00", total_uzs: 1500000, note: "Lunch included" });
  await flush();
  const quote = sent.find((m) => m.to === "t@example.com");
  assert.ok(quote.subject.includes(UI.quoteTitle.fr) && quote.text.includes(`/?q=${token}`) && quote.text.includes("1 500 000"));
  const seen = await s.core.groupRequest(token);
  assert.deepEqual([seen.status, seen.quote.total_uzs, seen.quote.time], ["quoted", 1500000, "10:00"]);
  await assert.rejects(s.core.bookQuote(token, { expect_uzs: 1000 }), { code: "price" }, "the price the guest saw is the price charged");
  const { booking } = await s.core.bookQuote(token, { expect_uzs: 1500000 });
  assert.equal((await s.core.bookQuote(token, {})).booking, booking, "booking twice gives the same booking");
  const b = await s.core.guestBooking(booking);
  assert.deepEqual([b.guests, b.total_uzs, b.status], [12, 1500000, "pending"], "12 guests although the offer takes 4: the provider agreed");
  assert.equal(b.host_uzs + b.platform_uzs + b.hotel_uzs + b.partner_uzs, b.total_uzs);
  assert.equal((await s.payTest(booking)).status, "confirmed", "the provider already said yes");
  await status(s.core.answerGroup(h.key, r.id, { decline: true }), 409);
});

test("a declined request tells the guest, and requests cannot be used to flood an inbox", async () => {
  const { s, h, l, sent, flush } = await mailing(), d = weekday(5);
  const { token } = await s.core.askGroup(l.id, { date: d, guests: 9, name: "Club", email: "c@example.com", lang: "en" });
  await s.core.answerGroup(h.key, (await s.core.groupRequests(h.key))[0].id, { decline: true });
  await flush();
  assert.ok(sent.some((m) => m.to === "c@example.com" && m.text.includes(UI.quoteDeclined.en)));
  assert.equal((await s.core.groupRequest(token)).status, "declined");
  await status(s.core.bookQuote(token, {}), 409);
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await s.post(`/api/listings/${l.id}/group`, { date: d, guests: 9, name: "X", email: "spam@example.com", lang: "en" })).status);
  assert.equal(codes.at(-1), 429);
});
