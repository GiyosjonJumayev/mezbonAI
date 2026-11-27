// Search engines and link previews, promo codes, winning back unfinished bookings, the e-mail after a visit, instant confirmation.
import test from "node:test";
import assert from "node:assert/strict";
import { addDays, isoWeekday } from "../src/lib/util.mjs";
import { UI } from "../src/lib/i18n.mjs";
import { day, req, serve, settle, setup, status } from "./helpers.mjs";

const MAIL = { SMTP_URL: "smtp://mail.test", MAIL_FROM: "SilkRoad <x@example.com>" };
const weekday = (n) => { let d = day(n); while (isoWeekday(d) > 5) d = addDays(d, 1); return d; };
async function mailing(env = {}) {
  const sent = [], s = await serve({ env: { ...MAIL, ...env }, mailer: { sendMail: async (m) => { sent.push(m); }, close() {} } });
  const h = await s.core.createHost("Rustam"), l = await s.publishListing(h.key);
  return { s, h, l, sent, flush: async () => { await settle(); await s.mail.work(); } };
}

// ---- search engines and previews --------------------------------------------------------------------
test("an offer page carries its own title, picture, price, rating and languages for search engines and link previews", async () => {
  const s = await serve(), h = await s.core.createHost("Rustam"), l = await s.publishListing(h.key);
  const page = async (q) => (await fetch(`${s.base}/${q}`)).text();
  const html = await page(`?l=${l.id}&lang=de`);
  assert.match(html, /<html lang="de"/);
  assert.match(html, new RegExp(`<title>${l.i18n.de.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\| SilkRoad</title>`));
  assert.match(html, /<meta property="og:image" content="http:\/\/localhost:4321\/icon512\.png">/);
  assert.equal((html.match(/hreflang=/g) ?? []).length, 10);
  const data = JSON.parse(/<script type="application\/ld\+json">([^<]+)<\/script>/.exec(html)[1]);
  assert.deepEqual([data["@type"], data.offers.price, data.offers.priceCurrency], ["Product", 150000, "UZS"]);
  assert.equal((html.match(/og:title/g) ?? []).length, 1, "the generic preview gives way to the offer's");
  // a name with markup in it cannot break out of the page
  await s.core.updateListing(h.key, l.id, { text: { lang: "en", title: 'Pots</title><script>alert(1)</script>"' } });
  const bad = await page(`?l=${l.id}&lang=en`);
  assert.ok(!bad.includes("<script>alert(1)") && bad.includes("Pots&lt;/title&gt;"));
  assert.ok(!/<script type="application\/ld\+json">[^]*<\/script>[^]*alert/.test(bad.split("application/ld+json")[1].split("</script>")[0] + "</script>"), "JSON-LD cannot close its script element");
  assert.match(await page("?b=secret-booking"), /noindex/, "bookings are not for search engines");
  assert.match(await page(`?l=nope`), /<title>SilkRoad Experience OS<\/title>/, "an unknown offer leaves the page as it was");
});

test("the sitemap lists every real offer in ten languages; robots keep private pages out", async () => {
  const s = await serve(), h = await s.core.createHost("Rustam"), l = await s.publishListing(h.key);
  await s.db.run("INSERT INTO hosts (id,key_hash,name,demo) VALUES ('h_sample','\\x00','Sample',true)");
  const map = await (await fetch(`${s.base}/sitemap.xml`)).text();
  assert.equal((map.match(new RegExp(`\\?l=${l.id}&amp;lang=`, "g")) ?? []).length, 10);
  assert.match(map, /^<\?xml/);
  const robots = await (await fetch(`${s.base}/robots.txt`)).text();
  assert.match(robots, /Disallow: \/mezbon/);
  assert.match(robots, /Sitemap: http:\/\/localhost:4321\/sitemap\.xml/);
  const demo = await serve({ env: { DEMO_SITE: "1", PUBLIC_URL: "https://demo.example", ADMIN_KEY: "k".repeat(30) } });
  assert.equal(await (await fetch(`${demo.base}/robots.txt`)).text(), "User-agent: *\nDisallow: /\n");
});

