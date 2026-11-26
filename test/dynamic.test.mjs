// Live streams, prices that follow the day and the group, next free times, and the waiting list.
import test from "node:test";
import assert from "node:assert/strict";
import { unitPrice } from "../public/price.js";
import { createLive } from "../src/http/live.mjs";
import { UI } from "../src/lib/i18n.mjs";
import { addDays, isoWeekday } from "../src/lib/util.mjs";
import { day, req, serve, settle, setup, status } from "./helpers.mjs";

const MAIL = { SMTP_URL: "smtp://mail.test", MAIL_FROM: "SilkRoad <x@example.com>" };
/** A day at least `n` days ahead that is (not) a weekend. */
const ahead = (n, weekend = false) => { let d = day(n); while ((isoWeekday(d) > 5) !== weekend) d = addDays(d, 1); return d; };

test("the price formula: weekends, last minute, groups, rounding", () => {
  const l = { price_uzs: 150000, pricing: { weekend: 20, last: { hours: 24, pct: 15 }, group: { from: 4, pct: 10 } } }, now = Date.parse("2026-11-23T10:00:00+05:00"); // a Monday
  const p = (date, time, guests) => unitPrice(l, date, time, guests, now);
  assert.deepEqual(p("2026-12-02", "10:00", 1), { unit: 150000, before: 150000, why: null, pct: 0 });
  assert.deepEqual(p("2026-11-28", "10:00", 1), { unit: 180000, before: 180000, why: "weekend", pct: 20 });
  assert.deepEqual(p("2026-11-24", "09:00", 1), { unit: 128000, before: 150000, why: "last", pct: -15 });
  assert.equal(p("2026-11-24", "10:00", 1).why, "last", "exactly 24 hours counts");
  assert.equal(p("2026-11-24", "10:01", 1).why, null);
  assert.deepEqual(p("2026-12-02", "10:00", 4), { unit: 135000, before: 150000, why: "group", pct: -10 });
  assert.deepEqual([p("2026-11-24", "09:00", 8).why, p("2026-11-24", "09:00", 8).unit], ["last", 128000], "discounts do not add up");
  assert.equal(p("2026-11-28", "10:00", 4).unit, 162000, "a group on a weekend");
  for (const price_uzs of [1000, 1499, 2500]) { const x = unitPrice({ price_uzs, pricing: { last: { hours: 72, pct: 50 } } }, "2026-11-23", "12:00", 1, now); assert.ok(x.unit >= 1000 && x.unit <= x.before, String(price_uzs)); }
  assert.equal(unitPrice({ price_uzs: 99000 }, "2026-11-28", "10:00").unit, 99000, "no rules, no change");
});

test("a provider's rules are checked, and only known parts are kept", async () => {
  const s = await setup(), set = (pricing) => s.core.updateListing(s.host.key, s.l.id, { pricing });
  assert.deepEqual((await set({ weekend: 10, last: { hours: 24, pct: 15, x: 1 }, group: { from: 4, pct: 10 }, evil: "x" })).pricing, { weekend: 10, last: { hours: 24, pct: 15 }, group: { from: 4, pct: 10 } });
  for (const bad of ["x", [], { weekend: 51 }, { weekend: -51 }, { weekend: 1.5 }, { weekend: "10" }, { last: { hours: 25, pct: 10 } }, { last: { hours: 24, pct: 60 } }, { last: { pct: 10 } }, { group: { from: 1, pct: 10 } }, { group: { from: 4, pct: 90 } }, { group: true }]) await status(set(bad), 400);
  assert.equal((await s.core.listing(s.l.id)).pricing.weekend, 10, "a refused change changes nothing");
  assert.deepEqual((await set({})).pricing, {});
  assert.deepEqual((await set({ weekend: 0, last: null })).pricing, {});
});

test("a booking costs what the formula says, its shares add up, and old bookings keep their price", async () => {
  const s = await setup(), l = s.l, d = ahead(5), w = ahead(5, true), book = (o) => s.core.book(req(l, { date: d, guests: 2, ...o }));
  const old = await book({});
  assert.equal(old.total_uzs, 300000);
  await s.core.updateListing(s.host.key, l.id, { pricing: { weekend: 20, group: { from: 3, pct: 10 } } });
  const g = await book({ date: addDays(d, 7), guests: 3 }), we = await book({ date: w });
  assert.deepEqual([g.total_uzs, we.total_uzs], [405000, 360000]);
  for (const b of [g, we]) assert.equal(b.host_uzs + b.platform_uzs + b.hotel_uzs, b.total_uzs);
  assert.equal((await s.core.guestBooking(old.token)).total_uzs, 300000);
  await s.payTest(g.token);
  assert.equal((await s.db.one("SELECT amount_uzs n FROM payments")).n, 405000);
  // moving a booking keeps the price the guest agreed to
  await s.payTest(old.token);
  assert.equal((await s.core.reschedule(old.token, { date: addDays(w, 7), time: "10:00" })).total_uzs, 300000);
});

