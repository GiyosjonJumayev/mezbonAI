// Bookings: holding a place, answering, moving, cancelling, tickets, reviews, messages.
import { randomBytes } from "node:crypto";
import { translate } from "../ai/claude.mjs";
import { REGIONS } from "../lib/i18n.mjs";
import { bad, fail, id, int, lang, notFound, secret, startsAt, str, tashkentNow, today } from "../lib/util.mjs";
import { hostListing } from "./catalog.mjs";
import { effectivePlan, split } from "./plans.mjs";

export const HOLD_MIN = 30;
export const CANCEL_HOURS = 24;
export const DECIDE_HOURS = 24;
export const newTicketCode = () => randomBytes(6).toString("hex").toUpperCase();
export const cleanTicketCode = (s) => String(s ?? "").toUpperCase().replace(/[^0-9A-F]/g, "").slice(0, 12);

/** The provider has a day to answer, and never longer than until the visit itself. */
const decideBy = (date, time) => new Date(Math.min(Date.now() + DECIDE_HOURS * 3600e3, +startsAt(date, time))).toISOString();

function ics(list) {
  const stamp = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const esc = (s) => s.replace(/[\\;,]/g, "\\$&").replace(/\r?\n/g, "\\n");
  const event = (b) => {
    const start = startsAt(b.date, b.time), end = new Date(+start + (b.duration_min ?? 60) * 60e3);
    return ["BEGIN:VEVENT", `UID:${b.id}@mezbon`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, `SUMMARY:${esc(b.summary)}`, `LOCATION:${esc(`${b.place ?? REGIONS[b.region]}, Uzbekistan`)}`, "END:VEVENT"];
  };
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SilkRoad Experience OS//EN", ...list.flatMap(event), "END:VCALENDAR", ""].join("\r\n");
}

