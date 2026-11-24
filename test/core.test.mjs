import test from "node:test";
import assert from "node:assert/strict";

process.env.MEZBON_OFFLINE = "1";
const { openDb } = await import("../src/db.mjs");
const { createCore, split, tashkentNow } = await import("../src/core.mjs");
const { createBot } = await import("../src/telegram.mjs");
const { LANGS, CATEGORIES, PHRASES, REGION_NAMES, REGIONS, UI } = await import("../src/i18n.mjs");

const SAY = "Rishtonda kulolman, ikki soat, yuz ellik ming so'm, 4 kishi";
const day = (n) => tashkentNow(new Date(Date.now() + n * 864e5)).slice(0, 10);

async function setup(say = SAY) {
  const events = [], db = openDb(":memory:");
  const core = createCore(db, { notify: (h, e) => events.push([h, e]) });
  const host = core.createHost("Rustam");
  db.prepare("INSERT INTO hotels VALUES ('x','X','fargona')").run();
  let l = await core.createDraft(host.key, say);
  l = core.updateListing(host.key, l.id, { weekdays: [1, 2, 3, 4, 5, 6, 7] });
  return { db, core, host, l, events };
}
const freeAt = (core, l, n) => core.availability(l.id, day(n), 1)[0].times.find((t) => t.time === "10:00").free;
const req = (l, o = {}) => ({ listing_id: l.id, date: day(2), time: "10:00", guests: 2, guest_name: "Li", lang: "zh", ...o });
const status = (fn, s) => assert.throws(fn, (e) => { assert.equal(e.status, s, e.message); return true; });

test("all strings exist in all languages", () => {
  assert.deepEqual(Object.keys(REGION_NAMES), Object.keys(REGIONS));
  for (const set of [CATEGORIES, PHRASES, REGION_NAMES, UI]) for (const [k, v] of Object.entries(set)) for (const l of LANGS) assert.ok(v[l], `${k}.${l}`);
});

test("split always adds up", () => {
  for (const c of ["web", "hotel", "ai"]) for (const t of [1000, 333333, 150001]) { const s = split(t, c); assert.equal(s.platform + s.hotel + s.host, t); }
  assert.deepEqual(split(300000, "hotel"), { total: 300000, platform: 36000, hotel: 24000, host: 240000 });
});

test("a draft is invisible until published, and has 10 languages", async () => {
  const { core, host, l } = await setup();
  assert.equal(core.search({}).length, 0);
  status(() => core.book(req(l)), 404);
  core.publish(host.key, l.id);
  assert.equal(core.search({})[0].id, l.id);
  assert.equal(Object.keys(l.i18n).length, 10);
});

test("missing facts and uncertified tours cannot be published", async () => {
  const a = await setup("Men somsa pishiraman");
  status(() => a.core.publish(a.host.key, a.l.id), 409);
  const b = await setup("Samarqandda ekskursiya, 2 soat, 100 ming so'm, 5 kishi");
  assert.deepEqual(b.l.missing.map((m) => m.field), ["cert_no"]);
  status(() => b.core.publish(b.host.key, b.l.id), 409);
  b.core.updateListing(b.host.key, b.l.id, { cert_no: "G-1" });
  b.core.publish(b.host.key, b.l.id);
});

test("a host cannot touch another host's listing or booking", async () => {
  const { core, host, l } = await setup();
  core.publish(host.key, l.id);
  const other = core.createHost("Boshqa");
  status(() => core.updateListing(other.key, l.id, { capacity: 1 }), 404);
  status(() => core.hostHome("xato"), 401);
  const b = core.book(req(l));
  core.payTest(b.token);
  const bid = core.hostHome(host.key).bookings[0].id;
  status(() => core.decide(other.key, bid, true), 404);
  await assert.rejects(core.message("host", other.key, { booking_id: bid, code: "r_yes" }), (e) => e.status === 404);
});

test("pay → host notified once → confirm; repeating a payment changes nothing", async () => {
  const { core, host, l, events } = await setup();
  core.publish(host.key, l.id);
  const b = core.book(req(l, { hotel_code: "x" }));
  assert.equal(b.channel, "hotel");
  assert.equal(core.hostHome(host.key).bookings.length, 0);
  core.payTest(b.token);
  core.payTest(b.token);
  assert.equal(events.length, 1);
  const hb = core.hostHome(host.key).bookings[0];
  core.decide(host.key, hb.id, true);
  assert.equal(core.guestBooking(b.token).status, "confirmed");
  status(() => core.decide(host.key, hb.id, false), 409);
});

