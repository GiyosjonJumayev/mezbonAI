// The money side: bills, fulfilment, refunds and the provider payout ledger.
// Card data never reaches this server: guests pay on the payment company's own page.
import { ago, fail, id, str, tashkentNow } from "../lib/util.mjs";
import { clickLink, createClick, createClickApi } from "./click.mjs";
import { createOcto } from "./octo.mjs";
import { checkoutLink, createPayme } from "./payme.mjs";

const MAX_ATTEMPTS = 8;
/** A trip is refunded booking by booking, so it needs a company that can send part of a payment back. */
const PARTIAL = ["octo", "test"];

export function createPayments({ db, config, fetchFn, accounts, bookings, plans, audit }) {
  const { octo, payme, click, publicUrl, testPayments } = config;
  const octoApi = octo && createOcto({ octo, fiscal: config.fiscal, publicUrl, fetchFn });
  const clickApi = click && createClickApi({ click, fetchFn });
  const get = (pid) => db.one("SELECT * FROM payments WHERE id=?", typeof pid === "string" ? pid : "");
  const methods = () => [octo && "octo", click && "click", payme && "payme", testPayments && "test"].filter(Boolean);

  // ---- fulfilment ------------------------------------------------------------------------------
  /** Delivers what was paid for, exactly once, in the caller's transaction. The payment row must be locked. */
  async function fulfil(p) {
    if (p.fulfilled_at) return;
    await db.run("UPDATE payments SET fulfilled_at=now(), updated_at=now() WHERE id=?", p.id);
    if (p.kind === "plan") return plans.activatePlan(p.ref, p);
    for (const { booking_id: bid } of await db.all("SELECT booking_id FROM payment_items WHERE payment_id=? ORDER BY booking_id", p.id)) {
      // markPaid queues on the listing, so the duplicate check below cannot race with another payment for this booking.
      if ((await bookings.markPaid(bid)) === "late") await dueRefund(p.id, bid, "Joy band bo‘lib qolgan");
      else if (await db.one(`SELECT 1 x FROM payment_items i JOIN payments o ON o.id=i.payment_id WHERE i.booking_id=? AND o.id<>? AND o.fulfilled_at IS NOT NULL AND o.status='paid'
        AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id=o.id AND r.booking_id=i.booking_id)`, bid, p.id)) await dueRefund(p.id, bid, "Ikki marta to‘langan");
    }
  }
  const settle = (pid) => db.tx(async () => {
    const r = await db.run("UPDATE payments SET status='paid', paid_at=now(), updated_at=now() WHERE id=? AND status IN ('created','cancelled','failed')", pid);
    if (r.changes) await audit("system", "payment_paid", pid);
    const p = await db.one("SELECT * FROM payments WHERE id=? FOR UPDATE", pid);
    if (p.status === "paid") await fulfil(p);
  });

  // ---- refunds -----------------------------------------------------------------------------------
  /** Decides that one booking's part of a payment goes back. Repeating it changes nothing. */
  async function dueRefund(pid, bid, why) {
    const r = await db.one("INSERT INTO refunds (id,payment_id,booking_id,amount_uzs,status,reason) SELECT ?, payment_id, booking_id, amount_uzs, 'due', ? FROM payment_items WHERE payment_id=? AND booking_id=? ON CONFLICT (payment_id,booking_id) DO NOTHING RETURNING id", id("r_"), why, pid, bid);
    if (!r) return;
    await db.run("UPDATE payments p SET note=?, updated_at=now(), status = CASE WHEN (SELECT SUM(amount_uzs) FROM refunds WHERE payment_id=p.id) >= p.amount_uzs THEN 'refund_due' ELSE p.status END WHERE id=? AND status='paid'", why, pid);
    await audit("system", "refund_due", pid);
    db.afterCommit(() => tryRefund(r.id));
  }
  const finishRefund = (rid, by) => db.tx(async () => {
    const r = await db.one("UPDATE refunds SET status='done', done_at=now(), updated_at=now(), problem=NULL WHERE id=? AND status='due' RETURNING payment_id, booking_id", rid);
    if (!r) return false;
    await bookings.tellGuest(r.booking_id, "refunded");
    await db.run("UPDATE payments p SET updated_at=now(), refunded_at=now(), status='refunded' WHERE id=? AND status IN ('paid','refund_due') AND (SELECT SUM(amount_uzs) FROM refunds WHERE payment_id=p.id AND status='done') >= p.amount_uzs", r.payment_id);
    await audit(by, "refunded", r.payment_id);
    // Refunds of one payment go one after another, so a lost answer can never be mistaken for the next refund.
    const next = await db.one("SELECT id FROM refunds WHERE payment_id=? AND status='due' ORDER BY no LIMIT 1", r.payment_id);
    if (next) db.afterCommit(() => tryRefund(next.id));
    return true;
  });
  /** The payment company already sent everything back. */
  const allRefunded = (pid, by) => db.tx(async () => {
    const p = await db.one("SELECT * FROM payments WHERE id=? FOR UPDATE", pid);
    if (!["paid", "refund_due"].includes(p.status)) return;
    await db.run("INSERT INTO refunds (id,payment_id,booking_id,amount_uzs,status,reason,done_at) SELECT 'r_' || md5(payment_id || booking_id), payment_id, booking_id, amount_uzs, 'done', 'To‘lov tizimi qaytardi', now() FROM payment_items WHERE payment_id=? ON CONFLICT (payment_id,booking_id) DO UPDATE SET status='done', done_at=COALESCE(refunds.done_at, now()), problem=NULL", pid);
    await db.run("UPDATE payments SET status='refunded', refunded_at=now(), updated_at=now() WHERE id=?", pid);
    await audit(by, "refunded", pid);
    for (const i of await db.all("SELECT booking_id FROM payment_items WHERE payment_id=? ORDER BY booking_id", pid)) await bookings.moneyReturned(i.booking_id);
  });
  async function tryRefund(rid) {
    // The update is the lock: only one worker, on any server, gets the row back.
    const r = await db.one(`UPDATE refunds SET attempts=attempts+1, updated_at=now() WHERE id=? AND status='due' AND attempts < ${MAX_ATTEMPTS} AND (attempts=0 OR updated_at < now() - interval '60 seconds')
      AND NOT EXISTS (SELECT 1 FROM refunds o WHERE o.payment_id=refunds.payment_id AND o.status='due' AND o.no < refunds.no) RETURNING *`, rid);
    if (!r) return;
    const p = await get(r.payment_id);
    try {
      if (p.provider === "test" || p.provider === "credit") await finishRefund(rid, "system");
      else if (p.provider === "octo" && octoApi) {
        // Look first: an earlier attempt may have worked although its answer was lost.
        const before = (await db.one("SELECT COALESCE(SUM(amount_uzs),0) n FROM refunds WHERE payment_id=? AND status='done'", p.id)).n;
        if ((await octoApi.refunded(p)) >= before + r.amount_uzs || (await octoApi.refund(p, r))) await finishRefund(rid, "octo");
      } else if (p.provider === "click" && clickApi && p.ext_id && r.amount_uzs === p.amount_uzs) { if (await clickApi.reverse(p.ext_id)) await finishRefund(rid, "click"); }
      // Payme refunds are made in its cabinet and arrive as CancelTransaction.
    } catch (e) {
      await db.run("UPDATE refunds SET problem=? WHERE id=? AND status='due'", String(e.message).slice(0, 200), rid);
      console.error(`[${p.provider}] refund`, e.octo ?? e.provider ?? e.name);
    }
  }

  // ---- starting a payment ------------------------------------------------------------------------
  async function bill(kind, ref, provider, amount, meta = {}, items = []) {
    const json = JSON.stringify(meta);
    return db.tx(async () => {
      await db.one("SELECT pg_advisory_xact_lock(hashtextextended(?, 7))", `${kind}:${ref}`); // pressing the button twice must not make two bills
      const open = await db.one("SELECT * FROM payments WHERE kind=? AND ref=? AND provider=? AND status='created' AND amount_uzs=? AND meta=?::jsonb AND created_at > ? ORDER BY created_at DESC LIMIT 1", kind, ref, provider, amount, json, ago(20 * 60e3));
      if (open) return open;
      const p = await db.one("INSERT INTO payments (id,kind,ref,provider,amount_uzs,status,meta) VALUES (?,?,?,?,?,'created',?) RETURNING *", id("p_"), kind, ref, provider, amount, json);
      for (const i of items) await db.run("INSERT INTO payment_items (payment_id,booking_id,amount_uzs) VALUES (?,?,?)", p.id, i.id, i.total_uzs);
      return p;
    });
  }
  async function start(kind, ref, provider, info) {
    if (!methods().includes(provider)) throw fail(400, "Bu to‘lov usuli ulanmagan", "pay");
    const p = await bill(kind, ref, provider, info.amount, info.meta, info.items);
    if (provider === "test") { await settle(p.id); return { done: true }; }
    if (provider === "payme") return { url: checkoutLink(config, p, info) };
    if (provider === "click") return { url: clickLink(config, p, info) };
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
    else if (s === "refunded") await allRefunded(p.id, "octo");
    else if (s === "cancelled") await db.run("UPDATE payments SET status='cancelled', updated_at=now() WHERE id=? AND status='created'", p.id);
  }

  /** What the Payme and Click protocols need to know. They run inside the protocol's own transaction. */
  const hooks = {
    canPay: async (p) => p.kind === "plan" || bookings.canPay(p.ref),
    extendHold: async (p) => { if (p.kind === "booking") await bookings.extendHold(p.ref); },
    settle: (p) => settle(p.id),
    canRefund: async (p) => p.kind === "booking" && bookings.canRefund(p.ref),
    refunded: (p) => allRefunded(p.id, p.provider),
  };
  const api = {
    methods, get,
    async startBooking(token, provider) {
      const b = await bookings.forPayment(token);
      return start("booking", b.id, provider, { amount: b.total_uzs, lang: b.lang, title: b.title, items: [b], returnUrl: `${publicUrl}/?b=${token}&lang=${b.lang}` });
    },
    /** One payment for every booking of a trip that still waits for money. */
    tripMethods: () => methods().filter((m) => PARTIAL.includes(m)),
    async startTrip(trip, provider) {
      if (!PARTIAL.includes(provider)) throw fail(400, "Bu usul bilan sayohatni birga to‘lab bo‘lmaydi", "pay");
      const waiting = trip.bookings.filter((b) => b.status === "pending");
      if (!waiting.length) throw fail(409, "To‘lanadigan bron yo‘q", "state");
      const items = await Promise.all(waiting.map((b) => bookings.forPayment(b.token)));
      items.sort((a, b) => a.id.localeCompare(b.id));
      return start("trip", trip.id, provider, { amount: items.reduce((n, b) => n + b.total_uzs, 0), lang: trip.lang, title: `SilkRoad trip (${items.length})`, items, meta: { bookings: items.map((b) => b.id) }, returnUrl: `${publicUrl}/?trip=${trip.token}&lang=${trip.lang}` });
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
      const p = await db.one(`SELECT p.id, p.provider, p.status, p.paid_at, i.amount_uzs, r.status back, r.done_at FROM payment_items i JOIN payments p ON p.id=i.payment_id LEFT JOIN refunds r ON r.payment_id=p.id AND r.booking_id=i.booking_id
        WHERE i.booking_id=? ORDER BY (p.paid_at IS NOT NULL AND r.id IS NULL) DESC, (r.id IS NOT NULL) DESC, p.created_at DESC LIMIT 1`, bookingId);
      return p ? { id: p.id, provider: p.provider, status: p.back ? (p.back === "done" ? "refunded" : "refund_due") : p.status, paid_at: p.paid_at, amount_uzs: p.amount_uzs, refunded_at: p.done_at } : null;
    },
    /** Called when the payer returns: asks Octo at most once every few seconds. */
    async refresh(kind, ref) {
      if (!octoApi) return;
      const which = kind === "booking" ? "id IN (SELECT payment_id FROM payment_items WHERE booking_id=?)" : "ref=?";
      const rows = await db.all(`UPDATE payments SET updated_at=now() WHERE ${which} AND provider='octo' AND status='created' AND ext_id IS NOT NULL AND updated_at < ? RETURNING *`, ref, ago(4000));
      for (const p of rows) await octoSync(p).catch((e) => console.error("[octo]", e.octo ?? e.message));
    },
    async octoNotify(body) {
      const p = octoApi && (await get(body?.shop_transaction_id));
      if (p?.provider !== "octo") return { status: "ignored" };
      await octoSync(p);
      return { status: "ok" };
    },
    payme: createPayme({ db, config, hooks }),
    click: createClick({ db, config, hooks }),

    /** Called when a paid booking is cancelled in time, declined or not answered. */
    async refundBooking(bookingId, why) {
      for (const p of await db.all("SELECT p.id FROM payment_items i JOIN payments p ON p.id=i.payment_id WHERE i.booking_id=? AND p.status='paid'", bookingId)) await dueRefund(p.id, bookingId, why);
    },
    refundsDue: () => db.all("SELECT r.id, r.payment_id, p.provider, r.amount_uzs, p.amount_uzs payment_uzs, COALESCE(r.problem, r.reason) note, r.attempts, r.created_at FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE r.status='due' ORDER BY r.no LIMIT 200"),
    /** An administrator confirms a refund made in the payment company's own cabinet. */
    async confirmRefund(rid, by = "admin") { if (!(await finishRefund(String(rid), by))) throw fail(409, "Bu to‘lov qaytarishni kutmayapti", "state"); return { ok: true }; },
    async retryRefund(rid) { await db.run("UPDATE refunds SET attempts=0 WHERE id=? AND status='due'", String(rid)); await tryRefund(String(rid)); return { ok: true }; },

    /** Runs every couple of minutes: missed notifications, unfinished deliveries, due refunds. */
    async work() {
      const safe = (fn, label) => fn().catch((e) => console.error(`[payments] ${label}`, e.octo ?? e.message));
      for (const p of await db.all("SELECT id FROM payments WHERE status='paid' AND fulfilled_at IS NULL LIMIT 50")) await safe(() => settle(p.id), "fulfil");
      if (octoApi) for (const p of await db.all("SELECT * FROM payments WHERE provider='octo' AND status='created' AND ext_id IS NOT NULL AND created_at > ? LIMIT 50", ago(2 * 3600e3))) await safe(() => octoSync(p), "octo");
      for (const r of await db.all(`SELECT id FROM refunds WHERE status='due' AND attempts < ${MAX_ATTEMPTS} ORDER BY no LIMIT 30`)) await safe(() => tryRefund(r.id), "refund");
    },

    // ---- payouts -------------------------------------------------------------------------------
    /** A visit counts as delivered after check-in, or a day after it took place. Test money never becomes a real debt. */
    async balance(hostId) {
      const cut = tashkentNow(new Date(Date.now() - 24 * 3600e3)).slice(0, 16);
      const r = await db.one(`SELECT COALESCE(SUM(b.host_uzs) FILTER (WHERE b.checked_in_at IS NOT NULL OR b.date + b.time::time <= ?::timestamp),0) earned,
        COALESCE(SUM(b.host_uzs) FILTER (WHERE b.checked_in_at IS NULL AND b.date + b.time::time > ?::timestamp),0) upcoming
        FROM bookings b JOIN listings l ON l.id=b.listing_id
        WHERE l.host_id=? AND b.status='confirmed' AND EXISTS (SELECT 1 FROM payment_items i JOIN payments p ON p.id=i.payment_id WHERE i.booking_id=b.id AND p.paid_at IS NOT NULL AND (p.provider<>'test' OR ?::boolean)
          AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id=p.id AND r.booking_id=b.id))`, cut, cut, hostId, testPayments);
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
