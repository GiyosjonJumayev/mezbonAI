// When places are free. Everything that sells or moves a place asks here, inside the same transaction.
import { addDays, bad, fail, int, isDate, isoWeekday, tashkentNow, today } from "../lib/util.mjs";

/** A booking holds its place while it is paid, confirmed, or still within its payment time. */
export const LIVE = "(status IN ('paid','confirmed') OR (status='pending' AND expires_at > now()))";
export const openOn = (l, date) => l.weekdays.includes(isoWeekday(date)) && !l.closed.includes(date);

function build(l, from, days, clock, room) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    if (!openOn(l, date)) continue;
    const times = l.times.filter((t) => `${date}T${t}` > clock).map((time) => ({ time, free: Math.max(0, room(`${date}T${time}`)) }));
    if (times.length) out.push({ date, times });
  }
  return out;
}

export function createAvailability({ db, catalog, events }) {
  const index = (rows, v) => new Map(rows.map((r) => [`${r.date}T${r.time}`, r[v]]));
  const load = async (lid, from, to, except = null) => {
    const used = index(await db.all(`SELECT date, time, SUM(guests) n FROM bookings WHERE listing_id=? AND date>=? AND date<? AND ${LIVE} AND (?::text IS NULL OR id<>?) GROUP BY date, time`, lid, from, to, except, except), "n");
    const rules = index(await db.all("SELECT date, time, capacity FROM slot_rules WHERE listing_id=? AND date>=? AND date<?", lid, from, to), "capacity");
    return { used, rules };
  };
  /** The same for many listings at once, in two queries instead of two per listing. */
  async function slotsMany(list, from, days) {
    const ids = list.map((l) => l.id), to = addDays(from, days), key = (r) => `${r.listing_id}|${r.date}T${r.time}`, clock = tashkentNow().slice(0, 16);
    const used = new Map((await db.all(`SELECT listing_id, date, time, SUM(guests) n FROM bookings WHERE listing_id = ANY(?::text[]) AND date>=? AND date<? AND ${LIVE} GROUP BY listing_id, date, time`, ids, from, to)).map((r) => [key(r), r.n]));
    const rules = new Map((await db.all("SELECT listing_id, date, time, capacity FROM slot_rules WHERE listing_id = ANY(?::text[]) AND date>=? AND date<?", ids, from, to)).map((r) => [key(r), r.capacity]));
    return new Map(list.map((l) => [l.id, build(l, from, days, clock, (k) => (rules.get(`${l.id}|${k}`) ?? l.capacity) - (used.get(`${l.id}|${k}`) ?? 0))]));
  }
  /** Free places per open slot for `days` calendar days from `from`. Past slots are left out. */
  async function slots(l, from, days, except = null) {
    const { used, rules } = await load(l.id, from, addDays(from, days), except);
    return build(l, from, days, tashkentNow().slice(0, 16), (k) => (rules.get(k) ?? l.capacity) - (used.get(k) ?? 0));
  }
  return {
    slots, slotsMany,
    /** Queues everyone who wants a place at this listing, so two guests can never buy the last one. Call inside a transaction. */
    lock: (lid) => db.one("SELECT id FROM listings WHERE id=? FOR UPDATE", lid),
    async free(l, date, time, except) { return (await slots(l, date, 1, except))[0]?.times.find((t) => t.time === time)?.free ?? 0; },
    /** Checks that a date and time can be chosen at all. */
    check(l, date, time) {
      if (!isDate(date)) throw bad("Sana noto‘g‘ri");
      const clock = tashkentNow();
      if (`${date}T${time}` <= clock.slice(0, 16)) throw fail(400, "Bu vaqt o‘tib ketgan", "past");
      if (date > addDays(clock.slice(0, 10), 365)) throw bad("Sana bir yildan uzoq");
      if (!openOn(l, date) || !l.times.includes(time)) throw fail(409, "Mezbon bu vaqtda ishlamaydi", "closed");
    },
    async availability(lid, from, days = 21) {
      const d = today();
      return slots(await catalog.published(lid), isDate(from) && from > d && from <= addDays(d, 366) ? from : d, Math.min(60, Math.max(1, days | 0)));
    },
    async slotCalendar(credential, lid, from, days = 14) {
      const l = await catalog.ownListing(credential, lid), start = isDate(from) && from > today() && from <= addDays(today(), 366) ? from : today();
      const n = Math.min(31, Math.max(1, days | 0)), { used, rules } = await load(l.id, start, addDays(start, n));
      return {
        id: l.id, title: l.i18n.uz.title, base: l.capacity, status: l.status,
        days: Array.from({ length: n }, (_, i) => {
          const date = addDays(start, i);
          return { date, open: openOn(l, date), closed: l.closed.includes(date), slots: l.times.map((time) => {
            const k = `${date}T${time}`, rule = rules.get(k);
            return { time, booked: used.get(k) ?? 0, capacity: rule ?? l.capacity, changed: rule != null };
          }) };
        }),
      };
    },
    /** capacity null returns the slot to the listing's normal size; 0 stops new bookings. Existing bookings are never touched. */
    async setSlot(credential, lid, { date, time, capacity }) {
      const l = await catalog.ownListing(credential, lid);
      if (!isDate(date) || date < today()) throw bad("Sana noto‘g‘ri");
      if (!l.times.includes(time)) throw bad("Bu vaqt jadvalda yo‘q");
      if (capacity === null || capacity === l.capacity) await db.run("DELETE FROM slot_rules WHERE listing_id=? AND date=? AND time=?", l.id, date, time);
      else {
        int(capacity, "Joylar soni", 0, 100);
        await db.run("INSERT INTO slot_rules (listing_id,date,time,capacity) VALUES (?,?,?,?) ON CONFLICT (listing_id,date,time) DO UPDATE SET capacity=excluded.capacity", l.id, date, time, capacity);
      }
      events.emit("slots", { listing: l.id });
      return (await this.slotCalendar(credential, lid, date, 1)).days[0];
    },
  };
}
