import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MEZBON_OFFLINE = "1";
process.env.MEZBON_DATA = mkdtempSync(path.join(os.tmpdir(), "mezbon-"));
const { openDb } = await import("../src/db.mjs");
const { createCore, split, tashkentNow } = await import("../src/core.mjs");
const { PLANS, cleanTicketCode, effectivePlan } = await import("../src/business.mjs");
const { createApp } = await import("../src/server.mjs");

const DAY = 864e5;
const day = (n) => tashkentNow(new Date(Date.now() + n * DAY)).slice(0, 10);
const status = (fn, s) => assert.throws(fn, (e) => { assert.equal(e.status, s, e.message); return true; });
const SAY = (cap = 4, price = "yuz ellik") => `Rishtonda kulolman, ikki soat, ${price} ming so'm, ${cap} kishi`;

async function setup() {
  const db = openDb(":memory:"), core = createCore(db);
  db.prepare("INSERT INTO hotels VALUES ('x','X','fargona')").run();
  const host = core.createHost("Rustam");
  const add = async (key = host.key, say = SAY()) => {
    const l = await core.createDraft(key, say);
    core.updateListing(key, l.id, { weekdays: [1, 2, 3, 4, 5, 6, 7] });
    return core.publish(key, l.id);
  };
  const book = (l, o = {}) => core.book({ listing_id: l.id, date: day(2), time: "10:00", guests: 2, guest_name: "Li Wei", lang: "zh", ...o });
  const confirm = (l, o) => {
    const b = book(l, o);
    core.payTest(b.token);
    core.decide(host.key, core.hostHome(host.key).bookings.find((x) => x.status === "paid").id, true);
    return core.guestBooking(b.token);
  };
  return { db, core, host, add, book, confirm, l: await add() };
}

// ---- provider types -------------------------------------------------------------------------------
test("provider type is stored, shown to travellers, and validated", async () => {
  const { core, l } = await setup();
  assert.equal(core.listing(l.id).host_type, "artisan");
  assert.equal(core.hostHome(core.createHost("Uy", { type: "guesthouse" }).key).type, "guesthouse");
  status(() => core.createHost("X", { type: "constructor" }), 400);
});

// ---- tickets --------------------------------------------------------------------------------------
test("ticket: issued on confirmation, valid only on the day, works once", async () => {
  const { db, core, host, l, book, confirm } = await setup();
  const pending = book(l);
  core.payTest(pending.token);
  assert.equal(core.guestBooking(pending.token).ticket, null);
  core.decide(host.key, core.hostHome(host.key).bookings[0].id, true);
  const { code } = core.guestBooking(pending.token).ticket;
  assert.match(code, /^[0-9A-F]{12}$/);
  assert.equal(core.ticket(host.key, code).state, "early");
  status(() => core.checkIn(host.key, code), 409);
  const move = (d) => db.prepare("UPDATE bookings SET date=? WHERE ticket_code=?").run(d, code);
  move(day(-1));
  assert.equal(core.ticket(host.key, code).state, "late");
  move(day(0));
  assert.equal(core.checkIn(host.key, code).state, "used");
  status(() => core.checkIn(host.key, code), 409);
  assert.equal(core.guestBooking(pending.token).can_review, true, "a checked-in guest can review");
  assert.notEqual(confirm(l, { date: day(3) }).ticket.code, code);
});

test("ticket: typed with dashes or spaces works; another provider learns nothing", async () => {
  const { core, host, l, confirm } = await setup();
  const { code } = confirm(l).ticket;
  assert.equal(core.ticket(host.key, code.toLowerCase().replace(/(.{4})/g, "$1- ")).guest_name, "Li Wei");
  assert.equal(cleanTicketCode("<script>"), "C"); // never reaches the 12 characters a lookup needs
  const other = core.createHost("Boshqa");
  const get = (k, c) => { try { core.ticket(k, c); } catch (e) { return [e.status, e.message]; } };
  assert.deepEqual(get(other.key, code), get(other.key, "000000000000"));
  status(() => core.checkIn(other.key, code), 404);
  status(() => core.ticket("", code), 401);
  status(() => core.ticket(host.key, ""), 404);
});

