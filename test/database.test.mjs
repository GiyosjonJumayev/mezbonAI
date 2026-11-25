// What PostgreSQL itself guarantees, and what happens when many people act at once.
import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase, placeholders } from "../src/db/database.mjs";
import { day, freeAt, freshDb, req, serve, settle, setup } from "./helpers.mjs";

test("placeholders are numbered and quoted text is left alone", () => {
  assert.equal(placeholders("SELECT ? , 'a?b', 'it''s?' WHERE x=?"), "SELECT $1 , 'a?b', 'it''s?' WHERE x=$2");
});

test("the server's account cannot change the schema or rewrite the audit log", async () => {
  const db = await freshDb();
  await db.run("INSERT INTO audit_log (actor,action,target) VALUES ('a','b','c')");
  for (const sql of ["UPDATE audit_log SET actor='x'", "DELETE FROM audit_log", "TRUNCATE audit_log", "DROP TABLE hosts", "ALTER TABLE hosts ADD x int", "CREATE TABLE y (a int)", "DELETE FROM schema_migrations"]) await assert.rejects(db.run(sql), (e) => e.code === "42501", sql);
  const owner = await freshDb({ owner: true });
  await owner.run("INSERT INTO audit_log (actor,action,target) VALUES ('a','b','c')");
  for (const sql of ["UPDATE audit_log SET actor='x'", "DELETE FROM audit_log", "TRUNCATE audit_log"]) await assert.rejects(owner.run(sql), /append only/, "even the owner is stopped");
});

test("migrations run once and refuse edited history", async () => {
  const db = await freshDb({ owner: true });
  await Promise.all([db.migrate(), db.migrate()]);
  await db.run("UPDATE schema_migrations SET checksum='x'");
  await assert.rejects(db.migrate(), /edited after it ran/);
});

test("impossible data is refused by the database, whatever the code does", async () => {
  const { db, l, book, confirm } = await setup(), b = await book(), c = await confirm({ date: day(3) });
  for (const [sql, ...p] of [
    ["UPDATE bookings SET host_uzs=host_uzs+1 WHERE token=?", b.token],
    ["UPDATE bookings SET guests=0 WHERE token=?", b.token],
    ["UPDATE bookings SET status='free' WHERE token=?", b.token],
    ["UPDATE bookings SET status='declined' WHERE token=?", c.token],
    ["UPDATE bookings SET listing_id='nope' WHERE token=?", b.token],
    ["UPDATE listings SET price_uzs=NULL WHERE id=?", l.id],
    ["UPDATE hosts SET plan='gold' WHERE id <> ?", ""],
    ["DELETE FROM listings WHERE id=?", l.id],
  ]) await assert.rejects(db.run(sql, ...p), (e) => /^23/.test(e.code), sql);
});

test("a transaction is all or nothing, and notifications wait for it", async () => {
  const db = await freshDb(), seen = [];
  await assert.rejects(db.tx(async () => { await db.run("INSERT INTO settings (k,v) VALUES ('a','1')"); db.afterCommit(() => seen.push("no")); throw new Error("stop"); }), /stop/);
  assert.equal((await db.one("SELECT COUNT(*) n FROM settings")).n, 0);
  await db.tx(async () => { await db.tx(() => db.run("INSERT INTO settings (k,v) VALUES ('a','1')")); db.afterCommit(() => seen.push("yes")); assert.deepEqual(seen, []); });
  await settle();
  assert.deepEqual(seen, ["yes"]);
  // A listener that fails does not undo what was saved.
  db.afterCommit(() => { throw new Error("listener"); });
  await settle();
});

test("a deadlock is retried", async () => {
  const db = await freshDb();
  await db.run("INSERT INTO settings (k,v) VALUES ('a','0'),('b','0')");
  let ready = 0;
  const both = new Promise((r) => { const t = setInterval(() => { if (ready >= 2) { clearInterval(t); r(); } }, 5); });
  const move = (x, y) => db.tx(async () => { await db.run("UPDATE settings SET v=(v::int+1)::text WHERE k=?", x); ready++; await both; await db.run("UPDATE settings SET v=(v::int+1)::text WHERE k=?", y); });
  await Promise.all([move("a", "b"), move("b", "a")]);
  assert.deepEqual((await db.all("SELECT v FROM settings ORDER BY k")).map((r) => r.v), ["2", "2"]);
});

