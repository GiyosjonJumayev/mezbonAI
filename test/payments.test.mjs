// Octo and Payme against local stand-ins that follow their published specs, not the real services.
import test from "node:test";
import assert from "node:assert/strict";
import { day, freeAt, OCTO, PAYME, req, serve, settle, setup, status } from "./helpers.mjs";

/** A small Octo: remembers payments, can be told to succeed, fail, or lose answers. */
function fakeOcto() {
  const pays = new Map(), calls = [], o = { pays, calls, down: false, refundAnswer: "succeeded", url: "https://pay2.octo.uz/pay/x" };
  o.fetch = async (url, init) => {
    const path = new URL(url).pathname.slice(1), b = JSON.parse(init.body);
    calls.push({ path, body: b });
    assert.equal(new URL(url).origin, "https://secure.octo.uz");
    if (o.down) throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    const reply = (data) => ({ status: 200, json: async () => ({ error: 0, data }) });
    if (path === "refund") {
      const p = [...pays.values()].find((x) => x.octo_payment_UUID === b.octo_payment_UUID);
      if (o.refundAnswer === "succeeded") p.refunded_sum = b.amount;
      if (o.loseRefund) { o.loseRefund = false; throw new Error("answer lost"); }
      return reply({ status: o.refundAnswer });
    }
    let p = pays.get(b.shop_transaction_id);
    if (!p && b.total_sum == null) return { status: 200, json: async () => ({ error: 1, errMessage: "not found" }) };
    if (!p) pays.set(b.shop_transaction_id, (p = { shop_transaction_id: b.shop_transaction_id, octo_payment_UUID: `uuid-${pays.size + 1}`, status: "created", octo_pay_url: o.url, total_sum: b.total_sum, refunded_sum: 0 }));
    return reply({ ...p });
  };
  return o;
}
const octoSetup = async () => { const octo = fakeOcto(); return { octo, ...(await setup({ env: OCTO, fetchFn: octo.fetch })) }; };

// ---- Octo -----------------------------------------------------------------------------------------
test("Octo: the guest is sent to Octo, and only Octo's own answer marks the booking paid", async () => {
  const { octo, core, payments, book, l, events, db } = await octoSetup();
  const b = await book();
  const { url } = await payments.startBooking(b.token, "octo");
  assert.equal(url, octo.url);
  const sent = octo.calls[0].body, [pid, p] = [...octo.pays][0];
  assert.deepEqual([sent.total_sum, sent.currency, sent.auto_capture, sent.notify_url], [300_000, "UZS", true, "https://silkroad.test/pay/octo"]);
  assert.deepEqual(await payments.startBooking(b.token, "octo"), { url }, "pressing twice makes no second bill");
  assert.equal(octo.pays.size, 1);
  // A forged notification changes nothing.
  await payments.octoNotify({ shop_transaction_id: pid, status: "succeeded", total_sum: 300_000 });
  assert.equal((await core.guestBooking(b.token)).status, "pending");
  assert.equal((await payments.octoNotify({ shop_transaction_id: "p_made_up", status: "succeeded" })).status, "ignored");
  p.status = "succeeded";
  for (let i = 0; i < 3; i++) await payments.octoNotify({ shop_transaction_id: pid });
  const paid = await core.guestBooking(b.token);
  assert.deepEqual([paid.status, paid.payment.status, paid.payment.provider], ["paid", "paid", "octo"]);
  await settle();
  assert.deepEqual(events, ["booking"], "the provider is told once");
  assert.equal(await freeAt(core, l, 2), 2);
  assert.ok(!JSON.stringify(paid).includes("uuid-"), "guests do not see payment internals");
  assert.equal((await db.one("SELECT COUNT(*) n FROM audit_log WHERE action='payment_paid'")).n, 1);
});

