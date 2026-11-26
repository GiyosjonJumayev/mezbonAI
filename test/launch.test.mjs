// Click, trip payments, contacts, e-mail, rates and two-step sign-in. Payment companies are stand-ins that follow their published specs.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cleanEmail, cleanPhone, isEmail, render } from "../src/domain/mail.mjs";
import { parseRates } from "../src/domain/rates.mjs";
import { base32, newTotpSecret, totp, totpChecker } from "../src/lib/totp.mjs";
import { CLICK, day, OCTO, req, serve, settle, setup, status } from "./helpers.mjs";

// ---- Click ----------------------------------------------------------------------------------------
async function clickSetup(reply = { error_code: 0 }) {
  const calls = [], s = await setup({ env: CLICK, fetchFn: async (url, init) => { calls.push({ url, init }); if (reply instanceof Error) throw reply; return { status: 200, json: async () => reply }; } });
  const bill = async (o) => { const b = await s.book(o), { url } = await s.payments.startBooking(b.token, "click"), q = new URL(url).searchParams; return { b, url, order: q.get("transaction_param"), amount: q.get("amount") }; };
  const send = async (action, f, secret = "click-key") => {
    const q = { click_trans_id: "900", service_id: "31", click_paydoc_id: "7001", error: "0", error_note: "", sign_time: "2026-11-25 10:00:00", action: String(action), ...f };
    q.sign_string ??= createHash("md5").update(`${q.click_trans_id}${q.service_id}${secret}${q.merchant_trans_id}${action === 1 ? q.merchant_prepare_id : ""}${q.amount}${q.action}${q.sign_time}`).digest("hex");
    return s.payments.click(new URLSearchParams(q).toString());
  };
  const pay = async (x) => { const p = await send(0, { merchant_trans_id: x.order, amount: x.amount }); return send(1, { click_paydoc_id: "7002", merchant_trans_id: x.order, amount: x.amount, merchant_prepare_id: String(p.merchant_prepare_id) }); };
  return { ...s, calls, bill, send, pay };
}

test("Click: the link, a wrong signature, wrong service, amount and order", async () => {
  const { bill, send } = await clickSetup(), x = await bill();
  assert.match(x.url, /^https:\/\/my\.click\.uz\/services\/pay\/\?service_id=31&merchant_id=20&merchant_user_id=4&amount=300000\.00&/);
  const f = { merchant_trans_id: x.order, amount: x.amount }, code = async (...a) => (await send(...a)).error;
  assert.equal(await code(0, f, "wrong"), -1);
  assert.equal(await code(0, { ...f, sign_string: "" }), -1);
  assert.equal(await code(0, { ...f, service_id: "32" }), -8);
  assert.equal(await code(2, f), -3);
  assert.equal(await code(0, { ...f, merchant_trans_id: "p_nope" }), -5);
  for (const amount of ["1000", "300000.5", "3e5", "-300000", ""]) assert.equal(await code(0, { ...f, amount }), -2, amount);
  assert.equal(await code(1, { ...f, merchant_prepare_id: "1" }), -6, "complete without prepare");
  const off = await setup();
  assert.equal((await off.payments.click("action=0")).error, -1);
});

test("Click: prepare and complete deliver once, repeats are answered, a failure releases the bill", async () => {
  const { bill, send, pay, core, payments, events } = await clickSetup(), x = await bill(), f = { merchant_trans_id: x.order, amount: x.amount };
  const p = await send(0, f);
  assert.deepEqual([p.error, Number.isInteger(p.merchant_prepare_id)], [0, true]);
  assert.equal((await send(0, f)).merchant_prepare_id, p.merchant_prepare_id);
  assert.equal((await core.guestBooking(x.b.token)).status, "pending");
  const c = { ...f, merchant_prepare_id: String(p.merchant_prepare_id) };
  assert.equal((await send(1, { ...c, merchant_prepare_id: "999999" })).error, -6);
  assert.deepEqual([(await send(1, c)).error, (await send(1, c)).error, (await send(0, f)).error], [0, -4, -4]);
  const g = await core.guestBooking(x.b.token);
  assert.deepEqual([g.status, g.payment.provider, g.payment.status], ["paid", "click", "paid"]);
  await settle();
  assert.deepEqual(events, ["booking"]);

  const y = await bill({ date: day(4) }), q = await send(0, { merchant_trans_id: y.order, amount: y.amount });
  assert.equal((await send(1, { merchant_trans_id: y.order, amount: y.amount, merchant_prepare_id: String(q.merchant_prepare_id), error: "-5017" })).error, -9);
  assert.equal((await send(0, { merchant_trans_id: y.order, amount: y.amount })).error, -9);
  const again = new URL((await payments.startBooking(y.b.token, "click")).url).searchParams;
  assert.equal((await pay({ order: again.get("transaction_param"), amount: again.get("amount") })).error, 0, "a new bill works");
});