test("a price that went up while the guest was typing needs a new yes; a lower one is simply charged", async () => {
  const s = await setup(), l = s.l, r = (o) => s.core.book(req(l, { date: ahead(5), ...o }));
  await s.core.updateListing(s.host.key, l.id, { price_uzs: 160000 });
  await assert.rejects(r({ expect_uzs: 300000 }), { status: 409, code: "price" });
  assert.equal((await s.db.one("SELECT COUNT(*) n FROM bookings")).n, 0);
  assert.equal((await r({ expect_uzs: 320000 })).total_uzs, 320000);
  await s.core.updateListing(s.host.key, l.id, { price_uzs: 100000 });
  assert.equal((await r({ time: "15:00", expect_uzs: 320000 })).total_uzs, 200000);
  // a trip is refused as a whole, and says which part
  await assert.rejects(s.core.bookTrip({ items: [{ listing_id: l.id, date: ahead(6), time: "10:00", expect_uzs: 1000 }], guests: 2, guest_name: "Anna", lang: "en" }), (e) => e.code === "price" && e.item.listing_id === l.id);
  assert.equal((await s.db.one("SELECT COUNT(*) n FROM trips")).n, 0);
});

test("the trip planner counts the real price of each day", async () => {
  const s = await setup(), w = ahead(3, true);
  await s.core.updateListing(s.host.key, s.l.id, { pricing: { weekend: -20 } });
  const t = await s.core.planTrip({ from: w, days: 1, guests: 2 });
  assert.deepEqual([t.days[0].items[0].price_uzs, t.total_uzs], [120000, 240000]);
  assert.equal((await s.core.planTrip({ from: w, days: 1, guests: 2, budget: 119000 })).total_uzs, 0);
});

test("search shows the next free time and its price; the same for a few listings only", async () => {
  const s = await setup(), l = s.l, d = day(1), one = async (o) => (await s.core.search({ ...o, log: false }))[0];
  const n = (await one({})).next;
  assert.ok(n.date >= day(0) && n.free === 4 && n.unit === 150000);
  for (const time of ["10:00", "15:00"]) await s.core.setSlot(s.host.key, l.id, { date: d, time, capacity: 0 });
  assert.equal(await one({ date: d }), undefined);
  await s.core.setSlot(s.host.key, l.id, { date: d, time: "15:00", capacity: 2 });
  assert.deepEqual([(await one({ date: d })).next.time, (await one({ date: d })).next.free], ["15:00", 2]);
  assert.equal(await one({ date: d, guests: 3 }), undefined);
  const next = await s.core.nextTimes([l.id, l.id, "no-such", "'; drop"], { date: d });
  assert.deepEqual([Object.keys(next), next[l.id].time], [[l.id], "15:00"]);
  assert.deepEqual(await s.core.nextTimes([l.id], { date: d, guests: 3 }), { [l.id]: null });
  await s.db.run("UPDATE listings SET unlisted=true");
  assert.deepEqual(await s.core.nextTimes([l.id], {}), {}, "an unlisted offer is not found this way");
});

// ---- live streams ----------------------------------------------------------------------------------
async function hear(base, path) {
  const ctl = new AbortController(), r = await fetch(base + path, { signal: ctl.signal }), got = [];
  if (r.ok) (async () => { try { let buf = ""; for await (const c of r.body.pipeThrough(new TextDecoderStream())) { buf += c; const parts = buf.split("\n\n"); buf = parts.pop(); for (const p of parts) if (p.startsWith("data: ")) got.push(JSON.parse(p.slice(6))); } } catch {} })();
  return { status: r.status, got, types: () => got.map((x) => x.t), until: async (fn, ms = 4000) => { for (let i = 0; i < ms / 50; i++) { if (got.some(fn)) return true; await settle(50); } return false; }, stop: () => ctl.abort() };
}

