// All business rules. No HTTP, Telegram or MCP code here: those are thin adapters over this module.
import { randomBytes } from "node:crypto";
import { CATEGORIES, LANGS, PROVIDER_TYPES, REGIONS } from "./i18n.mjs";
import { missing, templateI18n } from "./extract.mjs";
import { buildListing, translate } from "./ai.mjs";
import { createBusiness, effectivePlan, newTicketCode, PLANS } from "./business.mjs";
import { createAssistant } from "./assistant.mjs";

/** `message` is Uzbek for hosts; `code` lets the tourist site and AI assistants show their own wording. */
export class AppError extends Error {
  constructor(status, message, code = "input") { super(message); this.status = status; this.code = code; }
}
const bad = (m) => new AppError(400, m);
const notFound = (m) => new AppError(404, m, "notfound");
const id = (p) => p + randomBytes(5).toString("hex");
const secret = () => randomBytes(18).toString("base64url");
const now = () => new Date().toISOString();

/** A hotel that refers a guest earns this share. The platform's share depends on the provider's plan. */
export const HOTEL_FEE = 8;
export const HOLD_MIN = 30;
export const CANCEL_HOURS = 24;
const LIVE = "(status IN ('paid','confirmed') OR (status='pending' AND expires_at > ?))";
const PAID = "status IN ('paid','confirmed')";

export function split(total, channel, plan = "free") {
  const platform = Math.round((total * PLANS[plan].commission) / 100);
  const hotel = channel === "hotel" ? Math.round((total * HOTEL_FEE) / 100) : 0;
  return { total, platform, hotel, host: total - platform - hotel };
}

