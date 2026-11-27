// Gift vouchers: bought like a booking, spent on one or more visits. The balance is taken only when a booking's payment succeeds,
// so two bookings can never spend the same money, and it is given back when such a booking is refunded.
import { randomBytes } from "node:crypto";
import { addDays, fail, id, int, lang, notFound, secret, str, today } from "../lib/util.mjs";
import { cleanEmail } from "./mail.mjs";

export const VOUCHER = { min: 50_000, max: 20_000_000, months: 12 };
export const cleanVoucher = (v) => (typeof v === "string" ? v.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 11) : "");

export function createVouchers({ db, audit }) {
  const view = (v) => ({ token: v.token, code: v.status === "active" ? v.code : null, amount_uzs: v.amount_uzs, balance_uzs: v.balance_uzs, status: v.status, recipient: v.recipient, message: v.message, buyer_name: v.buyer_name, lang: v.lang, valid_until: v.valid_until });
  return {
    async createVoucher(p = {}) {
      const email = cleanEmail(p.email);
      if (!email) throw fail(400, "Email kerak", "email");
      const amount = int(p.amount_uzs, "Summa", VOUCHER.min, VOUCHER.max), v = { id: id("v_"), token: secret(), code: `G${randomBytes(5).toString("hex").toUpperCase()}` };
      await db.run("INSERT INTO vouchers (id,token,code,amount_uzs,balance_uzs,buyer_name,buyer_email,recipient,message,lang,valid_until) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        v.id, v.token, v.code, amount, amount, str(p.name, "Ism", 80), email, p.recipient ? str(p.recipient, "Kimga", 80) : null, p.message ? str(p.message, "Tilak", 400) : null, lang(p.lang), addDays(today(), 365));
      return { token: v.token };
    },
    async voucher(token) {
      const v = typeof token === "string" ? await db.one("SELECT * FROM vouchers WHERE token=?", token) : null;
      if (!v) throw notFound("Sovg‘a topilmadi");
      return view(v);
    },
    /** For the booking form: how much this code can pay. Every refusal looks the same. */
    async checkVoucher(code) {
      const v = await db.one("SELECT balance_uzs, valid_until FROM vouchers WHERE code=? AND status='active'", cleanVoucher(code));
      if (!v || v.valid_until < today() || v.balance_uzs <= 0) throw fail(409, "Sovg‘a kodi yaroqsiz", "voucher");
      return { code: cleanVoucher(code), balance_uzs: v.balance_uzs };
    },
    /** Inside the booking's transaction: the part of `total` this code will pay. */
    async voucherFor(code, total) {
      const v = await db.one("SELECT * FROM vouchers WHERE code=? AND status='active'", cleanVoucher(code));
      if (!v || v.valid_until < today() || v.balance_uzs <= 0) throw fail(409, "Sovg‘a kodi yaroqsiz", "voucher");
      return { id: v.id, amount: Math.min(v.balance_uzs, total) };
    },
    /** Called once per paid voucher payment, inside its transaction. */
    async activateVoucher(vid) {
      const r = await db.one("UPDATE vouchers SET status='active', paid_at=now() WHERE id=? AND status='unpaid' RETURNING *", vid);
      if (r) await audit("system", "voucher_paid", r.id);
      return r;
    },
    /** Whether the voucher still holds this booking's part. */
    covers: async (bid) => Boolean(await db.one("SELECT 1 x FROM bookings b JOIN vouchers v ON v.id=b.voucher_id WHERE b.id=? AND (b.voucher_taken OR (v.balance_uzs >= b.voucher_uzs AND v.valid_until >= ?))", bid, today())),
    /** Inside markPaid. False when the balance is no longer enough: then the booking cannot be paid this way. */
    async takeVoucher(b) {
      if (!b.voucher_id || b.voucher_taken) return true;
      const r = await db.run("UPDATE vouchers SET balance_uzs = balance_uzs - ? WHERE id=? AND balance_uzs >= ? AND valid_until >= ?", b.voucher_uzs, b.voucher_id, b.voucher_uzs, today());
      if (!r.changes) return false;
      await db.run("UPDATE bookings SET voucher_taken=true WHERE id=?", b.id);
      return true;
    },
    /** A refunded booking gives its part back. Once. */
    async returnVoucher(bid) {
      const b = await db.one("UPDATE bookings SET voucher_taken=false WHERE id=? AND voucher_taken RETURNING voucher_id, voucher_uzs", bid);
      if (b) await db.run("UPDATE vouchers SET balance_uzs = LEAST(amount_uzs, balance_uzs + ?) WHERE id=?", b.voucher_uzs, b.voucher_id);
    },
    /** For administrators and investors: money received in advance, and what is still to be spent. */
    voucherTotals: () => db.one("SELECT COUNT(*) FILTER (WHERE status='active') sold, COALESCE(SUM(amount_uzs) FILTER (WHERE status='active'),0) amount, COALESCE(SUM(balance_uzs) FILTER (WHERE status='active' AND valid_until >= current_date),0) open FROM vouchers"),
  };
}