test("Click: four identical completions at once deliver once; a refund reverses the payment", async () => {
  const { bill, send, core, host, calls, events } = await clickSetup(), x = await bill(), p = await send(0, { merchant_trans_id: x.order, amount: x.amount });
  const c = { merchant_trans_id: x.order, amount: x.amount, merchant_prepare_id: String(p.merchant_prepare_id) };
  const r = await Promise.all([1, 2, 3, 4].map(() => send(1, c)));
  assert.deepEqual(r.map((v) => v.error).sort(), [-4, -4, -4, 0]);
  await core.decide(host.key, await core.bookingId(x.b.token), false);
  await settle(150);
  assert.deepEqual([calls.length, calls[0].init.method, calls[0].url], [1, "DELETE", "https://api.click.uz/v2/merchant/payment/reversal/31/7001"]);
  const [user, digest, t] = calls[0].init.headers.Auth.split(":");
  assert.deepEqual([user, digest], ["4", createHash("sha1").update(`${t}click-key`).digest("hex")]);
  assert.equal((await core.guestBooking(x.b.token)).payment.status, "refunded");
  assert.equal(events.filter((e) => e === "booking").length, 1);
});

test("Click: money taken for a place that is gone goes back; a refused refund waits for a person", async () => {
  const { bill, send, core, payments, book, db } = await clickSetup({ error_code: -1, error_note: "Last month" }), x = await bill({ guests: 4 }), p = await send(0, { merchant_trans_id: x.order, amount: x.amount });
  await db.run("UPDATE bookings SET expires_at=now() - interval '1 minute'");
  await book({ guests: 1 });
  assert.equal((await send(1, { merchant_trans_id: x.order, amount: x.amount, merchant_prepare_id: String(p.merchant_prepare_id) })).error, 0, "the card was charged, so Click is told yes");
  await settle(150);
  assert.equal((await core.guestBooking(x.b.token)).payment.status, "refund_due");
  const [due] = await payments.refundsDue();
  assert.deepEqual([due.provider, due.note], ["click", "Last month"]);
  await payments.confirmRefund(due.id);
  await status(payments.confirmRefund(due.id), 409);
  assert.equal((await core.guestBooking(x.b.token)).payment.status, "refunded");
});

test("Click over HTTP: form body, no origin or cookies", async () => {
  const s = await serve({ env: CLICK }), r = await fetch(s.base + "/pay/click", { method: "POST", body: new URLSearchParams({ action: "0", service_id: "31", click_trans_id: "1" }) });
  assert.deepEqual([r.status, (await r.json()).error], [200, -1]);
});