test("twenty guests, four places: exactly four get one", async () => {
  const { core, book, l } = await setup();
  const r = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => book({ guests: 1, guest_name: `G${i}` })));
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 4);
  for (const x of r) if (x.status === "rejected") assert.equal(x.reason.code, "full", x.reason.message);
  assert.equal(await freeAt(core, l, 2), 0);
});

test("moving and booking at once never oversells", async () => {
  const { core, book, payTest, db } = await setup();
  const a = await book({ date: day(5), guests: 3 }), b = await book({ date: day(6), guests: 3 });
  await payTest(a.token);
  await payTest(b.token);
  const r = await Promise.allSettled([core.reschedule(a.token, { date: day(4), time: "10:00" }), core.reschedule(b.token, { date: day(4), time: "10:00" }), book({ date: day(4), guests: 3 })]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  assert.ok((await db.one("SELECT SUM(guests) n FROM bookings WHERE date=?", day(4))).n <= 4);
});

test("accept, decline, cancel and check-in race: one wins, the money matches", async () => {
  const { core, host, book, payTest, payments, db } = await setup();
  for (let i = 0; i < 4; i++) {
    const b = await book({ date: day(3 + i) }), bid = await core.bookingId(b.token);
    await payTest(b.token);
    await Promise.allSettled([core.decide(host.key, bid, true), core.decide(host.key, bid, false), core.cancel(b.token), core.cancel(b.token)]);
    await settle(80);
    const g = await core.guestBooking(b.token);
    assert.equal(g.payment.status, g.status === "confirmed" ? "paid" : "refunded", g.status);
  }
  assert.equal((await payments.refundsDue()).length, 0);
  const c = await book({ date: day(8) });
  await payTest(c.token);
  await core.decide(host.key, await core.bookingId(c.token), true);
  await db.run("UPDATE bookings SET date=? WHERE token=?", day(0), c.token);
  const { code } = (await core.guestBooking(c.token)).ticket;
  const r = await Promise.allSettled(Array.from({ length: 6 }, () => core.checkIn(host.key, code)));
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
});

test("the free plan limit holds when several phones publish at once", async () => {
  const { core, host } = await setup();
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await core.createDraft(host.key, "Rishtonda kulolman, ikki soat, 150 ming so'm, 4 kishi")).id);
  const r = await Promise.allSettled(ids.map((id) => core.publish(host.key, id)));
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 2);
});

test("hostile text is stored as text, and odd bytes are a clean refusal", async () => {
  const s = await serve(), h = await s.core.createHost("Robert'); DROP TABLE hosts;--"), l = await s.publishListing(h.key);
  assert.equal((await s.core.hostHome(h.key)).name, "Robert'); DROP TABLE hosts;--");
  for (const body of [req(l, { listing_id: "a\u0000b" }), req(l, { hotel_code: "x\u0000" }), req(l, { guest_name: "A\u0000\ud800" }), req(l, { listing_id: { a: 1 } }), req(l, { time: ["10:00"] }), req(l, { lang: "\u0000" })]) assert.ok([200, 400, 404, 409].includes((await s.post("/api/bookings", body)).status), JSON.stringify(body));
  for (const q of ["date=2026-02-31", "guests=1e9", "guests=-1", "region=%00", "lang=%00", "date=%00"]) assert.equal((await fetch(`${s.base}/api/listings?${q}`)).status, 200, q);
  assert.equal((await fetch(`${s.base}/api/panel?days=1e308`)).status, 200);
  assert.equal((await fetch(`${s.base}/api/listings/${l.id}/availability?from=9999-12-31`)).status, 200);
});

test("when the database is gone the site says so instead of hanging", async () => {
  const db = createDatabase("postgres://x:y@127.0.0.1:1/none");
  await assert.rejects(db.ping(), (e) => e.code === "ECONNREFUSED");
  await db.close();
});