test("ticket: a cancelled booking has no valid ticket, and hosts cannot read codes from their list", async () => {
  const { core, host, l, confirm } = await setup();
  const b = confirm(l, { date: day(5) });
  assert.ok(!JSON.stringify(core.hostHome(host.key)).includes(b.ticket.code));
  core.cancel(b.token);
  assert.equal(core.guestBooking(b.token).ticket, null);
  assert.equal(core.ticket(host.key, b.ticket.code).state, "void");
  status(() => core.checkIn(host.key, b.ticket.code), 409);
});

// ---- slot control ---------------------------------------------------------------------------------
test("slot control: close, shrink, enlarge and reset one time without touching bookings", async () => {
  const { core, host, l, book } = await setup();
  const free = () => core.availability(l.id, day(2), 1)[0].times.find((t) => t.time === "10:00").free;
  const set = (capacity) => core.setSlot(host.key, l.id, { date: day(2), time: "10:00", capacity });
  const b = book(l);
  assert.equal(free(), 2);
  set(0);
  assert.equal(free(), 0);
  assert.equal(core.guestBooking(b.token).status, "pending");
  status(() => book(l, { guests: 1 }), 409);
  set(8);
  assert.equal(free(), 6);
  book(l, { guests: 6 }); // more than the usual 4, allowed because this slot was enlarged
  status(() => book(l, { date: day(3), guests: 6 }), 400);
  const s = set(1).slots.find((x) => x.time === "10:00");
  assert.deepEqual([s.booked, s.capacity, s.changed], [8, 1, true]);
  assert.equal(free(), 0);
  assert.equal(set(null).slots[0].changed, false);
});

test("slot control is validated and private", async () => {
  const { core, host, l } = await setup();
  const bad = (o, s = 400) => status(() => core.setSlot(host.key, l.id, { date: day(2), time: "10:00", capacity: 2, ...o }), s);
  bad({ date: day(-1) });
  bad({ date: "2026-02-31" });
  bad({ time: "11:00" });
  bad({ capacity: 101 });
  bad({ capacity: -1 });
  bad({ capacity: 1.5 });
  bad({ capacity: undefined });
  const other = core.createHost("Boshqa");
  status(() => core.slotCalendar(other.key, l.id), 404);
  const days = core.slotCalendar(host.key, l.id, day(1), 3).days;
  assert.deepEqual(days.map((d) => [d.date, d.slots.length]), [1, 2, 3].map((n) => [day(n), 2]));
  status(() => core.setSlot(other.key, l.id, { date: day(2), time: "10:00", capacity: 0 }), 404);
});

test("a draft with slot rules can still be deleted", async () => {
  const { core, host } = await setup();
  const d = await core.createDraft(host.key, SAY());
  core.setSlot(host.key, d.id, { date: day(2), time: "10:00", capacity: 1 });
  core.deleteDraft(host.key, d.id);
});

// ---- plans ----------------------------------------------------------------------------------------
test("free plan sells up to three listings; pausing one makes room", async () => {
  const { core, host, l, add } = await setup();
  await add();
  await add();
  await assert.rejects(add(), (e) => e.status === 409 && e.code === "plan");
  core.pause(host.key, l.id);
  await add();
  core.subscribeTest(host.key, "pro");
  core.publish(host.key, l.id);
});

