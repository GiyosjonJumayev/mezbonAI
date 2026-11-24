// Provider business tools: subscription plans, QR tickets, slot control, revenue analytics, market intelligence.
import { randomBytes } from "node:crypto";
import { CATEGORIES, LANGS, REGIONS } from "./i18n.mjs";

/** Prices are placeholders to be tested with real providers. `listings: null` means no limit. */
export const PLANS = {
  free: { price: 0, commission: 12, listings: 3, days: [30], detail: false, intelligence: false },
  pro: { price: 149_000, commission: 8, listings: null, days: [30, 90, 365], detail: true, intelligence: false },
  business: { price: 490_000, commission: 6, listings: null, days: [30, 90, 365], detail: true, intelligence: true },
};
export const PERIOD_DAYS = 30;
const RANK = Object.keys(PLANS);
const DAY = 864e5;
/** Fewer prices than this would let one provider read a competitor's price. */
export const MIN_SAMPLE = 3;

export const effectivePlan = (h, at = new Date()) => (h.plan !== "free" && h.plan_until && new Date(h.plan_until) > at && Object.hasOwn(PLANS, h.plan) ? h.plan : "free");
export const newTicketCode = () => randomBytes(6).toString("hex").toUpperCase();
export const cleanTicketCode = (s) => String(s ?? "").toUpperCase().replace(/[^0-9A-F]/g, "").slice(0, 12);

const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const tashkentDate = (iso) => new Date(+new Date(iso) + 5 * 3600e3).toISOString().slice(0, 10);

