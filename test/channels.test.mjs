// Selling through resellers (OCTO), paid add-ons, and the booking box on a provider's own website.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { addDays, isoWeekday } from "../src/lib/util.mjs";
import { day, eventually, req, serve, settle, setup, status } from "./helpers.mjs";

const weekday = (n) => { let d = day(n); while (isoWeekday(d) > 5) d = addDays(d, 1); return d; };

async function reseller({ pct = 10, resell = true } = {}) {
  const s = await serve({ env: { ADMIN_KEY: "k".repeat(30) } }), h = await s.core.createHost("Rustam"), l = await s.publishListing(h.key);
  if (resell) await s.core.updateListing(h.key, l.id, { resell: true });
  const r = await s.resellers.createReseller({ name: "Silk Tours", pct });
  const call = async (method, path, body, o = {}) => {
    const res = await fetch(`${s.base}/octo${path}`, { method, headers: { Authorization: `Bearer ${o.key ?? r.key}`, "Octo-Capabilities": o.caps ?? "", ...(body && { "Content-Type": "application/json" }) }, body: body && JSON.stringify(body) });
    return { status: res.status, caps: res.headers.get("octo-capabilities"), body: await res.json() };
  };
  return { s, h, l, r, call };
}

test("OCTO: products and availability follow the standard, and only offers allowed for resale are shown", async () => {
  const { s, h, l, call } = await reseller(), other = await s.publishListing(h.key);
  assert.equal((await call("GET", "/supplier")).body.endpoint.endsWith("/octo"), true);
  const list = (await call("GET", "/products")).body;
  assert.deepEqual(list.map((p) => p.id), [l.id], "the other offer was not allowed for resale");
  const p = list[0], o = p.options[0];
  assert.deepEqual([p.availabilityType, p.timeZone, p.instantConfirmation, p.deliveryFormats, o.id, o.default, o.availabilityLocalStartTimes, o.cancellationCutoffAmount, o.units[0].type], ["START_TIME", "Asia/Tashkent", false, ["QRCODE"], "DEFAULT", true, ["10:00", "15:00"], 24, "ADULT"]);
  assert.equal(p.options[0].units[0].pricingFrom, undefined, "prices only when asked for");
  const priced = await call("GET", `/products/${l.id}`, null, { caps: "octo/pricing" });
  assert.deepEqual([priced.caps, priced.body.options[0].units[0].pricingFrom[0]], ["octo/pricing", { original: 150000, retail: 150000, net: 135000, currency: "UZS", currencyPrecision: 0, includedTaxes: [] }]);
  assert.deepEqual((await call("GET", `/products/${other.id}`)).body.error, "INVALID_PRODUCT_ID");
  const d = weekday(3), a = (await call("POST", "/availability", { productId: l.id, optionId: "DEFAULT", localDateStart: d, localDateEnd: d, units: [{ id: "adult", quantity: 2 }] })).body;
  assert.deepEqual(a.map((x) => [x.id, x.status, x.vacancies, x.available]), [[`${d}T10:00+05:00`, "AVAILABLE", 4, true], [`${d}T15:00+05:00`, "AVAILABLE", 4, true]]);
  assert.equal(a[0].localDateTimeEnd, `${d}T12:00+05:00`);
  const cal = (await call("POST", "/availability/calendar", { productId: l.id, optionId: "DEFAULT", localDateStart: d, localDateEnd: addDays(d, 1) })).body;
  assert.deepEqual([cal.length, cal[0].localDate, cal[0].vacancies], [2, d, 8]);
  for (const [b, code] of [[{ productId: l.id, optionId: "X" }, "INVALID_OPTION_ID"], [{ productId: l.id, optionId: "DEFAULT", units: [{ id: "child", quantity: 1 }] }, "INVALID_UNIT_ID"], [{ productId: "nope", optionId: "DEFAULT" }, "INVALID_PRODUCT_ID"]]) {
    const x = await call("POST", "/availability", b);
    assert.deepEqual([x.status, x.body.error], [400, code]);
  }
});

test("OCTO: keys are checked, revoked keys stop at once, and nobody else's booking can be seen", async () => {
  const { s, l, r, call } = await reseller(), d = weekday(3);
  assert.equal((await call("GET", "/products", null, { key: "" })).body.error, "FORBIDDEN");
  assert.equal((await fetch(`${s.base}/octo/products`)).status, 400);
  assert.equal((await (await fetch(`${s.base}/octo/products`)).json()).error, "UNAUTHORIZED");
  assert.equal((await call("GET", "/products", null, { key: "sr_" + "x".repeat(32) })).body.error, "FORBIDDEN");
  const other = await s.resellers.createReseller({ name: "Other", pct: 5 });
  const uuid = randomUUID();
  await call("POST", "/bookings", { uuid, productId: l.id, optionId: "DEFAULT", availabilityId: `${d}T10:00+05:00`, unitItems: [{ unitId: "adult" }] });
  assert.equal((await call("GET", `/bookings/${uuid}`, null, { key: other.key })).body.error, "INVALID_BOOKING_UUID");
  await s.resellers.setReseller(r.id, { active: false });
  assert.equal((await call("GET", "/products")).body.error, "FORBIDDEN");
  assert.equal((await s.db.one("SELECT COUNT(*) n FROM audit_log WHERE action IN ('reseller_created','reseller_off')")).n, 3);
});