test("Octo: a wrong amount, a swapped payment or a foreign pay page is refused", async () => {
  const { octo, core, payments, book } = await octoSetup();
  const b = await book();
  await payments.startBooking(b.token, "octo");
  const [pid, p] = [...octo.pays][0];
  Object.assign(p, { status: "succeeded", total_sum: 1000 });
  await assert.rejects(payments.octoNotify({ shop_transaction_id: pid }), /summasi/);
  Object.assign(p, { total_sum: 300_000, octo_payment_UUID: "other" });
  await assert.rejects(payments.octoNotify({ shop_transaction_id: pid }), /boshqa/);
  assert.equal((await core.guestBooking(b.token)).status, "pending");
  for (const url of ["https://octo.uz.evil.test/x", "http://pay.octo.uz/x", "javascript:alert(1)"]) {
    octo.url = url;
    await status(payments.startBooking((await book({ date: day(5), guests: 1 })).token, "octo"), 502);
  }
});

test("Octo: when it does not answer, the booking stays payable and a new try works", async () => {
  const { octo, core, payments, book } = await octoSetup();
  const b = await book();
  octo.down = true;
  await status(payments.startBooking(b.token, "octo"), 502);
  octo.down = false;
  await payments.startBooking(b.token, "octo");
  assert.equal((await core.guestBooking(b.token)).status, "pending");
  await status(payments.startBooking(b.token, "payme"), 400);
  await status(payments.startBooking(b.token, "test"), 400);
  await status(payments.startBooking("nope", "octo"), 404);
});

test("Octo: a missed notification is found by the background job and by the returning guest", async () => {
  const { octo, core, payments, book, db } = await octoSetup();
  const a = await book(), b = await book({ date: day(3) });
  await payments.startBooking(a.token, "octo");
  await payments.startBooking(b.token, "octo");
  for (const p of octo.pays.values()) p.status = "succeeded";
  await db.run("UPDATE payments SET updated_at = now() - interval '1 minute' WHERE ref=?", await core.bookingId(a.token));
  await payments.refresh("booking", await core.bookingId(a.token));
  assert.equal((await core.guestBooking(a.token)).status, "paid");
  await payments.work();
  assert.equal((await core.guestBooking(b.token)).status, "paid");
});

test("declining or cancelling in time returns the money once, even when an answer is lost", async () => {
  const { octo, core, payments, book, host, db } = await octoSetup();
  const pay = async (o) => { const b = await book(o); await payments.startBooking(b.token, "octo"); const [pid, p] = [...octo.pays].at(-1); p.status = "succeeded"; await payments.octoNotify({ shop_transaction_id: pid }); return b; };
  const refunds = () => octo.calls.filter((c) => c.path === "refund");
  const a = await pay();
  await core.decide(host.key, await core.bookingId(a.token), false);
  await settle(120);
  assert.deepEqual([(await core.guestBooking(a.token)).payment.status, refunds().length, refunds()[0].body.amount], ["refunded", 1, 300_000]);
  const b = await pay({ date: day(4) });
  octo.loseRefund = true; // the refund happens, the answer does not arrive
  await core.cancel(b.token);
  await settle(120);
  assert.equal((await core.guestBooking(b.token)).payment.status, "refund_due");
  await payments.work();
  assert.equal(refunds().length, 2, "no second attempt within a minute");
  await db.run("UPDATE refunds SET updated_at = now() - interval '2 minutes'");
  await payments.work();
  assert.deepEqual([(await core.guestBooking(b.token)).payment.status, refunds().length], ["refunded", 2], "it looks before refunding again");
  const c = await pay({ date: day(5) });
  octo.refundAnswer = "failed";
  await core.cancel(c.token);
  await settle(120);
  assert.deepEqual((await payments.refundsDue()).map((r) => r.provider), ["octo"]);
});

