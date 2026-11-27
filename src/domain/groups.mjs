// Requests for larger groups and private visits. The provider answers with a time and one price; the guest books that quote.
import { addDays, fail, id, int, isDate, lang, notFound, secret, str, today } from "../lib/util.mjs";
import { cleanEmail, cleanPhone } from "./mail.mjs";
import { openOn } from "./availability.mjs";

const AHEAD = 365;

export function createGroups({ db, events, accounts, catalog, bookings }) {
  async function own(token) {
    const r = typeof token === "string" ? await db.one("SELECT g.*, l.i18n, l.host_id, l.region, l.place, l.duration_min, l.price_uzs FROM group_requests g JOIN listings l ON l.id=g.listing_id WHERE g.token=?", token) : null;
    if (!r) throw notFound("So‘rov topilmadi");
    return r;
  }
  const view = (r) => ({ token: r.token, lang: r.lang, listing_id: r.listing_id, i18n: r.i18n, region: r.region, place: r.place, date: r.date, guests: r.guests, private: r.private, name: r.name, status: r.status,
    quote: r.quote_uzs ? { time: r.quote_time, total_uzs: r.quote_uzs, note: r.quote_note } : null, booking: r.booking_token ?? null, expired: r.date < today() });

  return {
    async askGroup(lid, p = {}) {
      const l = await catalog.published(lid), email = cleanEmail(p.email);
      if (!email) throw fail(400, "Email kerak", "email");
      if (!isDate(p.date) || p.date <= today() || p.date > addDays(today(), AHEAD)) throw fail(400, "Sana noto‘g‘ri", "past");
      const r = { id: id("g_"), token: secret() };
      await db.run("INSERT INTO group_requests (id,token,listing_id,date,guests,private,name,email,phone,note,lang) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        r.id, r.token, l.id, p.date, int(p.guests, "Mehmonlar soni", 1, 300), p.private === true, str(p.name, "Ism", 80), email, cleanPhone(p.phone), p.note ? str(p.note, "Izoh", 600) : null, lang(p.lang));
      events.emit("host", { hostId: l.host_id, type: "request", id: r.id });
      return { token: r.token };
    },
    async groupRequest(token) {
      const r = typeof token === "string" ? await db.one("SELECT g.*, l.i18n, l.region, l.place, b.token booking_token FROM group_requests g JOIN listings l ON l.id=g.listing_id LEFT JOIN bookings b ON b.id=g.booking_id WHERE g.token=?", token) : null;
      if (!r) throw notFound("So‘rov topilmadi");
      return view(r);
    },
    /** For the provider: what is waiting for an answer, and what was answered. No guest e-mail. */
    async groupRequests(credential) {
      const h = await accounts.authHost(credential);
      return db.all(`SELECT g.id, g.date, g.guests, g.private, g.name, g.phone, g.note, g.lang, g.status, g.quote_time, g.quote_uzs, g.quote_note, g.created_at, l.id listing_id, l.i18n->'uz'->>'title' title, l.times, l.price_uzs
        FROM group_requests g JOIN listings l ON l.id=g.listing_id WHERE l.host_id=? AND g.date >= ? ORDER BY g.status='new' DESC, g.date LIMIT 100`, h.id, today());
    },
    async answerGroup(credential, rid, p = {}) {
      const h = await accounts.authHost(credential);
      const r = await db.one("SELECT g.*, l.host_id, l.times, l.weekdays, l.closed FROM group_requests g JOIN listings l ON l.id=g.listing_id WHERE g.id=?", String(rid ?? ""));
      if (!r || r.host_id !== h.id) throw notFound("So‘rov topilmadi");
      if (!["new", "quoted"].includes(r.status) || r.date < today()) throw fail(409, "So‘rovga endi javob berib bo‘lmaydi", "state");
      if (p.decline) await db.run("UPDATE group_requests SET status='declined', updated_at=now() WHERE id=?", r.id);
      else {
        // Only a time the offer really runs on that day, so the guest can always book what was offered.
        if (!r.times.includes(p.time)) throw fail(400, "Taklif jadvalidagi vaqtni tanlang");
        if (!openOn(r, r.date)) throw fail(409, "Bu kun ish kuni emas. Avval jadvalni o‘zgartiring", "closed");
        await db.run("UPDATE group_requests SET status='quoted', quote_time=?, quote_uzs=?, quote_note=?, updated_at=now() WHERE id=?", p.time, int(p.total_uzs, "Jami narx", 1000, 1_000_000_000), p.note ? str(p.note, "Izoh", 600) : null, r.id);
      }
      events.emit("quote", { token: r.token });
      return { ok: true };
    },
    /** The guest accepts the quote: a booking at that price, confirmed as soon as it is paid. */
    async bookQuote(token, p = {}) {
      return db.tx(async () => {
        const r = await own(token);
        await db.one("SELECT id FROM group_requests WHERE id=? FOR UPDATE", r.id);
        const now = await own(token);
        if (now.status === "booked") return { booking: (await db.one("SELECT token FROM bookings WHERE id=?", now.booking_id)).token };
        if (now.status !== "quoted" || now.date < today()) throw fail(409, "Bu taklifni endi bron qilib bo‘lmaydi", "state");
        const b = await bookings.book({ listing_id: now.listing_id, date: now.date, time: now.quote_time, guests: now.guests, guest_name: now.name, email: now.email, phone: now.phone, lang: now.lang, expect_uzs: p.expect_uzs }, { quote: { total: now.quote_uzs } });
        await db.run("UPDATE group_requests SET status='booked', booking_id=(SELECT id FROM bookings WHERE token=?), updated_at=now() WHERE id=?", b.token, now.id);
        return { booking: b.token };
      });
    },
  };
}
