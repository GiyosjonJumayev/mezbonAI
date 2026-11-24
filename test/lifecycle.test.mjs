import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

process.env.MEZBON_OFFLINE = "1";
const { openDb } = await import("../src/db.mjs");
const { createCore, tashkentNow } = await import("../src/core.mjs");

const SAY = "Rishtonda kulolman, ikki soat, yuz ellik ming so'm, 4 kishi";
const day = (n) => tashkentNow(new Date(Date.now() + n * 864e5)).slice(0, 10);
const freeAt = (core, l, n) => core.availability(l.id, day(n), 1)[0].times.find((t) => t.time === "10:00").free;
const req = (l, o = {}) => ({ listing_id: l.id, date: day(2), time: "10:00", guests: 2, guest_name: "Li Wei", lang: "zh", ...o });
const status = (fn, s) => assert.throws(fn, (e) => { assert.equal(e.status, s, e.message); return true; });

async function setup({ publish = true } = {}) {
  const events = [], db = openDb(":memory:");
  const core = createCore(db, { notify: (h, e) => events.push(e.type) });
  const host = core.createHost("Rustam");
  let l = await core.createDraft(host.key, SAY);
  l = core.updateListing(host.key, l.id, { weekdays: [1, 2, 3, 4, 5, 6, 7] });
  if (publish) core.publish(host.key, l.id);
  return { db, core, host, l, events };
}

test("guest cancellation: free in time, refused late, gives the place back", async () => {
  const { db, core, host, l, events } = await setup();
  const b = core.book(req(l, { date: day(3), guests: 4 }));
  core.payTest(b.token);
  assert.equal(freeAt(core, l, 3), 0);
  assert.equal(core.cancel(b.token).status, "cancelled");
  assert.equal(freeAt(core, l, 3), 4);
  assert.deepEqual(events, ["booking", "cancelled"]);
  status(() => core.cancel(b.token), 409);

  const late = core.book(req(l));
  core.payTest(late.token);
  db.prepare("UPDATE bookings SET date=?, time='00:00' WHERE token=?").run(day(1), late.token);
  status(() => core.cancel(late.token), 409);

  const unpaid = core.book(req(l, { date: day(4) }));
  core.cancel(unpaid.token);
  assert.equal(events.length, 3, "an unpaid hold is released silently");
  assert.ok(!core.hostHome(host.key).bookings.some((x) => x.date === day(4)));
});

test("reviews: only after a confirmed visit, once, shown with an initial", async () => {
  const { db, core, host, l } = await setup();
  const b = core.book(req(l));
  core.payTest(b.token);
  core.decide(host.key, core.hostHome(host.key).bookings[0].id, true);
  status(() => core.review(b.token, { rating: 5 }), 409);
  db.prepare("UPDATE bookings SET date=?").run(day(-1));
  status(() => core.review(b.token, { rating: 6 }), 400);
  assert.equal(core.review(b.token, { rating: 4, text: "很好" }).my_rating, 4);
  status(() => core.review(b.token, { rating: 5 }), 409);
  const pub = core.listing(l.id);
  assert.deepEqual([pub.rating, pub.reviews, pub.reviewList[0].by], [4, 1, "L."]);
  assert.ok(!JSON.stringify(pub).includes("Wei"));
});

test("closed dates block booking and search by date", async () => {
  const { core, host, l } = await setup();
  assert.equal(core.search({ date: day(2), guests: 2 }).length, 1);
  assert.equal(core.search({ guests: 5 }).length, 0);
  core.updateListing(host.key, l.id, { closed: [day(2)] });
  assert.deepEqual(core.availability(l.id, day(2), 1), []);
  assert.equal(core.search({ date: day(2) }).length, 0);
  status(() => core.book(req(l)), 409);
  status(() => core.updateListing(host.key, l.id, { closed: ["2026-13-01"] }), 400);
});

test("availability never shows past slots", async () => {
  const { core, l } = await setup();
  const clock = tashkentNow().slice(0, 16);
  for (const d of core.availability(l.id, "2020-01-01", 60)) for (const t of d.times) assert.ok(`${d.date}T${t.time}` > clock);
});

test("hand-edited text survives later number changes; other languages follow", async () => {
  const { core, host, l } = await setup();
  core.updateListing(host.key, l.id, { text: { lang: "en", title: "My kiln", description: "Come and see." } });
  const r = core.updateListing(host.key, l.id, { capacity: 9 });
  assert.equal(r.i18n.en.title, "My kiln");
  assert.match(r.i18n.de.description, /bis zu 9/);
  core.updateListing(host.key, l.id, { text: { lang: "fr", title: "Mon four" } });
  const fr = core.updateListing(host.key, l.id, { duration_min: 75 }).i18n.fr;
  assert.equal(fr.title, "Mon four");
  assert.match(fr.description, /75 minutes/, "editing only the title must not freeze the description");
  status(() => core.updateListing(host.key, l.id, { text: { lang: "xx", title: "a", description: "b" } }), 400);
});

