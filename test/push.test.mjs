import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createECDH, randomBytes } from "node:crypto";

process.env.MEZBON_OFFLINE = "1";
process.env.MEZBON_DATA = mkdtempSync(path.join(os.tmpdir(), "mezbon-"));
const { openDb } = await import("../src/db.mjs");
const { createApp } = await import("../src/server.mjs");
const { okEndpoint } = await import("../src/push.mjs");
const { tashkentNow } = await import("../src/core.mjs");
const { generateRequestDetails } = await import("web-push");
const { UI } = await import("../src/i18n.mjs");

const DAY = 864e5, day = (n) => tashkentNow(new Date(Date.now() + n * DAY)).slice(0, 10);
const keys = () => { const e = createECDH("prime256v1"); e.generateKeys(); return { p256dh: e.getPublicKey("base64url"), auth: randomBytes(16).toString("base64url") }; };
const sub = (id = "a") => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, keys: keys() });

async function setup() {
  const db = openDb(":memory:"), sent = [];
  let reply = () => {};
  const app = createApp(db, { telegram: null, pushSend: async (s, body, o) => { sent.push({ to: s.endpoint, body: JSON.parse(body), request: generateRequestDetails(s, body, o) }); return reply(s); } });
  const { core, push } = app, host = core.createHost("Rustam");
  const l = await core.createDraft(host.key, "Rishtonda kulolman, ikki soat, 150 ming so'm, 4 kishi");
  core.updateListing(host.key, l.id, { weekdays: [1, 2, 3, 4, 5, 6, 7] });
  core.publish(host.key, l.id);
  const book = (d = 3) => { const b = core.book({ listing_id: l.id, date: day(d), time: "10:00", guests: 2, guest_name: "Li Wei", lang: "zh" }); core.payTest(b.token); return b; };
  const accept = () => core.decide(host.key, core.hostHome(host.key).bookings.find((x) => x.status === "paid").id, true);
  return { ...app, db, core, push, host, l, book, accept, sent, onSend: (f) => { reply = f; } };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

test("only real push services are accepted, so the server cannot be aimed at other hosts", () => {
  for (const u of ["https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://wns2-par02p.notify.windows.com/w/?token=x", "https://web.push.apple.com/Qx"]) assert.ok(okEndpoint(u), u);
  for (const u of ["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://fcm.googleapis.com.evil.test/x", "https://evil.test/fcm.googleapis.com", "https://fcm.googleapis.com:8443/x", "https://a@fcm.googleapis.com/x", "https://notify.windows.com.evil.test/x", "file:///etc/passwd", "x", null, "https://fcm.googleapis.com/" + "a".repeat(1000)]) assert.ok(!okEndpoint(u), String(u));
});

test("subscriptions are validated, owned, capped and can be removed", async () => {
  const { push, db, host, core, book } = await setup();
  for (const s of [null, {}, { endpoint: sub().endpoint }, { ...sub(), keys: { p256dh: "x", auth: "y" } }, { ...sub(), endpoint: "https://127.0.0.1/" }]) assert.throws(() => push.subscribe("host", host.id, s), (e) => e.status === 400);
  for (let i = 0; i < 13; i++) push.subscribe("host", host.id, sub("n" + i));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM push_subs").get().n, 10);
  push.unsubscribe("host", host.id, sub("n12").endpoint);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM push_subs").get().n, 9);
  assert.throws(() => core.bookingId("nope"), (e) => e.status === 404);
  assert.match(core.bookingId(book().token), /^b_/);
});

test("provider and guest are told about the right things in the right language", async () => {
  const { push, core, host, book, accept, sent } = await setup();
  push.subscribe("host", host.id, sub("host"));
  const b = book();
  push.subscribe("guest", core.bookingId(b.token), sub("guest"));
  await tick();
  assert.deepEqual([sent[0].to.endsWith("/host"), sent[0].body.title], [true, "Yangi bron"]);
  accept();
  await tick();
  assert.deepEqual([sent[1].to.endsWith("/guest"), sent[1].body.body], [true, UI.confirmed.zh]);
  assert.ok(sent[1].body.url.includes(b.token));
  await core.message("host", host.key, { booking_id: core.bookingId(b.token), code: "r_yes" });
  await tick();
  assert.equal(sent[2].body.body, "可以，欢迎！");
  core.cancel(b.token);
  await tick();
  assert.equal(sent[3].body.title, "Bron bekor qilindi");
  // Encrypted for the browser, signed by this server, and nothing readable on the wire.
  assert.match(sent[0].request.headers.Authorization, /^vapid /);
  assert.ok(!sent[0].request.body.toString("latin1").includes("Li Wei"));
});

test("reminders: once, only for confirmed visits within 24 hours", async () => {
  const { db, push, core, book, accept, remind, sent } = await setup();
  const b = book();
  push.subscribe("guest", core.bookingId(b.token), sub("g"));
  const at = (h) => { const s = tashkentNow(new Date(Date.now() + h * 3600e3)); db.prepare("UPDATE bookings SET date=?, time=?").run(s.slice(0, 10), s.slice(11, 16)); };
  at(5);
  await remind();
  assert.equal(sent.length, 0, "not confirmed yet");
  accept();
  at(30);
  await remind();
  assert.equal(sent.filter((s) => s.body.body.startsWith(UI.remind.zh)).length, 0, "too early");
  at(5);
  await remind();
  await remind();
  assert.equal(sent.filter((s) => s.body.body.startsWith(UI.remind.zh)).length, 1);
  db.prepare("UPDATE bookings SET reminded_at=NULL").run();
  at(-1);
  await remind();
  assert.equal(sent.filter((s) => s.body.body.startsWith(UI.remind.zh)).length, 1, "already started");
});

test("a dropped subscription is forgotten; a failing push service never breaks a booking", async () => {
  const { db, push, core, host, book, onSend } = await setup();
  push.subscribe("host", host.id, sub("gone"));
  onSend(() => { throw Object.assign(new Error("x"), { statusCode: 500 }); });
  assert.equal(core.guestBooking(book().token).status, "paid");
  await tick();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM push_subs").get().n, 1);
  onSend(() => { throw Object.assign(new Error("x"), { statusCode: 410 }); });
  book(4);
  await tick();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM push_subs").get().n, 0);
});

test("HTTP: subscribing needs the provider key or the booking link; keys survive a restart", async () => {
  const s = await setup();
  await new Promise((r) => s.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${s.server.address().port}`;
  const post = (p, b, h = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) });
  assert.equal((await post("/api/push/host", { subscription: sub() })).status, 401);
  assert.equal((await post("/api/push/host", { subscription: sub() }, { "X-Host-Key": s.host.key })).status, 200);
  assert.equal((await post("/api/push/guest/nope", { subscription: sub() })).status, 404);
  assert.equal((await post(`/api/push/guest/${s.book().token}`, { subscription: { endpoint: "https://127.0.0.1/" } })).status, 400);
  const { key } = await (await fetch(base + "/api/push/key")).json();
  assert.equal(createApp(s.db, { telegram: null }).push.publicKey, key);
  s.server.closeAllConnections();
  s.server.close();
});