test("commission follows the plan, only for new bookings, and always adds up", async () => {
  const { core, host, l, book } = await setup();
  const before = book(l);
  core.subscribeTest(host.key, "pro");
  assert.equal(book(l, { date: day(3) }).platform_uzs, 24_000);
  core.subscribeTest(host.key, "business");
  const hotel = book(l, { date: day(4), hotel_code: "x" });
  assert.deepEqual([hotel.platform_uzs, hotel.hotel_uzs, hotel.host_uzs], [18_000, 24_000, 258_000]);
  assert.equal(core.guestBooking(before.token).platform_uzs, 36_000);
  for (const p of Object.keys(PLANS)) for (const c of ["web", "hotel", "ai"]) { const s = split(333_333, c, p); assert.equal(s.platform + s.hotel + s.host, 333_333); }
});

test("plans: extend adds 30 days, upgrade credits unused days, downgrade waits, expiry is automatic", async () => {
  const { db, core, host } = await setup();
  status(() => core.subscribeTest(host.key, "free"), 400);
  status(() => core.subscribeTest(host.key, "constructor"), 400);
  core.subscribeTest(host.key, "pro");
  const first = +new Date(core.plans(host.key).current.until);
  core.subscribeTest(host.key, "pro");
  assert.equal(+new Date(core.plans(host.key).current.until) - first, 30 * DAY);
  db.prepare("UPDATE hosts SET plan_until=? WHERE id=?").run(new Date(Date.now() + 15 * DAY).toISOString(), host.id);
  const offer = core.plans(host.key).options.find((o) => o.id === "business").offer;
  assert.ok(Math.abs(offer.credit - PLANS.pro.price / 2) <= 1);
  assert.equal(offer.amount + offer.credit, PLANS.business.price);
  core.subscribeTest(host.key, "business");
  status(() => core.subscribeTest(host.key, "pro"), 409);
  assert.equal(core.plans(host.key).invoices.length, 3);
  db.prepare("UPDATE hosts SET plan_until=? WHERE id=?").run(new Date(Date.now() - 1).toISOString(), host.id);
  assert.equal(core.plans(host.key).current.plan, "free");
  assert.equal(effectivePlan({ plan: "pro", plan_until: null }), "free");
});

test("an upgrade never costs less than zero", async () => {
  const { core, host } = await setup();
  for (let i = 0; i < 12; i++) core.subscribeTest(host.key, "pro"); // a year of Pro is worth more than a month of Business
  const { amount, credit } = core.plans(host.key).options.find((o) => o.id === "business").offer;
  assert.deepEqual([amount, credit], [0, PLANS.business.price]);
});

// ---- analytics ------------------------------------------------------------------------------------
test("analytics: totals match bookings, series matches totals, other providers are excluded", async () => {
  const { db, core, host, l, add, book, confirm } = await setup();
  const other = core.createHost("Boshqa");
  const foreign = await add(other.key);
  const f = core.book({ listing_id: foreign.id, date: day(2), time: "10:00", guests: 4, guest_name: "Z", lang: "en" });
  core.payTest(f.token);
  for (let i = 0; i < 5; i++) core.view(l.id, "de");
  confirm(l);
  confirm(l, { date: day(3), hotel_code: "x", lang: "de" });
  core.cancel(confirm(l, { date: day(6) }).token);
  const waiting = book(l, { date: day(4) });
  core.payTest(waiting.token);
  book(l, { date: day(7) }); // never paid: not a sale
  const a = core.analytics(host.key, 30), t = a.totals;
  assert.deepEqual([t.bookings, t.gross, t.earned, t.fees, t.expected], [2, 600_000, 504_000, 96_000, 264_000]);
  assert.deepEqual([t.cancelled, t.views, t.conversion, t.average], [1, 5, 3 / 5, 300_000]);
  assert.equal(a.series.reduce((s, x) => s + x.earned, 0), t.earned);
  assert.equal(a.series.at(-1).to, day(0));
  db.prepare("UPDATE bookings SET created_at=? WHERE status='confirmed'").run(new Date(Date.now() - 45 * DAY).toISOString());
  const later = core.analytics(host.key, 30);
  assert.deepEqual([later.totals.earned, later.previous.earned], [0, 504_000]);
});

