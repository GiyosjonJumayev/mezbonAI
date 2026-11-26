// Letters of intent, the live stage, unlisted offers and the public demonstration.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.mjs";
import { fillDemo } from "../src/demo.mjs";
import { letterText } from "../src/domain/partners.mjs";
import { CLICK, day, OCTO, req, serve, setup, status } from "./helpers.mjs";

const ADMIN_KEY = "admin-key-admin-key-admin-key";
const form = (o = {}) => ({ kind: "host", region: "fargona", name: "Rustam kulolchilik", signed_name: "Rustam Usta", offer: "Lagan yasash darsi", price_uzs: 250000, groups_week: 5, max_commission: 15, ...o });
const sign = async (s, o = {}, extra = {}) => { const f = form(o), { letter } = await s.partners.previewLetter(f); return s.partners.signLetter({ ...f, letter, agree: true, phone: "901112233", ...extra }); };

test("a letter is signed exactly as shown, and cannot be signed by surprise", async () => {
  const s = await setup(), p = await sign(s);
  assert.match(p.letter, /Rustam Usta .*250 000 so‘mdan.*haftasiga 5 guruhgacha.*15% gacha.*shartnoma emas/s);
  assert.deepEqual([p.status, p.letter_hash, p.phone], ["signed", createHash("sha256").update(p.letter).digest("hex"), undefined]);
  const f = form(), { letter } = await s.partners.previewLetter(f), base = { ...f, letter, agree: true, phone: "901112244" };
  for (const bad of [{ agree: false }, { agree: "true" }, { letter: letter + " " }, { letter: undefined }, { price_uzs: 999_000 }, { max_commission: 18 }, { phone: "" }, { phone: "x" }, { email: "x" }]) await status(s.partners.signLetter({ ...base, ...bad }), 400);
  for (const bad of [{ kind: "constructor" }, { region: "constructor" }, { max_commission: 17 }, { max_commission: "15" }, { price_uzs: 1 }, { groups_week: 0 }, { offer: " " }, { name: "" }, { offer: "a".repeat(301) }]) await status(s.partners.previewLetter(form(bad)), 400);
  assert.ok(letterText(form({ kind: "hotel", max_commission: 0, price_uzs: null })).includes("keyin kelishamiz"));
});

test("one phone is one signal, even at the same moment", async () => {
  const s = await setup(), r = await Promise.allSettled([1, 2, 3, 4].map(() => sign(s)));
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  await sign(s, {}, { phone: "901112255" });
  assert.equal((await s.partners.letterTotals()).waiting, 2);
});

test("only confirmed letters count; withdrawal erases the contact and the claim", async () => {
  const s = await setup(), a = await sign(s), b = await sign(s, { kind: "hotel", region: "samarqand", price_uzs: null, groups_week: null, max_commission: 0, offer: "QR kod qo‘yamiz" }, { phone: "901112255" }), list = await s.partners.partners();
  assert.deepEqual([(await s.partners.letterTotals()).confirmed, (await s.metrics.investor()).letters.confirmed], [0, 0]);
  const id = (p) => list.find((x) => x.letter_hash === p.letter_hash).id;
  await s.partners.setPartner(id(a), { status: "verified" });
  await s.partners.setPartner(id(b), { status: "joined" });
  const t = await s.partners.letterTotals();
  assert.deepEqual([t.confirmed, t.joined, t.hosts, t.hotels, t.regions, t.groups_week, t.price, t.c12, t.c15, t.c18], [2, 1, 1, 1, 2, 5, 250000, 1, 1, 0]);
  const w = await s.partners.withdrawLetter(a.token);
  assert.equal(w.status, "withdrawn");
  assert.deepEqual([(await s.partners.letterTotals()).confirmed, (await s.db.one("SELECT phone, email FROM partners WHERE id=?", id(a))).phone], [1, ""]);
  await status(s.partners.setPartner(id(a), { status: "verified" }), 404);
  await status(s.partners.letter("nope"), 404);
  await status(s.partners.setPartner(id(b), { status: "withdrawn" }), 400);
  await sign(s); // may sign again after withdrawing
  await s.db.run("UPDATE partners SET updated_at = now() - interval '100 days'");
  await s.partners.cleanPartners();
  assert.equal((await s.db.one("SELECT COUNT(*) n FROM partners WHERE status='withdrawn'")).n, 0);
  assert.deepEqual((await s.db.all("SELECT action FROM audit_log ORDER BY id")).map((x) => x.action), ["letter_verified", "letter_joined", "letter_withdrawn"]);
});

test("HTTP: the list of partners is for administrators only, and signing is limited", async () => {
  const s = await serve({ env: { ADMIN_KEY } }), p = await (async () => { const f = form(), { letter } = await (await s.post("/api/partners/preview", f)).json(); return (await s.post("/api/partners", { ...f, letter, agree: true, phone: "901112233" })).json(); })();
  assert.equal((await s.get(`/api/partners/${p.token}`)).name, "Rustam kulolchilik");
  assert.ok(!/901112233/.test(JSON.stringify(await s.get(`/api/partners/${p.token}`))));
  assert.equal((await fetch(s.base + "/api/admin/partners")).status, 401);
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await s.post("/api/partners", {})).status);
  assert.deepEqual([codes[0], codes.at(-1)], [400, 429]);
  assert.equal((await fetch(s.base + "/hamkor")).status, 200);
});

