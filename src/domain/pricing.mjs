// Checks the price rules a provider sets. The formula itself is shared with the browser: public/price.js.
import { PRICE_LIMITS as L } from "../../public/price.js";
import { bad } from "../lib/util.mjs";

export { unitPrice } from "../../public/price.js";

const within = (v, [lo, hi], name) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw bad(`${name}: ${lo}–${hi} oralig‘ida butun son bo‘lsin`);
  return v;
};

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