test("money that arrives too late or twice goes back by itself", async () => {
  const { octo, core, payments, book, db, l } = await octoSetup();
  const late = await book({ guests: 4 });
  await payments.startBooking(late.token, "octo");
  await db.run("UPDATE bookings SET expires_at = now() - interval '1 minute'");
  const winner = await book({ guests: 4 });
  const [pid, p] = [...octo.pays][0];
  p.status = "succeeded";
  await payments.octoNotify({ shop_transaction_id: pid });
  await settle(120);
  const g = await core.guestBooking(late.token);
  assert.deepEqual([g.status, g.payment.status], ["expired", "refunded"]);
  assert.equal((await core.guestBooking(winner.token)).status, "pending");
  assert.equal(await freeAt(core, l, 2), 0);

  // An expired hold whose place is still free is simply honoured.
  const slow = await book({ date: day(6) });
  await payments.startBooking(slow.token, "octo");
  await db.run("UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE token=?", slow.token);
  const [pid2, p2] = [...octo.pays].at(-1);
  p2.status = "succeeded";
  await payments.octoNotify({ shop_transaction_id: pid2 });
  assert.equal((await core.guestBooking(slow.token)).status, "paid");

  // Two bills for one booking, both paid.
  const twice = await book({ date: day(7) });
  await payments.startBooking(twice.token, "octo");
  await db.run("UPDATE payments SET created_at = now() - interval '30 minutes' WHERE ref=?", await core.bookingId(twice.token));
  await payments.startBooking(twice.token, "octo");
  for (const [k, v] of [...octo.pays].slice(-2)) { v.status = "succeeded"; await payments.octoNotify({ shop_transaction_id: k }); }
  await settle(120);
  assert.deepEqual((await db.all("SELECT status FROM payments WHERE ref=? ORDER BY created_at", await core.bookingId(twice.token))).map((r) => r.status).sort(), ["paid", "refunded"]);
  assert.equal((await core.guestBooking(twice.token)).status, "paid");
});

test("a guest never waits for an answer that does not come", async () => {
  const { core, confirm, payTest, book, db, events, guestEvents } = await setup();
  const b = await book({ date: day(5) });
  await payTest(b.token);
  assert.ok(new Date((await core.guestBooking(b.token)).decide_by) - Date.now() <= 24 * 3600e3);
  assert.equal(await core.declineUnanswered(), 0);
  await db.run("UPDATE bookings SET decide_by = now() - interval '1 second' WHERE status='paid'");
  assert.deepEqual([await core.declineUnanswered(), await core.declineUnanswered()], [1, 0]);
  await settle(120);
  const g = await core.guestBooking(b.token);
  assert.deepEqual([g.status, g.payment.status], ["declined", "refunded"]);
  assert.ok(events.includes("unanswered") && guestEvents.includes("declined"));
  const ok = await confirm({ date: day(6) });
  assert.equal(await core.declineUnanswered(), 0);
  assert.equal((await core.guestBooking(ok.token)).status, "confirmed");
});

// ---- Payme ----------------------------------------------------------------------------------------
async function paymeSetup() {
  const s = await setup({ env: PAYME }), auth = "Basic " + Buffer.from("Paycom:payme-key").toString("base64");
  const rpc = async (method, params, a = auth) => s.payments.payme(a, JSON.stringify({ jsonrpc: "2.0", id: 5, method, params }));
  const bill = async (o) => {
    const b = await s.book(o), { url } = await s.payments.startBooking(b.token, "payme");
    const q = Object.fromEntries(Buffer.from(new URL(url).pathname.slice(1), "base64").toString().split(";").map((x) => x.split(/=(.*)/s)));
    return { b, q, order: q["ac.order_id"], amount: Number(q.a), p: { amount: Number(q.a), account: { order_id: q["ac.order_id"] } } };
  };
  return { ...s, rpc, bill, auth };
}
const code = (r) => r.error?.code;

test("Payme: the checkout link carries the right bill", async () => {
  const { bill } = await paymeSetup();
  const { q, b } = await bill();
  assert.deepEqual([q.m, q.a, q.l], ["m1", String(300_000 * 100), "en"]);
  assert.equal(q.c, `https://silkroad.test/?b=${b.token}&lang=zh`);
});