test("OCTO: hold, confirm, the provider accepts, the reseller gets the ticket; shares add up", async () => {
  const { s, h, l, call } = await reseller({ pct: 10 }), d = weekday(3), uuid = randomUUID();
  const hold = await call("POST", "/bookings", { uuid, productId: l.id, optionId: "DEFAULT", availabilityId: `${d}T10:00+05:00`, unitItems: [{ unitId: "adult" }, { unitId: "adult" }], expirationMinutes: 15 }, { caps: "octo/pricing" });
  assert.deepEqual([hold.body.status, hold.body.unitItems.length, hold.body.pricing.retail, hold.body.pricing.net], ["ON_HOLD", 2, 300000, 270000]);
  assert.ok(Date.parse(hold.body.utcExpiresAt) - Date.now() < 16 * 60e3);
  assert.equal((await call("POST", "/bookings", { uuid, productId: l.id, optionId: "DEFAULT", availabilityId: `${d}T10:00+05:00`, unitItems: [{ unitId: "adult" }] })).body.id, hold.body.id, "the same uuid is the same hold");
  assert.equal((await s.core.availability(l.id, d, 1))[0].times[0].free, 2, "the places are held");
  assert.equal((await call("POST", `/bookings/${uuid}/confirm`, { contact: {} })).body.error, "BAD_REQUEST");
  const ok = (await call("POST", `/bookings/${uuid}/confirm`, { resellerReference: "ST-77", contact: { firstName: "Anna", lastName: "Berg", emailAddress: "anna@example.com", locales: ["de-DE"] } })).body;
  assert.deepEqual([ok.status, ok.resellerReference, ok.contact.fullName], ["PENDING", "ST-77", "Anna Berg"]);
  const b = await s.db.one("SELECT * FROM bookings WHERE reseller_uuid=?", uuid);
  assert.deepEqual([b.channel, b.lang, b.total_uzs, b.partner_uzs, b.platform_uzs, b.host_uzs], ["partner", "de", 300000, 30000, 36000, 234000]);
  assert.equal((await s.db.one("SELECT provider, status FROM payments")).provider, "reseller");
  await s.core.decide(h.key, b.id, true);
  const done = (await call("GET", `/bookings/${uuid}`)).body;
  assert.deepEqual([done.status, done.unitItems[0].ticket.deliveryOptions[0].deliveryFormat, done.cancellable], ["CONFIRMED", "QRCODE", true]);
  assert.equal((await call("GET", "/bookings?resellerReference=ST-77")).body.length, 1);
  const [row] = await s.resellers.resellers();
  assert.deepEqual([row.sold, row.gross, row.owed], [1, 300000, 270000]);
  assert.equal((await s.metrics.investor()).money.gmv, 300000, "reseller sales are real sales");
});

test("OCTO: a hold expires, a full time is refused, and cancelling gives the places back", async () => {
  const { s, l, call } = await reseller(), d = weekday(4), at = `${d}T10:00+05:00`, book = (n, uuid = randomUUID()) => call("POST", "/bookings", { uuid, productId: l.id, optionId: "DEFAULT", availabilityId: at, unitItems: Array(n).fill({ unitId: "adult" }) });
  assert.equal((await book(5)).body.error, "BAD_REQUEST", "more people than the offer takes");
  const first = randomUUID();
  await book(3, first);
  assert.equal((await book(2)).body.error, "INVALID_AVAILABILITY_ID", "only one place is left");
  await call("POST", `/bookings/${first}/cancel`, {});
  assert.equal((await call("POST", "/bookings", { productId: l.id, optionId: "DEFAULT", availabilityId: `${d}T11:11+05:00`, unitItems: [{ unitId: "adult" }] })).body.error, "INVALID_AVAILABILITY_ID");
  const late = randomUUID();
  await book(1, late);
  await s.db.run("UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE reseller_uuid=?", late);
  assert.equal((await call("GET", `/bookings/${late}`)).body.status, "EXPIRED");
  assert.equal((await call("POST", `/bookings/${late}/confirm`, { contact: { fullName: "X Y" } })).body.error, "INVALID_BOOKING_UUID");
  const u = randomUUID();
  await book(4, u);
  await call("POST", `/bookings/${u}/confirm`, { contact: { fullName: "Anna Berg" } });
  assert.equal((await s.core.availability(l.id, d, 1))[0].times[0].free, 0);
  const c = (await call("POST", `/bookings/${u}/cancel`, { reason: "client changed plans" })).body;
  assert.deepEqual([c.status, c.cancellation.refund], ["CANCELLED", "FULL"]);
  assert.equal((await s.core.availability(l.id, d, 1))[0].times[0].free, 4);
  assert.equal(await eventually(async () => (await s.db.one("SELECT status FROM refunds WHERE status='done'"))?.status), "done", "a reseller is simply not charged");
  // too close to the visit
  const soon = randomUUID(), tomorrow = day(1);
  await call("POST", "/bookings", { uuid: soon, productId: l.id, optionId: "DEFAULT", availabilityId: `${tomorrow}T10:00+05:00`, unitItems: [{ unitId: "adult" }] });
  await call("POST", `/bookings/${soon}/confirm`, { contact: { fullName: "Late Guest" } });
  assert.equal((await call("POST", `/bookings/${soon}/cancel`, {})).body.error, "UNPROCESSABLE_ENTITY");
});

