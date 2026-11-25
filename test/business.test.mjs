import test from "node:test";
import assert from "node:assert/strict";
import { cleanTicketCode } from "../src/domain/bookings.mjs";
import { effectivePlan, PLANS, split } from "../src/domain/plans.mjs";
import { day, serve, setup as full, status } from "./helpers.mjs";

const DAY = 864e5;
const SAY = (cap = 4, price = "yuz ellik") => `Rishtonda kulolman, ikki soat, ${price} ming so'm, ${cap} kishi`;
async function setup() {
  const s = await full();
  await s.hotel();
  const book = (l, o) => s.book(o);
  return { ...s, book, confirm: (l, o) => s.confirm(o), add: (key = s.host.key, say = SAY()) => s.publishListing(key, say) };
}

test("provider type is stored, shown to travellers, and validated", async () => {
  const { core, l } = await setup();
  assert.equal((await core.listing(l.id)).host_type, "artisan");
  assert.equal((await core.hostHome((await core.createHost("Uy", { type: "guesthouse" })).key)).type, "guesthouse");
  await status(() => core.createHost("X", { type: "constructor" }), 400);
});

// ---- tickets --------------------------------------------------------------------------------------
test("ticket: issued on confirmation, valid only on the day, works once", async () => {
  const { payTest, db, core, host, l, book, confirm } = await setup();
  const pending = await book(l);
  await payTest(pending.token);
  assert.equal((await core.guestBooking(pending.token)).ticket, null);
  await core.decide(host.key, (await core.hostHome(host.key)).bookings[0].id, true);
  const { code } = (await core.guestBooking(pending.token)).ticket;
  assert.match(code, /^[0-9A-F]{12}$/);
  assert.equal((await core.ticket(host.key, code)).state, "early");
  await status(() => core.checkIn(host.key, code), 409);
  const move = (d) => db.run("UPDATE bookings SET date=? WHERE ticket_code=?", d, code);
  await move(day(-1));
  assert.equal((await core.ticket(host.key, code)).state, "late");
  await move(day(0));
  assert.equal((await core.checkIn(host.key, code)).state, "used");
  await status(() => core.checkIn(host.key, code), 409);
  assert.equal((await core.guestBooking(pending.token)).can_review, true, "a checked-in guest can review");
  assert.notEqual((await confirm(l, { date: day(3) })).ticket.code, code);
});

test("ticket: typed with dashes or spaces works; another provider learns nothing", async () => {
  const { core, host, l, confirm } = await setup();
  const { code } = (await confirm(l)).ticket;
  assert.equal((await core.ticket(host.key, code.toLowerCase().replace(/(.{4})/g, "$1- "))).guest_name, "Li Wei");
  assert.equal(cleanTicketCode("<script>"), "C"); // never reaches the 12 characters a lookup needs
  const other = await core.createHost("Boshqa");
  const get = async (k, c) => { try { await core.ticket(k, c); } catch (e) { return [e.status, e.message]; } };
  assert.deepEqual(await get(other.key, code), await get(other.key, "000000000000"));
  await status(() => core.checkIn(other.key, code), 404);
  await status(() => core.ticket("", code), 401);
  await status(() => core.ticket(host.key, ""), 404);
});

test("ticket: a cancelled booking has no valid ticket, and hosts cannot read codes from their list", async () => {
  const { core, host, l, confirm } = await setup();
  const b = await confirm(l, { date: day(5) });
  assert.ok(!JSON.stringify(await core.hostHome(host.key)).includes(b.ticket.code));
  await core.cancel(b.token);
  assert.equal((await core.guestBooking(b.token)).ticket, null);
  assert.equal((await core.ticket(host.key, b.ticket.code)).state, "void");
  await status(() => core.checkIn(host.key, b.ticket.code), 409);
});

// ---- slot control ---------------------------------------------------------------------------------
test("slot control: close, shrink, enlarge and reset one time without touching bookings", async () => {
  const { core, host, l, book } = await setup();
  const free = async () => (await core.availability(l.id, day(2), 1))[0].times.find((t) => t.time === "10:00").free;
  const set = (capacity) => core.setSlot(host.key, l.id, { date: day(2), time: "10:00", capacity });
  const b = await book(l);
  assert.equal(await free(), 2);
  await set(0);
  assert.equal(await free(), 0);
  assert.equal((await core.guestBooking(b.token)).status, "pending");
  await status(() => book(l, { guests: 1 }), 409);
  await set(8);
  assert.equal(await free(), 6);
  await book(l, { guests: 6 }); // more than the usual 4, allowed because this slot was enlarged
  await status(() => book(l, { date: day(3), guests: 6 }), 400);
  const s = (await set(1)).slots.find((x) => x.time === "10:00");
  assert.deepEqual([s.booked, s.capacity, s.changed], [8, 1, true]);
  assert.equal(await free(), 0);
  assert.equal((await set(null)).slots[0].changed, false);
});