// ---- promo codes ---------------------------------------------------------------------------------
test("promo codes: the platform pays the discount, the provider earns the same, and the limit holds", async () => {
  const s = await setup(), d = weekday(3);
  await s.promos.createPromo({ code: "hotel-vodiy", pct: 10, uses_max: 2, note: "Vodiy mehmonxonasi" });
  for (const bad of [{ code: "x", pct: 10 }, { code: "ABC", pct: 0 }, { code: "ABC", pct: 60 }, { code: "ABC", pct: 10, valid_until: day(-1) }]) await status(s.promos.createPromo(bad), 400);
  await status(s.promos.createPromo({ code: "HOTELVODIY", pct: 5 }), 409);
  assert.deepEqual(await s.promos.checkPromo(" hotelvodiy ", s.l.id), { code: "HOTELVODIY", pct: 10 });
  const plain = await s.core.book(req(s.l, { date: d, guests: 2 })), coded = await s.core.book(req(s.l, { date: d, time: "15:00", guests: 2, promo: "HOTELVODIY" }));
  assert.deepEqual([coded.total_uzs, coded.discount_uzs, coded.host_uzs, plain.host_uzs], [270000, 30000, plain.host_uzs, plain.host_uzs]);
  assert.equal(coded.platform_uzs, plain.platform_uzs - 30000);
  assert.equal(coded.host_uzs + coded.platform_uzs + coded.hotel_uzs + coded.partner_uzs, coded.total_uzs);
  await s.core.book(req(s.l, { date: addDays(d, 7), guests: 1, promo: "HOTELVODIY" }));
  await assert.rejects(s.core.book(req(s.l, { date: addDays(d, 7), time: "15:00", promo: "HOTELVODIY" })), { code: "promo" }, "used up");
  await assert.rejects(s.core.book(req(s.l, { date: addDays(d, 8), promo: "NOSUCH" })), { code: "promo" });
  assert.equal((await s.db.one("SELECT COUNT(*) n FROM bookings WHERE date=?", addDays(d, 8))).n, 0, "a bad code books nothing");
  const [row] = await s.promos.promos();
  assert.deepEqual([row.sold, row.cost], [0, 0], "only paid bookings count as sold");
  await s.payTest(coded.token);
  assert.deepEqual([(await s.promos.promos())[0].sold, (await s.promos.promos())[0].cost], [1, 30000]);
  assert.equal((await s.db.one("SELECT amount_uzs n FROM payments")).n, 270000, "the guest pays the lower price");
});

test("promo codes never cost more than the platform earns, and expire", async () => {
  const s = await setup(), d = weekday(3);
  await s.promos.createPromo({ code: "BIG", pct: 50 });
  assert.equal((await s.promos.checkPromo("BIG", s.l.id)).pct, 12, "capped at the free plan's commission");
  const b = await s.core.book(req(s.l, { date: d, guests: 2, promo: "BIG" }));
  assert.deepEqual([b.platform_uzs, b.discount_uzs], [0, 36000]);
  await s.db.run("UPDATE promo_codes SET valid_until = now()::date - 1 WHERE code='BIG'");
  await status(s.promos.checkPromo("BIG", s.l.id), 409);
  await s.promos.setPromo("BIG", { active: false });
  await s.db.run("UPDATE promo_codes SET valid_until=NULL");
  await status(s.promos.checkPromo("BIG", s.l.id), 409);
});

