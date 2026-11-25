// The money side: bills, fulfilment, refunds and the provider payout ledger.
// Card data never reaches this server: guests pay on the payment company's own page.
import { ago, fail, id, str, tashkentNow } from "../lib/util.mjs";
import { createOcto } from "./octo.mjs";
import { checkoutLink, createPayme } from "./payme.mjs";

const MAX_ATTEMPTS = 8;

export function createPayments({ db, config, fetchFn, accounts, bookings, plans, audit }) {
  const { octo, payme, publicUrl, testPayments } = config;
  const octoApi = octo && createOcto({ octo, fiscal: config.fiscal, publicUrl, fetchFn });
  const get = (pid) => db.one("SELECT * FROM payments WHERE id=?", typeof pid === "string" ? pid : "");
  const methods = () => [octo && "octo", payme && "payme", testPayments && "test"].filter(Boolean);

  // ---- fulfilment ------------------------------------------------------------------------------
  /** Delivers what was paid for, exactly once, in the caller's transaction. The payment row must be locked. */
  async function fulfil(p) {
    if (p.fulfilled_at) return;
    let problem = null;
    if (p.kind === "plan") await plans.activatePlan(p.ref, p);
    else {
      // markPaid queues on the listing, so the duplicate check below cannot race with another payment for this booking.
      if ((await bookings.markPaid(p.ref)) === "late") problem = "Joy band bo‘lib qolgan";
      else if (await db.one("SELECT 1 x FROM payments WHERE kind='booking' AND ref=? AND id<>? AND fulfilled_at IS NOT NULL AND status='paid'", p.ref, p.id)) problem = "Ikki marta to‘langan";
    }
    await db.run("UPDATE payments SET fulfilled_at=now(), updated_at=now() WHERE id=?", p.id);
    if (problem) await dueRefund(p.id, problem);
  }
  const settle = (pid) => db.tx(async () => {
    const r = await db.run("UPDATE payments SET status='paid', paid_at=now(), updated_at=now() WHERE id=? AND status IN ('created','cancelled','failed')", pid);
    if (r.changes) await audit("system", "payment_paid", pid);
    const p = await db.one("SELECT * FROM payments WHERE id=? FOR UPDATE", pid);
    if (p.status === "paid") await fulfil(p);
  });

  // ---- refunds -----------------------------------------------------------------------------------
  async function dueRefund(pid, why) {
    const r = await db.run("UPDATE payments SET status='refund_due', note=?, updated_at=now() WHERE id=? AND status='paid'", why, pid);
    if (!r.changes) return;
    await audit("system", "refund_due", pid);
    db.afterCommit(() => tryRefund(pid));
  }
  async function markRefunded(pid, by) {
    const r = await db.run("UPDATE payments SET status='refunded', refunded_at=now(), updated_at=now() WHERE id=? AND status IN ('paid','refund_due')", pid);
    if (r.changes) await audit(by, "refunded", pid);
    return r.changes > 0;
  }
  async function tryRefund(pid) {
    // The update is the lock: only one worker, on any server, gets the row back.
    const p = await db.one(`UPDATE payments SET attempts=attempts+1, updated_at=now() WHERE id=? AND status='refund_due' AND attempts < ${MAX_ATTEMPTS} AND (attempts=0 OR updated_at < now() - interval '60 seconds') RETURNING *`, pid);
    if (!p) return;
    if (p.provider === "test" || p.provider === "credit") return void (await markRefunded(pid, "system"));
    if (p.provider !== "octo" || !octoApi) return; // Payme refunds are made in its cabinet and arrive as CancelTransaction
    try {
      // Look first: an earlier attempt may have worked although its answer was lost.
      if ((await octoApi.status(p)) === "refunded" || (await octoApi.refund(p))) await markRefunded(pid, "octo");
    } catch (e) {
      await db.run("UPDATE payments SET note=? WHERE id=? AND status='refund_due'", `Qaytarish xatosi: ${String(e.message).slice(0, 160)}`, pid);
      console.error("[octo] refund", e.octo ?? e.name);
    }
  }

  // ---- starting a payment ------------------------------------------------------------------------
  async function bill(kind, ref, provider, amount, meta = {}) {
    const json = JSON.stringify(meta);
    return db.tx(async () => {
      await db.one("SELECT pg_advisory_xact_lock(hashtextextended(?, 7))", `${kind}:${ref}`); // pressing the button twice must not make two bills
      const open = await db.one("SELECT * FROM payments WHERE kind=? AND ref=? AND provider=? AND status='created' AND amount_uzs=? AND meta=?::jsonb AND created_at > ? ORDER BY created_at DESC LIMIT 1", kind, ref, provider, amount, json, ago(20 * 60e3));
      return open ?? db.one("INSERT INTO payments (id,kind,ref,provider,amount_uzs,status,meta) VALUES (?,?,?,?,?,'created',?) RETURNING *", id("p_"), kind, ref, provider, amount, json);
    });
  }
  async function start(kind, ref, provider, info) {
    if (!methods().includes(provider)) throw fail(400, "Bu to‘lov usuli ulanmagan", "pay");
    const p = await bill(kind, ref, provider, info.amount, info.meta);
    if (provider === "test") { await settle(p.id); return { done: true }; }
    if (provider === "payme") return { url: checkoutLink(config, p, info) };
    if (p.url) return { url: p.url };
    try {
      const d = await octoApi.prepare(p, info);
      await db.run("UPDATE payments SET ext_id=?, url=?, updated_at=now() WHERE id=?", d.uuid, d.url, p.id);
      return { url: d.url };
    } catch (e) {
      console.error("[octo]", e.octo ?? e.name);
      await db.run("UPDATE payments SET status='failed', note=?, updated_at=now() WHERE id=? AND status='created'", String(e.message).slice(0, 200), p.id);
      throw fail(502, "To‘lov tizimi javob bermadi. Birozdan keyin urinib ko‘ring", "pay");
    }
  }
  /** A notification body is never trusted: the status is always asked for again from Octo. */
  async function octoSync(p) {
    const s = await octoApi.status(p).catch(async (e) => {
      if (!e.octo && e.name === "Error") await db.run("UPDATE payments SET note=? WHERE id=?", e.message.slice(0, 200), p.id); // a mismatch an administrator must see
      throw e;
    });
    if (s === "paid") await settle(p.id);
    else if (s === "refunded") await db.tx(async () => { if (await markRefunded(p.id, "octo")) if (p.kind === "booking") await bookings.moneyReturned(p.ref); });
    else if (s === "cancelled") await db.run("UPDATE payments SET status='cancelled', updated_at=now() WHERE id=? AND status='created'", p.id);
  }

  const api = {
    methods, get,
    async startBooking(token, provider) {
      const b = await bookings.forPayment(token);
      return start("booking", b.id, provider, { amount: b.total_uzs, lang: b.lang, title: b.title, returnUrl: `${publicUrl}/?b=${token}&lang=${b.lang}` });
    },
    async startPlan(credential, plan, provider) {
      const { hostId, quote } = await plans.planQuote(credential, plan);
      if (quote.amount <= 0) { // unused days cover the whole price
        await settle((await bill("plan", hostId, "credit", 0, { plan })).id);
        return { done: true };
      }
      return start("plan", hostId, provider, { amount: quote.amount, lang: "uz", title: `SilkRoad ${plan}`, meta: { plan }, returnUrl: `${publicUrl}/mezbon#tarif` });
    },
    /** What the guest may see about the money for a booking. */
    async summary(bookingId) {
      const p = await db.one("SELECT provider, status FROM payments WHERE kind='booking' AND ref=? ORDER BY (status='paid') DESC, (status IN ('refund_due','refunded')) DESC, created_at DESC LIMIT 1", bookingId);
      return p ? { provider: p.provider, status: p.status } : null;
    },
    /** Called when the payer returns: asks Octo at most once every few seconds. */
    async refresh(kind, ref) {
      if (!octoApi) return;
      const rows = await db.all("UPDATE payments SET updated_at=now() WHERE kind=? AND ref=? AND provider='octo' AND status='created' AND ext_id IS NOT NULL AND updated_at < ? RETURNING *", kind, ref, ago(4000));
      for (const p of rows) await octoSync(p).catch((e) => console.error("[octo]", e.octo ?? e.message));
    },
    async octoNotify(body) {
      const p = octoApi && (await get(body?.shop_transaction_id));
      if (p?.provider !== "octo") return { status: "ignored" };
      await octoSync(p);
      return { status: "ok" };
    },
    payme: createPayme({ db, config, hooks: {
      canPay: async (p) => p.kind === "plan" || bookings.canPay(p.ref),
      extendHold: async (p) => { if (p.kind === "booking") await bookings.extendHold(p.ref); },
      settle: (p) => settle(p.id),
      canRefund: async (p) => p.kind === "booking" && bookings.canRefund(p.ref),
      refunded: async (p) => { await markRefunded(p.id, "payme"); if (p.kind === "booking") await bookings.moneyReturned(p.ref); },
    } }),

    /** Called when a paid booking is cancelled in time, declined or not answered. */
    async refundBooking(bookingId, why) {
      for (const p of await db.all("SELECT id FROM payments WHERE kind='booking' AND ref=? AND status='paid'", bookingId)) await dueRefund(p.id, why);
    },
    refundsDue: () => db.all("SELECT id, kind, ref, provider, amount_uzs, note, attempts, created_at FROM payments WHERE status='refund_due' ORDER BY updated_at LIMIT 200"),
    /** An administrator confirms a refund made in the payment company's own cabinet. */
    async confirmRefund(pid, by = "admin") { if (!(await db.one("SELECT 1 x FROM payments WHERE id=? AND status='refund_due'", String(pid))) || !(await markRefunded(pid, by))) throw fail(409, "Bu to‘lov qaytarishni kutmayapti", "state"); return { ok: true }; },
    async retryRefund(pid) { await db.run("UPDATE payments SET attempts=0 WHERE id=? AND status='refund_due'", String(pid)); await tryRefund(String(pid)); return { ok: true }; },

    /** Runs every couple of minutes: missed notifications, unfinished deliveries, due refunds. */
    async work() {
      const safe = (fn, label) => fn().catch((e) => console.error(`[payments] ${label}`, e.octo ?? e.message));
      for (const p of await db.all("SELECT id FROM payments WHERE status='paid' AND fulfilled_at IS NULL LIMIT 50")) await safe(() => settle(p.id), "fulfil");
      if (octoApi) for (const p of await db.all("SELECT * FROM payments WHERE provider='octo' AND status='created' AND ext_id IS NOT NULL AND created_at > ? LIMIT 50", ago(2 * 3600e3))) await safe(() => octoSync(p), "octo");
      for (const p of await db.all(`SELECT id FROM payments WHERE status='refund_due' AND attempts < ${MAX_ATTEMPTS} ORDER BY updated_at LIMIT 20`)) await safe(() => tryRefund(p.id), "refund");
    },

    // ---- payouts -------------------------------------------------------------------------------
    /** A visit counts as delivered after check-in, or a day after it took place. Test money never becomes a real debt. */
    async balance(hostId) {
      const cut = tashkentNow(new Date(Date.now() - 24 * 3600e3)).slice(0, 16);
      const r = await db.one(`SELECT COALESCE(SUM(b.host_uzs) FILTER (WHERE b.checked_in_at IS NOT NULL OR b.date + b.time::time <= ?::timestamp),0) earned,
        COALESCE(SUM(b.host_uzs) FILTER (WHERE b.checked_in_at IS NULL AND b.date + b.time::time > ?::timestamp),0) upcoming
        FROM bookings b JOIN listings l ON l.id=b.listing_id
        WHERE l.host_id=? AND b.status='confirmed' AND EXISTS (SELECT 1 FROM payments p WHERE p.kind='booking' AND p.ref=b.id AND p.status='paid' AND (p.provider<>'test' OR ?::boolean))`, cut, cut, hostId, testPayments);
      const paid = (await db.one("SELECT COALESCE(SUM(amount_uzs),0) n FROM payouts WHERE host_id=?", hostId)).n;
      return { available: Math.max(0, r.earned - paid), upcoming: r.upcoming, paid_out: paid, payouts: await db.all("SELECT id, amount_uzs, reference, created_at FROM payouts WHERE host_id=? ORDER BY created_at DESC LIMIT 24", hostId) };
    },
    async hostBalance(credential) { return api.balance((await accounts.authHost(credential)).id); },
    /** Records a transfer the administrator has already made at the bank. This server moves no money. */
    recordPayout: (hostId, amount, reference, by = "admin") => db.tx(async () => {
      const ref = str(reference, "Bank to‘lov raqami", 80);
      if (!Number.isInteger(amount) || amount <= 0) throw fail(400, "Summa noto‘g‘ri");
      if (!(await db.one("SELECT id FROM hosts WHERE id=? FOR UPDATE", String(hostId)))) throw fail(404, "Hisob topilmadi", "notfound");
      if (amount > (await api.balance(hostId)).available) throw fail(409, "Summa mavjud qoldiqdan katta");
      const pid = id("o_");
      await db.run("INSERT INTO payouts (id,host_id,amount_uzs,reference) VALUES (?,?,?,?)", pid, hostId, amount, ref);
      await audit(by, "payout", pid);
      return api.balance(hostId);
    }),
  };
  return api;
}
