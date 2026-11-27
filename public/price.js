// The one price formula. The server charges with it and the browser shows it, so the two can never disagree.

/** What a provider may choose. */
export const PRICE_LIMITS = { weekend: [-50, 50], hours: [6, 12, 24, 48, 72], last: [5, 50], from: [2, 30], group: [5, 40] };

/** Add-ons a provider can sell with a visit. Their names are translated in the interface. */
export const EXTRAS = ["transfer", "lunch", "souvenir", "photo"];
/** What the chosen add-ons cost. `per` is "person" or "booking". Unknown or unoffered add-ons are ignored. */
export function extrasCost(l, kinds = [], guests = 1) {
  const chosen = (l.extras ?? []).filter((x) => kinds.includes(x.kind));
  return { items: chosen.map((x) => ({ ...x, amount: x.per === "person" ? x.price * guests : x.price })), total: chosen.reduce((s, x) => s + (x.per === "person" ? x.price * guests : x.price), 0) };
}

const round = (n) => Math.max(1000, Math.round(n / 1000) * 1000);

/** Price for one person. Weekends change the price itself; of the two discounts only the larger one counts.
 *  `l` needs price_uzs and pricing. Times are Tashkent (UTC+5). */
export function unitPrice(l, date, time, guests = 1, now = Date.now()) {
  const p = l.pricing ?? {}, weekday = new Date(`${date}T00:00:00Z`).getUTCDay(), weekend = Boolean(p.weekend) && (weekday === 6 || weekday === 0);
  const before = weekend ? round((l.price_uzs * (100 + p.weekend)) / 100) : l.price_uzs;
  const offers = [];
  if (p.last && Date.parse(`${date}T${time}:00+05:00`) - now <= p.last.hours * 3600e3) offers.push(["last", p.last.pct]);
  if (p.group && guests >= p.group.from) offers.push(["group", p.group.pct]);
  const best = offers.sort((a, b) => b[1] - a[1])[0];
  return best ? { unit: Math.min(before, round((before * (100 - best[1])) / 100)), before, why: best[0], pct: -best[1] } : { unit: before, before, why: weekend ? "weekend" : null, pct: weekend ? p.weekend : 0 };
}