test("Payme: authentication, malformed requests and unknown methods", async () => {
  const { payments, rpc, auth } = await paymeSetup();
  for (const a of [undefined, "", "Basic", "Bearer x", "Basic " + Buffer.from("Paycom:wrong").toString("base64"), "Basic " + Buffer.from("Paycom:payme-key2").toString("base64"), "Basic " + Buffer.from(":").toString("base64")]) assert.equal(code(await rpc("CheckTransaction", { id: "x" }, a ?? null)), -32504, String(a));
  assert.equal(code(await payments.payme(auth, "{")), -32700);
  for (const raw of ["[]", "1", "null", '{"id":1}', '{"method":"CheckTransaction"}']) assert.equal(code(await payments.payme(auth, raw)), -32600, raw);
  assert.equal(code(await rpc("constructor", {})), -32601);
  assert.deepEqual([(await rpc("x", {})).id, Object.keys((await rpc("x", {})).error.message).sort()], [5, ["en", "ru", "uz"]]);
  const off = await setup();
  assert.equal(code(await off.payments.payme(auth, "{}")), -32504, "not connected");
});

test("Payme: create, perform, check, cancel follow the protocol and repeat safely", async () => {
  const { rpc, bill, core, events } = await paymeSetup();
  const { b, p, order } = await bill(), time = Date.now();
  assert.equal(code(await rpc("CheckPerformTransaction", { ...p, account: { order_id: "nope" } })), -31050);
  assert.equal(code(await rpc("CheckPerformTransaction", { ...p, account: {} })), -31050);
  assert.equal(code(await rpc("CheckPerformTransaction", { ...p, amount: 1 })), -31001);
  assert.equal(code(await rpc("CheckPerformTransaction", { ...p, amount: "30000000" })), -31001);
  assert.deepEqual((await rpc("CheckPerformTransaction", p)).result, { allow: true });
  for (const m of ["PerformTransaction", "CancelTransaction", "CheckTransaction"]) assert.equal(code(await rpc(m, { id: "t1", reason: 1 })), -31003, m);
  const made = (await rpc("CreateTransaction", { ...p, id: "t1", time })).result;
  assert.deepEqual([made.state, made.transaction], [1, order]);
  assert.deepEqual((await rpc("CreateTransaction", { ...p, id: "t1", time })).result, made);
  assert.equal(code(await rpc("CreateTransaction", { ...p, id: "t2", time })), -31008, "one bill, one transaction");
  assert.equal((await core.guestBooking(b.token)).status, "pending");
  const done = (await rpc("PerformTransaction", { id: "t1" })).result;
  assert.equal(done.state, 2);
  assert.deepEqual((await rpc("PerformTransaction", { id: "t1" })).result, done);
  assert.equal((await core.guestBooking(b.token)).status, "paid");
  await settle();
  assert.deepEqual(events, ["booking"]);
  assert.equal(code(await rpc("CreateTransaction", { ...p, id: "t3", time })), -31051);
  const check = (await rpc("CheckTransaction", { id: "t1" })).result;
  assert.deepEqual([check.state, check.create_time, check.perform_time, check.cancel_time, check.reason], [2, made.create_time, done.perform_time, 0, null]);
  const cancelled = (await rpc("CancelTransaction", { id: "t1", reason: 5 })).result;
  assert.equal(cancelled.state, -2);
  assert.deepEqual((await rpc("CancelTransaction", { id: "t1", reason: 5 })).result, cancelled);
  assert.equal(code(await rpc("PerformTransaction", { id: "t1" })), -31008);
  const g = await core.guestBooking(b.token);
  assert.deepEqual([g.status, g.payment.status], ["cancelled", "refunded"]);
  const st = (await rpc("GetStatement", { from: time - 1, to: time + 1 })).result.transactions;
  assert.deepEqual([st.length, st[0].id, st[0].amount, st[0].state, st[0].account.order_id], [1, "t1", 30_000_000, -2, order]);
  assert.equal((await rpc("GetStatement", { from: 1, to: 2 })).result.transactions.length, 0);
});