export function createBusiness({ db, one, all, run, now, fail, authHost, ownListing, booking, openOn, isDate, addDays, today, id }) {
  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const v = fn(); db.exec("COMMIT"); return v; } catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  const planOf = (h) => {
    const plan = effectivePlan(h);
    return { plan, until: plan === "free" ? null : h.plan_until, ...PLANS[plan], used: one("SELECT COUNT(*) n FROM listings WHERE host_id=? AND status='published'", h.id).n };
  };

  // ---- subscriptions ---------------------------------------------------------------------------
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

  const api = {
    planOf,
    plans(key) {
      const h = authHost(key), cur = planOf(h);
      return {
        current: cur,
        options: RANK.map((p) => {
          let offer = null;
          try { offer = p === "free" ? null : quote(h, p); } catch {}
          return { id: p, ...PLANS[p], offer };
        }),
        invoices: all("SELECT id, plan, kind, credit_uzs, amount_uzs, until, created_at FROM invoices WHERE host_id=? ORDER BY created_at DESC LIMIT 24", h.id),
      };
    },
    /** Sandbox only: a licensed payment partner's callback replaces this. Plans never renew by themselves. */
    subscribeTest(key, plan) {
      tx(() => {
        const h = authHost(key), q = quote(h, plan);
        run("INSERT INTO invoices (id,host_id,plan,kind,credit_uzs,amount_uzs,until,created_at) VALUES (?,?,?,?,?,?,?,?)", id("i_"), h.id, plan, q.kind, q.credit, q.amount, q.until, now());
        run("UPDATE hosts SET plan=?, plan_until=? WHERE id=?", plan, q.until, h.id);
      });
      return api.plans(key);
    },

    // ---- QR tickets ------------------------------------------------------------------------------
    /** Looks a ticket up for its own provider. Other providers get the same answer as for a made-up code. */
    ticket(key, raw) {
      const h = authHost(key), code = cleanTicketCode(raw);
      const b = code.length === 12 ? booking("ticket_code", code) : null;
      if (!b || b.host_id !== h.id) throw fail(404, "Chipta topilmadi. Kodni tekshiring", "ticket");
      const d = today();
      const state = b.status !== "confirmed" ? "void" : b.checked_in_at ? "used" : b.date > d ? "early" : b.date < d ? "late" : "valid";
      return { code, state, title: b.i18n.uz.title, guest_name: b.guest_name, guests: b.guests, date: b.date, time: b.time, lang: b.lang, checked_in_at: b.checked_in_at };
    },
    checkIn(key, raw) {
      const t = api.ticket(key, raw);
      const why = { used: "Bu chipta allaqachon ishlatilgan", early: `Bu chipta ${t.date} kuni uchun`, late: `Bu chipta muddati o‘tgan: ${t.date}`, void: "Bron bekor qilingan, chipta yaroqsiz" };
      if (t.state !== "valid") throw fail(409, why[t.state], "ticket");
      const r = run("UPDATE bookings SET checked_in_at=? WHERE ticket_code=? AND status='confirmed' AND checked_in_at IS NULL", now(), t.code);
      if (!r.changes) throw fail(409, why.used, "ticket"); // another phone scanned it a moment earlier
      return api.ticket(key, raw);
    },

    // ---- slot control ----------------------------------------------------------------------------
    slotCalendar(key, lid, from, days = 14) {
      const l = ownListing(key, lid), start = isDate(from) && from > today() ? from : today();
      const n = Math.min(31, Math.max(1, days | 0)), to = addDays(start, n);
      const index = (rows, v) => new Map(rows.map((r) => [`${r.date}T${r.time}`, r[v]]));
      const booked = index(all("SELECT date, time, SUM(guests) n FROM bookings WHERE listing_id=? AND date>=? AND date<? AND (status IN ('paid','confirmed') OR (status='pending' AND expires_at > ?)) GROUP BY date, time", l.id, start, to, now()), "n");
      const rules = index(all("SELECT date, time, capacity FROM slot_rules WHERE listing_id=? AND date>=? AND date<?", l.id, start, to), "capacity");
      return {
        id: l.id, title: l.i18n.uz.title, base: l.capacity, status: l.status,
        days: Array.from({ length: n }, (_, i) => {
          const date = addDays(start, i);
          return { date, open: openOn(l, date), closed: l.closed.includes(date), slots: l.times.map((time) => {
            const k = `${date}T${time}`, rule = rules.get(k);
            return { time, booked: booked.get(k) ?? 0, capacity: rule ?? l.capacity, changed: rule != null };
          }) };
        }),
      };
    },
    /** capacity null returns the slot to the listing's normal size; 0 stops new bookings. Existing bookings are never touched. */
    setSlot(key, lid, { date, time, capacity }) {
      const l = ownListing(key, lid);
      if (!isDate(date) || date < today()) throw fail(400, "Sana noto‘g‘ri");
      if (!l.times.includes(time)) throw fail(400, "Bu vaqt jadvalda yo‘q");
      if (capacity === null || capacity === l.capacity) run("DELETE FROM slot_rules WHERE listing_id=? AND date=? AND time=?", l.id, date, time);
      else {
        if (!Number.isInteger(capacity) || capacity < 0 || capacity > 100) throw fail(400, "Joylar soni 0–100 oralig‘ida bo‘lsin");
        run("INSERT INTO slot_rules (listing_id,date,time,capacity) VALUES (?,?,?,?) ON CONFLICT(listing_id,date,time) DO UPDATE SET capacity=excluded.capacity", l.id, date, time, capacity);
      }
      return api.slotCalendar(key, lid, date, 1).days[0];
    },

    // ---- revenue analytics -------------------------------------------------------------------------
    view(lid, lang) {
      run("INSERT INTO views (listing_id,day,lang,n) VALUES (?,?,?,1) ON CONFLICT(listing_id,day,lang) DO UPDATE SET n=n+1", lid, today(), LANGS.includes(lang) ? lang : "en");
    },
    analytics(key, wanted = 30) {
      const h = authHost(key), p = planOf(h);
      const days = p.days.includes(wanted) ? wanted : 30;
      // Whole Tashkent days, in blocks that end today: single days, weeks, or 30-day blocks.
      const size = days <= 30 ? 1 : days <= 90 ? 7 : 30, blocks = Math.ceil(days / size), span = blocks * size;
      const first = addDays(today(), -(span - 1)), start = +new Date(`${first}T00:00:00+05:00`), iso = (ms) => new Date(ms).toISOString();
      const load = (from, to) => all(`SELECT b.*, l.i18n, l.id lid FROM bookings b JOIN listings l ON l.id=b.listing_id
        WHERE l.host_id=? AND b.created_at >= ? AND b.created_at < ? AND b.status!='pending' AND NOT (b.status='cancelled' AND b.expires_at IS NOT NULL) ORDER BY b.created_at`, h.id, from, to);
      const rows = load(iso(start), iso(Date.now() + 1)), before = load(iso(start - span * DAY), iso(start));
      const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
      const done = rows.filter((b) => b.status === "confirmed"), expected = rows.filter((b) => b.status === "paid");
      const live = [...done, ...expected];
      const views = new Map(all("SELECT v.listing_id id, SUM(v.n) n FROM views v JOIN listings l ON l.id=v.listing_id WHERE l.host_id=? AND v.day >= ? GROUP BY v.listing_id", h.id, first).map((r) => [r.id, r.n]));
      const totalViews = sum([...views.values()], (x) => x);
      const was = before.filter((b) => b.status === "confirmed");

      const series = Array.from({ length: blocks }, (_, i) => ({ from: addDays(first, i * size), to: addDays(first, i * size + size - 1), earned: 0, bookings: 0 }));
      for (const b of done) {
        const s = series[Math.floor((+new Date(tashkentDate(b.created_at)) - +new Date(first)) / DAY / size)];
        if (s) { s.earned += b.host_uzs; s.bookings++; }
      }
      const group = (key_) => {
        const m = new Map();
        for (const b of done) { const k = key_(b), g = m.get(k) ?? { key: k, bookings: 0, guests: 0, earned: 0 }; g.bookings++; g.guests += b.guests; g.earned += b.host_uzs; m.set(k, g); }
        return [...m.values()].sort((a, b) => b.earned - a.earned);
      };
      const listings = all("SELECT l.id, l.i18n, l.status, (SELECT AVG(rating) FROM reviews WHERE listing_id=l.id) rating FROM listings l WHERE l.host_id=? AND l.status!='draft'", h.id).map((l) => {
        const g = group((b) => b.lid).find((x) => x.key === l.id), v = views.get(l.id) ?? 0, sold = live.filter((b) => b.lid === l.id).length;
        let cap = 0, taken = 0;
        for (const d of api.slotCalendar(key, l.id, today(), 14).days) if (d.open) for (const s of d.slots) { cap += s.capacity; taken += Math.min(s.booked, s.capacity); }
        return { id: l.id, title: JSON.parse(l.i18n).uz.title, status: l.status, bookings: g?.bookings ?? 0, guests: g?.guests ?? 0, earned: g?.earned ?? 0, views: v, conversion: v >= sold && v > 0 ? sold / v : null, rating: l.rating == null ? null : Math.round(l.rating * 10) / 10, fill: cap ? taken / cap : null };
      }).sort((a, b) => b.earned - a.earned);
      return {
        plan: p.plan, days, available: PLANS.business.days, unlocked: p.days, detail: p.detail, bucket: size,
        totals: {
          gross: sum(done, (b) => b.total_uzs), earned: sum(done, (b) => b.host_uzs), fees: sum(done, (b) => b.platform_uzs + b.hotel_uzs), expected: sum(expected, (b) => b.host_uzs),
          bookings: done.length, guests: sum(done, (b) => b.guests), average: done.length ? Math.round(sum(done, (b) => b.total_uzs) / done.length) : 0,
          cancelled: rows.filter((b) => b.status === "cancelled").length, declined: rows.filter((b) => b.status === "declined").length, checkedIn: done.filter((b) => b.checked_in_at).length,
          views: totalViews, conversion: totalViews >= live.length && totalViews > 0 ? live.length / totalViews : null,
        },
        previous: { earned: sum(was, (b) => b.host_uzs), bookings: was.length },
        series,
        listings: p.detail ? listings : null,
        channels: p.detail ? group((b) => b.channel) : null,
        languages: p.detail ? group((b) => b.lang) : null,
        // No guest names: the export is for accounting, not for contact lists.
        rows: p.detail ? rows.map((b) => ({ created: tashkentDate(b.created_at), date: b.date, time: b.time, title: JSON.parse(b.i18n).uz.title, guests: b.guests, channel: b.channel, status: b.status, total: b.total_uzs, platform: b.platform_uzs, hotel: b.hotel_uzs, host: b.host_uzs })) : null,
      };
    },

    // ---- market intelligence (Business plan) -------------------------------------------------------
    intelligence(key) {
      const h = authHost(key);
      if (!planOf(h).intelligence) throw fail(403, "Bozor tahlili Business tarifida ochiladi", "plan");
      const mine = all("SELECT id, region, category, price_uzs, i18n FROM listings WHERE host_id=? AND status='published'", h.id);
      const since = (n) => new Date(Date.now() - n * DAY).toISOString();
      const top = (col, names) => all(`SELECT ${col} k, COUNT(*) searches, SUM(results=0) unmet, SUM(demo) sample FROM searches WHERE ${col} IS NOT NULL AND created_at >= ? GROUP BY ${col} ORDER BY unmet DESC, searches DESC LIMIT 6`, since(90)).map((r) => ({ ...r, name: names(r.k) }));
      const prices = mine.map((l) => {
        const others = all("SELECT l.price_uzs p, h.demo FROM listings l JOIN hosts h ON h.id=l.host_id WHERE l.status='published' AND l.category=? AND l.host_id!=?", l.category, h.id);
        const ok = others.length >= MIN_SAMPLE, v = others.map((o) => o.p);
        return { id: l.id, title: JSON.parse(l.i18n).uz.title, category: CATEGORIES[l.category].uz, price: l.price_uzs, sample: others.length, demo: others.some((o) => o.demo),
          low: ok ? Math.min(...v) : null, median: ok ? median(v) : null, high: ok ? Math.max(...v) : null };
      });
      const regions = [...new Set(mine.map((l) => l.region))];
      const count = (r, from, to) => one("SELECT COUNT(*) n FROM searches WHERE demo=0 AND region=? AND created_at >= ? AND created_at < ?", r, from, to).n;
      const trend = regions.map((r) => ({ region: r, name: REGIONS[r], last: count(r, since(30), new Date(Date.now() + 1).toISOString()), before: count(r, since(60), since(30)) }));
      const unmet = { regions: top("region", (k) => REGIONS[k]), categories: top("category", (k) => CATEGORIES[k].uz) };
      const languages = all("SELECT lang, COUNT(*) n FROM searches WHERE demo=0 AND created_at >= ? GROUP BY lang ORDER BY n DESC LIMIT 6", since(90));

      const tips = [];
      for (const p of prices) {
        if (p.median && p.price < p.median * 0.8) tips.push(`“${p.title}”: narxingiz bozor medianasidan ${Math.round((1 - p.price / p.median) * 100)}% past. Oshirib ko‘rish mumkin.`);
        if (p.median && p.price > p.median * 1.4) tips.push(`“${p.title}”: narxingiz medianadan ${Math.round((p.price / p.median - 1) * 100)}% yuqori. Farqini tavsifda tushuntiring.`);
      }
      const gap = unmet.categories.find((c) => c.unmet > 0 && !mine.some((l) => l.category === c.k));
      if (gap) tips.push(`“${gap.name}” bo‘yicha ${gap.unmet} ta qidiruv javobsiz qolgan. Shunday taklif qo‘sha olasizmi?`);
      const near = unmet.regions.find((r) => r.unmet > 0 && !regions.includes(r.k));
      if (near) tips.push(`${near.name} viloyatida ${near.unmet} ta qidiruv javobsiz. U yerdagi hamkor bilan qo‘shma taklif o‘ylab ko‘ring.`);
      return { prices, minSample: MIN_SAMPLE, unmet, trend, languages, tips, sampleSearches: one("SELECT COUNT(*) n FROM searches WHERE demo=1 AND created_at >= ?", since(90)).n };
    },

    /** Platform income for the demo panel. */
    platform() {
      const active = all("SELECT plan, plan_until FROM hosts").map((h) => effectivePlan(h)).filter((p) => p !== "free");
      return { subscribers: active.length, mrr: active.reduce((s, p) => s + PLANS[p].price, 0), subscriptions: one("SELECT COALESCE(SUM(amount_uzs),0) n FROM invoices").n };
    },
  };
  return api;
}
