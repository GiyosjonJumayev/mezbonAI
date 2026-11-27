// Subscription plans. They are paid for one period at a time and never renew by themselves.
import { DAY, fail, id } from "../lib/util.mjs";

/** Prices are placeholders to be tested with real providers. `listings: null` means no limit; `assistant` is AI messages per day. */
export const PLANS = {
  free: { price: 0, commission: 12, listings: 3, assistant: 15, days: [30], detail: false, intelligence: false },
  pro: { price: 149_000, commission: 8, listings: null, assistant: 100, days: [30, 90, 365], detail: true, intelligence: false },
  business: { price: 490_000, commission: 6, listings: null, assistant: 300, days: [30, 90, 365], detail: true, intelligence: true },
};
export const PERIOD_DAYS = 30;
/** Being shown first in search, always marked as promoted. */
export const BOOST = { days: 7, price: 99_000 };
/** A hotel that refers a guest earns this share. The platform's share depends on the provider's plan. */
export const HOTEL_FEE = 8;
const RANK = Object.keys(PLANS);

export const effectivePlan = (h, at = new Date()) => (h.plan !== "free" && h.plan_until && new Date(h.plan_until) > at && Object.hasOwn(PLANS, h.plan) ? h.plan : "free");
/** `partner` is a reseller's share in percent; it comes out of the provider's part, which the provider agreed to when allowing resale. */
export function split(total, channel, plan = "free", partner = 0) {
  const platform = Math.round((total * PLANS[plan].commission) / 100);
  const hotel = channel === "hotel" ? Math.round((total * HOTEL_FEE) / 100) : 0;
  const resold = Math.round((total * partner) / 100);
  return { total, platform, hotel, partner: resold, host: total - platform - hotel - resold };
}

export function createPlans({ db, accounts }) {
  async function planOf(h) {
    const plan = effectivePlan(h);
    return { plan, until: plan === "free" ? null : h.plan_until, ...PLANS[plan], used: (await db.one("SELECT COUNT(*) n FROM listings WHERE host_id=? AND status='published'", h.id)).n };
  }
  /** What a plan would cost now. Upgrading credits the unused days of the current plan. */
  function quote(h, plan) {
    if (!Object.hasOwn(PLANS, plan) || plan === "free") throw fail(400, "Tarif noto‘g‘ri");
    const cur = effectivePlan(h), price = PLANS[plan].price, t = Date.now();
    if (RANK.indexOf(plan) < RANK.indexOf(cur)) throw fail(409, "Joriy tarif muddati tugagach, past tarifga o‘tish mumkin", "plan");
    if (plan === cur) return { plan, kind: "extend", credit: 0, amount: price, until: new Date(+new Date(h.plan_until) + PERIOD_DAYS * DAY).toISOString() };
    const left = cur === "free" ? 0 : Math.max(0, (+new Date(h.plan_until) - t) / DAY);
    const credit = Math.min(price, Math.round((left / PERIOD_DAYS) * PLANS[cur].price));
    return { plan, kind: cur === "free" ? "new" : "upgrade", credit, amount: price - credit, until: new Date(t + PERIOD_DAYS * DAY).toISOString() };
  }
  return {
    planOf,
    async plans(credential) {
      const h = await accounts.authHost(credential);
      return {
        current: await planOf(h),
        options: RANK.map((p) => {
          let offer = null;
          try { offer = p === "free" ? null : quote(h, p); } catch {}
          return { id: p, ...PLANS[p], offer };
        }),
        invoices: await db.all("SELECT id, plan, kind, credit_uzs, amount_uzs, until, created_at FROM invoices WHERE host_id=? ORDER BY created_at DESC LIMIT 24", h.id),
      };
    },
    async planQuote(credential, plan) { const h = await accounts.authHost(credential); return { hostId: h.id, quote: quote(h, plan) }; },
    /** Called once per paid payment, inside its transaction. The amount paid is what the invoice says. */
    async activatePlan(hostId, payment) {
      const h = await db.one("SELECT * FROM hosts WHERE id=? FOR UPDATE", hostId), plan = payment.meta.plan, cur = effectivePlan(h), t = Date.now();
      // The plan may have changed while the bill was open: a paid period is always added, never lost.
      const higher = RANK.indexOf(cur) > RANK.indexOf(plan);
      const until = cur === plan || higher ? new Date(+new Date(h.plan_until) + PERIOD_DAYS * DAY * (higher ? PLANS[plan].price / PLANS[cur].price : 1)).toISOString() : new Date(t + PERIOD_DAYS * DAY).toISOString();
      const kept = higher ? cur : plan;
      const r = await db.run("INSERT INTO invoices (id,host_id,payment_id,plan,kind,credit_uzs,amount_uzs,until) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (payment_id) DO NOTHING",
        id("i_"), hostId, payment.id, kept, cur === kept ? "extend" : cur === "free" ? "new" : "upgrade", Math.max(0, PLANS[plan].price - payment.amount_uzs), payment.amount_uzs, until);
      if (r.changes) await db.run("UPDATE hosts SET plan=?, plan_until=? WHERE id=?", kept, until, hostId);
    },
    /** Platform income for the demo panel. */
    async platform() {
      const r = await db.all("SELECT plan, COUNT(*) n FROM hosts WHERE plan<>'free' AND plan_until > now() GROUP BY plan");
      return { subscribers: r.reduce((s, x) => s + x.n, 0), mrr: r.reduce((s, x) => s + PLANS[x.plan].price * x.n, 0), subscriptions: (await db.one("SELECT COALESCE(SUM(amount_uzs),0) n FROM invoices")).n };
    },
  };
}
