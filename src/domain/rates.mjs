// Daily exchange rates of the Central Bank of Uzbekistan, only to show approximate prices. Payments are always in so'm.
const URL_ = "https://cbu.uz/uz/arkhiv-kursov-valyut/json/";
export const CURRENCIES = ["USD", "EUR", "GBP", "RUB", "CNY", "KRW", "JPY", "TRY", "KZT", "AED", "SAR"];

/** So'm for one unit of each currency; null when the answer cannot be trusted. */
export function parseRates(list) {
  if (!Array.isArray(list)) return null;
  const out = {};
  for (const r of list) {
    const v = Number(r?.Rate) / Number(r?.Nominal);
    if (CURRENCIES.includes(r?.Ccy) && Number.isFinite(v) && v > 0.1 && v < 100_000) out[r.Ccy] = v;
  }
  const date = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(list[0]?.Date ?? "");
  return out.USD && date ? { date: `${date[3]}-${date[2]}-${date[1]}`, rates: out } : null;
}

export async function createRates({ db, config, fetchFn }) {
  let now = null;
  const row = await db.one("SELECT v FROM settings WHERE k='rates'");
  if (row) try { now = JSON.parse(row.v); } catch {}
  return {
    get: () => (config.usdRate ? { date: null, rates: { USD: config.usdRate } } : now),
    async work() {
      if (config.usdRate) return;
      const r = await fetchFn(URL_, { redirect: "error", signal: AbortSignal.timeout(15_000) }), next = parseRates(await r.json());
      if (!next) throw new Error("kurs javobi noto‘g‘ri");
      now = next;
      await db.run("INSERT INTO settings (k,v) VALUES ('rates',?) ON CONFLICT (k) DO UPDATE SET v=excluded.v", JSON.stringify(now));
    },
  };
}