test("promo codes: checking is limited, and resellers cannot use them", async () => {
  const s = await serve(), h = await s.core.createHost("R"), l = await s.publishListing(h.key), codes = [];
  for (let i = 0; i < 17; i++) codes.push((await s.post("/api/promo/check", { code: `TRY${i}`, listing_id: l.id })).status);
  assert.deepEqual([codes[0], codes.at(-1)], [409, 429]);
  await s.promos.createPromo({ code: "FREE", pct: 10 });
  await s.core.updateListing(h.key, l.id, { resell: true });
  const r = await s.resellers.createReseller({ name: "X", pct: 10 });
  await s.core.book({ ...req(l), promo: "FREE" }, { reseller: r, uuid: "a1b2c3d4-0000-4000-8000-000000000000" });
  assert.equal((await s.db.one("SELECT discount_uzs FROM bookings")).discount_uzs, 0);
});

// ---- winning back unfinished bookings -------------------------------------------------------------
test("an unpaid hold is followed up once, only while its place is free and the guest did not book again", async () => {
  const { s, l, sent, flush } = await mailing(), d = weekday(4);
  const a = await s.core.book(req(l, { date: d, email: "a@example.com" })), b = await s.core.book(req(l, { date: d, time: "15:00", email: "b@example.com" }));
  await s.core.book(req(l, { date: d, email: null }));
  assert.equal(await s.recall(), 0, "not while the hold is still running");
  await s.db.run("UPDATE bookings SET expires_at = now() - interval '20 minutes'");
  const again = await s.core.book(req(l, { date: d, time: "15:00", email: "B@example.com" }));
  await s.payTest(again.token);
  assert.equal(await s.recall(), 1, "b booked again; the guest without an address cannot be written to");
  assert.equal(await s.recall(), 0, "once only");
  await flush();
  assert.deepEqual(sent.filter((m) => m.subject.includes(UI.recallTitle.zh)).map((m) => m.to), ["a@example.com"]);
  assert.ok(sent.find((m) => m.to === "a@example.com").text.includes(`/?b=${a.token}`));
  // and the link really still works: paying revives the hold
  await s.payTest(a.token);
  assert.equal((await s.core.guestBooking(a.token)).status, "paid");
  assert.ok(b);
});

// ---- after the visit --------------------------------------------------------------------------------
test("after a visit the guest is asked for a review and shown more nearby, once", async () => {
  const { s, h, l, sent, flush } = await mailing(), other = await s.publishListing(h.key, "Rishtonda qishloq hayoti, uch soat, 80 ming so'm, 6 kishi");
  const b = await s.core.book(req(l, { date: weekday(3), email: "a@example.com" }));
  await s.payTest(b.token);
  await s.core.decide(h.key, await s.core.bookingId(b.token), true);
  assert.equal(await s.follow(), 0, "not before the visit");
  await s.db.run("UPDATE bookings SET date = current_date - 1");
  assert.equal(await s.follow(), 1);
  assert.equal(await s.follow(), 0);
  await flush();
  const m = sent.find((x) => x.subject.includes(UI.afterTitle.zh));
  assert.ok(m && m.text.includes(`/?l=${other.id}`) && !m.text.includes(`/?l=${l.id}&`));
});

// ---- instant confirmation ---------------------------------------------------------------------------
test("instant confirmation: a paid booking is confirmed at once, with its ticket", async () => {
  const s = await setup();
  await s.core.updateListing(s.host.key, s.l.id, { instant: true });
  assert.equal((await s.core.listing(s.l.id)).instant, true);
  const b = await s.core.book(req(s.l, { date: weekday(3) }));
  const paid = await s.payTest(b.token);
  assert.deepEqual([paid.status, paid.ticket.code.length, paid.decide_by], ["confirmed", 12, null]);
  await settle();
  assert.deepEqual([s.events.at(-1), s.guestEvents.at(-1)], ["booking", "confirmed"]);
  await s.core.updateListing(s.host.key, s.l.id, { instant: false });
  assert.equal((await s.payTest((await s.core.book(req(s.l, { date: weekday(3), time: "15:00" }))).token)).status, "paid");
});