test("slot control is validated and private", async () => {
  const { core, host, l } = await setup();
  const bad = (o, s = 400) => status(() => core.setSlot(host.key, l.id, { date: day(2), time: "10:00", capacity: 2, ...o }), s);
  await bad({ date: day(-1) });
  await bad({ date: "2026-02-31" });
  await bad({ time: "11:00" });
  await bad({ capacity: 101 });
  await bad({ capacity: -1 });
  await bad({ capacity: 1.5 });
  await bad({ capacity: undefined });
  const other = await core.createHost("Boshqa");
  await status(() => core.slotCalendar(other.key, l.id), 404);
  const days = (await core.slotCalendar(host.key, l.id, day(1), 3)).days;
  assert.deepEqual(days.map((d) => [d.date, d.slots.length]), [1, 2, 3].map((n) => [day(n), 2]));
  await status(() => core.setSlot(other.key, l.id, { date: day(2), time: "10:00", capacity: 0 }), 404);
});

test("a draft with slot rules can still be deleted", async () => {
  const { core, host } = await setup();
  const d = await core.createDraft(host.key, SAY());
  await core.setSlot(host.key, d.id, { date: day(2), time: "10:00", capacity: 1 });
  await core.deleteDraft(host.key, d.id);
});

// ---- plans ----------------------------------------------------------------------------------------
test("free plan sells up to three listings; pausing one makes room", async () => {
  const { subscribeTest, core, host, l, add } = await setup();
  await add();
  await add();
  await assert.rejects(() => add(), (e) => e.status === 409 && e.code === "plan");
  await core.pause(host.key, l.id);
  await add();
  await subscribeTest(host.key, "pro");
  await core.publish(host.key, l.id);
});

test("commission follows the plan, only for new bookings, and always adds up", async () => {
  const { subscribeTest, core, host, l, book } = await setup();
  const before = await book(l);
  await subscribeTest(host.key, "pro");
  assert.equal((await book(l, { date: day(3) })).platform_uzs, 24_000);
  await subscribeTest(host.key, "business");
  const hotel = await book(l, { date: day(4), hotel_code: "x" });
  assert.deepEqual([hotel.platform_uzs, hotel.hotel_uzs, hotel.host_uzs], [18_000, 24_000, 258_000]);
  assert.equal((await core.guestBooking(before.token)).platform_uzs, 36_000);
  for (const p of Object.keys(PLANS)) for (const c of ["web", "hotel", "ai"]) { const s = split(333_333, c, p); assert.equal(s.platform + s.hotel + s.host, 333_333); }
});

test("plans: extend adds 30 days, upgrade credits unused days, downgrade waits, expiry is automatic", async () => {
  const { subscribeTest, db, core, host } = await setup();
  await status(() => subscribeTest(host.key, "free"), 400);
  await status(() => subscribeTest(host.key, "constructor"), 400);
  await subscribeTest(host.key, "pro");
  const first = +new Date((await core.plans(host.key)).current.until);
  await subscribeTest(host.key, "pro");
  assert.equal(+new Date((await core.plans(host.key)).current.until) - first, 30 * DAY);
  await db.run("UPDATE hosts SET plan_until=? WHERE id=?", new Date(Date.now() + 15 * DAY).toISOString(), host.id);
  const offer = (await core.plans(host.key)).options.find((o) => o.id === "business").offer;
  assert.ok(Math.abs(offer.credit - PLANS.pro.price / 2) <= 1);
  assert.equal(offer.amount + offer.credit, PLANS.business.price);
  await subscribeTest(host.key, "business");
  await status(() => subscribeTest(host.key, "pro"), 409);
  assert.equal((await core.plans(host.key)).invoices.length, 3);
  await db.run("UPDATE hosts SET plan_until=? WHERE id=?", new Date(Date.now() - 1).toISOString(), host.id);
  assert.equal((await core.plans(host.key)).current.plan, "free");
  assert.equal(effectivePlan({ plan: "pro", plan_until: null }), "free");
});

test("an upgrade never costs less than zero", async () => {
  const { subscribeTest, core, host } = await setup();
  for (let i = 0; i < 12; i++) await subscribeTest(host.key, "pro"); // a year of Pro is worth more than a month of Business
  const { amount, credit } = (await core.plans(host.key)).options.find((o) => o.id === "business").offer;
  assert.deepEqual([amount, credit], [0, PLANS.business.price]);
});