test("capacity, schedule and date rules", async () => {
  const { db, core, host, l } = await setup();
  core.publish(host.key, l.id);
  core.book(req(l, { guests: 3 }));
  status(() => core.book(req(l)), 409);
  core.book(req(l, { guests: 1 }));
  assert.equal(freeAt(core, l, 2), 0);
  db.prepare("UPDATE bookings SET expires_at='2020-01-01T00:00:00Z'").run();
  assert.equal(freeAt(core, l, 2), 4);
  for (const o of [{ date: day(-1) }, { date: "2026-02-31" }, { date: "x" }, { date: day(400) }, { guests: 0 }, { guests: 5 }, { guests: 1.5 }, { guest_name: " " }]) status(() => core.book(req(l, o)), 400);
  status(() => core.book(req(l, { time: "11:00" })), 409);
  const closed = new Date(`${day(2)}T00:00:00Z`).getUTCDay() || 7;
  core.updateListing(host.key, l.id, { weekdays: [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== closed) });
  status(() => core.book(req(l)), 409);
});

test("an expired hold cannot be paid", async () => {
  const { db, core, host, l } = await setup();
  core.publish(host.key, l.id);
  const b = core.book(req(l));
  db.prepare("UPDATE bookings SET expires_at='2020-01-01T00:00:00Z'").run();
  status(() => core.payTest(b.token), 410);
  assert.equal(core.guestBooking(b.token).status, "expired");
});

test("chat: phrases translate exactly, free text offline is marked untranslated", async () => {
  const { core, host, l } = await setup();
  core.publish(host.key, l.id);
  const b = core.book(req(l));
  await assert.rejects(core.message("guest", b.token, { code: "q_children" }), (e) => e.status === 409);
  core.payTest(b.token);
  const m = await core.message("guest", b.token, { code: "q_children" });
  assert.equal(m[0].original, PHRASES.q_children.zh);
  assert.equal(m[0].translated, PHRASES.q_children.uz);
  const bid = core.hostHome(host.key).bookings[0].id;
  assert.equal((await core.message("host", host.key, { booking_id: bid, code: "r_yes" })).at(-1).translated, PHRASES.r_yes.zh);
  assert.equal((await core.message("guest", b.token, { text: "你好" })).at(-1).engine, "untranslated");
  await assert.rejects(core.message("guest", b.token, { code: "constructor" }), (e) => e.status === 400);
});

test("unmet demand is recorded and reported", async () => {
  const { core, host, l } = await setup();
  core.publish(host.key, l.id);
  for (const region of ["surxondaryo", "fargona", undefined, "'; DROP TABLE"]) core.search({ region });
  const r = Object.fromEntries(core.panel().regions.map((x) => [x.region, x]));
  assert.deepEqual([r.surxondaryo.unmet, r.fargona.unmet, r.fargona.searches], [1, 0, 1]);
});

test("a published listing keeps its required facts; template text follows the numbers", async () => {
  const { core, host, l } = await setup();
  core.publish(host.key, l.id);
  assert.match(core.updateListing(host.key, l.id, { capacity: 7 }).i18n.en.description, /up to 7/);
  status(() => core.updateListing(host.key, l.id, { category: "tour" }), 400);
  status(() => core.updateListing(host.key, l.id, { region: "constructor" }), 400);
});

test("telegram: asks for the gaps, then publishes", async () => {
  const core = createCore(openDb(":memory:")), out = [];
  const bot = createBot(core, async (c, t, kb) => out.push({ t, kb }));
  const say = (text) => bot({ message: { chat: { id: 7 }, from: { first_name: "Ali" }, text } });
  await say("/start");
  await say("Kulolman, ikki soat, 8 kishi");
  assert.match(out.at(-1).t, /viloyat/i);
  await say("Farg‘ona");
  assert.match(out.at(-1).t, /narx/i);
  await say("150 000");
  const button = out.at(-1).kb[0][0].callback_data;
  await bot({ callback_query: { data: button, from: {}, message: { chat: { id: 7 } } } });
  const [l] = core.search({});
  assert.deepEqual([l.price_uzs, l.host, l.region], [150000, "Ali", "fargona"]);
});