export function createBookings({ db, events, accounts, catalog, availability, plans, refunds }) {
  const BOOKING = `SELECT b.*, l.host_id, l.i18n, l.place, l.region, l.category, l.photos->>0 photo, l.duration_min, ho.name hotel_name, r.rating review_rating, tr.token trip_token
    FROM bookings b JOIN listings l ON l.id=b.listing_id LEFT JOIN hotels ho ON ho.code=b.hotel_code LEFT JOIN reviews r ON r.booking_id=b.id LEFT JOIN trips tr ON tr.id=b.trip_id`;
  const byId = (bid) => db.one(`${BOOKING} WHERE b.id=?`, String(bid ?? ""));
  async function guestOwn(token) {
    const b = typeof token === "string" ? await db.one(`${BOOKING} WHERE b.token=?`, token) : null;
    if (!b) throw notFound("Bron topilmadi");
    return b;
  }
  const MSG = "sender, original, lang, translated, translated_lang, engine, created_at";
  const msgs = (bid) => db.all(`SELECT ${MSG} FROM messages WHERE booking_id=? ORDER BY id`, bid);
  const isExpired = (b) => b.status === "pending" && b.expires_at <= new Date().toISOString();
  const canCancel = (b) => (b.status === "pending" ? !isExpired(b) : ["paid", "confirmed"].includes(b.status) && !b.checked_in_at && startsAt(b.date, b.time) - Date.now() >= CANCEL_HOURS * 3600e3);
  const canReview = (b) => b.status === "confirmed" && (b.checked_in_at || startsAt(b.date, b.time) <= new Date()) && b.review_rating == null;
  const toHost = (b, type) => events.emit("host", { hostId: b.host_id, type, id: b.id });
  const toGuest = (b, type, text) => events.emit("guest", { booking: b, type, text });
  const listingOf = (lid) => db.one("SELECT l.*, h.plan host_plan, h.plan_until host_plan_until FROM listings l JOIN hosts h ON h.id=l.host_id WHERE l.id=?", lid);

  const api = {
    byId,
    async hostHome(credential) {
      const h = await accounts.authHost(credential);
      const rows = await db.all(`SELECT b.id, b.date, b.time, b.guests, b.guest_name, b.lang, b.channel, b.status, b.host_uzs, b.total_uzs, b.created_at, b.checked_in_at, b.moved_at, b.decide_by, l.i18n->'uz'->>'title' title, l.id listing_id
        FROM bookings b JOIN listings l ON l.id=b.listing_id WHERE l.host_id=? AND b.status<>'pending' AND NOT (b.status='cancelled' AND b.expires_at IS NOT NULL)
        ORDER BY b.status='paid' DESC, (b.date >= ?) DESC, b.date, b.time LIMIT 100`, h.id, today());
      const sums = await db.one(`SELECT COALESCE(SUM(b.host_uzs) FILTER (WHERE b.status='confirmed'),0) earned, COALESCE(SUM(b.guests) FILTER (WHERE b.status='confirmed'),0) guests, COUNT(*) FILTER (WHERE b.status='paid') waiting
        FROM bookings b JOIN listings l ON l.id=b.listing_id WHERE l.host_id=?`, h.id);
      const talk = new Map();
      for (const { booking_id, ...m } of await db.all(`SELECT booking_id, ${MSG} FROM messages WHERE booking_id = ANY(?::text[]) ORDER BY id`, rows.map((b) => b.id))) talk.set(booking_id, [...(talk.get(booking_id) ?? []), m]);
      const d = today();
      return {
        id: h.id, name: h.name, type: h.type, verified: Boolean(h.verified_at), suspended: Boolean(h.suspended_at), plan: await plans.planOf(h), sums,
        listings: (await catalog.ownListings(h.id)).map(hostListing),
        bookings: rows.map((b) => ({ ...b, past: b.date < d, messages: talk.get(b.id) ?? [] })),
      };
    },

    async book(p) {
      const l = await catalog.published(p.listing_id), { date } = p, time = String(p.time ?? "");
      availability.check(l, date, time);
      const guests = int(p.guests, "Mehmonlar soni", 1, 100);
      const name = str(p.guest_name, "Ism", 80);
      const hotel = await catalog.hotel(p.hotel_code);
      const channel = p.source === "ai" ? "ai" : hotel ? "hotel" : "web";
      const b = { id: id("b_"), token: secret() };
      await db.tx(async () => {
        await availability.lock(l.id);
        const fresh = await catalog.published(l.id); // price and schedule as they are now that we hold the lock
        availability.check(fresh, date, time);
        const rule = (await db.one("SELECT capacity FROM slot_rules WHERE listing_id=? AND date=? AND time=?", l.id, date, time))?.capacity ?? 0;
        int(guests, "Mehmonlar soni", 1, Math.max(fresh.capacity, rule));
        if ((await availability.free(fresh, date, time)) < guests) throw fail(409, "Bu vaqtda joy yetarli emas", "full");
        const s = split(fresh.price_uzs * guests, channel, effectivePlan({ plan: fresh.host_plan, plan_until: fresh.host_plan_until }));
        await db.run(`INSERT INTO bookings (id,token,listing_id,date,time,guests,guest_name,lang,channel,hotel_code,status,total_uzs,platform_uzs,hotel_uzs,host_uzs,expires_at,trip_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?)`,
          b.id, b.token, l.id, date, time, guests, name, lang(p.lang), channel, channel === "hotel" ? hotel.code : null,
          s.total, s.platform, s.hotel, s.host, new Date(Date.now() + HOLD_MIN * 60e3).toISOString(), p.trip_id ?? null);
      });
      return api.guestBooking(b.token);
    },

    bookingId: async (token) => (await guestOwn(token)).id,
    async guestBooking(token) {
      const b = await guestOwn(token);
      return {
        token: b.token, trip: b.trip_token, listing_id: b.listing_id, i18n: b.i18n, place: b.place, region: b.region, category: b.category, photo: b.photo, duration_min: b.duration_min,
        date: b.date, time: b.time, guests: b.guests, guest_name: b.guest_name, lang: b.lang, channel: b.channel, hotel: b.hotel_name,
        status: isExpired(b) ? "expired" : b.status, expires_at: b.status === "pending" ? b.expires_at : null, decide_by: b.status === "paid" ? b.decide_by : null,
        total_uzs: b.total_uzs, platform_uzs: b.platform_uzs, hotel_uzs: b.hotel_uzs, host_uzs: b.host_uzs,
        ticket: b.status === "confirmed" ? { code: b.ticket_code, used_at: b.checked_in_at } : null,
        can_cancel: canCancel(b), can_move: b.status !== "pending" && canCancel(b), can_review: Boolean(canReview(b)), my_rating: b.review_rating,
        payment: await refunds.summary(b.id), messages: await msgs(b.id),
      };
    },

    /** Free cancellation up to CANCEL_HOURS before the start. Money already paid goes back. */
    async cancel(token) {
      await db.tx(async () => {
        const b = await guestOwn(token);
        if (!canCancel(b)) throw fail(409, "Bekor qilish muddati o‘tgan", "cancel");
        const r = await db.run("UPDATE bookings SET status='cancelled' WHERE id=? AND status=? AND checked_in_at IS NULL", b.id, b.status);
        if (!r.changes) throw fail(409, "Bron holati o‘zgargan", "state");
        if (b.status === "pending") return;
        await refunds.refundBooking(b.id, "Mehmon bekor qildi");
        toHost(b, "cancelled");
      });
      return api.guestBooking(token);
    },

    /** Moves a paid or confirmed booking to another open slot at the same price. The provider approves it again and a new ticket is issued. */
    async reschedule(token, p) {
      const { date } = p, time = String(p.time ?? "");
      await db.tx(async () => {
        const { listing_id } = await guestOwn(token);
        await availability.lock(listing_id);
        const b = await guestOwn(token);
        if (b.status === "pending" || !canCancel(b)) throw fail(409, "Ko‘chirish muddati o‘tgan", "cancel");
        if (date === b.date && time === b.time) throw bad("Boshqa vaqtni tanlang");
        const l = await catalog.published(listing_id);
        availability.check(l, date, time);
        if ((await availability.free(l, date, time, b.id)) < b.guests) throw fail(409, "Bu vaqtda joy yetarli emas", "full");
        const r = await db.run("UPDATE bookings SET date=?, time=?, status='paid', ticket_code=NULL, reminded_at=NULL, moved_at=now(), decide_by=?, asked_at=now(), decided_at=NULL WHERE id=? AND status=? AND checked_in_at IS NULL", date, time, decideBy(date, time), b.id, b.status);
        if (!r.changes) throw fail(409, "Bron holati o‘zgargan", "state");
        toHost(b, "moved");
      });
      return api.guestBooking(token);
    },

    async review(token, p) {
      const b = await guestOwn(token);
      const twice = () => fail(409, "Baho tashrifdan keyin bir marta qo‘yiladi", "review");
      if (!canReview(b)) throw twice();
      const rating = int(p.rating, "Baho", 1, 5), text = p.text ? str(p.text, "Izoh", 600) : null;
      const r = await db.run("INSERT INTO reviews (booking_id,listing_id,rating,text,lang) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING", b.id, b.listing_id, rating, text, b.lang);
      if (!r.changes) throw twice();
      return api.guestBooking(token);
    },

    async decide(credential, bid, accept) {
      const h = await accounts.authHost(credential);
      await db.tx(async () => {
        const b = await byId(bid);
        if (!b || b.host_id !== h.id) throw notFound("Bron topilmadi");
        const r = await db.run("UPDATE bookings SET status=?, ticket_code=?, decide_by=NULL, decided_at=now() WHERE id=? AND status='paid'", accept ? "confirmed" : "declined", accept ? newTicketCode() : null, b.id);
        if (!r.changes) throw fail(409, "Bron holati allaqachon o‘zgargan", "state");
        if (!accept) await refunds.refundBooking(b.id, "Mezbon rad etdi");
        toGuest(b, accept ? "confirmed" : "declined");
      });
      return api.hostHome(credential);
    },
    /** Paid bookings nobody answered in time are declined and refunded, so a guest never waits for money. */
    async declineUnanswered() {
      let n = 0;
      for (const { id: bid } of await db.all("SELECT id FROM bookings WHERE status='paid' AND decide_by <= now() ORDER BY decide_by LIMIT 100")) await db.tx(async () => {
        const b = await byId(bid);
        const r = await db.run("UPDATE bookings SET status='declined', decide_by=NULL WHERE id=? AND status='paid' AND decide_by <= now()", bid);
        if (!r.changes) return;
        await refunds.refundBooking(bid, "Mezbon javob bermadi");
        toGuest(b, "declined");
        toHost(b, "unanswered");
        n++;
      });
      return n;
    },

    async message(sender, auth, p) {
      const hostId = sender === "host" ? (await accounts.authHost(auth)).id : null;
      const b = sender === "guest" ? await guestOwn(auth) : await byId(p.booking_id);
      if (!b || (hostId && b.host_id !== hostId)) throw notFound("Bron topilmadi");
      if (!["paid", "confirmed"].includes(b.status)) throw fail(409, "Yozishma to‘lovdan keyin ochiladi", "state");
      const [from, to] = sender === "guest" ? [b.lang, "uz"] : ["uz", b.lang];
      const t = await translate({ text: p.code ? null : str(p.text, "Xabar", 1000), code: p.code, from, to });
      if (!t.original) throw bad("Xabar kerak");
      await db.run("INSERT INTO messages (booking_id,sender,original,lang,translated,translated_lang,engine) VALUES (?,?,?,?,?,?,?)", b.id, sender, t.original, from, t.translated, to, t.engine);
      if (sender === "guest") toHost(b, "message");
      else toGuest(b, "message", t.translated);
      return msgs(b.id);
    },

    /** Confirmed visits starting within 24 hours that nobody was reminded of yet. Each is returned once. */
    async takeReminders() {
      const clock = tashkentNow().slice(0, 16), limit = tashkentNow(new Date(Date.now() + 24 * 3600e3)).slice(0, 16);
      const ids = await db.all(`UPDATE bookings SET reminded_at=now() WHERE id IN (SELECT id FROM bookings WHERE status='confirmed' AND reminded_at IS NULL AND checked_in_at IS NULL
        AND date + time::time > ?::timestamp AND date + time::time <= ?::timestamp LIMIT 200 FOR UPDATE SKIP LOCKED) RETURNING id`, clock, limit);
      return Promise.all(ids.map((r) => byId(r.id)));
    },

    /** iCalendar file for a paid or confirmed booking. */
    async calendar(token) {
      const b = await guestOwn(token);
      if (!["paid", "confirmed"].includes(b.status)) throw fail(409, "Bron faol emas", "state");
      return ics([{ ...b, summary: b.i18n[b.lang].title }]);
    },
    /** Every coming visit of a provider, for the calendar on their phone. First name only: the feed lives on other companies' servers. */
    async hostCalendar(token) {
      const h = await accounts.hostByCalendar(token);
      const rows = await db.all(`${BOOKING} WHERE l.host_id=? AND b.status IN ('paid','confirmed') AND b.date >= ? ORDER BY b.date, b.time LIMIT 500`, h.id, today());
      return ics(rows.map((b) => ({ ...b, summary: `${b.status === "paid" ? "Javob kutmoqda: " : ""}${b.i18n.uz.title} (${b.guest_name.split(/\s+/)[0]}, ${b.guests} kishi)` })));
    },

    // ---- QR tickets ----------------------------------------------------------------------------
    /** Looks a ticket up for its own provider. Other providers get the same answer as for a made-up code. */
    async ticket(credential, raw) {
      const h = await accounts.authHost(credential), code = cleanTicketCode(raw);
      const b = code.length === 12 ? await db.one(`${BOOKING} WHERE b.ticket_code=?`, code) : null;
      if (!b || b.host_id !== h.id) throw fail(404, "Chipta topilmadi. Kodni tekshiring", "ticket");
      const d = today();
      const state = b.status !== "confirmed" ? "void" : b.checked_in_at ? "used" : b.date > d ? "early" : b.date < d ? "late" : "valid";
      return { code, state, title: b.i18n.uz.title, guest_name: b.guest_name, guests: b.guests, date: b.date, time: b.time, lang: b.lang, checked_in_at: b.checked_in_at };
    },
    async checkIn(credential, raw) {
      const t = await api.ticket(credential, raw);
      const why = { used: "Bu chipta allaqachon ishlatilgan", early: `Bu chipta ${t.date} kuni uchun`, late: `Bu chipta muddati o‘tgan: ${t.date}`, void: "Bron bekor qilingan, chipta yaroqsiz" };
      if (t.state !== "valid") throw fail(409, why[t.state], "ticket");
      const r = await db.run("UPDATE bookings SET checked_in_at=now() WHERE ticket_code=? AND status='confirmed' AND checked_in_at IS NULL", t.code);
      if (!r.changes) throw fail(409, why.used, "ticket"); // another phone scanned it a moment earlier
      return api.ticket(credential, raw);
    },

    // ---- used by payments, inside the payment's own transaction ----------------------------------
    async forPayment(token) {
      const b = await guestOwn(token);
      if (b.status !== "pending") throw fail(409, "Bu bron to‘lov kutmayapti", "state");
      if (isExpired(b)) throw fail(410, "Bron muddati tugagan", "expired");
      return { id: b.id, total_uzs: b.total_uzs, lang: b.lang, title: b.i18n[b.lang]?.title ?? b.i18n.en.title };
    },
    /** Whether money for this booking can still be accepted. An expired hold is fine while the place is free. */
    async canPay(bid) {
      const b = await byId(bid);
      if (!b || b.status !== "pending") return false;
      if (!isExpired(b)) return true;
      return canRevive(b);
    },
    extendHold: (bid) => db.run("UPDATE bookings SET expires_at=GREATEST(expires_at, now() + interval '30 minutes') WHERE id=? AND status='pending'", bid),
    /** 'paid', or 'late' when the place is gone and the money must go back. */
    async markPaid(bid) {
      const first = await byId(bid);
      if (!first) return "late";
      await availability.lock(first.listing_id);
      const b = await byId(bid);
      if (b.status === "paid" || b.status === "confirmed") return "paid";
      if (b.status !== "pending" || (isExpired(b) && !(await canRevive(b)))) return "late";
      await db.run("UPDATE bookings SET status='paid', expires_at=NULL, decide_by=?, asked_at=now() WHERE id=?", decideBy(b.date, b.time), bid);
      toHost(b, "booking");
      return "paid";
    },
    /** A refund started in the payment company's cabinet is allowed until the visit. */
    async canRefund(bid) {
      const b = await byId(bid);
      return Boolean(b) && !b.checked_in_at && (["cancelled", "declined"].includes(b.status) || startsAt(b.date, b.time) > new Date());
    },
    async moneyReturned(bid) {
      const b = await byId(bid);
      const r = await db.run("UPDATE bookings SET status='cancelled', expires_at=NULL WHERE id=? AND status IN ('paid','confirmed') AND checked_in_at IS NULL", bid);
      if (r.changes) { toHost(b, "cancelled"); toGuest(b, "declined"); }
    },
  };
  async function canRevive(b) {
    if (startsAt(b.date, b.time) <= new Date()) return false;
    const l = await listingOf(b.listing_id);
    return (await availability.free(l, b.date, b.time, b.id)) >= b.guests;
  }
  return api;
}