// ---- one payment for a trip -------------------------------------------------------------------------
async function tripSetup(env, fetchFn) {
  const s = await setup({ env, fetchFn }), h2 = await s.core.createHost("Ikkinchi"), l2 = await s.publishListing(h2.key);
  const trip = await s.core.bookTrip({ items: [{ listing_id: s.l.id, date: day(5), time: "10:00" }, { listing_id: l2.id, date: day(6), time: "10:00" }], guests: 2, guest_name: "Anna", lang: "en" });
  const mine = async () => Object.fromEntries((await s.core.trip(trip.token)).bookings.map((b) => [b.listing_id === s.l.id ? "a" : "b", b]));
  return { ...s, h2, l2, trip, mine };
}
test("a whole trip is paid once; one refusal returns only its part", async () => {
  const s = await tripSetup({}), { core, payments, trip, mine, host, h2, db } = s;
  assert.deepEqual(payments.tripMethods(), ["test"]);
  await payments.startTrip(await core.trip(trip.token), "test");
  const m = await mine();
  assert.deepEqual([m.a.status, m.b.status, (await core.trip(trip.token)).waiting], ["paid", "paid", 0]);
  assert.deepEqual([m.a.payment.id, m.a.payment.amount_uzs], [m.b.payment.id, 300_000]);
  await status(async () => payments.startTrip(await core.trip(trip.token), "test"), 409);
  await core.decide(host.key, await core.bookingId(m.a.token), true);
  await core.decide(h2.key, await core.bookingId(m.b.token), false);
  await settle(150);
  const after = await mine();
  assert.deepEqual([after.a.payment.status, after.b.payment.status], ["paid", "refunded"]);
  assert.equal((await db.one("SELECT status FROM payments")).status, "paid", "half of it is still earned");
  assert.deepEqual([(await payments.balance(host.id)).upcoming, (await payments.balance(h2.id)).upcoming], [264_000, 0]);
  await core.cancel(after.a.token);
  await settle(150);
  assert.equal((await db.one("SELECT status FROM payments")).status, "refunded");
  for (const p of ["payme", "click", "constructor", undefined]) await status(payments.startTrip({ bookings: [] }, p), 400);
});

test("trip and Octo: partial refunds run one after another and a lost answer is never counted twice", async () => {
  const o = { sum: 0, refunded: 0, status: "created", log: [], lose: false, slow: 0 };
  const fetchFn = async (url, init) => {
    const b = JSON.parse(init.body);
    if (url.endsWith("/refund")) {
      o.log.push([b.shop_refund_id, b.amount]);
      o.refunded += b.amount;
      if (o.lose) { o.lose = false; throw new Error("answer lost"); }
      return { json: async () => ({ error: 0, data: { status: "succeeded" } }) };
    }
    if (b.total_sum) o.sum = b.total_sum, (o.id = b.shop_transaction_id);
    return { json: async () => ({ error: 0, data: { shop_transaction_id: o.id, octo_payment_UUID: "u1", status: o.status, octo_pay_url: "https://pay2.octo.uz/x", total_sum: o.sum, refunded_sum: o.refunded } }) };
  };
  const { core, payments, trip, mine, db } = await tripSetup(OCTO, fetchFn);
  assert.deepEqual(payments.tripMethods(), ["octo"]);
  await payments.startTrip(await core.trip(trip.token), "octo");
  assert.equal(o.sum, 600_000);
  o.status = "succeeded";
  await payments.octoNotify({ shop_transaction_id: o.id });
  const m = await mine();
  assert.deepEqual([m.a.status, m.b.status], ["paid", "paid"]);
  o.lose = true; // the first refund happens, its answer does not arrive
  await core.cancel(m.a.token);
  await settle(120);
  await core.cancel(m.b.token);
  await settle(120);
  assert.equal(o.log.length, 1, "the second waits for the first");
  assert.deepEqual((await payments.refundsDue()).length, 2);
  await db.run("UPDATE refunds SET updated_at = now() - interval '2 minutes'");
  await payments.work();
  await settle(200);
  assert.deepEqual([o.log.length, o.refunded, (await payments.refundsDue()).length], [2, 600_000, 0]);
  assert.equal(new Set(o.log.map(([id]) => id)).size, 2);
  const after = await mine();
  assert.deepEqual([after.a.payment.status, after.b.payment.status, (await db.one("SELECT status FROM payments")).status], ["refunded", "refunded", "refunded"]);
});

