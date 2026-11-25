// Payme Merchant API: Payme calls us with JSON-RPC. https://developer.help.paycom.uz/
import { safeEqual } from "../lib/util.mjs";

const TIMEOUT = 12 * 3600e3; // Payme cancels an unfinished transaction after 12 hours

class RpcError extends Error {
  constructor(code, text, data) { super(text.en ?? text); this.body = { code, message: typeof text === "string" ? { ru: text, uz: text, en: text } : text, ...(data && { data }) }; }
}
const E = {
  auth: () => new RpcError(-32504, { ru: "Недостаточно привилегий", uz: "Ruxsat yetarli emas", en: "Insufficient privileges" }),
  parse: () => new RpcError(-32700, "Parse error"),
  request: () => new RpcError(-32600, "Invalid request"),
  method: (m) => new RpcError(-32601, "Method not found", m),
  system: () => new RpcError(-32400, "System error"),
  amount: () => new RpcError(-31001, { ru: "Неверная сумма", uz: "Summa noto‘g‘ri", en: "Invalid amount" }),
  noTx: () => new RpcError(-31003, { ru: "Транзакция не найдена", uz: "Tranzaksiya topilmadi", en: "Transaction not found" }),
  done: () => new RpcError(-31007, { ru: "Услуга оказана, отмена невозможна", uz: "Xizmat ko‘rsatilgan, bekor qilib bo‘lmaydi", en: "Service delivered, cannot cancel" }),
  state: () => new RpcError(-31008, { ru: "Невозможно выполнить операцию", uz: "Amalni bajarib bo‘lmaydi", en: "Cannot perform the operation" }),
  order: () => new RpcError(-31050, { ru: "Заказ не найден", uz: "Buyurtma topilmadi", en: "Order not found" }, "order_id"),
  closed: () => new RpcError(-31051, { ru: "Заказ недоступен для оплаты", uz: "Buyurtmani to‘lab bo‘lmaydi", en: "Order can no longer be paid" }, "order_id"),
};

export function checkoutLink({ payme }, p, info) {
  const q = `m=${payme.merchant};ac.order_id=${p.id};a=${p.amount_uzs * 100};l=${{ uz: "uz", ru: "ru" }[info.lang] ?? "en"};c=${info.returnUrl}`;
  return `${payme.checkout}/${Buffer.from(q).toString("base64")}`;
}

