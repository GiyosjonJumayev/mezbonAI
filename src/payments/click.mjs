// Click SHOP API (Prepare and Complete) and refunds through its Merchant API. https://docs.click.uz/
import { createHash } from "node:crypto";
import { safeEqual } from "../lib/util.mjs";

const PAY = "https://my.click.uz/services/pay/", API = "https://api.click.uz/v2/merchant/";
const TEXT = { 0: "Success", "-1": "SIGN CHECK FAILED!", "-2": "Incorrect parameter amount", "-3": "Action not found", "-4": "Already paid", "-5": "User does not exist", "-6": "Transaction does not exist", "-7": "Failed to update user", "-8": "Error in request from click", "-9": "Transaction cancelled" };
const md5 = (s) => createHash("md5").update(s).digest("hex");

export function clickLink({ click }, p, info) {
  const q = new URLSearchParams({ service_id: click.serviceId, merchant_id: click.merchantId, merchant_user_id: click.userId, amount: p.amount_uzs.toFixed(2), transaction_param: p.id, return_url: info.returnUrl });
  return `${PAY}?${q}`;
}

/** Sends the whole payment back. Click allows this during the month of the payment. */
export function createClickApi({ click, fetchFn }) {
  return {
    async reverse(payDocId) {
      const t = Math.floor(Date.now() / 1000), digest = createHash("sha1").update(`${t}${click.secret}`).digest("hex");
      const r = await fetchFn(`${API}payment/reversal/${encodeURIComponent(click.serviceId)}/${encodeURIComponent(payDocId)}`, { method: "DELETE", headers: { Accept: "application/json", "Content-Type": "application/json", Auth: `${click.userId}:${digest}:${t}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      const v = await r.json();
      if (v?.error_code !== 0) throw Object.assign(new Error(String(v?.error_note ?? `Click ${r.status}`).slice(0, 160)), { provider: v?.error_code ?? r.status });
      return true;
    },
  };
}

/** `hooks` are the same as for Payme and run inside the open transaction. */
export function createClick({ db, config: { click }, hooks }) {
  const answer = (q, error, extra) => ({ click_trans_id: Number(q.click_trans_id) || 0, merchant_trans_id: q.merchant_trans_id ?? "", ...extra, error, error_note: TEXT[error] });
  const find = (q) => db.one("SELECT * FROM payments WHERE id=? AND provider='click' FOR UPDATE", q.merchant_trans_id ?? "");
  const sameAmount = (q, p) => /^\d+(\.\d+)?$/.test(q.amount ?? "") && Math.abs(Number(q.amount) - p.amount_uzs) < 0.01;
  const signed = (q, middle = "") => safeEqual(md5(`${q.click_trans_id}${q.service_id}${click.secret}${q.merchant_trans_id}${middle}${q.amount}${q.action}${q.sign_time}`), String(q.sign_string ?? "").toLowerCase());

  async function prepare(q) {
    const p = await find(q);
    if (!p) return answer(q, -5);
    if (!sameAmount(q, p)) return answer(q, -2);
    if (["paid", "refund_due", "refunded"].includes(p.status)) return answer(q, -4);
    if (Number(q.error) < 0 || p.status !== "created" || !(await hooks.canPay(p))) return answer(q, -9);
    await db.run("UPDATE payments SET state=1, create_ms=COALESCE(create_ms,?), updated_at=now() WHERE id=?", Date.now(), p.id);
    await hooks.extendHold(p);
    return answer(q, 0, { merchant_prepare_id: p.no });
  }
  async function complete(q) {
    const p = await find(q);
    if (!p) return answer(q, -5);
    if (p.state == null || String(p.no) !== q.merchant_prepare_id) return answer(q, -6);
    if (!sameAmount(q, p)) return answer(q, -2);
    const done = { merchant_confirm_id: p.no };
    if (["paid", "refund_due", "refunded"].includes(p.status)) return answer(q, -4, done);
    if (Number(q.error) < 0) {
      await db.run("UPDATE payments SET status='cancelled', state=-1, cancel_ms=?, updated_at=now() WHERE id=? AND status='created'", Date.now(), p.id);
      return answer(q, -9, done);
    }
    if (p.status !== "created") return answer(q, -9, done);
    // The card is already charged, so this must succeed. If the place is gone, settling sends the money back.
    await db.run("UPDATE payments SET state=2, ext_id=?, perform_ms=?, updated_at=now() WHERE id=?", String(q.click_paydoc_id), Date.now(), p.id);
    await hooks.settle(p);
    return answer(q, 0, done);
  }

  /** `raw` is a form body. Click reads the code inside the answer, not the HTTP status. */
  return async function handle(raw) {
    const q = Object.fromEntries(new URLSearchParams(raw));
    try {
      if (!click || q.service_id !== click.serviceId || !/^\d{1,20}$/.test(q.click_trans_id ?? "")) return answer(q, click ? -8 : -1);
      if (!["0", "1"].includes(q.action)) return answer(q, -3);
      if (!signed(q, q.action === "1" ? q.merchant_prepare_id ?? "" : "")) return answer(q, -1);
      if (q.action === "1" && !/^\d{1,20}$/.test(q.click_paydoc_id ?? "")) return answer(q, -8);
      return await db.tx(() => (q.action === "0" ? prepare(q) : complete(q)));
    } catch (e) {
      console.error("[click]", e.code ?? e.message);
      return answer(q, -7);
    }
  };
}
