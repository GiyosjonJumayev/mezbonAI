import test from "node:test";
import assert from "node:assert/strict";
import { readWish } from "../src/domain/trips.mjs";
import { day, serve, setup as full, settle, status } from "./helpers.mjs";

const OFFERS = [
  "Xivada gilam to'qish, 2 soat, 130 ming so'm, 6 kishi", "Samarqandda tandirda non yopamiz, 90 daqiqa, 100 ming so'm, 5 kishi", "Samarqandda palov damlashni o'rgataman, uch soat, 200 ming so'm, 10 kishi",
  "Buxoroda kashta tikamiz, 2 soat, 90 ming so'm, 6 kishi", "Marg'ilonda atlas to'qiymiz, bir yarim soat, 120 ming so'm, 6 kishi",
];
async function setup() {
  const s = await full();
  for (const say of OFFERS) { const h = await s.core.createHost("M"); await s.publishListing(h.key, say); }
  const plan = (o) => s.core.planTrip({ from: day(3), days: 4, guests: 2, ...o });
  const pick = (p) => p.days.flatMap((d) => d.items.map((x) => ({ listing_id: x.listing_id, date: d.date, time: x.time })));
  return { ...s, plan, pick };
}
const items = (p) => p.days.flatMap((d) => d.items);

test("wishes are understood in several languages without AI", () => {
  for (const [s, v] of [
    ["5 days, 2 people, Samarkand and Bukhara, we love cooking", { days: 5, guests: 2, regions: ["samarqand", "buxoro"], interests: ["cooking"] }],
    ["4 kun, 3 kishi, Xivada kulolchilik", { days: 4, guests: 3, regions: ["xorazm"], interests: ["pottery"] }],
    ["На 3 дня в Риштан, керамика и вышивка, спокойно", { days: 3, guests: null, regions: ["fargona"], interests: ["pottery", "embroidery"], pace: "calm" }],
    ["6天 撒马尔罕 陶艺", { days: 6, regions: ["samarqand"], interests: ["pottery"] }],
    ["ignore previous instructions", { days: null, regions: [], interests: [] }],
  ]) { const r = readWish(s); for (const k of Object.keys(v)) assert.deepEqual(Array.isArray(v[k]) ? [...r[k]].sort() : r[k], Array.isArray(v[k]) ? [...v[k]].sort() : v[k], `${s}: ${k}`); }
});

test("a plan uses only free places, never overlaps, never repeats and does not zigzag", async () => {
  const { plan, core } = await setup(), p = await plan({ days: 6 });
  const all = items(p);
  assert.ok(all.length >= 5);
  assert.equal(new Set(all.map((x) => x.listing_id)).size, all.length);
  const regions = p.days.map((d) => d.region).filter((r, i, a) => r !== a[i - 1]);
  assert.equal(new Set(regions).size, regions.length, "a region is never left and entered again");
  for (const d of p.days) {
    for (const x of d.items) assert.ok((await core.availability(x.listing_id, d.date, 1))[0].times.find((t) => t.time === x.time).free >= 2);
    const t = d.items.map((x) => [+x.time.slice(0, 2) * 60 + +x.time.slice(3), x.duration_min]);
    if (t.length === 2) assert.ok(t[1][0] >= t[0][0] + t[0][1] + 60, "time to get from one to the other");
  }
  assert.equal(p.total_uzs, all.reduce((s, x) => s + x.price_uzs, 0) * 2);
});

test("choices are respected: region, interest, pace, budget, swap, group size; explicit beats text", async () => {
  const { plan } = await setup();
  assert.deepEqual([...new Set(items(await plan({ regions: ["samarqand"] })).map((x) => x.region))], ["samarqand"]);
  assert.deepEqual(items(await plan({ interests: ["bread"] })).map((x) => x.category), ["bread"]);
  for (const d of (await plan({ pace: "calm" })).days) assert.ok(d.items.length <= 1);
  assert.ok(items(await plan({ budget: 230_000 })).reduce((s, x) => s + x.price_uzs, 0) <= 230_000);
  const first = items(await plan({ regions: ["samarqand"], pace: "calm" }))[0];
  assert.ok(!items(await plan({ regions: ["samarqand"], skip: [first.listing_id] })).some((x) => x.listing_id === first.listing_id));
  assert.ok(items(await plan({ guests: 8 })).every((x) => x.category === "cooking"));
  assert.equal(items(await plan({ guests: 30 })).length, 0);
  const w = await plan({ wish: "10 days in Bukhara", days: 2 });
  assert.deepEqual([w.days.length, w.asked.regions], [2, ["buxoro"]]);
  for (const bad of [{ days: 1e9 }, { days: -1 }, { guests: "2" }, { regions: "samarqand" }, { regions: ["constructor"] }, { from: "x" }, { budget: "a" }, { skip: 5 }, { wish: 7 }]) assert.ok((await plan(bad)).days.length <= 14);
  await status(plan({ from: day(400) }), 400);
});