/** `hooks`: { canPay(p), extendHold(p), settle(p), canRefund(p), refunded(p) } — all run inside the open transaction. */
export function createPayme({ db, config: { payme, fiscal }, hooks }) {
  const LOCK = "FOR UPDATE";
  const byTx = (i) => db.one(`SELECT * FROM payments WHERE provider='payme' AND ext_id=? ${LOCK}`, typeof i === "string" ? i : "");
  const view = (p) => ({ create_time: p.create_ms ?? 0, perform_time: p.perform_ms ?? 0, cancel_time: p.cancel_ms ?? 0, transaction: p.id, state: p.state, reason: p.reason ?? null });
  async function order(params) {
    const oid = params.account?.order_id;
    const p = typeof oid === "string" ? await db.one(`SELECT * FROM payments WHERE id=? AND provider='payme' ${LOCK}`, oid) : null;
    if (!p) throw E.order();
    if (!Number.isInteger(params.amount) || params.amount !== p.amount_uzs * 100) throw E.amount();
    return p;
  }
  const payable = async (p) => { if (p.status !== "created" || !(await hooks.canPay(p))) throw E.closed(); };
  const expired = (p) => p.state === 1 && Date.now() - p.create_ms > TIMEOUT;
  /** Recorded even though the call itself is refused, so the error is returned, not thrown. */
  async function timeout(p) {
    await db.run("UPDATE payments SET state=-1, reason=4, cancel_ms=?, status='cancelled', updated_at=now() WHERE id=?", Date.now(), p.id);
    return { error: E.state() };
  }

  const methods = {
    async CheckPerformTransaction(params) {
      const p = await order(params);
      await payable(p);
      return { allow: true, ...(fiscal && { detail: { receipt_type: 0, items: [{ title: p.kind === "plan" ? "SilkRoad obuna" : "Turistik xizmat", price: p.amount_uzs * 100, count: 1, code: fiscal.spic, package_code: fiscal.pack, vat_percent: fiscal.vat }] } }) };
    },
    async CreateTransaction(params) {
      if (typeof params.id !== "string" || !params.id || !Number.isInteger(params.time)) throw E.request();
      const known = await byTx(params.id);
      if (known) {
        if (known.state !== 1) throw E.state();
        if (expired(known)) return timeout(known);
        return { create_time: known.create_ms, transaction: known.id, state: known.state };
      }
      const p = await order(params);
      if (p.status === "created" && p.ext_id) throw E.state(); // another transaction already holds this order
      await payable(p);
      if (Date.now() - params.time > TIMEOUT) throw E.state();
      const t = Date.now();
      await db.run("UPDATE payments SET ext_id=?, payme_time=?, create_ms=?, state=1, updated_at=now() WHERE id=?", params.id, params.time, t, p.id);
      await hooks.extendHold(p);
      return { create_time: t, transaction: p.id, state: 1 };
    },
    async PerformTransaction(params) {
      const p = await byTx(params.id);
      if (!p) throw E.noTx();
      if (p.state === 2) return { transaction: p.id, perform_time: p.perform_ms, state: 2 };
      if (p.state !== 1) throw E.state();
      if (expired(p)) return timeout(p);
      if (!(await hooks.canPay(p))) throw E.state(); // refuse before money moves
      const t = Date.now();
      await db.run("UPDATE payments SET state=2, perform_ms=?, updated_at=now() WHERE id=?", t, p.id);
      await hooks.settle(p);
      return { transaction: p.id, perform_time: t, state: 2 };
    },
    async CancelTransaction(params) {
      const p = await byTx(params.id);
      if (!p) throw E.noTx();
      if (p.state < 0) return { transaction: p.id, cancel_time: p.cancel_ms, state: p.state };
      const t = Date.now(), reason = Number.isInteger(params.reason) ? params.reason : 10;
      if (p.state === 1) {
        await db.run("UPDATE payments SET state=-1, reason=?, cancel_ms=?, status='cancelled', updated_at=now() WHERE id=?", reason, t, p.id);
        return { transaction: p.id, cancel_time: t, state: -1 };
      }
      if (!["refund_due", "refunded"].includes(p.status) && !(await hooks.canRefund(p))) throw E.done();
      await db.run("UPDATE payments SET state=-2, reason=?, cancel_ms=?, updated_at=now() WHERE id=?", reason, t, p.id);
      await hooks.refunded(p);
      return { transaction: p.id, cancel_time: t, state: -2 };
    },
    async CheckTransaction(params) {
      const p = await byTx(params.id);
      if (!p) throw E.noTx();
      return view(p);
    },
    async GetStatement({ from, to }) {
      if (!Number.isInteger(from) || !Number.isInteger(to)) throw E.request();
      const rows = await db.all("SELECT * FROM payments WHERE provider='payme' AND ext_id IS NOT NULL AND payme_time >= ? AND payme_time <= ? ORDER BY payme_time", from, to);
      return { transactions: rows.map((p) => ({ id: p.ext_id, time: p.payme_time, amount: p.amount_uzs * 100, account: { order_id: p.id }, ...view(p) })) };
    },
  };

  /** Always answers HTTP 200 with JSON-RPC, as Payme requires. */
  return async function handle(authorization, raw, ip) {
    let rpcId = null;
    try {
      let req;
      try { req = JSON.parse(raw); } catch { req = undefined; }
      if (Number.isInteger(req?.id)) rpcId = req.id;
      const [type, b64] = String(authorization ?? "").split(" ");
      const given = type === "Basic" ? Buffer.from(b64 ?? "", "base64").toString() : "";
      if (!payme || (payme.ips && !payme.ips.includes(ip)) || !safeEqual(given, `${payme.login}:${payme.key}`)) throw E.auth();
      if (req === undefined) throw E.parse();
      if (!req || typeof req !== "object" || typeof req.method !== "string" || !req.params || typeof req.params !== "object") throw E.request();
      if (!Object.hasOwn(methods, req.method)) throw E.method(req.method);
      const result = await db.tx(() => methods[req.method](req.params));
      if (result.error) throw result.error;
      return { id: rpcId, result };
    } catch (e) {
      if (e instanceof RpcError) return { id: rpcId, error: e.body };
      console.error("[payme]", e.code ?? e.message);
      return { id: rpcId, error: E.system().body };
    }
  };
}
