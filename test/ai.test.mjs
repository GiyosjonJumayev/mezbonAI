// Exercises the Claude code path against a local stand-in, not the real API.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const calls = [];
let mode = "ok";
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
    : props.includes("translation") ? { translation: "Salom" } : Object.fromEntries(props.map((l) => [l, t(l)]));
  send(200, { id: "msg_1", type: "message", role: "assistant", model: body.model, stop_reason: mode === "refusal" ? "refusal" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: mode === "refusal" ? [] : [{ type: "text", text: JSON.stringify(out) }] });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.ANTHROPIC_API_KEY = "test";
delete process.env.MEZBON_OFFLINE;
delete process.env.ANTHROPIC_MODEL;
const { buildListing, translate } = await import("../src/ai.mjs");
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
