import test from "node:test";
import assert from "node:assert/strict";
import { createBot } from "../src/adapters/telegram.mjs";
import { createDomain } from "../src/domain/index.mjs";
import { split } from "../src/domain/plans.mjs";
import { CATEGORIES, LANGS, PHRASES, PROVIDER_TYPES, REGION_NAMES, REGIONS, UI } from "../src/lib/i18n.mjs";
import { day, freeAt, freshDb, req, settle, setup as full, status, testConfig } from "./helpers.mjs";

const setup = async (say) => { const s = await full({ publish: false, ...(say && { say }) }); await s.hotel(); return s; };

test("all strings exist in all languages", () => {
  assert.deepEqual(Object.keys(REGION_NAMES), Object.keys(REGIONS));
  for (const set of [CATEGORIES, PHRASES, PROVIDER_TYPES, REGION_NAMES, UI]) for (const [k, v] of Object.entries(set)) for (const l of LANGS) assert.ok(v[l], `${k}.${l}`);
});

test("split always adds up", () => {
  for (const c of ["web", "hotel", "ai", "widget", "partner"]) for (const t of [1000, 333333, 150001]) for (const pct of [0, 10, 25]) { const s = split(t, c, "free", c === "partner" ? pct : 0); assert.equal(s.platform + s.hotel + s.partner + s.host, t); assert.ok(s.host >= 0); }
  assert.deepEqual(split(300000, "hotel"), { total: 300000, platform: 36000, hotel: 24000, partner: 0, host: 240000 });
  assert.deepEqual(split(300000, "partner", "free", 10), { total: 300000, platform: 36000, hotel: 0, partner: 30000, host: 234000 });
});

test("a draft is invisible until published, and has 10 languages", async () => {
  const { core, host, l } = await setup();
  assert.equal((await core.search({})).length, 0);
  await status(() => core.book(req(l)), 404);
  await core.publish(host.key, l.id);
  assert.equal((await core.search({}))[0].id, l.id);
  assert.equal(Object.keys(l.i18n).length, 10);
});

test("missing facts and uncertified tours cannot be published", async () => {
  const a = await setup("Men somsa pishiraman");
  await status(() => a.core.publish(a.host.key, a.l.id), 409);
  const b = await setup("Samarqandda ekskursiya, 2 soat, 100 ming so'm, 5 kishi");
  assert.deepEqual(b.l.missing.map((m) => m.field), ["cert_no"]);
  await status(() => b.core.publish(b.host.key, b.l.id), 409);
  b.core.updateListing(b.host.key, b.l.id, { cert_no: "G-1" });
  b.core.publish(b.host.key, b.l.id);
});

test("a host cannot touch another host's listing or booking", async () => {
  const { payTest, core, host, l } = await setup();
  await core.publish(host.key, l.id);
  const other = await core.createHost("Boshqa");
  await status(() => core.updateListing(other.key, l.id, { capacity: 1 }), 404);
  await status(() => core.hostHome("xato"), 401);
  const b = await core.book(req(l));
  await payTest(b.token);
  const bid = (await core.hostHome(host.key)).bookings[0].id;
  await status(() => core.decide(other.key, bid, true), 404);
  await assert.rejects(core.message("host", other.key, { booking_id: bid, code: "r_yes" }), (e) => e.status === 404);
});

test("pay → host notified once → confirm; repeating a payment changes nothing", async () => {
  const { payTest, core, host, l, events } = await setup();
  await core.publish(host.key, l.id);
  const b = await core.book(req(l, { hotel_code: "x" }));
  assert.equal(b.channel, "hotel");
  assert.equal((await core.hostHome(host.key)).bookings.length, 0);
  await payTest(b.token);
  await status(() => payTest(b.token), 409);
  await settle();
  assert.equal(events.length, 1);
  const hb = (await core.hostHome(host.key)).bookings[0];
  await core.decide(host.key, hb.id, true);
  assert.equal((await core.guestBooking(b.token)).status, "confirmed");
  await status(() => core.decide(host.key, hb.id, false), 409);
});

