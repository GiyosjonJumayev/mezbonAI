import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MEZBON_OFFLINE = "1";
process.env.MEZBON_DATA = mkdtempSync(path.join(os.tmpdir(), "mezbon-"));
const { openDb } = await import("../src/db.mjs");
const { createApp } = await import("../src/server.mjs");

const db = openDb();
async function serve(opts) {
  const app = createApp(db, { telegram: null, ...opts });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (p, b, h = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) });
  return { ...app, base, post, close: () => { app.server.closeAllConnections(); app.server.close(); } };
}
const a = await serve();
test.after(() => a.close());

test("errors carry a code so each audience gets its own words", async () => {
  assert.equal((await (await fetch(a.base + "/api/bookings/none")).json()).code, "notfound");
  assert.equal((await (await a.post("/api/hosts", { name: "" })).json()).code, "input");
  assert.equal((await (await fetch(a.base + "/api/host")).json()).code, "auth");
});

test("test payments can be switched off", async () => {
  const b = await serve({ testPayments: false });
  assert.equal((await b.post("/api/bookings/x/pay-test", {})).status, 403);
  assert.equal((await (await fetch(b.base + "/api/config")).json()).testPayments, false);
  b.close();
});

test("repeating a search counts as one signal of demand", async () => {
  for (let i = 0; i < 3; i++) await fetch(a.base + "/api/listings?region=sirdaryo");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM searches WHERE region='sirdaryo'").get().n, 1);
});

test("a replaced or deleted photo is removed from disk", async () => {
  const h = a.core.createHost("Foto"), l = await a.core.createDraft(h.key, "kulolman"), head = { "X-Host-Key": h.key };
  const up = async (tail) => (await (await a.post(`/api/host/listings/${l.id}/photo`, { data: Buffer.from([0xff, 0xd8, 0xff, tail]).toString("base64") }, head)).json()).photo;
  const code = async (f) => (await fetch(`${a.base}/photos/${f}`)).status;
  const first = await up(1), second = await up(2);
  assert.deepEqual([await code(first), await code(second)], [404, 200]);
  await a.post(`/api/host/listings/${l.id}/delete`, {}, head);
  assert.equal(await code(second), 404);
});

test("security headers are present and sign-ups are limited", async () => {
  const r = await fetch(a.base + "/");
  assert.match(r.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await a.post("/api/hosts", { name: "N" })).status);
  assert.ok(codes.includes(429));
});
