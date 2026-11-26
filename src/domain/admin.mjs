// Platform administration: verification, moderation, refunds, payouts, audit trail and data retention.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { asHost } from "./accounts.mjs";
import { totpChecker } from "../lib/totp.mjs";
import { ago, DAY, fail, notFound, safeEqual, today, addDays } from "../lib/util.mjs";

const SESSION_HOURS = 8;

/** Signed, self-expiring administrator sessions. Changing ADMIN_KEY ends all of them. */
export function adminSessions(adminKey, totpSecret) {
  const code = totpSecret && totpChecker(totpSecret);
  const sign = (s) => createHmac("sha256", `admin-session:${adminKey}:${totpSecret ?? ""}`).update(s).digest("base64url");
  return {
    maxAge: SESSION_HOURS * 3600,
    twoStep: Boolean(code),
    open(key, otp) {
      const right = Boolean(adminKey) && typeof key === "string" && safeEqual(key, adminKey);
      // The same answer for a wrong key and a wrong code, and a code is only spent when the key is right.
      if (!right || (code && !code(otp))) throw fail(401, code ? "Kalit yoki kod noto‘g‘ri" : "Ma’muriyat kaliti noto‘g‘ri", "auth");
      const body = `${Date.now() + SESSION_HOURS * 3600e3}.${randomBytes(9).toString("base64url")}`;
      return `${body}.${sign(body)}`;
    },
    check(token) {
      const m = adminKey && /^(\d{13}\.[\w-]{12})\.([\w-]{43})$/.exec(token ?? "");
      if (!m || Number(m[1].split(".")[0]) < Date.now() || !timingSafeEqual(Buffer.from(m[2]), Buffer.from(sign(m[1])))) throw fail(401, "Qaytadan kiring", "auth");
    },
  };
}

export function createAdmin({ db, accounts, payments, audit, events, config }) {
  const one = async (sql, ...p) => { const r = await db.one(sql, ...p); if (!r) throw notFound("Topilmadi"); return r; };
  return {
    async overview() {
      return {
        counts: await db.one(`SELECT (SELECT COUNT(*) FROM hosts WHERE NOT demo) hosts, (SELECT COUNT(*) FROM listings l JOIN hosts h ON h.id=l.host_id WHERE l.status='published' AND NOT h.demo) listings,
          (SELECT COUNT(*) FROM bookings WHERE status='paid') waiting, (SELECT COUNT(*) FROM bookings WHERE status='confirmed') confirmed,
          (SELECT COALESCE(SUM(amount_uzs),0) FROM payments WHERE status='paid' AND provider<>'test') received, (SELECT COALESCE(SUM(amount_uzs),0) FROM payments WHERE status='paid' AND provider='test') test_received`),
        refunds: await payments.refundsDue(),
        reports: await db.all(`SELECT r.id, r.reason, r.details, r.created_at, l.id listing_id, l.status, l.i18n->'uz'->>'title' title, h.name host, h.id host_id
          FROM reports r JOIN listings l ON l.id=r.listing_id JOIN hosts h ON h.id=l.host_id WHERE r.resolved_at IS NULL ORDER BY r.created_at LIMIT 100`),
        payments: await db.all("SELECT id, kind, provider, amount_uzs, status, note, created_at FROM payments ORDER BY created_at DESC LIMIT 30"),
        audit: await db.all("SELECT actor, action, target, at FROM audit_log ORDER BY id DESC LIMIT 60"),
        methods: payments.methods(),
      };
    },
    async hosts(q = "") {
      const like = `%${String(q).slice(0, 60).replace(/[\\%_]/g, "\\$&")}%`;
      const rows = await db.all(`SELECT h.id, h.name, h.type, h.plan, h.demo, h.verified_at, h.suspended_at, h.created_at,
        (SELECT COUNT(*) FROM listings WHERE host_id=h.id AND status='published') listings,
        (SELECT string_agg(DISTINCT cert_no, ', ') FROM listings WHERE host_id=h.id) certificates
        FROM hosts h WHERE NOT h.stage AND (h.name ILIKE ? OR h.id ILIKE ?) ORDER BY (h.verified_at IS NULL) DESC, h.created_at DESC LIMIT 50`, like, like);
      return Promise.all(rows.map(async (h) => ({ ...h, balance: await payments.balance(h.id) })));
    },
    async verifyHost(hid, on) {
      const h = await one("UPDATE hosts SET verified_at = CASE WHEN ?::boolean THEN COALESCE(verified_at, now()) END WHERE id=? RETURNING id", Boolean(on), String(hid));
      await audit("admin", on ? "host_verified" : "host_unverified", h.id);
      return { ok: true };
    },
    async suspendHost(hid, on) {
      const h = await one("UPDATE hosts SET suspended_at = CASE WHEN ?::boolean THEN COALESCE(suspended_at, now()) END WHERE id=? RETURNING id", Boolean(on), String(hid));
      await audit("admin", on ? "host_suspended" : "host_restored", h.id);
      return { ok: true };
    },
    async blockListing(lid, on) {
      const l = await one("UPDATE listings SET status = CASE WHEN ?::boolean THEN 'blocked' ELSE 'paused' END WHERE id=? AND status <> 'draft' RETURNING id", Boolean(on), String(lid));
      await audit("admin", on ? "listing_blocked" : "listing_unblocked", l.id);
      return { ok: true };
    },
    async resolveReport(rid) {
      const r = await one("UPDATE reports SET resolved_at=now() WHERE id=? AND resolved_at IS NULL RETURNING id", Number.parseInt(rid, 10) || 0);
      await audit("admin", "report_resolved", String(r.id));
      return { ok: true };
    },
    /** For a provider who lost every way in, after the administrator has checked who they are. */
    async recoveryLink(hid) {
      const h = await one("SELECT id FROM hosts WHERE id=?", String(hid));
      const token = await accounts.loginLink(asHost(h.id));
      await audit("admin", "recovery_link", h.id);
      return { url: `${config.publicUrl}/mezbon#kirish=${token}` };
    },

    /** Removes personal data that is no longer needed. Amounts and dates stay for accounting. */
    async retention() {
      const cut = addDays(today(), -config.retentionDays);
      return db.tx(async () => {
        const rows = await db.all("UPDATE bookings SET guest_name='—', guest_email=NULL, guest_phone=NULL, anonymized_at=now() WHERE anonymized_at IS NULL AND date < ? AND status NOT IN ('paid') RETURNING id", cut);
        if (!rows.length) return 0;
        const ids = rows.map((r) => r.id);
        await db.run("UPDATE trips t SET guest_name='—' WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.trip_id=t.id AND b.anonymized_at IS NULL)");
        await db.run("DELETE FROM messages WHERE booking_id = ANY(?::text[])", ids);
        await db.run("DELETE FROM push_subs WHERE kind='guest' AND ref = ANY(?::text[])", ids);
        await audit("system", "anonymized", `${rows.length} bookings`);
        return rows.length;
      });
    },
    cleanup: async () => {
      await accounts.cleanAccounts();
      // Holds that were never paid and have no bill are only clutter.
      await db.run("DELETE FROM bookings b WHERE b.status='pending' AND b.expires_at < ? AND NOT EXISTS (SELECT 1 FROM payment_items i WHERE i.booking_id=b.id)", ago(7 * DAY));
      await db.run("DELETE FROM trips t WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.trip_id=t.id)", ago(8 * DAY));
    },
  };
}
