// Checks the price rules a provider sets. The formula itself is shared with the browser: public/price.js.
import { PRICE_LIMITS as L } from "../../public/price.js";
import { bad } from "../lib/util.mjs";

export { extrasCost, unitPrice } from "../../public/price.js";
import { EXTRAS } from "../../public/price.js";

const within = (v, [lo, hi], name) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw bad(`${name}: ${lo}–${hi} oralig‘ida butun son bo‘lsin`);
  return v;
};

/** Up to four add-ons, each kind once, with a price per person or per group. */
export function cleanExtras(v) {
  if (!Array.isArray(v) || v.length > EXTRAS.length) throw bad("Qo‘shimcha xizmatlar noto‘g‘ri");
  const seen = new Set();
  return v.map((x) => {
    if (!x || !EXTRAS.includes(x.kind) || seen.has(x.kind)) throw bad("Qo‘shimcha xizmat turi noto‘g‘ri");
    seen.add(x.kind);
    if (!["person", "booking"].includes(x.per)) throw bad("Narx kishi yoki guruh uchun bo‘lsin");
    return { kind: x.kind, price: within(x.price, [1000, 10_000_000], "Qo‘shimcha xizmat narxi"), per: x.per };
  });
}

/** Keeps only what is known. An empty part means the rule is off. */
export function cleanPricing(v) {
  if (v === null || v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw bad("Narx qoidasi noto‘g‘ri");
  const out = {};
  if (v.weekend) out.weekend = within(v.weekend, L.weekend, "Dam olish kunlari foizi");
  if (v.last) {
    if (!L.hours.includes(v.last.hours)) throw bad("Oxirgi daqiqa muddati noto‘g‘ri");
    out.last = { hours: v.last.hours, pct: within(v.last.pct, L.last, "Oxirgi daqiqa chegirmasi") };
  }
  if (v.group) out.group = { from: within(v.group.from, L.from, "Guruh soni"), pct: within(v.group.pct, L.group, "Guruh chegirmasi") };
  return out;
}