test("a booking paid alone and again inside a trip payment is refunded once", async () => {
  const { core, payments, trip, mine, db } = await tripSetup({}), m = await mine();
  // The trip bill is opened first, then one booking is paid by itself, then the trip bill is paid.
  const t = await core.trip(trip.token), bill = await db.tx(async () => {
    await db.run("INSERT INTO payments (id,kind,ref,provider,amount_uzs,status) VALUES ('p_trip','trip',?,'test',600000,'created')", t.id);
    for (const x of t.bookings) await db.run("INSERT INTO payment_items (payment_id,booking_id,amount_uzs) VALUES ('p_trip',?,300000)", await core.bookingId(x.token));
    return "p_trip";
  });
  await payments.startBooking(m.a.token, "test");
  await db.run("UPDATE payments SET status='paid', paid_at=now() WHERE id=?", bill);
  await payments.work();
  await settle(150);
  const r = await db.all("SELECT payment_id, booking_id, status FROM refunds");
  assert.deepEqual(r, [{ payment_id: "p_trip", booking_id: await core.bookingId(m.a.token), status: "done" }]);
  const after = await mine();
  assert.deepEqual([after.a.status, after.a.payment.status, after.b.payment.status], ["paid", "paid", "paid"]);
});

// ---- meeting point and contacts -----------------------------------------------------------------------
test("the address and phone are shown only to a confirmed guest; the guest's phone only to the host", async () => {
  const { core, host, l, book, payTest } = await setup();
  await core.updateListing(host.key, l.id, { address: "Kulollar 12", point: { lat: 40.3567891, lng: 71.2834 } });
  await core.setContact(host.key, { phone: "90 123-45-67" });
  assert.ok(!/Kulollar|71\.28|123456/.test(JSON.stringify([await core.listing(l.id), await core.search({}), await core.feed(), await core.provider(host.id)])), "never public");
  const b = await book({ email: "li@example.com", phone: "+86 138 0000 1111" });
  assert.equal(b.meet, null);
  assert.equal((await core.hostHome(host.key)).bookings.length, 0);
  await payTest(b.token);
  assert.equal((await core.guestBooking(b.token)).meet, null);
  const [hb] = (await core.hostHome(host.key)).bookings;
  assert.equal(hb.guest_phone, "+8613800001111");
  assert.ok(!JSON.stringify(await core.hostHome(host.key)).includes("li@example.com"), "the host does not see the e-mail");
  await core.decide(host.key, hb.id, true);
  assert.deepEqual((await core.guestBooking(b.token)).meet, { host: "Rustam", address: "Kulollar 12", phone: "+998901234567", lat: 40.35679, lng: 71.2834 });
  assert.match(await core.calendar(b.token), /Kulollar 12/);
  await core.cancel(b.token);
  assert.equal((await core.guestBooking(b.token)).meet, null);
  assert.equal((await core.hostHome(host.key)).bookings[0].guest_phone, null);
  for (const point of [{ lat: 1, lng: 1 }, { lat: "40", lng: 70 }, { lat: 40 }, { lat: NaN, lng: 70 }]) await status(core.updateListing(host.key, l.id, { point }), 400);
  assert.equal((await core.updateListing(host.key, l.id, { point: null })).lat, null);
});

test("contacts are validated, and removed with other personal data", async () => {
  for (const v of ["a@b.uz", "x.y+z@mail.example.com"]) assert.ok(isEmail(v), v);
  for (const v of ["a", "a@b", "a b@c.uz", "a@b.uz\r\nBcc: x@y.uz", "<a@b.uz>", "a@b.uz,c@d.uz", "a".repeat(120) + "@b.uz", null, {}]) assert.ok(!isEmail(v), String(v));
  assert.equal(cleanPhone("901234567"), "+998901234567");
  assert.equal(cleanPhone(""), null);
  for (const v of ["abc", "+12", "1".repeat(20), "tel:+998"]) assert.throws(() => cleanPhone(v), (e) => e.code === "phone");
  assert.throws(() => cleanEmail("x"), (e) => e.code === "email");
  const { admin, db, book, confirm } = await setup();
  await status(book({ email: "bad" }), 400);
  await status(book({ phone: "bad" }), 400);
  const b = await confirm({ email: "li@example.com", phone: "+8613800001111" });
  await db.run("UPDATE bookings SET date=? WHERE token=?", day(-400), b.token);
  await admin.retention();
  assert.deepEqual(await db.one("SELECT guest_email, guest_phone FROM bookings"), { guest_email: null, guest_phone: null });
});

