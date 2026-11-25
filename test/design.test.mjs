// WCAG 2.2 contrast of the design tokens, in both themes, plus checks on the installable app.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");
const read = (f) => readFileSync(path.join(PUB, f), "utf8");
const css = read("app.css");
const token = (name, dark) => {
  const m = new RegExp(`--${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`, "i").exec(css);
  assert.ok(m, `--${name} is a light-dark() pair`);
  return m[dark ? 2 : 1];
};
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// foreground, background, minimum. 4.5 for text, 3 for control borders and chart marks.
const PAIRS = [
  ...["bg", "page", "card", "soft"].flatMap((b) => [["ink", b, 4.5], ["muted", b, 4.5], ["link", b, 4.5]]),
  ["turq", "card", 3], ["turq", "bg", 4.5], ["heart", "card", 3], ["field", "card", 3], ["bar", "card", 3], ["bad", "card", 4.5], ["on-cobalt", "cobalt", 4.5], ["on-cobalt", "cobalt-2", 4.5],
  ["on-night", "night", 4.5], ["on-night-2", "night", 4.5], ["bad", "bad-bg", 4.5], ["warn", "warn-bg", 4.5], ["ok", "ok-bg", 4.5], ["ink", "info-bg", 4.5], ["muted", "info-bg", 4.5], ["bg", "ink", 4.5], ["bg", "turq", 4.5],
];
for (const dark of [false, true]) test(`contrast, ${dark ? "dark" : "light"} theme`, () => {
  const low = PAIRS.map(([f, b, min]) => [f, b, min, ratio(token(f, dark), token(b, dark))]).filter(([, , min, r]) => r < min).map(([f, b, min, r]) => `${f} on ${b}: ${r.toFixed(2)} < ${min}`);
  assert.deepEqual(low, []);
});

test("every colour variable that is used is defined", () => {
  const all = css + read("components.css"), defined = new Set([...all.matchAll(/--([\w-]+)\s*:/g)].map((m) => m[1]));
  const used = [...all.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].filter((u) => !defined.has(u) && !["c", "r"].includes(u)), []);
});

test("installable app: manifest, icons and offline shell exist", () => {
  const m = JSON.parse(read("manifest.webmanifest"));
  for (const i of m.icons) assert.ok(existsSync(path.join(PUB, i.src)), i.src);
  assert.ok(m.icons.some((i) => i.sizes === "512x512") && m.icons.some((i) => i.purpose === "maskable"));
  const shell = /SHELL = (\[[^\]]+\])/.exec(read("sw.js"))[1];
  for (const f of JSON.parse(shell)) if (f !== "/") assert.ok(existsSync(path.join(PUB, f)), f);
});

test("the service worker never stores provider data", () => {
  const keep = new Function("u", `return (${/const keep = \(u\) => (.+);/.exec(read("sw.js"))[1]})`);
  const at = (p) => keep(new URL("http://x" + p));
  for (const p of ["/api/host", "/api/host/analytics", "/api/host/listings/l_1", "/api/panel", "/api/push/key", "/api/bookings/x/messages", "/api/bookings/x/calendar.ics", "/api/listings/l_1/availability"]) assert.ok(!at(p), p);
  for (const p of ["/api/config", "/api/listings?region=x", "/api/listings/l_1", "/api/bookings/tok-_1", "/api/qr.svg?text=x"]) assert.ok(at(p), p);
});

test("every icon a page asks for is drawn", () => {
  const names = new Set([.../(?:^|[\s{,])([a-z]+): "M/g[Symbol.matchAll](read("art.js"))].map((m) => m[1]));
  for (const f of ["tourist.js", "host.js", "panel.js"]) for (const [, n] of read(f).matchAll(/\bicon\("([a-z]+)"/g)) assert.ok(names.has(n), `${f}: ${n}`);
});