test("open pages hear about places, offers, bookings and totals, and nothing personal", async () => {
  const s = await serve(), h = await s.core.createHost("Rustam"), l = await s.publishListing(h.key);
  const all = await hear(s.base, "/api/live"), one = await hear(s.base, `/api/listings/${l.id}/live`);
  const b = await s.core.book(req(l)), mine = await hear(s.base, `/api/bookings/${b.token}/live`);
  assert.ok(await all.until((x) => x.t === "slots" && x.ids.includes(l.id)));
  assert.ok(await one.until((x) => x.t === "slots"));
  await s.payTest(b.token);
  assert.ok(await mine.until((x) => x.t === "booking"));
  assert.ok(await all.until((x) => x.t === "numbers"));
  const n = mine.got.length;
  await s.core.decide(h.key, await s.core.bookingId(b.token), true);
  assert.ok(await mine.until((x) => mine.got.indexOf(x) >= n && x.t === "booking"));
  await s.core.updateListing(h.key, l.id, { price_uzs: 170000 });
  assert.ok(await all.until((x) => x.t === "catalog"));
  assert.ok(await one.until((x) => x.t === "listing"));
  const said = JSON.stringify([all.got, one.got, mine.got]);
  for (const secret of ["Li Wei", b.token, "170000", await s.core.bookingId(b.token)]) assert.ok(!said.includes(secret), secret);
  for (const p of ["/api/listings/nope/live", "/api/bookings/nope/live"]) assert.equal((await fetch(s.base + p)).status, 404);
  for (const x of [all, one, mine]) x.stop();
  await settle(200);
  assert.equal(s.live.count(), 0, "closed pages are forgotten");
});

test("an unlisted offer is announced only to those who have it open", async () => {
  const s = await serve(), h = await s.core.createHost("Rustam"), l = await s.publishListing(h.key);
  await s.db.run("UPDATE listings SET unlisted=true");
  await settle(700); // what was announced while it was still listed
  const all = await hear(s.base, "/api/live"), one = await hear(s.base, `/api/listings/${l.id}/live`);
  await s.core.book(req(l));
  await s.core.updateListing(h.key, l.id, { capacity: 6 });
  assert.ok(await one.until((x) => x.t === "listing"));
  await settle(700);
  assert.ok(!all.got.some((x) => ["slots", "catalog"].includes(x.t)));
  for (const x of [all, one]) x.stop();
});

test("one visitor cannot use up the streams", async () => {
  const s = await serve(), open = [];
  for (let i = 0; i < 40; i++) open.push(await hear(s.base, "/api/live"));
  assert.ok(open.every((x) => x.status === 200));
  assert.equal((await fetch(s.base + "/api/live")).status, 429);
  open[0].stop();
  await settle(200);
  const again = await hear(s.base, "/api/live");
  assert.equal(again.status, 200);
  for (const x of [...open, again]) x.stop();
});

test("many changes at once become one announcement", async () => {
  const live = createLive({ gather: 40, slow: 40 }), out = [], res = { writeHead() {}, write: (t) => out.push(t), on() {}, writableLength: 0 };
  live.open(res, "all", "1");
  for (let i = 0; i < 100; i++) { live.slots(`l_${i % 3}`, true); live.numbers(); }
  await settle(150);
  assert.deepEqual(out.map((t) => JSON.parse(t.slice(6)).t).sort(), ["hello", "numbers", "slots"]);
});

// ---- waiting list ----------------------------------------------------------------------------------
async function full() {
  const sent = [], s = await serve({ env: { ...MAIL, ADMIN_KEY: "k".repeat(30) }, mailer: { sendMail: async (m) => { sent.push(m); }, close() {} } });
  const h = await s.core.createHost("Rustam"), l = await s.publishListing(h.key), b = await s.core.book(req(l, { guests: 4 }));
  await s.payTest(b.token);
  await s.mail.work();
  sent.length = 0;
  return { s, h, l, b, sent, join: (o) => s.core.joinWaitlist(l.id, { date: day(2), time: "10:00", guests: 2, email: "a@example.com", lang: "de", ...o }) };
}

