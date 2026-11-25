import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createBot } from "../src/adapters/telegram.mjs";
import { loadConfig } from "../src/config.mjs";
import { asHost } from "../src/domain/accounts.mjs";
import { clientIp } from "../src/http/guard.mjs";
import { day, OCTO, PAYME, req, serve, setup, status } from "./helpers.mjs";

const ADMIN = "a".repeat(12) + "-test-admin-key";
const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

// ---- settings -------------------------------------------------------------------------------------
test("unsafe settings stop the server from starting", () => {
  const bad = (env, re) => assert.match(loadConfig({ DATABASE_URL: "x", ...env }).problems.join("; "), re);
  bad({ NODE_ENV: "production", ADMIN_KEY: ADMIN }, /https/);
  bad({ NODE_ENV: "production", PUBLIC_URL: "https://a.uz" }, /ADMIN_KEY/);
  bad({ ADMIN_KEY: "short" }, /24/);
  bad({ OCTO_SHOP_ID: "1" }, /OCTO_SECRET/);
  bad({ ...OCTO, PUBLIC_URL: "http://a.uz" }, /https/);
  bad({ ...OCTO, OCTO_SHOP_ID: "abc" }, /OCTO_SHOP_ID/);
  bad({ ...PAYME, FISCAL_INN: "1" }, /FISCAL/);
  assert.match(loadConfig({}).problems.join(), /DATABASE_URL/);
  assert.deepEqual(loadConfig({ DATABASE_URL: "x", NODE_ENV: "production", PUBLIC_URL: "https://a.uz", ADMIN_KEY: ADMIN }).problems, []);
  assert.equal(loadConfig({ ...OCTO }).testPayments, false, "real payments switch test payments off");
  assert.equal(loadConfig({ NODE_ENV: "production" }).testPayments, false);
});

// ---- sign-in --------------------------------------------------------------------------------------
test("secrets are not in the database, and a leaked hash is useless", async () => {
  const { db, core, host } = await setup(), s = await core.signIn(host.key, "Test"), link = await core.loginLink(host.key);
  const dump = [];
  for (const t of ["hosts", "sessions", "challenges", "audit_log"]) dump.push(...(await db.all(`SELECT t::text x FROM ${t} t`)).map((r) => r.x));
  for (const v of [host.key, s.token, link]) assert.ok(!dump.join().includes(v));
  const { key_hash } = await db.one("SELECT key_hash FROM hosts");
  for (const v of [key_hash, key_hash.toString("hex"), key_hash.toString("base64url"), { host_id: host.id }, host.id, null, undefined, [], ""]) await status(core.hostHome(v), 401);
});