test("Payme: cancel before paying, and the twelve-hour limit", async () => {
  const { rpc, bill, core, db, payments } = await paymeSetup();
  const a = await bill();
  await rpc("CreateTransaction", { ...a.p, id: "a", time: Date.now() });
  assert.equal((await rpc("CancelTransaction", { id: "a", reason: 3 })).result.state, -1);
  assert.equal(code(await rpc("CreateTransaction", { ...a.p, id: "a2", time: Date.now() })), -31051);
  assert.ok((await payments.startBooking(a.b.token, "payme")).url, "the guest can ask for a new bill");
  const b = await bill({ date: day(4) });
  assert.equal(code(await rpc("CreateTransaction", { ...b.p, id: "old", time: Date.now() - 13 * 3600e3 })), -31008);
  await rpc("CreateTransaction", { ...b.p, id: "b", time: Date.now() });
  await db.run("UPDATE payments SET create_ms=? WHERE ext_id='b'", Date.now() - 13 * 3600e3);
  assert.equal(code(await rpc("PerformTransaction", { id: "b" })), -31008);
  const c = (await rpc("CheckTransaction", { id: "b" })).result;
  assert.deepEqual([c.state, c.reason], [-1, 4], "the timeout is remembered");
  assert.equal((await core.guestBooking(b.b.token)).status, "pending");
});

test("Payme: money is refused when the place is gone, and a visit that happened cannot be cancelled", async () => {
  const { rpc, bill, core, book, db, host } = await paymeSetup();
  const a = await bill({ guests: 4 });
  await rpc("CreateTransaction", { ...a.p, id: "a", time: Date.now() });
  await db.run("UPDATE bookings SET expires_at = now() - interval '1 minute'");
  await book({ guests: 1 });
  assert.equal(code(await rpc("PerformTransaction", { id: "a" })), -31008);
  assert.equal(code(await rpc("CheckPerformTransaction", a.p)), -31051);

  const b = await bill({ date: day(5) });
  await rpc("CreateTransaction", { ...b.p, id: "b", time: Date.now() });
  await rpc("PerformTransaction", { id: "b" });
  await core.decide(host.key, await core.bookingId(b.b.token), true);
  await db.run("UPDATE bookings SET date=? WHERE token=?", day(0), b.b.token);
  await core.checkIn(host.key, (await core.guestBooking(b.b.token)).ticket.code);
  assert.equal(code(await rpc("CancelTransaction", { id: "b", reason: 5 })), -31007);
});

test("Payme: two calls at the same moment make one transaction", async () => {
  const { rpc, bill, core, events } = await paymeSetup();
  const { p, b } = await bill();
  const made = await Promise.all(["x", "y", "x", "z"].map((id) => rpc("CreateTransaction", { ...p, id, time: Date.now() })));
  assert.equal(new Set(made.filter((r) => r.result).map((r) => r.result.create_time)).size, 1);
  const id = ["x", "y", "x", "z"][made.findIndex((r) => r.result)];
  const done = await Promise.all(Array.from({ length: 4 }, () => rpc("PerformTransaction", { id })));
  assert.equal(new Set(done.map((r) => r.result.perform_time)).size, 1);
  assert.equal((await core.guestBooking(b.token)).status, "paid");
  await settle();
  assert.deepEqual(events, ["booking"]);
});

test("Payme over HTTP: always 200, no cookies or origin needed; refunds it makes are confirmed by its own call", async () => {
  const app = await serve({ env: PAYME }), h = await app.core.createHost("R"), l = await app.publishListing(h.key);
  const call = (body, auth) => fetch(app.base + "/pay/payme", { method: "POST", headers: { "Content-Type": "text/json; charset=UTF-8", ...(auth && { Authorization: auth }) }, body });
  const r = await call("{}");
  assert.deepEqual([r.status, (await r.json()).error.code], [200, -32504]);
  assert.equal((await fetch(app.base + "/pay/payme")).status, 404);
  const b = await app.core.book(req(l)), { url } = await app.payments.startBooking(b.token, "payme");
  const order = /order_id=(p_\w+)/.exec(Buffer.from(new URL(url).pathname.slice(1), "base64").toString())[1], auth = "Basic " + Buffer.from("Paycom:payme-key").toString("base64");
  const rpc = async (method, params) => (await call(JSON.stringify({ id: 1, method, params }), auth)).json();
  await rpc("CreateTransaction", { id: "h1", time: Date.now(), amount: 30_000_000, account: { order_id: order } });
  await rpc("PerformTransaction", { id: "h1" });
  await app.core.decide(h.key, await app.core.bookingId(b.token), false);
  await settle(120);
  assert.equal((await app.core.guestBooking(b.token)).payment.status, "refund_due", "waits for the refund in Payme's cabinet");
  assert.equal((await rpc("CancelTransaction", { id: "h1", reason: 5 })).result.state, -2);
  assert.equal((await app.core.guestBooking(b.token)).payment.status, "refunded");
});

