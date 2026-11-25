import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ROOT } from "../src/config.mjs";
import { seed } from "../src/seed.mjs";
import { day as dayAt, serve } from "./helpers.mjs";

const sent = [], { base, post, core, db, publishListing } = await serve({ telegram: async (...a) => sent.push(a) });
await seed(db, core);
const day = dayAt(2);

test("pages load; paths outside public do not", async () => {
  for (const p of ["/", "/mezbon", "/panel", "/qr", "/admin", "/trip.js", "/account.js", "/app.css", "/common.js", "/icon.svg", "/fonts/onest-latin-wght-normal.woff2", "/healthz", "/sw.js", "/manifest.webmanifest", "/icon192.png", "/theme.js"]) assert.equal((await fetch(base + p)).status, 200, p);
  for (const p of ["/package.json", "/..%2f.env", "/src/app.mjs", "/photos/..%2fmezbon.db", "/constructor"]) assert.equal((await fetch(base + p)).status, 404, p);
});

test("public data has no host keys, transcripts or guest details", async () => {
  const s = JSON.stringify([await (await fetch(base + "/api/listings")).json(), await (await fetch(base + "/api/panel")).json(), await (await fetch(base + "/feeds/products.json")).json()]);
  for (const { key_hash } of await db.all("SELECT key_hash FROM hosts")) assert.ok(!s.includes(key_hash.toString("hex")));
  assert.ok(!/transcript|guest_name|token|key/.test(s));
});

test("bad requests are refused cleanly", async () => {
  assert.equal((await post("/api/host/drafts", { transcript: "x" })).status, 401);
  assert.equal((await fetch(base + "/api/bookings", { method: "POST", body: "{}" })).status, 415);
  assert.equal((await post("/api/bookings", [1])).status, 400);
  assert.equal((await post("/api/hosts", { name: "a".repeat(30000) })).status, 413);
  assert.equal((await fetch(base + "/api/host/events")).status, 401);
});

test("photo upload accepts real images only", async () => {
  const h = await core.createHost("Rasmchi"), l = await core.createDraft(h.key, "kulolman");
  const up = (data) => post(`/api/host/listings/${l.id}/photo`, { data }, { "X-Host-Key": h.key });
  assert.equal((await up(Buffer.from("<svg onload=alert(1)>").toString("base64"))).status, 400);
  const r = await (await up(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0]).toString("base64"))).json();
  assert.equal((await fetch(`${base}/photos/${r.photo}`)).headers.get("content-type"), "image/png");
});

test("host gets a live event when a guest pays; Telegram host gets buttons", async () => {
  const h = await core.createHost("Tg", { telegramChat: "55" });
  const l = await publishListing(h.key);
  const es = await fetch(`${base}/api/host/events`, { headers: { "X-Host-Key": h.key } }), reader = es.body.getReader();
  await reader.read();
  const b = await (await post("/api/bookings", { listing_id: l.id, date: day, time: "10:00", guests: 1, guest_name: "Li", lang: "zh" })).json();
  await post(`/api/bookings/${b.token}/pay`, { method: "test" });
  assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"booking"/);
  await reader.cancel();
  for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent[0][0], "55");
  assert.match(sent[0][2][0][0].callback_data, /^acc:b_/);
});

test("MCP: an AI assistant finds and holds a place but cannot pay", async () => {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "src/adapters/mcp.mjs")], env: { ...process.env, MEZBON_URL: base } }));
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ["check_availability", "create_booking", "plan_trip", "search_experiences"]);
    const found = JSON.parse((await client.callTool({ name: "search_experiences", arguments: { region: "fargona", category: "ikat", language: "de" } })).content[0].text);
    assert.equal(found.length, 1);
    assert.equal(found[0].sample, true);
    const args = { listing_id: found[0].listing_id, date: day, time: "10:00", guests: 2, guest_name: "Anna" };
    const r = JSON.parse((await client.callTool({ name: "create_booking", arguments: args })).content[0].text);
    assert.equal(r.status, "pending");
    const token = new URL(r.payment_link).searchParams.get("b");
    assert.equal((await core.guestBooking(token)).channel, "ai");
    const full = await client.callTool({ name: "create_booking", arguments: { ...args, guests: 6 } });
    assert.equal(full.isError, true);
    assert.match(full.content[0].text, /Not enough places/);
    const open = JSON.parse((await client.callTool({ name: "check_availability", arguments: { listing_id: found[0].listing_id, from: day, days: 1 } })).content[0].text);
    assert.equal(open[0].times.find((t) => t.time === "10:00").free, 4);
    const trip = JSON.parse((await client.callTool({ name: "plan_trip", arguments: { from: day, days: 4, guests: 2 } })).content[0].text);
    assert.ok(trip.days.flatMap((d) => d.stops).length >= 3);
    const none = JSON.parse((await client.callTool({ name: "search_experiences", arguments: { region: "fargona", category: "ikat", date: day, guests: 7 } })).content[0].text);
    assert.equal(none.length, 0);
  } finally { await client.close(); }
});