test("the same uuid at the same moment makes one booking", async () => {
  const { s, l, call } = await reseller(), uuid = randomUUID(), d = weekday(3);
  const all = await Promise.all([1, 2, 3, 4].map(() => call("POST", "/bookings", { uuid, productId: l.id, optionId: "DEFAULT", availabilityId: `${d}T15:00+05:00`, unitItems: [{ unitId: "adult" }] })));
  assert.equal(new Set(all.map((x) => x.body.id)).size, 1);
  assert.equal((await s.db.one("SELECT COUNT(*) n FROM bookings")).n, 1);
});

test("a visitor cannot pretend to be a reseller", async () => {
  const s = await serve(), h = await s.core.createHost("R"), l = await s.publishListing(h.key);
  const b = await (await s.post("/api/bookings", { ...req(l), reseller: { id: "x", pct: 100 }, via: { reseller: { pct: 100 } } })).json();
  const row = await s.db.one("SELECT channel, partner_uzs, reseller_id FROM bookings WHERE token=?", b.token);
  assert.deepEqual([row.channel, row.partner_uzs, row.reseller_id], ["web", 0, null]);
});

test("add-ons: checked, priced per person or per group, included in the total and its shares", async () => {
  const s = await setup(), set = (extras) => s.core.updateListing(s.host.key, s.l.id, { extras });
  for (const bad of ["x", [{ kind: "spa", price: 1000, per: "person" }], [{ kind: "lunch", price: 10, per: "person" }], [{ kind: "lunch", price: 50000, per: "everyone" }], [{ kind: "lunch", price: 50000, per: "person" }, { kind: "lunch", price: 60000, per: "person" }]]) await status(set(bad), 400);
  await set([{ kind: "lunch", price: 50000, per: "person" }, { kind: "transfer", price: 120000, per: "booking", evil: 1 }]);
  assert.deepEqual((await s.core.listing(s.l.id)).extras, [{ kind: "lunch", price: 50000, per: "person" }, { kind: "transfer", price: 120000, per: "booking" }]);
  const b = await s.core.book(req(s.l, { date: weekday(3), guests: 2, extras: ["lunch", "transfer"] }));
  assert.deepEqual([b.total_uzs, b.extras_uzs, b.extras.map((x) => x.amount)], [300000 + 100000 + 120000, 220000, [100000, 120000]]);
  assert.equal(b.host_uzs + b.platform_uzs + b.hotel_uzs + b.partner_uzs, b.total_uzs);
  assert.equal((await s.core.book(req(s.l, { date: weekday(3), time: "15:00", guests: 1, extras: [] }))).total_uzs, 150000);
  await assert.rejects(s.core.book(req(s.l, { date: weekday(4), extras: ["photo"] })), { code: "price" }, "an add-on that is not offered");
  await assert.rejects(s.core.book(req(s.l, { date: weekday(4), extras: ["lunch"], expect_uzs: 300000 })), { code: "price" }, "the add-on counts in the agreed total");
  assert.equal((await s.core.hostHome(s.host.key)).bookings.length, 0, "unpaid bookings are not shown to the provider");
});

test("the booking box may be shown on other websites; nothing else may", async () => {
  const s = await serve(), h = await s.core.createHost("R"), l = await s.publishListing(h.key);
  const csp = async (p) => (await fetch(s.base + p)).headers.get("content-security-policy");
  assert.match(await csp(`/?l=${l.id}&embed=1`), /frame-ancestors \*/);
  for (const p of ["/", `/?l=${l.id}`, "/mezbon?embed=1", "/admin"]) assert.doesNotMatch(await csp(p), /frame-ancestors \*/, p);
  const b = await (await s.post("/api/bookings", { ...req(l), source: "widget" })).json();
  assert.equal((await s.db.one("SELECT channel FROM bookings WHERE token=?", b.token)).channel, "widget");
  await settle();
});