// ---- plans and payouts ------------------------------------------------------------------------------
test("plans are paid the same way, delivered once, and never lost when the plan changed meanwhile", async () => {
  const { rpc, payments, core, host, db } = await paymeSetup();
  const order = async (plan) => /order_id=(p_\w+);a=(\d+)/.exec(Buffer.from(new URL((await payments.startPlan(host.key, plan, "payme")).url).pathname.slice(1), "base64").toString()).slice(1);
  const pro = await order("pro"), business = await order("business");
  const buy = async ([id, a], t) => { await rpc("CreateTransaction", { id: t, time: Date.now(), amount: Number(a), account: { order_id: id } }); return rpc("PerformTransaction", { id: t }); };
  await buy(business, "t1");
  assert.equal((await core.plans(host.key)).current.plan, "business");
  const until = +new Date((await core.plans(host.key)).current.until);
  await buy(pro, "t2"); // opened earlier, paid later
  const after = (await core.plans(host.key)).current;
  assert.equal(after.plan, "business", "a lower plan never replaces a higher one");
  assert.ok(+new Date(after.until) - until > 8 * 864e5, "the money became extra days");
  assert.equal((await core.plans(host.key)).invoices.length, 2);
  await payments.work();
  assert.equal((await db.one("SELECT COUNT(*) n FROM invoices")).n, 2);
  assert.equal(code(await rpc("CancelTransaction", { id: "t1", reason: 5 })), -31007);
});

test("payouts: only delivered visits count, never more than the balance, never test money on a real site", async () => {
  const { confirm, payments, host, core, db } = await setup(), pay = (n, ref = "BANK-1") => payments.recordPayout(host.id, n, ref);
  const a = await confirm({ date: day(3) });
  assert.deepEqual([(await payments.balance(host.id)).available, (await payments.balance(host.id)).upcoming], [0, 264_000]);
  await status(pay(1000), 409);
  await db.run("UPDATE bookings SET date=? WHERE token=?", day(0), a.token);
  await core.checkIn(host.key, a.ticket.code);
  assert.equal((await payments.hostBalance(host.key)).available, 264_000);
  for (const [n, ref, s] of [[264_001, "B", 409], [0, "B", 400], [-5, "B", 400], [1.5, "B", 400], [1000, " ", 400]]) await status(pay(n, ref), s);
  const tries = await Promise.allSettled([pay(200_000), pay(200_000), pay(200_000)]);
  assert.equal(tries.filter((t) => t.status === "fulfilled").length, 1, "three clicks at once pay once");
  assert.deepEqual([(await payments.balance(host.id)).available, (await payments.balance(host.id)).paid_out], [64_000, 200_000]);
  const live = await setup({ env: PAYME });
  await live.db.run("UPDATE hosts SET id=id");
  const b = await live.book();
  await live.db.run("UPDATE bookings SET status='confirmed', ticket_code='ABC', checked_in_at=now() WHERE token=?", b.token);
  await live.db.run("INSERT INTO payments (id,kind,ref,provider,amount_uzs,status) VALUES ('p_t','booking',?,'test',300000,'paid')", await live.core.bookingId(b.token));
  await live.db.run("UPDATE payments SET paid_at=now()");
  await live.db.run("INSERT INTO payment_items (payment_id,booking_id,amount_uzs) VALUES ('p_t',?,300000)", await live.core.bookingId(b.token));
  assert.equal((await live.payments.balance(live.host.id)).available, 0);
});
