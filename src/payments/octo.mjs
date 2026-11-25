// Octo client: Visa, Mastercard, Uzcard and Humo on Octo's own page. https://help.octo.uz/en/
const API = "https://secure.octo.uz/";

export function createOcto({ octo, fiscal, publicUrl, fetchFn = fetch }) {
  async function call(path, body) {
    const r = await fetchFn(API + path, {
      method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ octo_shop_id: octo.shopId, octo_secret: octo.secret, ...body }),
    });
    const v = await r.json();
    if (v?.error !== 0) throw Object.assign(new Error(String(v?.errMessage ?? v?.errorMessage ?? `Octo ${v?.error}`).slice(0, 200)), { octo: v?.error ?? r.status });
    return v.data ?? v;
  }
  const stamp = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 19).replace("T", " ");
  return {
    /** One-stage payment: the card is charged when the guest pays, and refunded if the provider declines. */
    async prepare(p, info) {
      const d = await call("prepare_payment", {
        shop_transaction_id: p.id, auto_capture: true, test: octo.test, init_time: stamp(), total_sum: p.amount_uzs, currency: "UZS", description: info.title.slice(0, 120),
        return_url: info.returnUrl, notify_url: `${publicUrl}/pay/octo`, language: { uz: "uz", ru: "ru" }[info.lang] ?? "en", ttl: 25,
        payment_methods: ["bank_card", "uzcard", "humo"].map((method) => ({ method })),
        ...(fiscal && { basket: [{ position_desc: `Experience ${p.id}`, count: 1, price: p.amount_uzs, spic: fiscal.spic, inn: fiscal.inn, package_code: fiscal.pack, nds: fiscal.vat ? 1 : 0 }] }),
      });
      const u = new URL(d.octo_pay_url); // only ever send a guest to Octo itself
      if (u.protocol !== "https:" || !/(^|\.)octo\.uz$/.test(u.hostname)) throw new Error("Octo javobi noto‘g‘ri");
      return { uuid: String(d.octo_payment_UUID), url: u.href };
    },
    /** The state of a payment according to Octo. Anything that does not match our own record is an error. */
    async status(p) {
      const d = await call("prepare_payment", { shop_transaction_id: p.id });
      if (d.shop_transaction_id !== p.id || (p.ext_id && d.octo_payment_UUID && d.octo_payment_UUID !== p.ext_id)) throw new Error("Octo boshqa to‘lovni qaytardi");
      if (d.total_sum != null && Math.abs(Number(d.total_sum) - p.amount_uzs) > 0.5) throw new Error("Octo summasi mos emas");
      if (p.amount_uzs > 0 && Number(d.refunded_sum) >= p.amount_uzs) return "refunded";
      if (d.status === "succeeded") return "paid";
      return /^cancel+ed$/.test(d.status) ? "cancelled" : "open";
    },
    async refund(p) {
      const d = await call("refund", { shop_refund_id: `${p.id}-r`, octo_payment_UUID: p.ext_id, amount: p.amount_uzs });
      return d.status === "succeeded";
    },
  };
}
