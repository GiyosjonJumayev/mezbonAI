import test from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { generateRequestDetails } from "web-push";
import { okEndpoint } from "../src/domain/push.mjs";
import { UI } from "../src/lib/i18n.mjs";
import { tashkentNow } from "../src/lib/util.mjs";
import { day, req, serve, settle as tick } from "./helpers.mjs";

const keys = () => { const e = createECDH("prime256v1"); e.generateKeys(); return { p256dh: e.getPublicKey("base64url"), auth: randomBytes(16).toString("base64url") }; };
const sub = (id = "a") => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, keys: keys() });
async function setup() {
  const sent = [];
  let reply = () => {};
  const app = await serve({ pushSend: async (s, body, o) => { sent.push({ to: s.endpoint, body: JSON.parse(body), request: generateRequestDetails(s, body, o) }); return reply(s); } });
  const { core } = app, host = await core.createHost("Rustam"), l = await app.publishListing(host.key);
  const book = async (d = 3) => { const b = await core.book(req(l, { date: day(d) })); await app.payTest(b.token); return b; };
  const accept = async () => core.decide(host.key, (await core.hostHome(host.key)).bookings.find((x) => x.status === "paid").id, true);
  return { ...app, host, l, book, accept, sent, onSend: (f) => { reply = f; } };
}

test("only real push services are accepted, so the server cannot be aimed at other hosts", () => {
  for (const u of ["https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://wns2-par02p.notify.windows.com/w/?token=x", "https://web.push.apple.com/Qx"]) assert.ok(okEndpoint(u), u);
  for (const u of ["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://fcm.googleapis.com.evil.test/x", "https://evil.test/fcm.googleapis.com", "https://fcm.googleapis.com:8443/x", "https://a@fcm.googleapis.com/x", "https://notify.windows.com.evil.test/x", "file:///etc/passwd", "x", null, "https://fcm.googleapis.com/" + "a".repeat(1000)]) assert.ok(!okEndpoint(u), String(u));
});

test("subscriptions are validated, owned, capped and can be removed", async () => {
  const { push, db, host, core, book } = await setup();
  for (const s of [null, {}, { endpoint: sub().endpoint }, { ...sub(), keys: { p256dh: "x", auth: "y" } }, { ...sub(), endpoint: "https://127.0.0.1/" }]) await assert.rejects(() => push.subscribe("host", host.id, s), (e) => e.status === 400);
  for (let i = 0; i < 13; i++) await push.subscribe("host", host.id, sub("n" + i));
  assert.equal((await db.one("SELECT COUNT(*) n FROM push_subs")).n, 10);
  await push.unsubscribe("host", host.id, sub("n12").endpoint);
  assert.equal((await db.one("SELECT COUNT(*) n FROM push_subs")).n, 9);
  await assert.rejects(() => core.bookingId("nope"), (e) => e.status === 404);
  assert.match(await core.bookingId((await book()).token), /^b_/);
});

test("provider and guest are told about the right things in the right language", async () => {
  const { push, core, host, book, accept, sent } = await setup();
  await push.subscribe("host", host.id, sub("host"));
  // Notifications leave after the data is saved; wait for each one instead of guessing how long that takes.
  const arrived = async (n) => { for (let i = 0; i < 100 && sent.length < n; i++) await tick(20); assert.equal(sent.length, n, "notification sent"); };
  const b = await book();
  await push.subscribe("guest", await core.bookingId(b.token), sub("guest"));
  await arrived(1);
  assert.deepEqual([sent[0].to.endsWith("/host"), sent[0].body.title], [true, "Yangi bron"]);
  await accept();
  await arrived(2);
  assert.deepEqual([sent[1].to.endsWith("/guest"), sent[1].body.body], [true, UI.confirmed.zh]);
  assert.ok(sent[1].body.url.includes(b.token));
  await core.message("host", host.key, { booking_id: await core.bookingId(b.token), code: "r_yes" });
  await arrived(3);
  assert.equal(sent[2].body.body, "可以，欢迎！");
  await core.cancel(b.token);
  await arrived(4);
  assert.equal(sent[3].body.title, "Bron bekor qilindi");
  // Encrypted for the browser, signed by this server, and nothing readable on the wire.
  assert.match(sent[0].request.headers.Authorization, /^vapid /);
  assert.ok(!sent[0].request.body.toString("latin1").includes("Li Wei"));
});

test("reminders: once, only for confirmed visits within 24 hours", async () => {
  const { db, push, core, book, accept, remind, sent } = await setup();
  const b = await book();
  await push.subscribe("guest", await core.bookingId(b.token), sub("g"));
  const at = async (h) => { const s = tashkentNow(new Date(Date.now() + h * 3600e3)); await db.run("UPDATE bookings SET date=?, time=?", s.slice(0, 10), s.slice(11, 16)); };
  await at(5);
  await remind();
  assert.equal(sent.length, 0, "not confirmed yet");
  await accept();
  await at(30);
  await remind();
  assert.equal(sent.filter((s) => s.body.body.startsWith(UI.remind.zh)).length, 0, "too early");
  await at(5);
  await remind();
  await remind();
  assert.equal(sent.filter((s) => s.body.body.startsWith(UI.remind.zh)).length, 1);
  await db.run("UPDATE bookings SET reminded_at=NULL");
  await at(-1);
  await remind();
  assert.equal(sent.filter((s) => s.body.body.startsWith(UI.remind.zh)).length, 1, "already started");
});

test("a dropped subscription is forgotten; a failing push service never breaks a booking", async () => {
  const { db, push, core, host, book, onSend } = await setup();
  await push.subscribe("host", host.id, sub("gone"));
  onSend(() => { throw Object.assign(new Error("x"), { statusCode: 500 }); });
  assert.equal((await core.guestBooking((await book()).token)).status, "paid");
  await tick();
  assert.equal((await db.one("SELECT COUNT(*) n FROM push_subs")).n, 1);
  onSend(() => { throw Object.assign(new Error("x"), { statusCode: 410 }); });
  await book(4);
  await tick();
  assert.equal((await db.one("SELECT COUNT(*) n FROM push_subs")).n, 0);
});

test("HTTP: subscribing needs the provider key or the booking link; keys survive a restart", async () => {
  const s = await setup();
  assert.equal((await s.post("/api/push/host", { subscription: sub() })).status, 401);
  assert.equal((await s.post("/api/push/host", { subscription: sub() }, { "X-Host-Key": s.host.key })).status, 200);
  assert.equal((await s.post("/api/push/guest/nope", { subscription: sub() })).status, 404);
  assert.equal((await s.post(`/api/push/guest/${(await s.book()).token}`, { subscription: { endpoint: "https://127.0.0.1/" } })).status, 400);
  const { key } = await s.get("/api/push/key");
  assert.equal((await serve({ db: s.db })).push.publicKey, key);
});