test("analytics: free plan gets 30 days and no breakdown; Pro gets everything without guest names", async () => {
  const { core, host, l, confirm } = await setup();
  confirm(l, { lang: "de" });
  const free = core.analytics(host.key, 365);
  assert.deepEqual([free.days, free.listings, free.channels, free.rows], [30, null, null, null]);
  core.subscribeTest(host.key, "pro");
  for (const [d, n] of [[30, 30], [90, 13], [365, 13]]) {
    const a = core.analytics(host.key, d);
    assert.equal(a.series.length, n);
    assert.equal(a.series.reduce((s, x) => s + x.earned, 0), a.totals.earned);
  }
  const a = core.analytics(host.key, 365);
  assert.deepEqual([a.channels[0].key, a.languages[0].key, a.listings[0].bookings, a.rows.length], ["web", "de", 1, 1]);
  assert.ok(a.listings[0].fill > 0);
  assert.ok(!JSON.stringify(a).includes("Li Wei"));
});

// ---- intelligence ---------------------------------------------------------------------------------
test("intelligence: Business only, and prices need at least three other listings", async () => {
  const { core, host, add } = await setup();
  status(() => core.intelligence(host.key), 403);
  core.subscribeTest(host.key, "pro");
  status(() => core.intelligence(host.key), 403);
  core.subscribeTest(host.key, "business");
  const others = [100, 200, 300].map((p, i) => [core.createHost("H" + i), p]);
  for (const [h, p] of others.slice(0, 2)) await add(h.key, SAY(4, p));
  assert.equal(core.intelligence(host.key).prices[0].median, null);
  await add(others[2][0].key, SAY(4, 300));
  const p = core.intelligence(host.key).prices[0];
  assert.deepEqual([p.low, p.median, p.high, p.sample], [100_000, 200_000, 300_000, 3]);
  core.search({ region: "surxondaryo", category: "wood", lang: "ko" });
  const m = core.intelligence(host.key);
  assert.equal(m.unmet.categories[0].k, "wood");
  assert.ok(m.tips.some((t) => t.includes("past")) && m.tips.some((t) => t.includes("Surxondaryo")));
  assert.ok(!/H0|H1|H2/.test(JSON.stringify(m)), "no competitor names");
});

// ---- HTTP -----------------------------------------------------------------------------------------
test("HTTP: views count once per visitor, subscriptions are off with test payments, platform income is hidden", async () => {
  const db = openDb();
  const serve = async (o) => {
    const { server, core } = createApp(db, { telegram: null, ...o });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { core, server, base: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } };
  };
  const a = await serve(), h = a.core.createHost("V"), head = { "X-Host-Key": h.key, "Content-Type": "application/json" };
  const l = await a.core.createDraft(h.key, SAY());
  a.core.publish(h.key, l.id);
  for (const q of ["?lang=en", "?lang=de", ""]) await fetch(`${a.base}/api/listings/${l.id}${q}`);
  assert.equal(a.core.analytics(h.key).totals.views, 1);
  assert.equal((await fetch(`${a.base}/api/host/tickets/ABCDEF012345`, { headers: head })).status, 404);
  assert.equal((await fetch(`${a.base}/api/host/analytics`)).status, 401);
  assert.equal((await (await fetch(`${a.base}/api/host/plans/pro/subscribe-test`, { method: "POST", headers: head, body: "{}" })).json()).current.plan, "pro");
  assert.equal((await (await fetch(a.base + "/api/panel")).json()).platform.mrr, PLANS.pro.price);
  const b = await serve({ testPayments: false });
  assert.equal((await fetch(`${b.base}/api/host/plans/business/subscribe-test`, { method: "POST", headers: head, body: "{}" })).status, 403);
  assert.equal((await (await fetch(b.base + "/api/panel")).json()).platform, undefined);
  a.close();
  b.close();
  db.close();
});