test("the browser gets an HttpOnly session; the key works once per sign-in; sign-out ends it", async () => {
  const s = await serve(), origin = { Origin: s.base };
  const r = await s.post("/api/hosts", { name: "Olim" }, origin), raw = r.headers.getSetCookie()[0], me = await r.json();
  assert.match(raw, /^sr=s_[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  const jar = { Cookie: cookieOf(r), ...origin };
  assert.equal((await s.get("/api/host", jar)).name, "Olim");
  const again = await s.post("/api/auth/key", { key: me.key }, origin), jar2 = { Cookie: cookieOf(again), ...origin };
  assert.deepEqual(Object.keys(await again.json()).sort(), ["id", "name", "type"]);
  assert.equal((await s.get("/api/host/account", jar)).sessions.length, 2);
  assert.equal((await s.post("/api/auth/sign-out", {}, jar2)).status, 200);
  assert.equal((await fetch(s.base + "/api/host", { headers: jar2 })).status, 401);
  assert.equal((await fetch(s.base + "/api/host", { headers: jar })).status, 200);
  assert.equal((await s.post("/api/auth/key", { key: jar.Cookie.slice(3) }, origin)).status, 401, "a session is not a key");
  // Lost phone: everything old stops at once.
  const rot = await s.post("/api/auth/rotate", {}, jar), fresh = await rot.json();
  for (const h of [jar, { "X-Host-Key": me.key }]) assert.equal((await fetch(s.base + "/api/host", { headers: h })).status, 401);
  assert.equal((await fetch(s.base + "/api/host", { headers: { Cookie: cookieOf(rot) } })).status, 200);
  assert.equal((await fetch(s.base + "/api/host", { headers: { "X-Host-Key": fresh.key } })).status, 200);
});

test("sessions expire, and cookies are locked down on https", async () => {
  const { db, core, host } = await setup(), { token } = await core.signIn(host.key);
  await core.hostHome(token);
  await db.run("UPDATE sessions SET expires_at=now()");
  await status(core.hostHome(token), 401);
  const s = await serve({ env: { PUBLIC_URL: "https://silkroad.test" } });
  const r = await s.post("/api/hosts", { name: "A" });
  assert.match(r.headers.getSetCookie()[0], /^__Host-sr=.*HttpOnly; SameSite=Strict; .*Secure$/);
  assert.match(r.headers.get("strict-transport-security"), /max-age=31536000/);
});

test("another website cannot act with a provider's cookies", async () => {
  const s = await serve(), r = await s.post("/api/hosts", { name: "A" }), Cookie = cookieOf(r);
  for (const o of [{ Origin: "https://evil.test" }, { Origin: "null" }, { Origin: "http://localhost.evil.test:4321" }, {}]) assert.equal((await s.post("/api/host/drafts", { transcript: "x" }, { Cookie, ...o })).status, 403, JSON.stringify(o));
  assert.equal((await fetch(s.base + "/api/host/drafts", { method: "POST", headers: { Cookie, Origin: s.base, "Content-Type": "text/plain" }, body: "{}" })).status, 415);
  const prod = await serve({ db: s.db, env: { NODE_ENV: "production", PUBLIC_URL: "https://silkroad.test" } });
  assert.equal((await prod.post("/api/listings/x/report", {}, { Origin: prod.base })).status, 403, "only the configured address in production");
  assert.notEqual((await prod.post("/api/listings/x/report", {}, { Origin: "https://silkroad.test" })).status, 403);
});

test("one-time links: once, soon, and only for their provider", async () => {
  const { core, db, host } = await setup(), t = await core.loginLink(host.key);
  assert.equal((await core.useLink(t)).host.id, host.id);
  await status(core.useLink(t), 401);
  const t2 = await core.loginLink(host.key);
  await db.run("UPDATE challenges SET expires_at=now()");
  await status(core.useLink(t2), 401);
  for (const v of ["", null, "l_x", {}, "x".repeat(5000)]) await status(core.useLink(v), 401);
  const { id } = await core.passkeyLoginOptions();
  await status(core.useLink("l_" + id), 401);
});

test("Telegram: the bot acts for its own chat only and gives a one-time link, never the key", async () => {
  const { core, db } = await setup(), out = [], bot = createBot(core, async (c, t) => out.push([c, t]), { baseUrl: "https://silkroad.test" });
  const say = (id, text) => bot({ message: { chat: { id }, from: { first_name: "Ali" }, text } });
  await say(9, "/kirish");
  const token = /#kirish=(l_[\w-]+)/.exec(out.at(-1)[1])[1];
  assert.equal((await core.useLink(token)).host.name, "Ali");
  const other = await core.createHost("B"), d = await core.createDraft(other.key, "kulolman");
  await bot({ callback_query: { data: `pub:${d.id}`, message: { chat: { id: 9 } } } });
  assert.match(out.at(-1)[1], /topilmadi/);
  await bot({ message: { chat: { id: -100, type: "group" }, text: "/kirish" } });
  assert.equal(out.length, 2, "groups are ignored");
  assert.equal((await db.one("SELECT COUNT(*) n FROM hosts WHERE telegram_chat='9'")).n, 1);
  assert.equal(JSON.stringify(asHost("h_1")), "{}", "a server-side identity cannot be sent or received");
});

// ---- passkeys: a software authenticator ------------------------------------------------------------
const b64 = (b) => Buffer.from(b).toString("base64url");
const cbor = {
  int: (n) => (n >= 0 ? Buffer.from(n < 24 ? [n] : n < 256 ? [24, n] : [25, n >> 8, n & 255]) : (() => { const v = -1 - n; return v < 24 ? Buffer.from([0x20 | v]) : v < 256 ? Buffer.from([0x38, v]) : Buffer.from([0x39, v >> 8, v & 255]); })()),
  bytes: (b) => Buffer.concat([b.length < 24 ? Buffer.from([0x40 | b.length]) : b.length < 256 ? Buffer.from([0x58, b.length]) : Buffer.from([0x59, b.length >> 8, b.length & 255]), b]),
  text: (s) => Buffer.concat([Buffer.from([0x60 | s.length]), Buffer.from(s)]),
  map: (pairs) => Buffer.concat([Buffer.from([0xa0 | pairs.length]), ...pairs.flat()]),
};
function authenticator({ origin = "http://localhost:4321", rpId = "localhost", verified = true } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" }), id = randomBytes(16), jwk = publicKey.export({ format: "jwk" });
  let counter = 0;
  const data = (extra) => { const c = Buffer.alloc(4); c.writeUInt32BE(++counter); return Buffer.concat([createHash("sha256").update(rpId).digest(), Buffer.from([(verified ? 0x05 : 0x01) | (extra ? 0x40 : 0)]), c, extra ?? Buffer.alloc(0)]); };
  const client = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: b64(id),
    create(options) {
      const key = cbor.map([[cbor.int(1), cbor.int(2)], [cbor.int(3), cbor.int(-7)], [cbor.int(-1), cbor.int(1)], [cbor.int(-2), cbor.bytes(Buffer.from(jwk.x, "base64url"))], [cbor.int(-3), cbor.bytes(Buffer.from(jwk.y, "base64url"))]]);
      const authData = data(Buffer.concat([Buffer.alloc(16), Buffer.from([0, id.length]), id, key]));
      const att = cbor.map([[cbor.text("fmt"), cbor.text("none")], [cbor.text("attStmt"), cbor.map([])], [cbor.text("authData"), cbor.bytes(authData)]]);
      return { id: b64(id), rawId: b64(id), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64(client("webauthn.create", options.challenge)), attestationObject: b64(att), transports: ["internal"] } };
    },
    get(options) {
      const authData = data(), c = client("webauthn.get", options.challenge);
      return { id: b64(id), rawId: b64(id), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64(c), authenticatorData: b64(authData), signature: b64(sign("sha256", Buffer.concat([authData, createHash("sha256").update(c).digest()]), privateKey)) } };
    },
  };
}