/** Wall-clock time in Tashkent as an ISO-shaped string (UTC+5, no daylight saving). */
export const tashkentNow = (d = new Date()) => new Date(d.getTime() + 5 * 3600e3).toISOString();
export const startsAt = (date, time) => new Date(`${date}T${time}:00+05:00`);
export const isoWeekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
export const addDays = (date, n) => new Date(+new Date(`${date}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export function isDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === s;
}

const str = (v, name, max) => {
  if (typeof v !== "string" || !v.trim()) throw bad(`${name} kerak`);
  const s = v.trim();
  if (s.length > max) throw bad(`${name} juda uzun (${max} belgigacha)`);
  return s;
};
const int = (v, name, min, max) => {
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`${name}: ${min}–${max} oralig‘ida butun son bo‘lsin`);
  return v;
};
const lang = (v) => (LANGS.includes(v) ? v : "en");
const known = (map, v) => (typeof v === "string" && Object.hasOwn(map, v) ? v : null);

export const MAX_PHOTOS = 6;

export function createCore(db, { notify = () => {}, notifyGuest = () => {} } = {}) {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);

  const full = (r) => r && { ...r, weekdays: JSON.parse(r.weekdays), times: JSON.parse(r.times), i18n: JSON.parse(r.i18n), edited: JSON.parse(r.edited), closed: JSON.parse(r.closed), photos: JSON.parse(r.photos), photo: JSON.parse(r.photos)[0] ?? null };
  const publicListing = (r) => ({
    id: r.id, category: r.category, region: r.region, place: r.place, price_uzs: r.price_uzs, duration_min: r.duration_min,
    capacity: r.capacity, weekdays: r.weekdays, times: r.times, i18n: r.i18n, photo: r.photo, photos: r.photos, hosted: r.hosted, host: r.host_name, host_type: r.host_type, demo: Boolean(r.host_demo),
    rating: r.rating == null ? null : Math.round(r.rating * 10) / 10, reviews: r.review_count,
  });
  const hostListing = (r) => ({ ...publicListing(r), status: r.status, cert_no: r.cert_no, transcript: r.transcript, engine: r.engine, edited: r.edited, closed: r.closed, missing: missing(r) });
  const LISTING = `SELECT l.*, h.name host_name, h.demo host_demo, h.type host_type, h.plan host_plan, h.plan_until host_plan_until,
    (SELECT AVG(rating) FROM reviews WHERE listing_id=l.id) rating, (SELECT COUNT(*) FROM reviews WHERE listing_id=l.id) review_count,
    (SELECT COALESCE(SUM(guests),0) FROM bookings WHERE listing_id=l.id AND checked_in_at IS NOT NULL) hosted
    FROM listings l JOIN hosts h ON h.id = l.host_id`;

  function authHost(key) {
    const h = typeof key === "string" && key ? one("SELECT * FROM hosts WHERE key = ?", key) : null;
    if (!h) throw new AppError(401, "Kirish havolasi noto‘g‘ri yoki eskirgan", "auth");
    return h;
  }
  function ownListing(key, listingId) {
    const h = authHost(key);
    const l = full(one(`${LISTING} WHERE l.id = ? AND l.host_id = ?`, listingId, h.id));
    if (!l) throw notFound("Taklif topilmadi");
    return l;
  }
  function booking(column, v) {
    const b = one(`SELECT b.*, l.host_id, l.i18n, l.place, l.region, l.category, json_extract(l.photos, '$[0]') photo, l.duration_min, ho.name hotel_name, r.rating review_rating
      FROM bookings b JOIN listings l ON l.id = b.listing_id LEFT JOIN hotels ho ON ho.code = b.hotel_code LEFT JOIN reviews r ON r.booking_id = b.id
      WHERE b.${column} = ?`, String(v ?? ""));
    return b && { ...b, i18n: JSON.parse(b.i18n) };
  }
  function guestOwn(token) {
    const b = booking("token", token);
    if (!b) throw notFound("Bron topilmadi");
    return b;
  }
  const msgs = (bid) => all("SELECT sender, original, lang, translated, translated_lang, engine, created_at FROM messages WHERE booking_id = ? ORDER BY id", bid);
  const isExpired = (b) => b.status === "pending" && b.expires_at <= now();
  const canCancel = (b) => (b.status === "pending" ? !isExpired(b) : ["paid", "confirmed"].includes(b.status) && startsAt(b.date, b.time) - Date.now() >= CANCEL_HOURS * 3600e3);
  const canReview = (b) => b.status === "confirmed" && (b.checked_in_at || startsAt(b.date, b.time) <= new Date()) && b.review_rating == null;
  const openOn = (l, date) => l.weekdays.includes(isoWeekday(date)) && !l.closed.includes(date);

  /** Free places per open slot for `days` calendar days from `from`. Past slots are left out. */
  function slots(l, from, days) {
    const to = addDays(from, days), clock = tashkentNow().slice(0, 16);
    const used = new Map(all(`SELECT date, time, SUM(guests) n FROM bookings WHERE listing_id=? AND date>=? AND date<? AND ${LIVE} GROUP BY date, time`, l.id, from, to, now())
      .map((r) => [`${r.date}T${r.time}`, r.n]));
    const rules = new Map(all("SELECT date, time, capacity FROM slot_rules WHERE listing_id=? AND date>=? AND date<?", l.id, from, to).map((r) => [`${r.date}T${r.time}`, r.capacity]));
    const out = [];
    for (let i = 0; i < days; i++) {
      const date = addDays(from, i);
      if (!openOn(l, date)) continue;
      const times = l.times.filter((t) => `${date}T${t}` > clock).map((time) => {
        const k = `${date}T${time}`;
        return { time, free: Math.max(0, (rules.get(k) ?? l.capacity) - (used.get(k) ?? 0)) };
      });
      if (times.length) out.push({ date, times });
    }
    return out;
  }
  function published(lid) {
    const l = full(one(`${LISTING} WHERE l.id=? AND l.status='published'`, String(lid ?? "")));
    if (!l) throw notFound("Taklif topilmadi");
    return l;
  }

  const biz = createBusiness({ db, one, all, run, now, authHost, ownListing, booking, openOn, isDate, addDays, id, today: () => tashkentNow().slice(0, 10), fail: (s, m, c) => new AppError(s, m, c) });

  const core = {
    ...biz,
    // ---- hosts -------------------------------------------------------------------------------
    createHost(name, { telegramChat = null, demo = 0, type = "artisan" } = {}) {
      if (!known(PROVIDER_TYPES, type)) throw bad("Faoliyat turi noto‘g‘ri");
      const h = { id: id("h_"), key: secret(), name: str(name, "Ism", 60) };
      run("INSERT INTO hosts (id,key,name,telegram_chat,demo,created_at,type) VALUES (?,?,?,?,?,?,?)", h.id, h.key, h.name, telegramChat, demo, now(), type);
      return h;
    },
    authHost,
    hostByTelegram: (chat) => one("SELECT * FROM hosts WHERE telegram_chat = ?", String(chat)),

    hostHome(key) {
      const h = authHost(key);
      const rows = all(`SELECT b.id, b.date, b.time, b.guests, b.guest_name, b.lang, b.channel, b.status, b.host_uzs, b.total_uzs, b.created_at, b.checked_in_at, b.moved_at, l.i18n, l.id listing_id
        FROM bookings b JOIN listings l ON l.id=b.listing_id WHERE l.host_id=? AND b.status!='pending' AND NOT (b.status='cancelled' AND b.expires_at IS NOT NULL)
        ORDER BY b.status='paid' DESC, b.date, b.time LIMIT 100`, h.id);
      const sums = one(`SELECT COALESCE(SUM(CASE WHEN b.status='confirmed' THEN b.host_uzs END),0) earned, COALESCE(SUM(CASE WHEN b.status='confirmed' THEN b.guests END),0) guests, COUNT(CASE WHEN b.status='paid' THEN 1 END) waiting
        FROM bookings b JOIN listings l ON l.id=b.listing_id WHERE l.host_id=?`, h.id);
      const today = tashkentNow().slice(0, 10);
      return {
        id: h.id, name: h.name, type: h.type, plan: biz.planOf(h), sums,
        listings: all(`${LISTING} WHERE l.host_id=? ORDER BY l.created_at DESC`, h.id).map(full).map(hostListing),
        bookings: rows.map(({ i18n, ...b }) => ({ ...b, title: JSON.parse(i18n).uz.title, past: b.date < today, messages: msgs(b.id) })),
      };
    },

    // ---- listings ----------------------------------------------------------------------------
    async createDraft(key, transcript) {
      const h = authHost(key);
      const text = str(transcript, "Matn", 4000);
      if (one("SELECT COUNT(*) n FROM listings WHERE host_id=?", h.id).n >= 50) throw new AppError(409, "Ko‘pi bilan 50 ta taklif saqlanadi. Keraksiz qoralamalarni o‘chiring");
      const { facts, i18n, engine, note } = await buildListing(text, h.name);
      const lid = id("l_");
      run(`INSERT INTO listings (id,host_id,status,category,region,place,price_uzs,duration_min,capacity,weekdays,times,transcript,i18n,engine,created_at)
        VALUES (?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?)`,
        lid, h.id, facts.category, facts.region, facts.place, facts.price_uzs, facts.duration_min, facts.capacity,
        JSON.stringify([1, 2, 3, 4, 5, 6]), JSON.stringify(["10:00", "15:00"]), text, JSON.stringify(i18n), engine, now());
      return { ...hostListing(ownListing(key, lid)), note };
    },

    updateListing(key, lid, p) {
      const l = ownListing(key, lid);
      const n = { ...l, i18n: { ...l.i18n }, edited: [...l.edited] };
      if ("category" in p) { if (!known(CATEGORIES, p.category)) throw bad("Mashg‘ulot turi noto‘g‘ri"); n.category = p.category; }
      if ("region" in p) { if (!known(REGIONS, p.region)) throw bad("Viloyat noto‘g‘ri"); n.region = p.region; }
      if ("place" in p) n.place = p.place ? str(p.place, "Joy", 60) : null;
      if ("price_uzs" in p) n.price_uzs = int(p.price_uzs, "Narx", 1000, 100_000_000);
      if ("duration_min" in p) n.duration_min = int(p.duration_min, "Davomiylik", 15, 720);
      if ("capacity" in p) n.capacity = int(p.capacity, "Mehmonlar soni", 1, 100);
      if ("cert_no" in p) n.cert_no = p.cert_no ? str(p.cert_no, "Sertifikat", 40) : null;
      if ("weekdays" in p) {
        if (!Array.isArray(p.weekdays) || !p.weekdays.length || p.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw bad("Kamida bitta ish kunini tanlang");
        n.weekdays = [...new Set(p.weekdays)].sort();
      }
      if ("times" in p) {
        if (!Array.isArray(p.times) || !p.times.length || p.times.length > 12 || p.times.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) throw bad("Vaqtni 10:00 ko‘rinishida yozing, ko‘pi bilan 12 ta");
        n.times = [...new Set(p.times)].sort();
      }
      if ("closed" in p) {
        if (!Array.isArray(p.closed) || p.closed.length > 366 || !p.closed.every(isDate)) throw bad("Dam olish sanasi noto‘g‘ri");
        n.closed = [...new Set(p.closed)].sort();
      }
      // Template text quotes the numbers, so rebuild it when they change. AI and hand-edited text stays as approved.
      if (l.engine === "demo") for (const [g, t] of Object.entries(templateI18n(n, l.host_name)))
        n.i18n[g] = Object.fromEntries(Object.entries(t).map(([f, v]) => [f, n.edited.includes(`${g}.${f}`) ? n.i18n[g][f] : v]));
      if ("text" in p) {
        const g = p.text?.lang;
        if (!LANGS.includes(g)) throw bad("Til noto‘g‘ri");
        for (const [f, label, max] of [["title", "Sarlavha", 120], ["description", "Tavsif", 1500]]) {
          if (!(f in p.text)) continue;
          n.i18n[g] = { ...n.i18n[g], [f]: str(p.text[f], label, max) };
          if (!n.edited.includes(`${g}.${f}`)) n.edited.push(`${g}.${f}`);
        }
      }
      const gaps = missing(n);
      if (l.status === "published" && gaps.length) throw bad(gaps[0].text);
      run("UPDATE listings SET category=?,region=?,place=?,price_uzs=?,duration_min=?,capacity=?,cert_no=?,weekdays=?,times=?,closed=?,i18n=?,edited=? WHERE id=?",
        n.category, n.region, n.place, n.price_uzs, n.duration_min, n.capacity, n.cert_no ?? null, JSON.stringify(n.weekdays), JSON.stringify(n.times), JSON.stringify(n.closed), JSON.stringify(n.i18n), JSON.stringify(n.edited), lid);
      return hostListing(ownListing(key, lid));
    },

    addPhoto(key, lid, file) {
      const { photos } = ownListing(key, lid);
      if (photos.length >= MAX_PHOTOS) throw new AppError(409, `Ko‘pi bilan ${MAX_PHOTOS} ta rasm. Avval birini o‘chiring`);
      run("UPDATE listings SET photos=? WHERE id=?", JSON.stringify([...photos, file]), lid);
      return hostListing(ownListing(key, lid));
    },
    /** The first photo is the cover. The caller deletes the file itself. */
    removePhoto(key, lid, file) {
      const { photos } = ownListing(key, lid);
      if (!photos.includes(file)) throw notFound("Rasm topilmadi");
      run("UPDATE listings SET photos=? WHERE id=?", JSON.stringify(photos.filter((x) => x !== file)), lid);
      return hostListing(ownListing(key, lid));
    },
    coverPhoto(key, lid, file) {
      const { photos } = ownListing(key, lid);
      if (!photos.includes(file)) throw notFound("Rasm topilmadi");
      run("UPDATE listings SET photos=? WHERE id=?", JSON.stringify([file, ...photos.filter((x) => x !== file)]), lid);
      return hostListing(ownListing(key, lid));
    },
    publish(key, lid) {
      const l = ownListing(key, lid), gaps = missing(l);
      if (gaps.length) throw new AppError(409, gaps.map((g) => g.text).join(" "));
      const p = biz.planOf(authHost(key));
      if (l.status !== "published" && p.listings != null && p.used >= p.listings) throw new AppError(409, `Bepul tarifda ${p.listings} ta taklif sotiladi. Birini to‘xtating yoki Pro tarifga o‘ting`, "plan");
      run("UPDATE listings SET status='published', published_at=COALESCE(published_at, ?) WHERE id=?", now(), lid);
      return hostListing(ownListing(key, lid));
    },
    /** Hidden from search. Bookings already made stay valid. */
    pause(key, lid) { ownListing(key, lid); run("UPDATE listings SET status='paused' WHERE id=? AND status='published'", lid); return hostListing(ownListing(key, lid)); },
    deleteDraft(key, lid) {
      const l = ownListing(key, lid);
      if (l.status !== "draft") throw new AppError(409, "Faqat qoralamani o‘chirish mumkin. Sotuvdagi taklifni to‘xtating");
      run("DELETE FROM slot_rules WHERE listing_id=?", lid);
      run("DELETE FROM views WHERE listing_id=?", lid);
      run("DELETE FROM listings WHERE id=?", lid);
      return { photos: l.photos };
    },

    search({ region, category, date, guests, lang: lg, source = "web", log = true }) {
      const r = known(REGIONS, region), c = known(CATEGORIES, category);
      const n = Number.isInteger(guests) && guests > 0 ? guests : 1;
      let rows = all(`${LISTING} WHERE l.status='published' AND (? IS NULL OR l.region=?) AND (? IS NULL OR l.category=?) AND l.capacity >= ? ORDER BY l.published_at DESC`, r, r, c, c, n).map(full);
      if (isDate(date)) rows = rows.filter((l) => slots(l, date, 1).some((d) => d.times.some((t) => t.free >= n)));
      // Only a search that names a region or an activity says something about demand.
      if (log && (r || c)) run("INSERT INTO searches (region,category,results,lang,source,created_at,for_date,guests) VALUES (?,?,?,?,?,?,?,?)", r, c, rows.length, lang(lg), source, now(), isDate(date) ? date : null, n > 1 ? n : null);
      return rows.map(publicListing);
    },
    listing(lid) {
      const l = published(lid);
      const reviews = all(`SELECT r.rating, r.text, r.lang, r.created_at, b.guest_name FROM reviews r JOIN bookings b ON b.id=r.booking_id WHERE r.listing_id=? ORDER BY r.created_at DESC LIMIT 20`, l.id)
        .map(({ guest_name, created_at, ...r }) => ({ ...r, date: created_at.slice(0, 10), by: `${[...guest_name][0].toUpperCase()}.` })); // initial only
      return { ...publicListing(l), reviewList: reviews };
    },
    availability(lid, from, days = 21) {
      const today = tashkentNow().slice(0, 10);
      return slots(published(lid), isDate(from) && from > today ? from : today, Math.min(60, Math.max(1, days | 0)));
    },
    hotel: (code) => one("SELECT * FROM hotels WHERE code=?", String(code ?? "")) ?? null,
    hotels: () => all("SELECT * FROM hotels ORDER BY name"),

    // ---- bookings ----------------------------------------------------------------------------
    book(p) {
      const l = published(p.listing_id);
      const { date } = p, time = String(p.time ?? "");
      if (!isDate(date)) throw bad("Sana noto‘g‘ri");
      const clock = tashkentNow();
      if (`${date}T${time}` <= clock.slice(0, 16)) throw new AppError(400, "Bu vaqt o‘tib ketgan", "past");
      if (date > addDays(clock.slice(0, 10), 365)) throw bad("Sana bir yildan uzoq");
      if (!openOn(l, date) || !l.times.includes(time)) throw new AppError(409, "Mezbon bu vaqtda ishlamaydi", "closed");
      const rule = one("SELECT capacity FROM slot_rules WHERE listing_id=? AND date=? AND time=?", l.id, date, time)?.capacity ?? 0;
      const guests = int(p.guests, "Mehmonlar soni", 1, Math.max(l.capacity, rule));
      const name = str(p.guest_name, "Ism", 80);
      const hotel = core.hotel(p.hotel_code);
      const channel = p.source === "ai" ? "ai" : hotel ? "hotel" : "web";
      const s = split(l.price_uzs * guests, channel, effectivePlan({ plan: l.host_plan, plan_until: l.host_plan_until }));
      const b = { id: id("b_"), token: secret() };
      db.exec("BEGIN IMMEDIATE");
      try {
        const free = slots(l, date, 1)[0]?.times.find((t) => t.time === time)?.free ?? 0;
        if (free < guests) throw new AppError(409, "Bu vaqtda joy yetarli emas", "full");
        run(`INSERT INTO bookings (id,token,listing_id,date,time,guests,guest_name,lang,channel,hotel_code,status,total_uzs,platform_uzs,hotel_uzs,host_uzs,created_at,expires_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?)`,
          b.id, b.token, l.id, date, time, guests, name, lang(p.lang), channel, channel === "hotel" ? hotel.code : null,
          s.total, s.platform, s.hotel, s.host, now(), new Date(Date.now() + HOLD_MIN * 60e3).toISOString());
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      return core.guestBooking(b.token);
    },

    bookingId: (token) => guestOwn(token).id,
    guestBooking(token) {
      const b = guestOwn(token);
      return {
        token: b.token, listing_id: b.listing_id, i18n: b.i18n, place: b.place, region: b.region, category: b.category, photo: b.photo, duration_min: b.duration_min,
        date: b.date, time: b.time, guests: b.guests, guest_name: b.guest_name, lang: b.lang, channel: b.channel, hotel: b.hotel_name,
        status: isExpired(b) ? "expired" : b.status, expires_at: b.status === "pending" ? b.expires_at : null,
        total_uzs: b.total_uzs, platform_uzs: b.platform_uzs, hotel_uzs: b.hotel_uzs, host_uzs: b.host_uzs,
        ticket: b.status === "confirmed" ? { code: b.ticket_code, used_at: b.checked_in_at } : null,
        can_cancel: canCancel(b), can_move: b.status !== "pending" && canCancel(b), can_review: canReview(b), my_rating: b.review_rating, messages: msgs(b.id),
      };
    },

    /** Sandbox only: marks the booking paid. A licensed payment partner's callback replaces this. */
    payTest(token) {
      const b = guestOwn(token);
      if (isExpired(b)) throw new AppError(410, "Bron muddati tugagan", "expired");
      const r = run("UPDATE bookings SET status='paid', expires_at=NULL WHERE id=? AND status='pending' AND expires_at > ?", b.id, now());
      if (r.changes) notify(b.host_id, { type: "booking", id: b.id });
      return core.guestBooking(token);
    },

    /** Free cancellation up to CANCEL_HOURS before the start. */
    cancel(token) {
      const b = guestOwn(token);
      if (!canCancel(b)) throw new AppError(409, "Bekor qilish muddati o‘tgan", "cancel");
      const r = run("UPDATE bookings SET status='cancelled' WHERE id=? AND status=?", b.id, b.status);
      if (r.changes && b.status !== "pending") notify(b.host_id, { type: "cancelled", id: b.id });
      return core.guestBooking(token);
    },

    /** Moves a paid or confirmed booking to another open slot at the same price. The provider approves it again and a new ticket is issued. */
    reschedule(token, p) {
      const b = guestOwn(token), date = p.date, time = String(p.time ?? "");
      if (b.status === "pending" || !canCancel(b)) throw new AppError(409, "Ko‘chirish muddati o‘tgan", "cancel");
      if (!isDate(date)) throw bad("Sana noto‘g‘ri");
      if (date === b.date && time === b.time) throw bad("Boshqa vaqtni tanlang");
      if (`${date}T${time}` <= tashkentNow().slice(0, 16)) throw new AppError(400, "Bu vaqt o‘tib ketgan", "past");
      if (date > addDays(tashkentNow().slice(0, 10), 365)) throw bad("Sana bir yildan uzoq");
      const l = published(b.listing_id);
      if (!openOn(l, date) || !l.times.includes(time)) throw new AppError(409, "Mezbon bu vaqtda ishlamaydi", "closed");
      db.exec("BEGIN IMMEDIATE");
      try {
        const free = slots(l, date, 1)[0]?.times.find((t) => t.time === time)?.free ?? 0;
        if (free < b.guests) throw new AppError(409, "Bu vaqtda joy yetarli emas", "full");
        const r = run("UPDATE bookings SET date=?, time=?, status='paid', ticket_code=NULL, reminded_at=NULL, moved_at=? WHERE id=? AND status=? AND checked_in_at IS NULL", date, time, now(), b.id, b.status);
        if (!r.changes) throw new AppError(409, "Bron holati o‘zgargan", "state");
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      notify(b.host_id, { type: "moved", id: b.id });
      return core.guestBooking(token);
    },

    review(token, p) {
      const b = guestOwn(token);
      if (!canReview(b)) throw new AppError(409, "Baho tashrifdan keyin bir marta qo‘yiladi", "review");
      const rating = int(p.rating, "Baho", 1, 5);
      const text = p.text ? str(p.text, "Izoh", 600) : null;
      run("INSERT INTO reviews (booking_id,listing_id,rating,text,lang,created_at) VALUES (?,?,?,?,?,?)", b.id, b.listing_id, rating, text, b.lang, now());
      return core.guestBooking(token);
    },

    decide(key, bid, accept) {
      const h = authHost(key);
      const b = booking("id", bid);
      if (!b || b.host_id !== h.id) throw notFound("Bron topilmadi");
      const r = run("UPDATE bookings SET status=?, ticket_code=? WHERE id=? AND status='paid'", accept ? "confirmed" : "declined", accept ? newTicketCode() : null, bid);
      if (!r.changes) throw new AppError(409, "Bron holati allaqachon o‘zgargan", "state");
      notifyGuest(b, accept ? "confirmed" : "declined");
      return core.hostHome(key);
    },

    async message(sender, auth, p) {
      const hostId = sender === "host" ? authHost(auth).id : null;
      const b = sender === "guest" ? guestOwn(auth) : booking("id", p.booking_id);
      if (!b || (hostId && b.host_id !== hostId)) throw notFound("Bron topilmadi");
      if (!["paid", "confirmed"].includes(b.status)) throw new AppError(409, "Yozishma to‘lovdan keyin ochiladi", "state");
      const [from, to] = sender === "guest" ? [b.lang, "uz"] : ["uz", b.lang];
      const t = await translate({ text: p.code ? null : str(p.text, "Xabar", 1000), code: p.code, from, to });
      if (!t.original) throw bad("Xabar kerak");
      run("INSERT INTO messages (booking_id,sender,original,lang,translated,translated_lang,engine,created_at) VALUES (?,?,?,?,?,?,?,?)",
        b.id, sender, t.original, from, t.translated, to, t.engine, now());
      if (sender === "guest") notify(b.host_id, { type: "message", id: b.id });
      else notifyGuest(b, "message", t.translated);
      return msgs(b.id);
    },

    /** Confirmed visits starting within 24 hours that nobody was reminded of yet. Each is returned once. */
    takeReminders() {
      const clock = tashkentNow().slice(0, 16), limit = tashkentNow(new Date(Date.now() + 24 * 3600e3)).slice(0, 16);
      const ids = all("SELECT id FROM bookings WHERE status='confirmed' AND reminded_at IS NULL AND checked_in_at IS NULL AND date||'T'||time > ? AND date||'T'||time <= ? LIMIT 200", clock, limit);
      return ids.filter(({ id: bid }) => run("UPDATE bookings SET reminded_at=? WHERE id=? AND reminded_at IS NULL", now(), bid).changes).map(({ id: bid }) => booking("id", bid));
    },

    /** iCalendar file for a paid or confirmed booking. */
    calendar(token) {
      const b = guestOwn(token);
      if (!["paid", "confirmed"].includes(b.status)) throw new AppError(409, "Bron faol emas", "state");
      const stamp = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");
      const esc = (s) => s.replace(/[\\;,]/g, "\\$&").replace(/\r?\n/g, "\\n");
      const start = startsAt(b.date, b.time), end = new Date(+start + (b.duration_min ?? 60) * 60e3);
      return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SilkRoad Experience OS//EN", "BEGIN:VEVENT", `UID:${b.id}@mezbon`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`,
        `SUMMARY:${esc(b.i18n[b.lang].title)}`, `LOCATION:${esc(`${b.place ?? REGIONS[b.region]}, Uzbekistan`)}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
    },

    // ---- analytics and feed ------------------------------------------------------------------
    panel({ days = 0, demo = true } = {}) {
      const since = days > 0 ? new Date(Date.now() - days * 864e5).toISOString() : "";
      const noDemo = demo ? "" : "AND demo=0";
      const supply = Object.fromEntries(all("SELECT region, COUNT(*) n FROM listings WHERE status='published' GROUP BY region").map((r) => [r.region, r.n]));
      const group = (col) => Object.fromEntries(all(`SELECT ${col} k, COUNT(*) n, SUM(results=0) unmet FROM searches WHERE ${col} IS NOT NULL AND created_at >= ? ${noDemo} GROUP BY ${col}`, since).map((r) => [r.k, r]));
      const byRegion = group("region"), byCategory = group("category");
      const rank = (a, b) => b.unmet - a.unmet || b.searches - a.searches;
      return {
        totals: one(`SELECT COUNT(*) bookings, COALESCE(SUM(guests),0) guests, COALESCE(SUM(total_uzs),0) gmv,
          COALESCE(SUM(host_uzs),0) host, COALESCE(SUM(hotel_uzs),0) hotel, COALESCE(SUM(platform_uzs),0) platform FROM bookings WHERE ${PAID} AND created_at >= ?`, since),
        hosts: one("SELECT COUNT(DISTINCT host_id) n FROM listings WHERE status='published'").n,
        listings: one("SELECT COUNT(*) n FROM listings WHERE status='published'").n,
        channels: all(`SELECT channel, COUNT(*) n, SUM(total_uzs) gmv FROM bookings WHERE ${PAID} AND created_at >= ? GROUP BY channel ORDER BY n DESC`, since),
        regions: Object.keys(REGIONS).map((k) => ({ region: k, name: REGIONS[k], listings: supply[k] ?? 0, searches: byRegion[k]?.n ?? 0, unmet: byRegion[k]?.unmet ?? 0 })).sort(rank),
        categories: Object.keys(CATEGORIES).map((k) => ({ category: k, name: CATEGORIES[k].uz, searches: byCategory[k]?.n ?? 0, unmet: byCategory[k]?.unmet ?? 0 })).filter((x) => x.searches).sort(rank),
        platform: biz.platform(),
        dates: all(`SELECT for_date date, COUNT(*) n, SUM(results=0) unmet FROM searches WHERE for_date >= ? AND created_at >= ? ${noDemo} GROUP BY for_date ORDER BY n DESC, for_date LIMIT 10`, tashkentNow().slice(0, 10), since),
        languages: all(`SELECT lang, COUNT(*) n, SUM(results=0) unmet FROM searches WHERE demo=0 AND created_at >= ? GROUP BY lang ORDER BY n DESC LIMIT 10`, since),
        demoSearches: demo ? one("SELECT COUNT(*) n FROM searches WHERE demo=1 AND created_at >= ?", since).n : 0,
      };
    },

    /** Neutral channel feed: what a distribution partner would import. */
    feed: () => ({
      generated_at: now(), currency: "UZS",
      products: all(`${LISTING} WHERE l.status='published'`).map(full).map(publicListing).map((l) => ({
        external_id: l.id, title: l.i18n.en.title, description: l.i18n.en.description, languages: Object.keys(l.i18n), category: l.category,
        region: l.region, retail_price: l.price_uzs, duration_minutes: l.duration_min, max_participants: l.capacity, rating: l.rating, review_count: l.reviews,
        availability: { iso_weekdays: l.weekdays, start_times: l.times, timezone: "Asia/Tashkent" }, sample: l.demo,
      })),
    }),
  };
  for (const k of Object.keys(biz)) if (core[k] !== biz[k]) throw new Error(`Two core functions are named ${k}`);
  const helper = createAssistant({ core, one, run, today: () => tashkentNow().slice(0, 10), tashkentNow, addDays, isDate, fail: (s, m, c) => new AppError(s, m, c) });
  for (const k of Object.keys(helper)) if (k in core) throw new Error(`Two core functions are named ${k}`);
  return Object.assign(core, helper);
}