// ---- e-mail -------------------------------------------------------------------------------------------
const MAIL = { SMTP_URL: "smtp://x", MAIL_FROM: "SilkRoad <no@silkroad.test>" };
async function mailApp(o = {}) {
  const out = [], s = await serve({ env: MAIL, mailer: { sendMail: async (m) => { if (o.fail) throw Object.assign(new Error("down"), { code: "ECONNECTION" }); out.push(m); } } });
  const h = await s.core.createHost("Rustam"), l = await s.publishListing(h.key);
  return { ...s, out, o, h, l };
}
test("the guest gets a receipt, a confirmation with the address, and a refund notice, in their language", async () => {
  const s = await mailApp(), { core, out, mail, h, l } = s;
  await core.updateListing(h.key, l.id, { address: "Kulollar <12>", point: { lat: 40.35, lng: 71.28 } });
  const b = await core.book(req(l, { email: "Li@Example.com", date: day(5) }));
  await s.payTest(b.token);
  await settle(400);
  await mail.work();
  assert.deepEqual([out.length, out[0].to, /已支付/.test(out[0].subject), /Kulollar/.test(out[0].text), out[0].text.includes(b.token)], [1, "Li@Example.com", true, false, true]);
  await core.decide(h.key, await core.bookingId(b.token), true);
  await settle(400);
  await mail.work();
  assert.match(out[1].text, /Kulollar <12>/);
  assert.match(out[1].html, /Kulollar &lt;12&gt;/);
  assert.match(out[1].text, /40\.35,71\.28/);
  await core.cancel(b.token);
  await settle(500);
  await mail.work();
  assert.deepEqual(out.slice(2).map((m) => m.subject.split(": ")[1]).sort(), ["款项已退还", "预订已取消"].sort());
  const silent = await core.book(req(l, { date: day(6) }));
  await s.payTest(silent.token);
  await settle(400);
  assert.equal(await mail.work(), 0, "no address, no mail");
  assert.ok(!render({ title: "<script>", lines: ["a\"b"], button: { text: "x", url: "javascript:1\"" } }, "en").html.includes("<script>"));
});

test("a mail outage loses nothing; delivered messages are not kept", async () => {
  const s = await mailApp(), { core, out, mail, db, l, o } = s, b = await core.book(req(l, { email: "a@b.uz" }));
  o.fail = true;
  await s.payTest(b.token);
  await settle(400);
  assert.equal(await mail.work(), 0);
  assert.equal((await db.one("SELECT COUNT(*) n FROM emails")).n, 1);
  o.fail = false;
  assert.equal(await mail.work(), 0, "waits before trying again");
  await db.run("UPDATE emails SET next_at=now()");
  await Promise.all([mail.work(), mail.work(), mail.work()]);
  assert.deepEqual([out.length, (await db.one("SELECT COUNT(*) n FROM emails")).n], [1, 0]);
  const off = await serve();
  assert.equal((await off.get("/api/config")).mail, false);
  assert.equal(await off.mail.queue("a@b.uz", "x", { title: "x", lines: [] }), false);
});

test("finding bookings by e-mail tells a stranger nothing and cannot flood an inbox", async () => {
  const s = await mailApp(), { core, out, mail, l } = s, b = await core.book(req(l, { email: "li@example.com" }));
  const ask = async (email) => { const r = await s.post("/api/find", { email, lang: "de" }); return [r.status, JSON.stringify(await r.json())]; };
  assert.deepEqual(await ask("LI@example.com"), await ask("nobody@example.com"));
  await mail.work();
  assert.equal(out.length, 1);
  assert.ok(out[0].text.includes(b.token) && out[0].to === "li@example.com".replace("li", "LI"));
  assert.equal((await ask("x"))[0], 400);
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await ask("li@example.com"))[0]);
  assert.ok(codes.includes(429));
});

