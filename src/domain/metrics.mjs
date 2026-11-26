// The numbers an investor asks for, counted from the database. Test money and sample providers are left out unless asked for.
import { REGIONS } from "../lib/i18n.mjs";
import { addDays, ago, DAY, today } from "../lib/util.mjs";

const pct = (a, b) => (b > 0 ? a / b : null);

export function createMetrics({ db, config }) {
  // A booking counts as sold when a payment for it arrived and that part was not sent back.
  const SOLD = `EXISTS (SELECT 1 FROM payment_items i JOIN payments p ON p.id=i.payment_id WHERE i.booking_id=b.id AND p.paid_at IS NOT NULL AND (?::boolean OR p.provider NOT IN ('test','credit'))
    AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id=p.id AND r.booking_id=b.id))`;
  const FROM = "FROM bookings b JOIN listings l ON l.id=b.listing_id JOIN hosts h ON h.id=l.host_id";
  const REAL = "(?::boolean OR NOT h.demo)";

  return {
    async investor({ days = 90, sample = false } = {}) {
      const n = [30, 90, 365].includes(days) ? days : 90, since = ago(n * DAY), s = Boolean(sample);
      const funnel = await db.one(`SELECT
          (SELECT COALESCE(SUM(v.n),0) FROM views v JOIN listings l ON l.id=v.listing_id JOIN hosts h ON h.id=l.host_id WHERE v.day >= ? AND ${REAL}) views,
          COUNT(*) holds, COUNT(*) FILTER (WHERE ${SOLD} OR b.status IN ('declined') OR (b.status='cancelled' AND b.expires_at IS NULL)) paid,
          COUNT(*) FILTER (WHERE b.status='confirmed' AND ${SOLD}) confirmed, COUNT(*) FILTER (WHERE b.checked_in_at IS NOT NULL AND ${SOLD}) visited
        ${FROM} WHERE b.created_at >= ? AND ${REAL}`, addDays(today(), -n), s, s, s, s, since, s);
      const money = await db.one(`SELECT COUNT(*) bookings, COALESCE(SUM(b.total_uzs),0) gmv, COALESCE(SUM(b.platform_uzs),0) fees, COALESCE(SUM(b.hotel_uzs),0) hotels, COALESCE(SUM(b.host_uzs),0) hosts, COALESCE(SUM(b.guests),0) guests
        ${FROM} WHERE b.created_at >= ? AND ${REAL} AND ${SOLD}`, since, s, s);
      const plans = await db.one("SELECT COUNT(*) sold, COALESCE(SUM(i.amount_uzs),0) uzs FROM invoices i JOIN hosts h ON h.id=i.host_id JOIN payments p ON p.id=i.payment_id WHERE i.created_at >= ? AND (?::boolean OR (NOT h.demo AND p.provider <> 'test'))", since, s);
      const back = await db.one(`SELECT COUNT(DISTINCT b.id) n, COALESCE(SUM(r.amount_uzs),0) uzs FROM refunds r JOIN payments p ON p.id=r.payment_id JOIN bookings b ON b.id=r.booking_id JOIN listings l ON l.id=b.listing_id JOIN hosts h ON h.id=l.host_id
        WHERE r.created_at >= ? AND ${REAL} AND (?::boolean OR p.provider <> 'test')`, since, s, s);
      const hosts = await db.one(`WITH x AS (SELECT h.id, h.created_at, (SELECT MIN(published_at) FROM listings WHERE host_id=h.id) pub, EXISTS (SELECT 1 FROM listings WHERE host_id=h.id) draft,
          (SELECT COUNT(*) ${FROM.replace("JOIN hosts h ON h.id=l.host_id", "")} WHERE l.host_id=h.id AND ${SOLD}) sold FROM hosts h WHERE ${REAL})
        SELECT COUNT(*) registered, COUNT(*) FILTER (WHERE draft) drafted, COUNT(*) FILTER (WHERE pub IS NOT NULL) published, COUNT(*) FILTER (WHERE sold>0) selling, COUNT(*) FILTER (WHERE sold>=5) five,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM pub-created_at)) FILTER (WHERE pub >= created_at) to_publish FROM x`, s, s);
      const quality = await db.one(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM b.decided_at-b.asked_at)) FILTER (WHERE b.decided_at >= b.asked_at) reply, COUNT(*) FILTER (WHERE b.decided_at IS NOT NULL) answered, COUNT(*) FILTER (WHERE b.status='declined') declined,
          COUNT(*) FILTER (WHERE b.status='confirmed' AND b.date < ? AND b.checked_in_at IS NULL) no_show, COUNT(*) FILTER (WHERE b.status='confirmed' AND b.date < ?) past,
          (SELECT AVG(r.rating) FROM reviews r JOIN listings l ON l.id=r.listing_id JOIN hosts h ON h.id=l.host_id WHERE r.hidden_at IS NULL AND ${REAL}) rating
        ${FROM} WHERE b.created_at >= ? AND ${REAL}`, today(), today(), s, since, s);
      const repeat = await db.one(`WITH g AS (SELECT lower(b.guest_email) e, COUNT(DISTINCT b.date) n ${FROM} WHERE b.guest_email IS NOT NULL AND ${REAL} AND ${SOLD} GROUP BY 1) SELECT COUNT(*) guests, COUNT(*) FILTER (WHERE n>1) again FROM g`, s, s);
      const months = await db.all(`WITH m AS (SELECT generate_series(date_trunc('month', (now() AT TIME ZONE 'Asia/Tashkent') - interval '11 months'), date_trunc('month', now() AT TIME ZONE 'Asia/Tashkent'), interval '1 month') d),
          t AS (SELECT date_trunc('month', b.created_at AT TIME ZONE 'Asia/Tashkent') d, COUNT(*) bookings, SUM(b.total_uzs) gmv, SUM(b.platform_uzs) fees, COUNT(DISTINCT l.host_id) active ${FROM} WHERE ${REAL} AND ${SOLD} GROUP BY 1),
          k AS (SELECT date_trunc('month', h.created_at AT TIME ZONE 'Asia/Tashkent') d, COUNT(*) joined FROM hosts h WHERE ${REAL} GROUP BY 1),
          v AS (SELECT date_trunc('month', i.created_at AT TIME ZONE 'Asia/Tashkent') d, SUM(i.amount_uzs) plans FROM invoices i JOIN hosts h ON h.id=i.host_id JOIN payments p ON p.id=i.payment_id WHERE (?::boolean OR (NOT h.demo AND p.provider <> 'test')) GROUP BY 1)
        SELECT to_char(m.d,'YYYY-MM') "month", COALESCE(t.bookings,0) bookings, COALESCE(t.gmv,0) gmv, COALESCE(t.fees,0) fees, COALESCE(v.plans,0) plans, COALESCE(t.active,0) active, COALESCE(k.joined,0) joined FROM m LEFT JOIN t ON t.d=m.d LEFT JOIN k ON k.d=m.d LEFT JOIN v ON v.d=m.d ORDER BY m.d`, s, s, s, s);
      const group = (col) => db.all(`SELECT ${col} k, COUNT(*) n, SUM(b.total_uzs) gmv ${FROM} WHERE b.created_at >= ? AND ${REAL} AND ${SOLD} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`, since, s, s);
      const revenue = money.fees + plans.uzs;
      return {
        days: n, sample: s, since: since.slice(0, 10), real: !config.testPayments,
        funnel, conversion: { view_hold: pct(funnel.holds, funnel.views), hold_paid: pct(funnel.paid, funnel.holds), paid_confirmed: pct(funnel.confirmed, funnel.paid) },
        money: { ...money, plans: plans.uzs, revenue, take_rate: pct(money.fees, money.gmv), average: money.bookings ? Math.round(money.gmv / money.bookings) : 0, refunds: back.uzs, refund_rate: pct(back.n, money.bookings + back.n) },
        hosts: { ...hosts, days_to_publish: hosts.to_publish == null ? null : Math.round((hosts.to_publish / 86400) * 10) / 10 },
        quality: { reply_hours: quality.reply == null ? null : Math.round((quality.reply / 3600) * 10) / 10, decline_rate: pct(quality.declined, quality.answered), no_show: pct(quality.no_show, quality.past), rating: quality.rating == null ? null : Math.round(quality.rating * 10) / 10 },
        repeat: { guests: repeat.guests, again: repeat.again, rate: pct(repeat.again, repeat.guests) },
        months, channels: await group("b.channel"), languages: await group("b.lang"),
      };
    },

    /** Public: where the money went. Totals only: three hosts must have earned before any income is shown, so nobody's own income can be read. */
    async impact() {
      const s = config.testPayments, done = "b.status='confirmed' AND (b.checked_in_at IS NOT NULL OR b.date < ?)";
      const t = await db.one(`SELECT COUNT(*) visits, COALESCE(SUM(b.guests),0) guests, COALESCE(SUM(b.total_uzs),0) total, COALESCE(SUM(b.host_uzs),0) hosts_uzs, COUNT(DISTINCT l.host_id) hosts, COUNT(DISTINCT l.region) regions, COUNT(DISTINCT b.lang) languages,
          COALESCE(SUM(b.host_uzs) FILTER (WHERE l.region <> 'toshkent'),0) outside ${FROM} WHERE ${done} AND ${REAL} AND ${SOLD}`, today(), s, s);
      const rows = await db.all(`SELECT l.region, COUNT(*) visits, SUM(b.host_uzs) uzs, COUNT(DISTINCT l.host_id) hosts ${FROM} WHERE ${done} AND ${REAL} AND ${SOLD} GROUP BY 1`, today(), s, s);
      const supply = await db.one(`SELECT COUNT(*) listings, COUNT(DISTINCT l.host_id) hosts, COUNT(DISTINCT l.region) regions FROM listings l JOIN hosts h ON h.id=l.host_id WHERE l.status='published' AND h.suspended_at IS NULL AND ${REAL}`, s);
      const by = new Map(rows.map((r) => [r.region, r]));
      return {
        sample: s, totals: { visits: t.visits, guests: t.guests, hosts: t.hosts, regions: t.regions, languages: t.languages, host_income_uzs: t.hosts >= 3 ? t.hosts_uzs : null, host_share: pct(t.hosts_uzs, t.total), outside_capital: pct(t.outside, t.hosts_uzs), per_host_uzs: t.hosts >= 3 ? Math.round(t.hosts_uzs / t.hosts) : null }, supply,
        regions: Object.keys(REGIONS).map((k) => { const r = by.get(k); return { region: k, name: REGIONS[k], visits: r?.visits ?? 0, income_uzs: r && r.hosts >= 3 ? r.uzs : null }; }),
      };
    },
  };
}
