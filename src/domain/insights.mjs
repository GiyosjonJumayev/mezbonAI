// Analytics for providers, market intelligence, and the public demand panel.
import { CATEGORIES, LANGS, REGIONS } from "../lib/i18n.mjs";
import { addDays, ago, DAY, fail, tashkentDate, today } from "../lib/util.mjs";
import { ON_SALE } from "./catalog.mjs";
import { PLANS } from "./plans.mjs";

/** Fewer prices than this would let one provider read a competitor's price. */
export const MIN_SAMPLE = 3;
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const EPOCH = new Date(0).toISOString();

export function createInsights({ db, accounts, availability, plans }) {
  const { one, all, run } = db;
  const on = `EXISTS (SELECT 1 FROM hosts h WHERE h.id=l.host_id AND ${ON_SALE})`;
  return {
    async view(lid, lang) {
      await run("INSERT INTO views (listing_id,day,lang,n) VALUES (?,?,?,1) ON CONFLICT (listing_id,day,lang) DO UPDATE SET n=views.n+1", lid, today(), LANGS.includes(lang) ? lang : "en");
    },
    async analytics(key, wanted = 30) {
      const h = await accounts.authHost(key), p = await plans.planOf(h);
      const days = p.days.includes(wanted) ? wanted : 30;
      // Whole Tashkent days, in blocks that end today: single days, weeks, or 30-day blocks.
      const size = days <= 30 ? 1 : days <= 90 ? 7 : 30, blocks = Math.ceil(days / size), span = blocks * size;
      const first = addDays(today(), -(span - 1)), start = +new Date(`${first}T00:00:00+05:00`), iso = (ms) => new Date(ms).toISOString();
      const load = (from, to) => all(`SELECT b.*, l.i18n->'uz'->>'title' title, l.id lid FROM bookings b JOIN listings l ON l.id=b.listing_id
        WHERE l.host_id=? AND b.created_at >= ? AND b.created_at < ? AND b.status<>'pending' AND NOT (b.status='cancelled' AND b.expires_at IS NOT NULL) ORDER BY b.created_at`, h.id, from, to);
      const [rows, before] = await Promise.all([load(iso(start), iso(Date.now() + 1000)), load(iso(start - span * DAY), iso(start))]);
      const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
      const done = rows.filter((b) => b.status === "confirmed"), expected = rows.filter((b) => b.status === "paid");
      const live = [...done, ...expected];
      const views = new Map((await all("SELECT v.listing_id id, SUM(v.n) n FROM views v JOIN listings l ON l.id=v.listing_id WHERE l.host_id=? AND v.day >= ? GROUP BY v.listing_id", h.id, first)).map((r) => [r.id, r.n]));
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
      const own = p.detail ? await all("SELECT l.id, l.i18n->'uz'->>'title' title, l.status, (SELECT AVG(rating) FROM reviews WHERE listing_id=l.id AND hidden_at IS NULL) rating FROM listings l WHERE l.host_id=? AND l.status<>'draft'", h.id) : [];
      const listings = (await Promise.all(own.map(async (l) => {
        const g = group((b) => b.lid).find((x) => x.key === l.id), v = views.get(l.id) ?? 0, sold = live.filter((b) => b.lid === l.id).length;
        let cap = 0, taken = 0;
        for (const d of (await availability.slotCalendar(key, l.id, today(), 14)).days) if (d.open) for (const s of d.slots) { cap += s.capacity; taken += Math.min(s.booked, s.capacity); }
        return { id: l.id, title: l.title, status: l.status, bookings: g?.bookings ?? 0, guests: g?.guests ?? 0, earned: g?.earned ?? 0, views: v, conversion: v >= sold && v > 0 ? sold / v : null, rating: l.rating == null ? null : Math.round(l.rating * 10) / 10, fill: cap ? taken / cap : null };
      }))).sort((a, b) => b.earned - a.earned);
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
        // Which weekday and hour guests choose, by visit time.
        busy: p.detail ? [...done.reduce((m, b) => { const k = `${new Date(`${b.date}T00:00:00Z`).getUTCDay() || 7}|${b.time}`; return m.set(k, (m.get(k) ?? 0) + b.guests); }, new Map())].map(([k, guests]) => ({ weekday: +k.split("|")[0], time: k.split("|")[1], guests })) : null,
        // Confirmed visits whose day has passed without a ticket check-in.
        noShow: done.filter((b) => !b.checked_in_at && b.date < today()).length,
        // No guest names: the export is for accounting, not for contact lists.
        rows: p.detail ? rows.map((b) => ({ created: tashkentDate(b.created_at), date: b.date, time: b.time, title: b.title, guests: b.guests, channel: b.channel, status: b.status, total: b.total_uzs, platform: b.platform_uzs, hotel: b.hotel_uzs, host: b.host_uzs })) : null,
      };
    },

    // ---- market intelligence (Business plan) -------------------------------------------------------
    async intelligence(key) {
      const h = await accounts.authHost(key);
      if (!(await plans.planOf(h)).intelligence) throw fail(403, "Bozor tahlili Business tarifida ochiladi", "plan");
      const mine = await all("SELECT id, region, category, price_uzs, i18n->'uz'->>'title' title FROM listings WHERE host_id=? AND status='published'", h.id);
      const since = (n) => ago(n * DAY);
      const top = async (col, names) => (await all(`SELECT ${col} k, COUNT(*) searches, COUNT(*) FILTER (WHERE results=0) unmet, COUNT(*) FILTER (WHERE demo) sample FROM searches WHERE ${col} IS NOT NULL AND created_at >= ? GROUP BY ${col} ORDER BY unmet DESC, searches DESC LIMIT 6`, since(90))).map((r) => ({ ...r, name: names(r.k) }));
      const prices = await Promise.all(mine.map(async (l) => {
        const others = await all(`SELECT l.price_uzs p, h.demo FROM listings l JOIN hosts h ON h.id=l.host_id WHERE ${ON_SALE} AND l.category=? AND l.host_id<>?`, l.category, h.id);
        const ok = others.length >= MIN_SAMPLE, v = others.map((o) => o.p);
        return { id: l.id, title: l.title, category: CATEGORIES[l.category].uz, price: l.price_uzs, sample: others.length, demo: others.some((o) => o.demo),
          low: ok ? Math.min(...v) : null, median: ok ? median(v) : null, high: ok ? Math.max(...v) : null };
      }));
      const regions = [...new Set(mine.map((l) => l.region))];
      const count = async (r, from, to) => (await one("SELECT COUNT(*) n FROM searches WHERE NOT demo AND region=? AND created_at >= ? AND created_at < ?", r, from, to)).n;
      const trend = await Promise.all(regions.map(async (r) => ({ region: r, name: REGIONS[r], last: await count(r, since(30), ago(-1000)), before: await count(r, since(60), since(30)) })));
      const unmet = { regions: await top("region", (k) => REGIONS[k]), categories: await top("category", (k) => CATEGORIES[k].uz) };
      const dates = await all("SELECT for_date date, COUNT(*) n, COUNT(*) FILTER (WHERE results=0) unmet FROM searches WHERE NOT demo AND for_date >= ? GROUP BY for_date ORDER BY n DESC, for_date LIMIT 10", today());
      const languages = await all("SELECT lang, COUNT(*) n FROM searches WHERE NOT demo AND created_at >= ? GROUP BY lang ORDER BY n DESC LIMIT 6", since(90));

      const tips = [];
      for (const p of prices) {
        if (p.median && p.price < p.median * 0.8) tips.push(`“${p.title}”: narxingiz bozor medianasidan ${Math.round((1 - p.price / p.median) * 100)}% past. Oshirib ko‘rish mumkin.`);
        if (p.median && p.price > p.median * 1.4) tips.push(`“${p.title}”: narxingiz medianadan ${Math.round((p.price / p.median - 1) * 100)}% yuqori. Farqini tavsifda tushuntiring.`);
      }
      const gap = unmet.categories.find((c) => c.unmet > 0 && !mine.some((l) => l.category === c.k));
      if (gap) tips.push(`“${gap.name}” bo‘yicha ${gap.unmet} ta qidiruv javobsiz qolgan. Shunday taklif qo‘sha olasizmi?`);
      const near = unmet.regions.find((r) => r.unmet > 0 && !regions.includes(r.k));
      if (near) tips.push(`${near.name} viloyatida ${near.unmet} ta qidiruv javobsiz. U yerdagi hamkor bilan qo‘shma taklif o‘ylab ko‘ring.`);
      return { prices, minSample: MIN_SAMPLE, unmet, trend, languages, dates, tips, sampleSearches: (await one("SELECT COUNT(*) n FROM searches WHERE demo AND created_at >= ?", since(90))).n };
    },

    // ---- public demand panel -----------------------------------------------------------------------
    async panel({ days = 0, demo = true } = {}) {
      const since = days > 0 ? ago(Math.min(days, 3650) * DAY) : EPOCH, noDemo = demo ? "" : "AND NOT demo", PAID = "status IN ('paid','confirmed')";
      const supply = Object.fromEntries((await all(`SELECT region, COUNT(*) n FROM listings l WHERE ${on} GROUP BY region`)).map((r) => [r.region, r.n]));
      const group = async (col) => Object.fromEntries((await all(`SELECT ${col} k, COUNT(*) n, COUNT(*) FILTER (WHERE results=0) unmet FROM searches WHERE ${col} IS NOT NULL AND created_at >= ? ${noDemo} GROUP BY ${col}`, since)).map((r) => [r.k, r]));
      const byRegion = await group("region"), byCategory = await group("category");
      const rank = (a, b) => b.unmet - a.unmet || b.searches - a.searches;
      return {
        totals: await one(`SELECT COUNT(*) bookings, COALESCE(SUM(guests),0) guests, COALESCE(SUM(total_uzs),0) gmv,
          COALESCE(SUM(host_uzs),0) host, COALESCE(SUM(hotel_uzs),0) hotel, COALESCE(SUM(platform_uzs),0) platform FROM bookings WHERE ${PAID} AND created_at >= ?`, since),
        hosts: (await one(`SELECT COUNT(DISTINCT host_id) n FROM listings l WHERE ${on}`)).n,
        listings: (await one(`SELECT COUNT(*) n FROM listings l WHERE ${on}`)).n,
        channels: await all(`SELECT channel, COUNT(*) n, SUM(total_uzs) gmv FROM bookings WHERE ${PAID} AND created_at >= ? GROUP BY channel ORDER BY n DESC`, since),
        regions: Object.keys(REGIONS).map((k) => ({ region: k, name: REGIONS[k], listings: supply[k] ?? 0, searches: byRegion[k]?.n ?? 0, unmet: byRegion[k]?.unmet ?? 0 })).sort(rank),
        categories: Object.keys(CATEGORIES).map((k) => ({ category: k, name: CATEGORIES[k].uz, searches: byCategory[k]?.n ?? 0, unmet: byCategory[k]?.unmet ?? 0 })).filter((x) => x.searches).sort(rank),
        platform: await plans.platform(),
        dates: await all(`SELECT for_date date, COUNT(*) n, COUNT(*) FILTER (WHERE results=0) unmet FROM searches WHERE for_date >= ? AND created_at >= ? ${noDemo} GROUP BY for_date ORDER BY n DESC, for_date LIMIT 10`, today(), since),
        languages: await all("SELECT lang, COUNT(*) n, COUNT(*) FILTER (WHERE results=0) unmet FROM searches WHERE NOT demo AND created_at >= ? GROUP BY lang ORDER BY n DESC LIMIT 10", since),
        demoSearches: demo ? (await one("SELECT COUNT(*) n FROM searches WHERE demo AND created_at >= ?", since)).n : 0,
      };
    },
  };
}