test("provider e-mail: confirmed by its owner, unique, then usable for sign-in", async () => {
  const s = await mailApp(), { core, out, mail, db, h } = s, head = { "X-Host-Key": h.key };
  await s.post("/api/host/email", { email: "usta@example.com" }, head);
  await mail.work();
  assert.equal((await core.account(h.key)).email, null, "not before it is confirmed");
  const token = /#email=(e_[\w-]+)/.exec(out[0].text)[1];
  await status(core.useLink(token), 401);
  assert.equal((await s.post("/api/auth/email-confirm", { token })).status, 200);
  await status(core.confirmEmail(token), 401);
  assert.equal((await core.account(h.key)).email, "usta@example.com");
  const other = await core.createHost("B"), t2 = (await core.askEmail(other.key, "USTA@example.com")).token;
  await status(core.confirmEmail(t2), 409);
  const a = await s.post("/api/auth/email", { email: "usta@example.com" }), n = await s.post("/api/auth/email", { email: "nobody@example.com" });
  assert.deepEqual([a.status, await a.text()], [n.status, await n.text()]);
  await mail.work();
  assert.equal(out.length, 2);
  assert.equal((await core.useLink(/#kirish=(l_[\w-]+)/.exec(out[1].text)[1])).host.id, h.id);
  const pending = await core.loginLink(h.key);
  await core.rotateKey(h.key);
  await status(core.useLink(pending), 401);
  assert.ok(!(await db.all("SELECT challenge FROM challenges")).some((c) => c.challenge.includes("l_")));
});

// ---- rates and two-step sign-in -------------------------------------------------------------------------
test("exchange rates: units are respected and nonsense is ignored", async () => {
  const row = (Ccy, Rate, Nominal = "1") => ({ Ccy, Rate, Nominal, Date: "25.11.2026" });
  assert.deepEqual(parseRates([row("USD", "11990.54"), row("JPY", "780.10", "10"), row("XXX", "5"), row("EUR", "abc"), row("RUB", "0")]), { date: "2026-11-25", rates: { USD: 11990.54, JPY: 78.01 } });
  for (const v of [null, {}, [], [row("EUR", "1")], [{ ...row("USD", "1"), Date: "x" }]]) assert.equal(parseRates(v), null);
  const s = await serve({ fetchFn: async (url) => { assert.equal(url, "https://cbu.uz/uz/arkhiv-kursov-valyut/json/"); return { json: async () => [row("USD", "12000")] }; } });
  assert.equal((await s.get("/api/config")).fx, null);
  await s.rates.work();
  assert.deepEqual((await s.get("/api/config")).fx.rates, { USD: 12000 });
  const again = await serve({ db: s.db, fetchFn: async () => ({ json: async () => "broken" }) });
  assert.deepEqual((await again.get("/api/config")).fx.rates, { USD: 12000 }, "yesterday's rate survives a restart");
  await assert.rejects(again.rates.work());
  assert.deepEqual((await again.get("/api/config")).fx.rates, { USD: 12000 });
});

test("two-step sign-in: the published test values, each code once, and the key alone is not enough", async () => {
  const key = Buffer.from("12345678901234567890"); // RFC 6238, SHA-1
  for (const [t, code] of [[59, "287082"], [1111111109, "081804"], [1234567890, "005924"], [2000000000, "279037"]]) assert.equal(totp(key, Math.floor(t / 30)), code);
  const secret = newTotpSecret(), k = base32(secret), now = Date.now(), step = Math.floor(now / 30000), check = totpChecker(secret);
  assert.deepEqual([k.length, secret.length], [20, 32]);
  assert.equal(check(totp(k, step), now), true);
  assert.equal(check(totp(k, step), now), false, "only once");
  assert.equal(check(totp(k, step - 5), now), false);
  for (const v of [undefined, null, "", "000000", 123456, "abc"]) assert.equal(totpChecker(secret)(v === "000000" && totp(k, step) === v ? "x" : v, now), false);
  const ADMIN_KEY = "admin-key-admin-key-admin-key", s = await serve({ env: { ADMIN_KEY, ADMIN_TOTP: secret } }), login = (b) => s.post("/api/admin/login", b);
  assert.deepEqual(await s.get("/api/admin/door"), { twoStep: true });
  const a = await login({ key: ADMIN_KEY }), b = await login({ key: "x".repeat(29), code: totp(k, Math.floor(Date.now() / 30000)) });
  assert.deepEqual([a.status, b.status, await a.text()], [401, 401, await b.text()], "the answer does not say which was wrong");
  assert.equal((await login({ key: ADMIN_KEY, code: totp(k, Math.floor(Date.now() / 30000)) })).status, 200, "a wrong key does not spend the code");
});
