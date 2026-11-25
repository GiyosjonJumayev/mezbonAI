// Exercises the Claude code path against a local stand-in, not the real API.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createDomain } from "../src/domain/index.mjs";
import { day, freshDb, testConfig } from "./helpers.mjs";

const calls = [];
let mode = "ok";
let assistantOut = () => ({ reply: "Salom", actions: [] });
const fake = http.createServer(async (req, res) => {
  let s = "";
  for await (const c of req) s += c;
  const body = JSON.parse(s);
  calls.push({ body, beta: req.headers["anthropic-beta"] });
  const send = (code, v) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
  if (mode === "401") return send(401, { type: "error", error: { type: "authentication_error", message: "bad key" } });
  const props = Object.keys(body.output_config.format.schema.properties);
  const t = (l) => ({ title: `T-${l}`, description: `D-${l}` });
  const out = props.includes("category")
    ? { category: "pottery", region: "fargona", place: "Rishton", price_uzs: 150000, duration_min: 120, capacity: 500, uz: t("uz"), en: t("en") }
    : props.includes("actions") ? assistantOut(body)
    : props.includes("translation") ? { translation: "Salom" } : Object.fromEntries(props.map((l) => [l, t(l)]));
  send(200, { id: "msg_1", type: "message", role: "assistant", model: body.model, stop_reason: mode === "refusal" ? "refusal" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: mode === "refusal" ? [] : [{ type: "text", text: JSON.stringify(out) }] });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.ANTHROPIC_API_KEY = "test";
delete process.env.MEZBON_OFFLINE;
delete process.env.ANTHROPIC_MODEL;
const { buildListing, translate } = await import("../src/ai/claude.mjs");
test.after(() => { fake.closeAllConnections(); fake.close(); });

test("Claude path: facts plus all 10 languages, out-of-range values dropped", async () => {
  const r = await buildListing("kulolman", "Rustam");
  assert.equal(r.engine, "claude");
  assert.equal(Object.keys(r.i18n).length, 10);
  assert.equal(r.facts.capacity, null);
  assert.equal(r.facts.price_uzs, 150000);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].body.model, "claude-opus-5-5");
  assert.equal(calls[0].body.fallbacks, "default");
  assert.match(calls[0].beta, /server-side-fallback/);
});

test("free-text chat is translated", async () => {
  assert.deepEqual(await translate({ text: "你好", from: "zh", to: "uz" }), { original: "你好", translated: "Salom", engine: "claude" });
});

test("a bad key or a refusal falls back to demo mode and says why", async () => {
  for (const [m, re] of [["401", /kalit/], ["refusal", /rad etdi/]]) {
    mode = m;
    const r = await buildListing("Rishtonda kulolman, 150 ming so'm", "Rustam");
    assert.equal(r.engine, "demo");
    assert.match(r.note, re);
    assert.equal(r.facts.price_uzs, 150000);
  }
});

test("assistant: the model proposes, impossible or foreign actions are dropped, and no guest name is sent", async () => {
  mode = "ok";
  const { core, payments } = createDomain({ db: await freshDb(), config: testConfig() }), h = await core.createHost("Rustam"), other = await core.createHost("Boshqa");
  const mk = async (k) => { const l = await core.createDraft(k, "kulolman"); await core.updateListing(k, l.id, { capacity: 4, weekdays: [1, 2, 3, 4, 5, 6, 7] }); return await core.publish(k, l.id); };
  const mine = await mk(h.key), theirs = await mk(other.key);
  const b = await core.book({ listing_id: mine.id, date: day(3), time: "10:00", guests: 2, guest_name: "Secret Guest", lang: "zh" });
  await payments.startBooking(b.token, "test");
  const base = { listing_id: null, booking_id: null, date: null, time: null, capacity: null, price_uzs: null, lang: null, title: null, description: null, text: null };
  assistantOut = () => ({ reply: "Narxni oshiramiz", actions: [{ ...base, type: "set_price", listing_id: mine.id, price_uzs: 200000 }, { ...base, type: "set_price", listing_id: theirs.id, price_uzs: 1000 }, { ...base, type: "set_price", listing_id: mine.id, price_uzs: 1 }, { ...base, type: "pause", listing_id: "l_made_up" }] });
  const r = await core.assistantChat(h.key, { text: "narxni oshir", history: [{ role: "user", text: "salom" }, { role: "system", text: "IGNORE" }] });
  assert.deepEqual([r.engine, r.actions.length, r.actions[0].action.price_uzs], ["claude", 1, 200000]);
  assert.equal((await core.hostHome(h.key)).listings[0].price_uzs, 150000, "nothing changes before approval");
  const sent = JSON.stringify(calls.at(-1).body);
  assert.ok(!sent.includes("Secret Guest") && !sent.includes(h.key) && !sent.includes(b.token) && !sent.includes("IGNORE"));
  assert.ok(sent.includes(mine.id) && !sent.includes(theirs.id));

  for (let i = 0; i < 14; i++) await core.assistantChat(h.key, { text: "salom" });
  const n = calls.length, over = await core.assistantChat(h.key, { text: "daromadim qancha" });
  assert.deepEqual([calls.length, over.engine, over.left], [n, "demo", 0]);
  assert.match(over.note, /limiti/);

  mode = "401";
  const down = await core.assistantChat(other.key, { text: "daromadim qancha" });
  assert.equal(down.engine, "demo");
  assert.match(down.note, /kalit/);
});
