import test from "node:test";
import assert from "node:assert/strict";
import { day, PAYME, req, serve, settle, setup } from "./helpers.mjs";

const ADMIN_KEY = "admin-key-admin-key-admin-key";

test("investor numbers: an empty platform shows zeros, never made-up values", async () => {
  const { metrics, db } = await setup({ env: PAYME });
  await db.run("UPDATE hosts SET demo=true");
  const m = await metrics.investor();
  assert.deepEqual([m.money.gmv, m.money.revenue, m.money.take_rate, m.money.average, m.repeat.rate, m.hosts.registered, m.quality.rating, m.months.length], [0, 0, null, 0, null, 0, null, 12]);
  assert.deepEqual(m.funnel, { views: 0, holds: 0, paid: 0, confirmed: 0, visited: 0 });
});

test("investor numbers: money, funnel and hosts match what happened", async () => {
  const s = await setup(), { core, metrics, host, l, book, payTest, confirm, payments, db } = s;
  for (let i = 0; i < 7; i++) await core.view(l.id, "de");
  const a = await confirm({ email: "x@y.uz" });
  await confirm({ date: day(3), email: "X@y.uz" });
  await confirm({ date: day(4), email: "z@y.uz" });
  const declined = await book({ date: day(5) });
  await payTest(declined.token);
  await core.decide(host.key, await core.bookingId(declined.token), false);
  await book({ date: day(6) });
  await payments.startPlan(host.key, "pro", "test");
  await settle(150);
  await db.run("UPDATE bookings SET date=? WHERE token=?", day(0), a.token);
  await core.checkIn(host.key, a.ticket.code);
  const m = await metrics.investor({ sample: true });
  assert.deepEqual(m.funnel, { views: 7, holds: 5, paid: 4, confirmed: 3, visited: 1 });
  assert.deepEqual([m.money.bookings, m.money.gmv, m.money.fees, m.money.plans, m.money.revenue, m.money.average], [3, 900_000, 108_000, 149_000, 257_000, 300_000]);
  assert.deepEqual([m.money.take_rate, m.money.refunds, m.money.refund_rate], [0.12, 300_000, 0.25]);
  assert.deepEqual([m.repeat.guests, m.repeat.again, m.hosts.selling, m.hosts.five, m.months.at(-1).bookings, m.months.at(-1).gmv], [2, 1, 1, 0, 3, 900_000]);
  assert.equal(m.money.gmv, m.money.fees + m.money.hotels + m.money.hosts, "shares add up");
  // Test money is not traction.
  const real = await metrics.investor({ sample: false });
  assert.deepEqual([real.money.gmv, real.money.revenue, real.months.at(-1).gmv, real.hosts.selling], [0, 0, 0, 0]);
  for (const days of [NaN, -1, 1e9, "x"]) assert.equal((await metrics.investor({ days })).days, 90);
});

test("impact: only visits that happened; small regions stay private; nothing personal", async () => {
  const s = await setup(), { core, metrics, confirm, db, payTest } = s;
  const a = await confirm();
  assert.equal((await metrics.impact()).totals.visits, 0, "a coming visit is not impact yet");
  await db.run("UPDATE bookings SET date=? WHERE token=?", day(-2), a.token);
  let i = await metrics.impact();
  assert.deepEqual([i.totals.visits, i.totals.host_income_uzs, i.totals.per_host_uzs, i.totals.host_share, i.totals.outside_capital], [1, null, null, 0.88, 1]);
  assert.equal(i.regions.find((r) => r.region === "fargona").income_uzs, null, "one host's income is not published");
  for (const n of [1, 2]) {
    const h = await core.createHost("H" + n), l = await s.publishListing(h.key), b = await core.book(req(l, { date: day(3 + n) }));
    await payTest(b.token);
    await core.decide(h.key, await core.bookingId(b.token), true);
    await db.run("UPDATE bookings SET date=? WHERE token=?", day(-1), b.token);
  }
  i = await metrics.impact();
  assert.equal(i.regions.find((r) => r.region === "fargona").income_uzs, 264_000 * 3);
  assert.deepEqual([i.totals.host_income_uzs, i.totals.per_host_uzs], [792_000, 264_000]);
  assert.ok(!/Rustam|Li Wei|h_/.test(JSON.stringify(i)));
  const live = await setup({ env: PAYME });
  assert.equal((await live.metrics.impact()).sample, false);
});

test("HTTP: impact is public, investor numbers need an administrator", async () => {
  const s = await serve({ env: { ADMIN_KEY } });
  assert.equal((await fetch(s.base + "/impact")).status, 200);
  assert.equal((await s.get("/api/impact")).totals.visits, 0);
  assert.equal((await fetch(s.base + "/api/admin/metrics")).status, 401);
  const r = await s.post("/api/admin/login", { key: ADMIN_KEY }), Cookie = r.headers.getSetCookie()[0].split(";")[0];
  assert.equal((await s.get("/api/admin/metrics?days=30", { Cookie })).days, 30);
});
