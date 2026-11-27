// Promo codes for hotels, guides, bloggers and campaigns. The platform pays the discount from its own share,
// so a provider earns the same with or without a code.
import { randomBytes } from "node:crypto";
import { addDays, fail, int, isDate, notFound, today } from "../lib/util.mjs";
import { LIVE } from "./availability.mjs";
import { effectivePlan, PLANS } from "./plans.mjs";

export const cleanCode = (v) => (typeof v === "string" ? v.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20) : "");
/** Bookings that count against a code's limit: paid ones and holds still waiting for payment. */
const USED = `SELECT COUNT(*) n FROM bookings WHERE promo_code=? AND (status IN ('paid','confirmed') OR ${LIVE})`;

export function createPromos({ db, audit }) {
  /** A code that can be used now. Every refusal has the same answer, so codes cannot be probed for their details. */
  async function usable(raw, lock = false) {
    const code = cleanCode(raw), p = code && (await db.one(`SELECT * FROM promo_codes WHERE code=?${lock ? " FOR UPDATE" : ""}`, code));
    const no = () => fail(409, "Promo kod yaroqsiz", "promo");
    if (!p || !p.active || (p.valid_until && p.valid_until < today())) throw no();
    if (p.uses_max != null && (await db.one(USED, p.code)).n >= p.uses_max) throw no();
    return p;
  }
  /** The share a guest saves: never more than the platform earns on that offer. */
  const cap = (p, l) => Math.min(p.pct, PLANS[effectivePlan({ plan: l.host_plan, plan_until: l.host_plan_until })].commission);

  return {
    /** Called inside the booking's transaction. Returns the discount on `total`, and how much of it the platform carries. */
    async applyPromo(raw, l, total) {
      const p = await usable(raw, true);
      return { code: p.code, discount: Math.round((total * cap(p, l)) / 100) };
    },
    /** For the booking form: the exact percent this offer gets. */
    async checkPromo(raw, lid) {
      const l = await db.one("SELECT l.id, h.plan host_plan, h.plan_until host_plan_until FROM listings l JOIN hosts h ON h.id=l.host_id WHERE l.id=? AND l.status='published'", String(lid ?? ""));
      if (!l) throw fail(404, "Taklif topilmadi", "notfound");
      const p = await usable(raw);
      return { code: p.code, pct: cap(p, l) };
    },

    /** A paid guest's own code: friends get 10% off, and for each friend who pays the guest gets 10% off next time. */
    async referralCode(booking) {
      if (!booking || !["paid", "confirmed"].includes(booking.status) || !booking.guest_email) throw notFound("Bron topilmadi");
      const had = await db.one("SELECT code FROM promo_codes WHERE ref_booking=? AND note='referral'", booking.id);
      if (had) return { code: had.code };
      const code = `F${randomBytes(4).toString("hex").toUpperCase()}`;
      await db.run("INSERT INTO promo_codes (code,pct,uses_max,valid_until,note,ref_booking,owner_email) VALUES (?,10,10,?,'referral',?,?) ON CONFLICT DO NOTHING", code, addDays(today(), 365), booking.id, booking.guest_email);
      return { code: (await db.one("SELECT code FROM promo_codes WHERE ref_booking=? AND note='referral'", booking.id)).code };
    },
    /** One single-use code for the guest who brought a friend. */
    async rewardCode() {
      const code = `T${randomBytes(4).toString("hex").toUpperCase()}`;
      await db.run("INSERT INTO promo_codes (code,pct,uses_max,valid_until,note) VALUES (?,10,1,?,'reward')", code, addDays(today(), 365));
      return code;
    },

    // ---- administrators ------------------------------------------------------------------------------
    async createPromo({ code, pct, uses_max, valid_until, note } = {}) {
      const c = cleanCode(code);
      if (c.length < 3) throw fail(400, "Kod kamida 3 ta harf yoki raqam");
      int(pct, "Chegirma", 1, 50);
      if (uses_max != null) int(uses_max, "Necha marta", 1, 100000);
      if (valid_until != null && (!isDate(valid_until) || valid_until < today())) throw fail(400, "Muddat noto‘g‘ri");
      const r = await db.run("INSERT INTO promo_codes (code,pct,uses_max,valid_until,note) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING", c, pct, uses_max ?? null, valid_until ?? null, typeof note === "string" ? note.trim().slice(0, 120) : "");
      if (!r.changes) throw fail(409, "Bunday kod bor");
      await audit("admin", "promo_created", c);
      return { code: c };
    },
    async setPromo(code, { active } = {}) {
      const r = await db.one("UPDATE promo_codes SET active=? WHERE code=? RETURNING code", Boolean(active), cleanCode(code));
      if (!r) throw fail(404, "Topilmadi", "notfound");
      await audit("admin", active ? "promo_on" : "promo_off", r.code);
      return { ok: true };
    },
    /** What each code brought, and what it cost. */
    promos: () => db.all(`SELECT p.code, p.pct, p.uses_max, p.valid_until, p.note, p.active, p.created_at, COUNT(b.id) FILTER (WHERE b.status IN ('paid','confirmed')) sold, COALESCE(SUM(b.total_uzs) FILTER (WHERE b.status IN ('paid','confirmed')),0) gross,
        COALESCE(SUM(b.discount_uzs) FILTER (WHERE b.status IN ('paid','confirmed')),0) cost FROM promo_codes p LEFT JOIN bookings b ON b.promo_code=p.code WHERE p.note NOT IN ('referral','reward') GROUP BY p.code ORDER BY p.created_at DESC`),
    /** Totals of the guest programme, without anyone's address. */
    referralTotals: () => db.one(`SELECT COUNT(DISTINCT p.code) FILTER (WHERE p.note='referral') codes, COUNT(b.id) FILTER (WHERE p.note='referral' AND b.status IN ('paid','confirmed')) friends,
        COALESCE(SUM(b.total_uzs) FILTER (WHERE p.note IN ('referral','reward') AND b.status IN ('paid','confirmed')),0) gross, COALESCE(SUM(b.discount_uzs) FILTER (WHERE p.note IN ('referral','reward') AND b.status IN ('paid','confirmed')),0) cost
      FROM promo_codes p LEFT JOIN bookings b ON b.promo_code=p.code WHERE p.note IN ('referral','reward')`),
  };
}