test("waiting list: first come, first served, one message each, only while places are free", async () => {
  const { s, l, b, sent, join } = await full();
  await join();
  await join({ guests: 1 }); // the same person again changes the wish
  await join({ guests: 2, email: "b@example.com" });
  await join({ guests: 4, email: "c@example.com" });
  assert.equal((await s.db.one("SELECT COUNT(*) n FROM waitlist")).n, 3);
  assert.equal(await s.openings(), 0, "still full");
  await s.core.cancel(b.token);
  assert.equal(await s.openings(), 2, "4 places: 1 + 2 fit, the group of 4 does not");
  assert.equal(await s.openings(), 0, "nobody is written to twice, and offered places are not offered again");
  await s.mail.work();
  assert.deepEqual(sent.map((m) => m.to).sort(), ["a@example.com", "b@example.com"]);
  assert.ok(sent[0].text.includes(UI.waitHurry.de) && sent[0].text.includes(`/?l=${l.id}&date=${day(2)}`) && /\/\?leave=[\w-]{32}/.test(sent[0].text));
  await s.db.run("UPDATE waitlist SET notified_at = now() - interval '3 hours' WHERE notified_at IS NOT NULL");
  assert.equal(await s.openings(), 1, "unused places go to the next in line");
});

test("waiting list: refuses what makes no sense, limits one address, and forgets", async () => {
  const { s, h, l, join } = await full();
  await assert.rejects(join({ time: "15:00" }), { code: "open" });
  for (const bad of [{ email: "" }, { email: "x" }, { guests: 0 }, { guests: 99 }, { date: day(-1) }, { date: day(90) }, { date: "x" }]) await status(join(bad), 400);
  await status(join({ time: "11:11" }), 409);
  await status(s.core.joinWaitlist("nope", {}), 404);
  await join();
  const { token } = await s.db.one("SELECT token FROM waitlist");
  assert.deepEqual(await s.core.leaveWaitlist(token), { ok: true });
  await status(s.core.leaveWaitlist(token), 404);
  for (let i = 0; i < 12; i++) { const d = day(3 + i); await s.core.setSlot(h.key, l.id, { date: d, time: "10:00", capacity: 0 }); assert.deepEqual(await join({ date: d }), { ok: true }); }
  assert.equal((await s.db.one("SELECT COUNT(*) n FROM waitlist")).n, 10);
  await s.db.run("UPDATE waitlist SET date = date - 100");
  await s.core.cleanWaitlist();
  assert.equal((await s.db.one("SELECT COUNT(*) n FROM waitlist")).n, 0);
});

test("the provider sees how many wait, as numbers, and can open places with one tap", async () => {
  const { s, h, join } = await full();
  await join();
  await join({ email: "b@example.com" });
  const brief = await s.core.assistantBrief(h.key), task = brief.tasks.find((x) => /kutmoqda: /.test(x.text));
  assert.match(task.text, /^4 kishi joy kutmoqda/);
  assert.ok(!JSON.stringify(brief).includes("example.com"));
  assert.equal(task.actions.length, 1);
  await s.core.assistantApply(h.key, task.actions[0].action ?? task.actions[0]);
  assert.equal(await s.openings(), 2);
});

test("waiting over HTTP: needs mail, is limited, and opening the link changes nothing", async () => {
  const off = await serve(), h0 = await off.core.createHost("R"), l0 = await off.publishListing(h0.key);
  assert.equal((await off.post(`/api/listings/${l0.id}/waitlist`, { date: day(2), time: "10:00", guests: 1, email: "a@example.com" })).status, 404);
  const { s, l } = await full(), codes = [];
  for (let i = 0; i < 5; i++) codes.push((await s.post(`/api/listings/${l.id}/waitlist`, { date: day(2), time: "10:00", guests: 1, email: "a@example.com", lang: "en" })).status);
  assert.deepEqual([codes[0], codes.at(-1)], [200, 429]);
  const { token } = await s.db.one("SELECT token FROM waitlist");
  assert.equal((await fetch(`${s.base}/?leave=${token}`)).status, 200);
  assert.equal((await s.db.one("SELECT COUNT(*) n FROM waitlist")).n, 1);
  assert.equal((await s.post(`/api/waitlist/${token}/leave`, {})).status, 200);
  assert.equal((await s.db.one("SELECT COUNT(*) n FROM waitlist")).n, 0);
});

test("a suspended provider disappears from open pages at once", async () => {
  const s = await serve({ env: { ADMIN_KEY: "k".repeat(30) } }), h = await s.core.createHost("Rustam");
  await s.publishListing(h.key);
  const all = await hear(s.base, "/api/live");
  await s.admin.suspendHost(h.id, true);
  assert.ok(await all.until((x) => x.t === "catalog"));
  all.stop();
});
