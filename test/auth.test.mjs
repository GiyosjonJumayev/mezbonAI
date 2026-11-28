// Sign-in with a six-digit e-mail code, confirming an address by code, and signing up with an e-mail.
import test from "node:test";
import assert from "node:assert/strict";
import { serve, status } from "./helpers.mjs";

const MAIL = { SMTP_URL: "smtp://mail.test", MAIL_FROM: "SilkRoad <x@example.com>" };
async function app() {
  const out = [], s = await serve({ env: MAIL, mailer: { sendMail: async (m) => { out.push(m); }, close() {} } });
  const h = await s.core.createHost("Rustam");
  // An address the provider already confirmed
  const { token } = await s.core.askEmail(h.key, "usta@example.com");
  await s.core.confirmEmail(token);
  const codeOf = (m) => /: (\d{6})/.exec(m.text)[1];
  const ask = async (email = "usta@example.com") => { const r = await s.post("/api/auth/email", { email }); await s.mail.work(); return r; };
  return { ...s, h, out, codeOf, ask };
}

test("a six-digit code signs in on any device, once, and only the newest code works", async () => {
  const s = await app();
  await s.ask();
  const first = s.codeOf(s.out.at(-1));
  assert.match(s.out.at(-1).subject, new RegExp(first));
  await s.ask();
  const second = s.codeOf(s.out.at(-1));
  if (first !== second) await status(s.core.signInWithCode("usta@example.com", first), 401);
  const r = await s.post("/api/auth/code", { email: "USTA@example.com", code: second });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("set-cookie"), /HttpOnly/);
  assert.equal((await r.json()).id, s.h.id);
  await status(s.core.signInWithCode("usta@example.com", second), 401, "a code works once");
  assert.equal((await s.db.one("SELECT COUNT(*) n FROM login_codes")).n, 0);
  assert.ok(!(await s.db.all("SELECT code_hash FROM login_codes")).length && !JSON.stringify(await s.db.all("SELECT * FROM audit_log")).includes(second));
});

test("a code allows five tries, expires, and every failure looks the same", async () => {
  const s = await app();
  await s.ask();
  const code = s.codeOf(s.out.at(-1)), wrong = code === "000000" ? "111111" : "000000", answers = [];
  for (let i = 0; i < 5; i++) { const r = await s.post("/api/auth/code", { email: "usta@example.com", code: wrong }); answers.push([r.status, (await r.json()).error]); }
  assert.equal(new Set(answers.map(String)).size, 1);
  await status(s.core.signInWithCode("usta@example.com", code), 401, "the right code no longer works after five wrong ones");
  await s.ask();
  const fresh = s.codeOf(s.out.at(-1));
  await s.db.run("UPDATE login_codes SET expires_at = now() - interval '1 second'");
  await status(s.core.signInWithCode("usta@example.com", fresh), 401);
  for (const bad of [["usta@example.com", "12345"], ["usta@example.com", "abcdef"], [null, fresh], ["nobody@example.com", fresh]]) await status(s.core.signInWithCode(...bad), 401);
});

test("asking for a code tells nobody whether an address has an account, and is limited per address", async () => {
  const s = await app();
  const a = await s.ask("usta@example.com"), b = await s.ask("nobody@example.com");
  assert.deepEqual([a.status, await a.text()], [b.status, await b.text()]);
  assert.equal(s.out.filter((m) => m.to === "nobody@example.com").length, 0);
  assert.equal((await s.db.one("SELECT COUNT(*) n FROM login_codes WHERE email='nobody@example.com'")).n, 0);
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await s.post("/api/auth/code", { email: "target@example.com", code: "123456" })).status);
  assert.ok(codes.includes(429), "guessing codes for one address is limited");
});

test("sign-up with an e-mail sends a code that confirms the address without leaving the page", async () => {
  const s = await app();
  const r = await s.post("/api/hosts", { name: "Dilnoza opa", type: "guesthouse", email: "dilnoza@example.com" });
  const h = await r.json(), jar = { Cookie: r.headers.getSetCookie()[0].split(";")[0], Origin: s.base };
  assert.equal(h.email_sent, true);
  await s.mail.work();
  const m = s.out.find((x) => x.to === "dilnoza@example.com"), code = s.codeOf(m);
  assert.ok(m.text.includes("#email=e_"), "the link still works too");
  assert.equal((await s.post("/api/host/email/code", { code: code === "000000" ? "111111" : "000000" }, jar)).status, 401);
  const ok = await s.post("/api/host/email/code", { code }, jar);
  assert.deepEqual(await ok.json(), { ok: true, email: "dilnoza@example.com" });
  assert.equal((await s.core.account(h.key)).email, "dilnoza@example.com");
  // and now it signs in
  await s.ask("dilnoza@example.com");
  assert.equal((await s.core.signInWithCode("dilnoza@example.com", s.codeOf(s.out.at(-1)))).host.id, h.id);
});

test("a bad e-mail at sign-up creates nothing; another provider's address cannot be taken", async () => {
  const s = await app(), before = (await s.db.one("SELECT COUNT(*) n FROM hosts")).n;
  assert.equal((await s.post("/api/hosts", { name: "X", email: "not-an-email" })).status, 400);
  assert.equal((await s.db.one("SELECT COUNT(*) n FROM hosts")).n, before);
  const r = await s.post("/api/hosts", { name: "Copycat", email: "usta@example.com" }), jar = { Cookie: r.headers.getSetCookie()[0].split(";")[0], Origin: s.base };
  await s.mail.work();
  const code = s.codeOf(s.out.find((x) => x.to === "usta@example.com" && x.subject.includes("tasdiqlash")));
  assert.equal((await s.post("/api/host/email/code", { code }, jar)).status, 409);
  await status(s.core.signInWithCode("usta@example.com", code), 401, "a confirmation code is not a sign-in code");
  const signup = await s.post("/api/hosts", { name: "No mail", type: "artisan" });
  assert.equal((await signup.json()).email_sent, false);
});