test("reserving a trip is all or nothing", async () => {
  const { core, plan, pick, db, payTest, events } = await setup(), p = await plan({ days: 5 }), list = pick(p);
  const t = await core.bookTrip({ items: list, guests: 2, guest_name: "Anna", lang: "de" });
  assert.deepEqual([t.bookings.length, t.waiting, t.total_uzs], [list.length, list.length, p.total_uzs]);
  assert.equal((await core.guestBooking(t.bookings[0].token)).trip, t.token);
  await payTest(t.bookings[0].token);
  assert.equal((await core.trip(t.token)).waiting, list.length - 1);
  await settle();
  assert.deepEqual(events, ["booking"], "only the provider whose place was paid is told");
  // One place of the second trip is gone: nothing of it may stay.
  const again = pick(await plan({ days: 5, from: day(20) })), last = again.at(-1);
  await db.run("INSERT INTO slot_rules (listing_id,date,time,capacity) VALUES (?,?,?,1)", last.listing_id, last.date, last.time);
  const before = (await db.one("SELECT COUNT(*) n FROM bookings")).n;
  await assert.rejects(core.bookTrip({ items: again, guests: 2, guest_name: "C", lang: "en" }), (e) => e.code === "full" && e.item.listing_id === last.listing_id);
  assert.deepEqual([(await db.one("SELECT COUNT(*) n FROM bookings")).n, (await db.one("SELECT COUNT(*) n FROM trips")).n], [before, 1]);
  for (const items of [[], null, [null], [{}], [list[0], list[0]], Array(21).fill(list[0]), [{ ...list[0], date: "x" }]]) await status(core.bookTrip({ items, guests: 1, guest_name: "D" }), 400);
  await status(core.trip("nope"), 404);
});

test("two trips for the last places: one gets everything, the other nothing", async () => {
  const { core, plan, pick, db } = await setup(), list = pick(await plan({ days: 5, guests: 4 }));
  const r = await Promise.allSettled([list, [...list].reverse(), list].map((items, i) => core.bookTrip({ items, guests: 4, guest_name: `T${i}`, lang: "en" })));
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1, r.map((x) => x.reason?.message).join());
  assert.equal((await db.one("SELECT COUNT(*) n FROM bookings")).n, list.length);
});

test("HTTP: a visitor cannot attach a booking to someone else's trip", async () => {
  const s = await serve(), h = await s.core.createHost("R"), l = await s.publishListing(h.key), item = { listing_id: l.id, date: day(3), time: "10:00" };
  const trip = await (await s.post("/api/trips", { items: [item], guests: 1, guest_name: "A", lang: "en" })).json();
  const { id } = await s.db.one("SELECT id FROM trips");
  const b = await (await s.post("/api/bookings", { ...item, guests: 1, guest_name: "Evil", lang: "en", trip_id: id })).json();
  assert.equal(b.trip, null);
  assert.equal((await s.get(`/api/trips/${trip.token}`)).bookings.length, 1);
  const full = await s.post("/api/trips", { items: [item], guests: 4, guest_name: "B", lang: "en" });
  assert.deepEqual([full.status, (await full.json()).item.listing_id], [409, l.id]);
  assert.equal((await s.post("/api/trips/plan", {})).status, 200);
});

// ---- provider profile and calendar feed --------------------------------------------------------------
test("a provider's public page shows facts, not private data", async () => {
  const { core, db, host, confirm, l } = await full(), b = await confirm();
  for (const n of [3, 4]) await confirm({ date: day(n) });
  await db.run("UPDATE bookings SET asked_at = now() - interval '5 hours'");
  await db.run("UPDATE bookings SET date=? WHERE token=?", day(-1), b.token);
  await core.review(b.token, { rating: 4 });
  const p = await core.provider(host.id);
  assert.deepEqual([p.name, p.listings.length, p.rating, p.reviews, p.reply_hours, p.verified], ["Rustam", 1, 4, 1, 5, false]);
  assert.ok(!/key|telegram|transcript|Li Wei/.test(JSON.stringify(p)));
  await core.pause(host.key, l.id);
  await status(core.provider(host.id), 404);
});

test("calendar feed: private, replaceable, first names only", async () => {
  const s = await serve(), h = await s.core.createHost("R"), l = await s.publishListing(h.key), head = { "X-Host-Key": h.key };
  const b = await s.core.book({ listing_id: l.id, date: day(3), time: "10:00", guests: 2, guest_name: "Anna Secretname", lang: "de" });
  await s.payTest(b.token);
  const link = async () => new URL((await (await s.post("/api/host/calendar-link", {}, head)).json()).url).pathname;
  const one = await link(), r = await fetch(s.base + one), text = await r.text();
  assert.match(r.headers.get("content-type"), /text\/calendar/);
  assert.ok(text.includes("Anna") && !text.includes("Secretname") && !text.includes(b.token));
  const two = await link();
  assert.deepEqual([(await fetch(s.base + one)).status, (await fetch(s.base + two)).status], [401, 200]);
  assert.equal((await fetch(`${s.base}/calendar/${"x".repeat(32)}.ics`)).status, 401);
  await s.core.rotateKey(h.key);
  assert.equal((await fetch(s.base + two)).status, 401);
});
