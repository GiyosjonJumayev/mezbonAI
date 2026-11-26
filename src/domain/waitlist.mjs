// Waiting list: a guest who found a full time is written to once when places open.
import { addDays, ago, fail, id, int, isDate, lang, notFound, secret, today } from "../lib/util.mjs";
import { cleanEmail } from "./mail.mjs";

/** Places offered to someone are not offered to the next person for this long. */
const TURN_MS = 2 * 3600e3;
const MAX_PER_ADDRESS = 10, MAX_AHEAD = 60;

export function createWaitlist({ db, catalog, availability }) {
  return {
    async joinWaitlist(lid, { date, time, guests, email, lang: lg } = {}) {
      const l = await catalog.published(lid), to = cleanEmail(email), n = int(guests, "Mehmonlar soni", 1, l.capacity), at = time ? String(time) : null;
      if (!to) throw fail(400, "Email kerak", "email");
      if (!isDate(date) || date < today() || date > addDays(today(), MAX_AHEAD)) throw fail(400, "Sana noto‘g‘ri", "past");
      const day = (await availability.slots(l, date, 1))[0];
      if (!day || (at && !day.times.some((t) => t.time === at))) throw fail(409, "Mezbon bu vaqtda ishlamaydi", "closed");
      if (day.times.some((t) => (!at || t.time === at) && t.free >= n)) throw fail(409, "Hozir joy bor", "open");
      // The same answer whether or not the address was already waiting, or waits for too much.
      if ((await db.one("SELECT COUNT(*) n FROM waitlist WHERE lower(email)=lower(?)", to)).n < MAX_PER_ADDRESS)
        await db.run(`INSERT INTO waitlist (id,token,listing_id,date,time,guests,email,lang) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT (listing_id, date, COALESCE(time, ''), lower(email)) DO UPDATE SET guests=excluded.guests, lang=excluded.lang, notified_at=NULL`, id("w_"), secret(), l.id, date, at, n, to, lang(lg));
      return { ok: true };
    },
    async leaveWaitlist(token) {
      const r = typeof token === "string" && (await db.run("DELETE FROM waitlist WHERE token=?", token)).changes;
      if (!r) throw notFound("Topilmadi");
      return { ok: true };
    },
    /** First come, first served. Returns who should be written to now; each row is returned once. */
    async takeOpenings() {
      const rows = await db.all(`SELECT w.*, w.notified_at >= ? AS offered FROM waitlist w WHERE w.date >= ? AND (w.notified_at IS NULL OR w.notified_at >= ?) ORDER BY w.notified_at IS NULL, w.created_at, w.id LIMIT 2000`, ago(TURN_MS), today(), ago(TURN_MS));
      const out = [], open = new Map();
      for (const w of rows) {
        const key = `${w.listing_id}|${w.date}`;
        if (!open.has(key)) {
          const l = await catalog.published(w.listing_id).catch(() => null);
          open.set(key, { l, times: l ? ((await availability.slots(l, w.date, 1))[0]?.times ?? []).map((t) => ({ ...t })) : [] });
        }
        const { l, times } = open.get(key), slot = times.find((t) => (!w.time || t.time === w.time) && t.free >= w.guests);
        if (!slot) continue;
        slot.free -= w.guests;
        if (w.offered) continue; // already has the message; their places stay reserved in this count
        const r = await db.run("UPDATE waitlist SET notified_at=now() WHERE id=? AND notified_at IS NULL", w.id);
        if (r.changes) out.push({ ...w, time: slot.time, i18n: l.i18n });
      }
      return out;
    },
    /** For the provider: how many people wait for which time. Numbers only, no addresses. */
    waitingFor: (ids) => db.all("SELECT listing_id, date, time, COUNT(*) n, SUM(guests) guests FROM waitlist WHERE listing_id = ANY(?::text[]) AND date >= ? GROUP BY 1,2,3 ORDER BY date, time NULLS LAST LIMIT 50", ids, today()),
    cleanWaitlist: () => db.run("DELETE FROM waitlist WHERE date < ? OR notified_at < ?", today(), ago(7 * 864e5)),
  };
}