// ---- analytics ------------------------------------------------------------------------------------
test("analytics: totals match bookings, series matches totals, other providers are excluded", async () => {
  const { payTest, db, core, host, l, add, book, confirm } = await setup();
  const other = await core.createHost("Boshqa");
  const foreign = await add(other.key);
  const f = await core.book({ listing_id: foreign.id, date: day(2), time: "10:00", guests: 4, guest_name: "Z", lang: "en" });
  await payTest(f.token);
  for (let i = 0; i < 5; i++) await core.view(l.id, "de");
  await confirm(l);
  await confirm(l, { date: day(3), hotel_code: "x", lang: "de" });
  await core.cancel((await confirm(l, { date: day(6) })).token);
  const waiting = await book(l, { date: day(4) });
  await payTest(waiting.token);
  await book(l, { date: day(7) }); // never paid: not a sale
  const a = await core.analytics(host.key, 30), t = a.totals;
  assert.deepEqual([t.bookings, t.gross, t.earned, t.fees, t.expected], [2, 600_000, 504_000, 96_000, 264_000]);
  assert.deepEqual([t.cancelled, t.views, t.conversion, t.average], [1, 5, 3 / 5, 300_000]);
  assert.equal(a.series.reduce((s, x) => s + x.earned, 0), t.earned);
  assert.equal(a.series.at(-1).to, day(0));
  await db.run("UPDATE bookings SET created_at=? WHERE status='confirmed'", new Date(Date.now() - 45 * DAY).toISOString());
  const later = await core.analytics(host.key, 30);
  assert.deepEqual([later.totals.earned, later.previous.earned], [0, 504_000]);
});

test("analytics: free plan gets 30 days and no breakdown; Pro gets everything without guest names", async () => {
  const { subscribeTest, core, host, l, confirm } = await setup();
  await confirm(l, { lang: "de" });
  const free = await core.analytics(host.key, 365);
  assert.deepEqual([free.days, free.listings, free.channels, free.rows], [30, null, null, null]);
  await subscribeTest(host.key, "pro");
  for (const [d, n] of [[30, 30], [90, 13], [365, 13]]) {
    const a = await core.analytics(host.key, d);
    assert.equal(a.series.length, n);
    assert.equal(a.series.reduce((s, x) => s + x.earned, 0), a.totals.earned);
  }
  const a = await core.analytics(host.key, 365);
  assert.deepEqual([a.channels[0].key, a.languages[0].key, a.listings[0].bookings, a.rows.length], ["web", "de", 1, 1]);
  assert.ok(a.listings[0].fill > 0);
  assert.ok(!JSON.stringify(a).includes("Li Wei"));
});

// ---- intelligence ---------------------------------------------------------------------------------
test("intelligence: Business only, and prices need at least three other listings", async () => {
  const { subscribeTest, core, host, add } = await setup();
  await status(() => core.intelligence(host.key), 403);
  await subscribeTest(host.key, "pro");
  await status(() => core.intelligence(host.key), 403);
  await subscribeTest(host.key, "business");
  const others = await Promise.all([100, 200, 300].map(async (p, i) => [await core.createHost("H" + i), p]));
  for (const [h, p] of others.slice(0, 2)) await add(h.key, SAY(4, p));
  assert.equal((await core.intelligence(host.key)).prices[0].median, null);
  await add(others[2][0].key, SAY(4, 300));
  const p = (await core.intelligence(host.key)).prices[0];
  assert.deepEqual([p.low, p.median, p.high, p.sample], [100_000, 200_000, 300_000, 3]);
  await core.search({ region: "surxondaryo", category: "wood", lang: "ko" });
  const m = await core.intelligence(host.key);
  assert.equal(m.unmet.categories[0].k, "wood");
  assert.ok(m.tips.some((t) => t.includes("past")) && m.tips.some((t) => t.includes("Surxondaryo")));
  assert.ok(!/H0|H1|H2/.test(JSON.stringify(m)), "no competitor names");
});

// ---- HTTP -----------------------------------------------------------------------------------------
test("HTTP: views count once per visitor, test payments can be off, platform income is hidden", async () => {
  const a = await serve(), h = await a.core.createHost("V"), head = { "X-Host-Key": h.key };
  const l = await a.publishListing(h.key);
  for (const q of ["?lang=en", "?lang=de", ""]) await a.get(`/api/listings/${l.id}${q}`);
  assert.equal((await a.core.analytics(h.key)).totals.views, 1);
  assert.equal((await fetch(`${a.base}/api/host/tickets/ABCDEF012345`, { headers: head })).status, 404);
  assert.equal((await fetch(`${a.base}/api/host/analytics`)).status, 401);
  assert.deepEqual(await (await a.post("/api/host/plans/pro/pay", { method: "test" }, head)).json(), { done: true });
  assert.equal((await a.get("/api/panel")).platform.mrr, PLANS.pro.price);
  const b = await serve({ db: a.db, env: { NODE_ENV: "production" } });
  assert.equal((await b.post("/api/host/plans/business/pay", { method: "test" }, head)).status, 400);
  assert.equal((await b.get("/api/panel")).platform, undefined);
});