test("capacity, schedule and date rules", async () => {
  const { db, core, host, l } = await setup();
  await core.publish(host.key, l.id);
  await core.book(req(l, { guests: 3 }));
  await status(() => core.book(req(l)), 409);
  await core.book(req(l, { guests: 1 }));
  assert.equal(await freeAt(core, l, 2), 0);
  await db.run("UPDATE bookings SET expires_at='2020-01-01T00:00:00Z'");
  assert.equal(await freeAt(core, l, 2), 4);
  for (const o of [{ date: day(-1) }, { date: "2026-02-31" }, { date: "x" }, { date: day(400) }, { guests: 0 }, { guests: 5 }, { guests: 1.5 }, { guest_name: " " }]) await status(() => core.book(req(l, o)), 400);
  await status(() => core.book(req(l, { time: "11:00" })), 409);
  const closed = new Date(`${day(2)}T00:00:00Z`).getUTCDay() || 7;
  await core.updateListing(host.key, l.id, { weekdays: [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== closed) });
  await status(() => core.book(req(l)), 409);
});

test("an expired hold is paid only while its place is still free, and is never charged for a place that is gone", async () => {
  const { payTest, db, core, host, l } = await setup();
  await core.publish(host.key, l.id);
  const late = await core.book(req(l, { guests: 2 })), gone = await core.book(req(l, { guests: 2, time: "15:00" }));
  await db.run("UPDATE bookings SET expires_at='2020-01-01T00:00:00Z'");
  assert.deepEqual([(await core.guestBooking(late.token)).status, (await core.guestBooking(late.token)).can_revive], ["expired", true]);
  await payTest((await core.book(req(l, { guests: 4, time: "15:00" }))).token); // someone else takes every place at 15:00
  await status(() => payTest(gone.token), 410);
  assert.equal((await core.guestBooking(gone.token)).can_revive, false);
  assert.equal((await payTest(late.token)).status, "paid", "the place at 10:00 was still free");
  assert.equal((await db.one("SELECT COUNT(*) n FROM payments WHERE amount_uzs > 0 AND status='paid'")).n, 2);
});

test("chat: phrases translate exactly, free text offline is marked untranslated", async () => {
  const { payTest, core, host, l } = await setup();
  await core.publish(host.key, l.id);
  const b = await core.book(req(l));
  await assert.rejects(core.message("guest", b.token, { code: "q_children" }), (e) => e.status === 409);
  await payTest(b.token);
  const m = await core.message("guest", b.token, { code: "q_children" });
  assert.equal(m[0].original, PHRASES.q_children.zh);
  assert.equal(m[0].translated, PHRASES.q_children.uz);
  const bid = (await core.hostHome(host.key)).bookings[0].id;
  assert.equal((await core.message("host", host.key, { booking_id: bid, code: "r_yes" })).at(-1).translated, PHRASES.r_yes.zh);
  assert.equal((await core.message("guest", b.token, { text: "你好" })).at(-1).engine, "untranslated");
  await assert.rejects(core.message("guest", b.token, { code: "constructor" }), (e) => e.status === 400);
});

test("unmet demand is recorded and reported", async () => {
  const { core, host, l } = await setup();
  await core.publish(host.key, l.id);
  for (const region of ["surxondaryo", "fargona", undefined, "'; DROP TABLE"]) await core.search({ region });
  const r = Object.fromEntries((await core.panel()).regions.map((x) => [x.region, x]));
  assert.deepEqual([r.surxondaryo.unmet, r.fargona.unmet, r.fargona.searches], [1, 0, 1]);
});

test("a published listing keeps its required facts; template text follows the numbers", async () => {
  const { core, host, l } = await setup();
  await core.publish(host.key, l.id);
  assert.match((await core.updateListing(host.key, l.id, { capacity: 7 })).i18n.en.description, /up to 7/);
  await status(() => core.updateListing(host.key, l.id, { category: "tour" }), 400);
  await status(() => core.updateListing(host.key, l.id, { region: "constructor" }), 400);
});

test("telegram: asks for the gaps, then publishes", async () => {
  const { core } = createDomain({ db: await freshDb(), config: testConfig() }), out = [];
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
  const [l] = await core.search({});
  assert.deepEqual([l.price_uzs, l.host, l.region], [150000, "Ali", "fargona"]);
});
