import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import pg from "pg";
import { createApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { createDatabase } from "../src/db/database.mjs";
import { createDomain } from "../src/domain/index.mjs";
import { tashkentNow } from "../src/lib/util.mjs";

process.env.MEZBON_OFFLINE ??= "1";
if (!process.env.TEST_TEMPLATE) throw new Error("Testlarni `npm test` orqali ishga tushiring");
const open = [];
after(() => Promise.all(open.map((close) => Promise.resolve(close()).catch(() => {}))));

async function admin(sql) {
  const c = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}
/** A new database, already migrated. `owner: true` connects as its owner instead of the restricted app account. */
export async function freshDb({ owner = false } = {}) {
  const name = `${process.env.TEST_TEMPLATE}_${randomBytes(5).toString("hex")}`;
  for (let i = 0; ; i++) {
    try { await admin(`CREATE DATABASE ${name} TEMPLATE ${process.env.TEST_TEMPLATE}`); break; }
    catch (e) { if (i > 60 || !["55006", "23505"].includes(e.code)) throw e; await new Promise((r) => setTimeout(r, 50 + Math.random() * 100)); } // another test is copying right now
  }
  const u = new URL(owner ? process.env.TEST_ADMIN_URL : process.env.TEST_APP_URL);
  u.pathname = `/${name}`;
  const db = createDatabase(u.href, { max: 6 });
  db.url = u.href;
  open.unshift(() => db.close()); // servers opened later are closed first
  return db;
}
export const testConfig = (env = {}) => ({ ...loadConfig({ DATABASE_URL: "x", PUBLIC_URL: "http://localhost:4321", ...env }), dataDir: mkdtempSync(path.join(os.tmpdir(), "silkroad-")) });
export const OCTO = { PUBLIC_URL: "https://silkroad.test", OCTO_SHOP_ID: "77", OCTO_SECRET: "octo-secret" };
export const PAYME = { PUBLIC_URL: "https://silkroad.test", PAYME_MERCHANT_ID: "m1", PAYME_KEY: "payme-key" };

export const day = (n) => tashkentNow(new Date(Date.now() + n * 864e5)).slice(0, 10);
export const SAY = "Rishtonda kulolman, ikki soat, yuz ellik ming so'm, 4 kishi";
export const status = (p, s) => assert.rejects(typeof p === "function" ? async () => p() : p, (e) => { assert.equal(e.status, s, e.message); return true; });
export const req = (l, o = {}) => ({ listing_id: l.id, date: day(2), time: "10:00", guests: 2, guest_name: "Li Wei", lang: "zh", ...o });
export const freeAt = async (core, l, n) => (await core.availability(l.id, day(n), 1))[0].times.find((t) => t.time === "10:00").free;
/** Notifications are sent after the commit, so give them a moment. */
export const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const noNetwork = () => { throw new Error("no network in tests"); };
function extend(domain) {
  const { core, payments, db } = domain;
  return {
    ...domain,
    payTest: async (token) => { await payments.startBooking(token, "test"); return core.guestBooking(token); },
    subscribeTest: async (key, plan) => { await payments.startPlan(key, plan, "test"); return core.plans(key); },
    publishListing: async (key, say = SAY) => {
      const l = await core.createDraft(key, say);
      await core.updateListing(key, l.id, { weekdays: [1, 2, 3, 4, 5, 6, 7] });
      return core.publish(key, l.id);
    },
    hotel: () => db.run("INSERT INTO hotels (code,name,region) VALUES ('x','X','fargona')"),
  };
}
/** A domain with one provider and one listing. `events` holds the types of provider notifications. */
export async function setup({ say = SAY, publish = true, env = {}, fetchFn = noNetwork } = {}) {
  const db = await freshDb(), domain = extend(createDomain({ db, config: testConfig(env), fetchFn })), { core, events: bus } = domain;
  const events = [], guestEvents = [];
  bus.on("host", (e) => { events.push(e.type); });
  bus.on("guest", (e) => { guestEvents.push(e.type); });
  const host = await core.createHost("Rustam");
  const draft = await core.createDraft(host.key, say);
  let l = await core.updateListing(host.key, draft.id, { weekdays: [1, 2, 3, 4, 5, 6, 7] });
  if (publish) l = await core.publish(host.key, l.id);
  const confirm = async (o) => {
    const b = await core.book(req(l, o));
    await domain.payTest(b.token);
    await core.decide(host.key, (await core.hostHome(host.key)).bookings.find((x) => x.status === "paid").id, true);
    return core.guestBooking(b.token);
  };
  return { ...domain, host, l, events, guestEvents, confirm, book: (o) => core.book(req(l, o)) };
}
/** A running HTTP server. */
export async function serve({ db, env = {}, ...opts } = {}) {
  db ??= await freshDb();
  const app = extend(await createApp({ db, config: testConfig(env), telegram: null, fetchFn: noNetwork, ...opts }));
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (p, b = {}, h = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) });
  const get = async (p, h = {}) => (await fetch(base + p, { headers: h })).json();
  const close = () => { app.server.closeAllConnections(); app.server.close(); };
  open.unshift(close);
  return { ...app, base, post, get, close };
}