test("passkeys: register, sign in, remove; replays, other sites and unverified users are refused", async () => {
  const { core, host } = await setup(), key = authenticator();
  const reg = await core.passkeyRegisterOptions(host.key);
  assert.deepEqual([reg.options.rp.id, reg.options.authenticatorSelection.userVerification], ["localhost", "required"]);
  const made = { id: reg.id, response: key.create(reg.options) };
  const other = await core.createHost("B");
  await status(core.passkeyRegister(other.key, made), 401); // and the challenge is now used up
  await status(core.passkeyRegister(host.key, made), 401);
  const reg2 = await core.passkeyRegisterOptions(host.key);
  await core.passkeyRegister(host.key, { id: reg2.id, response: key.create(reg2.options) });
  assert.equal((await core.account(host.key)).passkeys.length, 1);

  const login = async (a) => { const o = await core.passkeyLoginOptions(); return { id: o.id, response: a.get(o.options) }; };
  const ok = await login(key), s = await core.passkeyLogin(ok);
  assert.equal((await core.hostHome(s.token)).id, host.id);
  await status(core.passkeyLogin(ok), 401);
  await status(core.passkeyLogin(await login(authenticator())), 401);
  for (const o of [{ origin: "https://evil.test" }, { rpId: "evil.test" }, { verified: false }]) {
    const bad = authenticator(o), r = await core.passkeyRegisterOptions(host.key);
    await status(core.passkeyRegister(host.key, { id: r.id, response: bad.create(r.options) }), 401);
  }
  const o = await core.passkeyLoginOptions(), forged = key.get(o.options);
  forged.response.signature = b64(randomBytes(70));
  await status(core.passkeyLogin({ id: o.id, response: forged }), 401);
  const swapped = await core.passkeyLoginOptions(), stale = await core.passkeyLoginOptions();
  await status(core.passkeyLogin({ id: swapped.id, response: key.get(stale.options) }), 401);
  for (const v of [null, {}, { id: "x" }, { id: stale.id }, { id: stale.id, response: "x" }]) await status(core.passkeyLogin(v), 401);
  await core.passkeyRemove(other.key, key.id);
  assert.equal((await core.account(host.key)).passkeys.length, 1, "someone else cannot remove it");
  await core.passkeyRemove(host.key, key.id);
  await status(core.passkeyLogin(await login(key)), 401);
});