test("only drafts can be deleted; paused listings keep their bookings", async () => {
  const { core, host, l } = await setup();
  const draft = await core.createDraft(host.key, SAY);
  core.deleteDraft(host.key, draft.id);
  status(() => core.deleteDraft(host.key, l.id), 409);
  const b = core.book(req(l));
  core.payTest(b.token);
  core.pause(host.key, l.id);
  status(() => core.listing(l.id), 404);
  assert.equal(core.guestBooking(b.token).status, "paid");
});

test("calendar file is in UTC and cannot be broken by text", async () => {
  const { core, host, l } = await setup();
  const b = core.book(req(l));
  status(() => core.calendar(b.token), 409);
  core.payTest(b.token);
  core.updateListing(host.key, l.id, { text: { lang: "zh", title: "a;b,c\r\nATTENDEE:x", description: "d" } });
  const ics = core.calendar(b.token);
  assert.ok(ics.includes(`DTSTART:${day(2).replaceAll("-", "")}T050000Z`));
  assert.ok(!/^ATTENDEE/m.test(ics));
});

test("panel can leave out sample searches and old periods", async () => {
  const { db, core } = await setup();
  db.prepare("INSERT INTO searches (region,results,lang,source,demo,created_at) VALUES ('navoiy',0,'en','seed',1,?)").run(new Date().toISOString());
  db.prepare("INSERT INTO searches (region,category,results,lang,source,created_at) VALUES ('navoiy','wood',0,'en','web','2020-01-01T00:00:00Z')").run();
  const unmet = (o) => core.panel(o).regions.find((r) => r.region === "navoiy").unmet;
  assert.deepEqual([unmet(), unmet({ demo: false }), unmet({ days: 7 }), unmet({ days: 7, demo: false })], [2, 1, 1, 0]);
  assert.equal(core.panel().categories[0].category, "wood");
});

test("a version 1 database is upgraded without losing data", () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "mezbon-")), "old.db");
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE hosts (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, telegram_chat TEXT UNIQUE, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE listings (id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id), status TEXT NOT NULL, category TEXT NOT NULL, region TEXT, place TEXT, price_uzs INTEGER, duration_min INTEGER, capacity INTEGER, weekdays TEXT NOT NULL, times TEXT NOT NULL, cert_no TEXT, transcript TEXT NOT NULL, i18n TEXT NOT NULL, photo TEXT, engine TEXT NOT NULL, created_at TEXT NOT NULL, published_at TEXT);
    CREATE TABLE hotels (code TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL);
    CREATE TABLE bookings (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, listing_id TEXT NOT NULL REFERENCES listings(id), date TEXT NOT NULL, time TEXT NOT NULL, guests INTEGER NOT NULL, guest_name TEXT NOT NULL, lang TEXT NOT NULL, channel TEXT NOT NULL, hotel_code TEXT REFERENCES hotels(code), status TEXT NOT NULL CHECK (status IN ('pending','paid','confirmed','declined')), total_uzs INTEGER NOT NULL, platform_uzs INTEGER NOT NULL, hotel_uzs INTEGER NOT NULL, host_uzs INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, booking_id TEXT NOT NULL REFERENCES bookings(id), sender TEXT NOT NULL, original TEXT NOT NULL, lang TEXT NOT NULL, translated TEXT NOT NULL, translated_lang TEXT NOT NULL, engine TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO hosts VALUES ('h','k','N',NULL,0,'x');
    INSERT INTO listings VALUES ('l','h','published','pottery','fargona',NULL,1000,60,4,'[1]','["10:00"]',NULL,'t','{"uz":{"title":"T"}}',NULL,'demo','x','x');
    INSERT INTO bookings VALUES ('b','tok','l','2030-01-07','10:00',1,'G','en','web',NULL,'paid',1000,120,0,880,'x',NULL);
    INSERT INTO messages VALUES (1,'b','guest','o','en','t','uz','none','x');`);
  old.close();
  const db = openDb(file), core = createCore(db);
  assert.equal(core.guestBooking("tok").messages.length, 1);
  assert.equal(core.cancel("tok").status, "cancelled");
  db.close();
  openDb(file).close();
});