test("the stage: each presentation has its own provider, works end to end and cleans up", async () => {
  const s = await serve({ env: { ADMIN_KEY } }), start = async () => { const r = await s.post("/api/stage/start", {}, { Origin: s.base }); return { ...(await r.json()), jar: { Cookie: r.headers.getSetCookie()[0].split(";")[0], Origin: s.base } }; };
  const a = await start(), b = await start();
  assert.notEqual(a.listing, b.listing);
  assert.equal((await s.get("/api/listings")).length, 0, "not shown in search");
  assert.equal((await s.get("/api/trips/plan")).code, "notfound");
  assert.equal((await s.core.planTrip({})).days.length, 0);
  assert.equal((await s.get("/feeds/products.json")).products.length, 0);
  assert.equal((await s.get(`/api/listings/${a.listing}`)).demo, true);
  const booking = await (await s.post("/api/bookings", { listing_id: a.listing, date: day(0), time: "23:30", guests: 2, guest_name: "Anna", lang: "en" })).json();
  await s.post(`/api/bookings/${booking.token}/pay`, { method: "test" });
  const home = await s.get("/api/host", a.jar);
  assert.equal(home.bookings.length, 1);
  assert.equal((await s.get("/api/host", b.jar)).bookings.length, 0, "another presentation sees nothing");
  await s.post(`/api/host/bookings/${home.bookings[0].id}/accept`, {}, a.jar);
  const { ticket } = await s.get(`/api/bookings/${booking.token}`);
  assert.equal((await s.post(`/api/host/tickets/${ticket.code}/check-in`, {}, b.jar)).status, 404);
  assert.equal((await s.post(`/api/host/tickets/${ticket.code}/check-in`, {}, a.jar)).status, 200);
  assert.equal((await s.get("/api/impact")).totals.visits, 1);
  await s.post("/api/host/plans/pro/pay", { method: "test" }, a.jar);
  await s.core.review(booking.token, { rating: 5 });
  assert.equal(await s.stage.cleanStage(), 0, "not while it is fresh");
  const real = await s.core.createHost("Haqiqiy"), rl = await s.publishListing(real.key), rb = await s.core.book(req(rl));
  await s.payTest(rb.token);
  await s.db.run("UPDATE hosts SET created_at = now() - interval '2 days'");
  assert.equal(await s.stage.cleanStage(), 2);
  assert.deepEqual([(await s.db.one("SELECT COUNT(*) n FROM hosts")).n, (await s.db.one("SELECT COUNT(*) n FROM bookings")).n, (await s.db.one("SELECT COUNT(*) n FROM payments")).n], [1, 1, 1], "the real provider is untouched");
  assert.equal((await s.core.guestBooking(rb.token)).status, "paid");
});

test("the stage and framing exist only in a demonstration", async () => {
  const live = await serve({ env: { ...OCTO, ADMIN_KEY } });
  assert.equal((await live.post("/api/stage/start")).status, 404);
  assert.match((await fetch(live.base + "/")).headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const demo = await serve();
  assert.match((await fetch(demo.base + "/")).headers.get("content-security-policy"), /frame-ancestors 'self'/);
  assert.equal(loadConfig({ DATABASE_URL: "x", NODE_ENV: "production", PUBLIC_URL: "https://a.uz", ADMIN_KEY, ALLOW_TEST_PAYMENTS: "1" }).stage, false);
});

test("a public demonstration is marked, filled once, and refuses real money", async () => {
  const c = loadConfig({ DATABASE_URL: "x", NODE_ENV: "production", DEMO_SITE: "1", RENDER_EXTERNAL_URL: "https://demo.onrender.com", ADMIN_KEY });
  assert.deepEqual([c.problems, c.testPayments, c.stage, c.publicUrl, c.https], [[], true, true, "https://demo.onrender.com", true]);
  assert.match(loadConfig({ ...CLICK, DATABASE_URL: "x", DEMO_SITE: "1" }).problems.join(), /DEMO_SITE/);
  const s = await serve({ env: { DEMO_SITE: "1", PUBLIC_URL: "https://demo.onrender.com", ADMIN_KEY } });
  assert.equal((await fetch(s.base + "/")).headers.get("x-robots-tag"), "noindex");
  const out = await fillDemo(s);
  assert.ok(out.trip && (await s.get("/api/config")).demoSite);
  assert.equal(await fillDemo(s), null, "only an empty database");
  for (const l of await s.get("/api/listings")) assert.equal(l.demo, true, "every sample is marked");
  assert.equal((await s.metrics.investor()).money.gmv, 0, "samples are not traction");
});