// ---- administration --------------------------------------------------------------------------------
test("admin: needs its own key, is rate limited, and every action is recorded", async () => {
  const s = await serve({ env: { ADMIN_KEY: ADMIN } }), origin = { Origin: s.base };
  const r = await s.post("/api/hosts", { name: "Ustoz" }), h = await r.json();
  for (const head of [{}, { Cookie: cookieOf(r) }, { "X-Host-Key": h.key }, { Cookie: "sra=1.2.3" }, { Cookie: `sra=${Date.now() + 1e6}.abcdefghijkl.${"A".repeat(43)}` }]) assert.equal((await fetch(s.base + "/api/admin", { headers: head })).status, 401);
  assert.equal((await s.post("/api/admin/login", { key: ADMIN + "x" }, origin)).status, 401);
  const jar = { Cookie: cookieOf(await s.post("/api/admin/login", { key: ADMIN }, origin)), ...origin };
  assert.equal((await fetch(s.base + "/api/admin", { headers: jar })).status, 200);
  assert.equal((await s.post(`/api/admin/hosts/${h.id}/verify`, { on: true }, { Cookie: jar.Cookie, Origin: "https://evil.test" })).status, 403);

  const l = await s.publishListing(h.key);
  assert.equal((await s.get(`/api/listings/${l.id}`)).verified, false);
  await s.post(`/api/admin/hosts/${h.id}/verify`, { on: true }, jar);
  assert.equal((await s.get(`/api/listings/${l.id}`)).verified, true);
  await s.post(`/api/listings/${l.id}/report`, { reason: "unsafe", details: "<b>x</b>" });
  assert.equal((await s.post(`/api/listings/${l.id}/report`, { reason: "constructor" })).status, 400);
  const view = await s.get("/api/admin", jar);
  assert.deepEqual([view.reports.length, view.reports[0].reason], [1, "unsafe"]);
  await s.post(`/api/admin/listings/${l.id}/block`, { on: true }, jar);
  assert.equal((await fetch(`${s.base}/api/listings/${l.id}`)).status, 404);
  await status(s.core.publish(h.key, l.id), 403);
  await s.post(`/api/admin/reports/${view.reports[0].id}/resolve`, {}, jar);
  const { url } = await (await s.post(`/api/admin/hosts/${h.id}/recovery`, {}, jar)).json();
  assert.equal((await s.core.useLink(url.split("kirish=")[1])).host.id, h.id);
  assert.deepEqual((await s.get("/api/admin", jar)).audit.map((a) => a.action), ["recovery_link", "report_resolved", "listing_blocked", "host_verified"]);
  assert.equal((await s.get("/api/admin/hosts?q=usto", jar))[0].name, "Ustoz");
  assert.equal((await s.get("/api/admin/hosts?q=%25", jar)).length, 0, "a percent sign is only a percent sign");

  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await s.post("/api/admin/login", { key: "guess" }, origin)).status);
  assert.ok(codes.includes(429));
  const off = await serve({ db: s.db });
  for (const key of [undefined, null, "", "undefined"]) assert.equal((await off.post("/api/admin/login", { key })).status, 401, "no key configured, no admin");
});

test("a suspended provider disappears from sale but guests with bookings are kept", async () => {
  const { core, admin, host, l, confirm } = await setup(), b = await confirm();
  await admin.suspendHost(host.id, true);
  assert.equal((await core.search({})).length, 0);
  assert.equal((await core.feed()).products.length, 0);
  assert.equal((await core.panel()).listings, 0);
  await status(core.book(req(l)), 404);
  await status(core.publish(host.key, l.id), 403);
  assert.equal((await core.guestBooking(b.token)).status, "confirmed");
  assert.equal((await core.hostHome(host.key)).suspended, true);
  await admin.suspendHost(host.id, false);
  assert.equal((await core.search({})).length, 1);
});

test("old personal data is removed; amounts stay", async () => {
  const { core, admin, db, host, confirm, payments } = await setup(), old = await confirm(), fresh = await confirm({ date: day(3) });
  await core.message("host", host.key, { booking_id: await core.bookingId(old.token), code: "r_yes" });
  await db.run("UPDATE bookings SET date=? WHERE token=?", day(-400), old.token);
  const before = await payments.balance(host.id);
  assert.deepEqual([await admin.retention(), await admin.retention()], [1, 0]);
  const g = await core.guestBooking(old.token);
  assert.deepEqual([g.guest_name, g.messages.length, g.total_uzs], ["—", 0, 300_000]);
  assert.equal((await core.guestBooking(fresh.token)).guest_name, "Li Wei");
  assert.deepEqual(await payments.balance(host.id), before);
  await admin.cleanup();
});

// ---- the door --------------------------------------------------------------------------------------
test("headers, sign-in limits and addresses", async () => {
  const s = await serve(), r = await fetch(s.base + "/panel");
  assert.equal(r.status, 200);
  for (const [k, re] of [["content-security-policy", /frame-ancestors 'none'/], ["x-content-type-options", /nosniff/], ["cross-origin-opener-policy", /same-origin/], ["cross-origin-resource-policy", /same-origin/], ["referrer-policy", /no-referrer/]]) assert.match(r.headers.get(k), re);
  assert.ok(!/unsafe/.test(r.headers.get("content-security-policy")), "no inline scripts or styles");
  assert.equal((await fetch(s.base + "/", { headers: { "If-None-Match": (await fetch(s.base + "/")).headers.get("etag") } })).status, 304);
  const codes = [];
  for (let i = 0; i < 22; i++) codes.push((await s.post("/api/auth/key", { key: "guess".repeat(6) })).status);
  assert.deepEqual([codes[0], codes.at(-1)], [401, 429]);
  const ip = (h, remote = "10.0.0.1", trust = true) => clientIp({ headers: h, socket: { remoteAddress: remote } }, trust);
  assert.equal(ip({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }), "1.2.3.4", "only what our own proxy added");
  assert.equal(ip({ "x-forwarded-for": "6.6.6.6" }, "::ffff:9.9.9.9", false), "9.9.9.9");
  assert.equal(ip({}, "2001:db8:1:2:3:4:5:6"), ip({}, "2001:db8:1:2::9"));
});
