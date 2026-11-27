// Listings: drafting, editing, photos, publishing, search and the partner feed.
import { buildListing } from "../ai/claude.mjs";
import { missing, templateI18n } from "../ai/extract.mjs";
import { CATEGORIES, LANGS, REGIONS } from "../lib/i18n.mjs";
import { bad, fail, id, int, isDate, known, lang, notFound, str, today } from "../lib/util.mjs";
import { cleanExtras, cleanPricing, unitPrice } from "./pricing.mjs";

export const MAX_PHOTOS = 6;
const OPEN = "l.status='published' AND h.suspended_at IS NULL";
/** Shown to everyone. A listing can also be open by its link only. */
export const ON_SALE = `${OPEN} AND NOT l.unlisted`;
const LISTING = `SELECT l.*, h.name host_name, h.demo host_demo, h.type host_type, h.plan host_plan, h.plan_until host_plan_until, h.verified_at host_verified,
  (SELECT AVG(rating) FROM reviews WHERE listing_id=l.id AND hidden_at IS NULL) rating, (SELECT COUNT(*) FROM reviews WHERE listing_id=l.id AND hidden_at IS NULL) review_count,
  (SELECT COALESCE(SUM(guests),0) FROM bookings WHERE listing_id=l.id AND checked_in_at IS NOT NULL) hosted
  FROM listings l JOIN hosts h ON h.id = l.host_id`;

export const publicListing = (r) => ({
  id: r.id, host_id: r.host_id, category: r.category, region: r.region, place: r.place, price_uzs: r.price_uzs, duration_min: r.duration_min,
  capacity: r.capacity, weekdays: r.weekdays, times: r.times, i18n: r.i18n, photo: r.photos[0] ?? null, photos: r.photos, hosted: r.hosted, pricing: r.pricing, extras: r.extras, instant: r.instant, promoted: Boolean(r.promoted_until && new Date(r.promoted_until) > new Date()),
  host: r.host_name, host_type: r.host_type, verified: Boolean(r.host_verified), demo: r.host_demo,
  rating: r.rating == null ? null : Math.round(r.rating * 10) / 10, reviews: r.review_count,
});
export const hostListing = (r) => ({ ...publicListing(r), status: r.status, cert_no: r.cert_no, address: r.address, lat: r.lat, lng: r.lng, transcript: r.transcript, engine: r.engine, edited: r.edited, closed: r.closed, resell: r.resell, promoted_until: r.promoted_until, missing: missing(r) });

/** How far ahead a card looks for the next free time. */
const LOOK_AHEAD = 14;
/** The first time with room for `guests`, and what it costs then. */
function nextSlot(l, days, guests) {
  for (const d of days ?? []) for (const t of d.times) if (t.free >= guests) { const { unit, before, why, pct } = unitPrice(l, d.date, t.time, guests); return { date: d.date, time: t.time, free: t.free, unit, before, why, pct }; }
  return null;
}

export function createCatalog({ db, accounts, plans, events }) {
  const ownListings = (hostId) => db.all(`${LISTING} WHERE l.host_id=? ORDER BY l.created_at DESC, l.id`, hostId);
  async function ownListing(credential, lid) {
    const h = await accounts.authHost(credential);
    const l = await db.one(`${LISTING} WHERE l.id=? AND l.host_id=?`, String(lid ?? ""), h.id);
    if (!l) throw notFound("Taklif topilmadi");
    return l;
  }
  async function published(lid) {
    const l = await db.one(`${LISTING} WHERE l.id=? AND ${OPEN}`, String(lid ?? ""));
    if (!l) throw notFound("Taklif topilmadi");
    return l;
  }
  const setPhotos = (lid, photos) => db.run("UPDATE listings SET photos=? WHERE id=?", JSON.stringify(photos), lid);
  /** Reads and changes a listing as one step, so two phones cannot overwrite each other's photos. */
  const change = (credential, lid, fn) => db.tx(async () => {
    const own = await ownListing(credential, lid);
    await db.one("SELECT id FROM listings WHERE id=? FOR UPDATE", own.id);
    const l = await ownListing(credential, lid);
    await fn(l);
    const now = await ownListing(credential, lid);
    if (l.status !== "draft" || now.status !== "draft") events.emit("listing", { listing: own.id });
    return hostListing(now);
  });

  const api = {
    ownListing, ownListings, published,
    async createDraft(credential, transcript) {
      const h = await accounts.authHost(credential);
      const text = str(transcript, "Matn", 4000);
      if ((await db.one("SELECT COUNT(*) n FROM listings WHERE host_id=?", h.id)).n >= 50) throw fail(409, "Ko‘pi bilan 50 ta taklif saqlanadi. Keraksiz qoralamalarni o‘chiring");
      const { facts, i18n, engine, note } = await buildListing(text, h.name);
      const lid = id("l_");
      await db.run(`INSERT INTO listings (id,host_id,status,category,region,place,price_uzs,duration_min,capacity,weekdays,times,transcript,i18n,engine)
        VALUES (?,?,'draft',?,?,?,?,?,?,?,?,?,?,?)`,
        lid, h.id, facts.category, facts.region, facts.place, facts.price_uzs, facts.duration_min, facts.capacity,
        JSON.stringify([1, 2, 3, 4, 5, 6]), JSON.stringify(["10:00", "15:00"]), text, JSON.stringify(i18n), engine);
      return { ...hostListing(await ownListing(credential, lid)), note };
    },

    updateListing: (credential, lid, p) => change(credential, lid, async (l) => {
      const n = { ...l, i18n: { ...l.i18n }, edited: [...l.edited] };
      if ("category" in p) { if (!known(CATEGORIES, p.category)) throw bad("Mashg‘ulot turi noto‘g‘ri"); n.category = p.category; }
      if ("region" in p) { if (!known(REGIONS, p.region)) throw bad("Viloyat noto‘g‘ri"); n.region = p.region; }
      if ("place" in p) n.place = p.place ? str(p.place, "Joy", 60) : null;
      if ("price_uzs" in p) n.price_uzs = int(p.price_uzs, "Narx", 1000, 100_000_000);
      if ("duration_min" in p) n.duration_min = int(p.duration_min, "Davomiylik", 15, 720);
      if ("capacity" in p) n.capacity = int(p.capacity, "Mehmonlar soni", 1, 100);
      if ("address" in p) n.address = p.address ? str(p.address, "Manzil", 200) : null;
      if ("point" in p) {
        const { lat, lng } = p.point ?? {};
        if (p.point && !(Number.isFinite(lat) && Number.isFinite(lng) && lat >= 37 && lat <= 46 && lng >= 55 && lng <= 74)) throw bad("Nuqta O‘zbekiston hududida bo‘lsin");
        [n.lat, n.lng] = p.point ? [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5] : [null, null];
      }
      if ("pricing" in p) n.pricing = cleanPricing(p.pricing);
      if ("extras" in p) n.extras = cleanExtras(p.extras);
      if ("resell" in p) n.resell = p.resell === true;
      if ("instant" in p) n.instant = p.instant === true;
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
      await db.run("UPDATE listings SET category=?,region=?,place=?,price_uzs=?,duration_min=?,capacity=?,cert_no=?,weekdays=?,times=?,closed=?,i18n=?,edited=?,address=?,lat=?,lng=?,pricing=?,extras=?,resell=?,instant=? WHERE id=?",
        n.category, n.region, n.place, n.price_uzs, n.duration_min, n.capacity, n.cert_no ?? null, JSON.stringify(n.weekdays), JSON.stringify(n.times), JSON.stringify(n.closed), JSON.stringify(n.i18n), JSON.stringify(n.edited), n.address, n.lat, n.lng, JSON.stringify(n.pricing), JSON.stringify(n.extras), n.resell, n.instant, l.id);
    }),

    addPhoto: (credential, lid, file) => change(credential, lid, async ({ id: lid_, photos }) => {
      if (photos.length >= MAX_PHOTOS) throw fail(409, `Ko‘pi bilan ${MAX_PHOTOS} ta rasm. Avval birini o‘chiring`);
      await setPhotos(lid_, [...photos, file]);
    }),
    /** The first photo is the cover. The caller deletes the file itself. */
    removePhoto: (credential, lid, file) => change(credential, lid, async ({ id: lid_, photos }) => {
      if (!photos.includes(file)) throw notFound("Rasm topilmadi");
      await setPhotos(lid_, photos.filter((x) => x !== file));
    }),
    coverPhoto: (credential, lid, file) => change(credential, lid, async ({ id: lid_, photos }) => {
      if (!photos.includes(file)) throw notFound("Rasm topilmadi");
      await setPhotos(lid_, [file, ...photos.filter((x) => x !== file)]);
    }),
    publish: (credential, lid) => change(credential, lid, async (l) => {
      const h = await accounts.authHost(credential), gaps = missing(l);
      if (gaps.length) throw fail(409, gaps.map((g) => g.text).join(" "));
      if (h.suspended_at) throw fail(403, "Hisobingiz to‘xtatilgan. Ma’muriyatga murojaat qiling", "suspended");
      if (l.status === "blocked") throw fail(403, "Ma’muriyat bu taklifni to‘xtatgan", "suspended");
      await db.one("SELECT id FROM hosts WHERE id=? FOR UPDATE", h.id); // two phones publishing at once share one limit
      const p = await plans.planOf(h);
      if (l.status !== "published" && p.listings != null && p.used >= p.listings) throw fail(409, `Bepul tarifda ${p.listings} ta taklif sotiladi. Birini to‘xtating yoki Pro tarifga o‘ting`, "plan");
      await db.run("UPDATE listings SET status='published', published_at=COALESCE(published_at, now()) WHERE id=?", l.id);
    }),
    /** Hidden from search. Bookings already made stay valid. */
    pause: (credential, lid) => change(credential, lid, (l) => db.run("UPDATE listings SET status='paused' WHERE id=? AND status='published'", l.id)),
    async deleteDraft(credential, lid) {
      const l = await ownListing(credential, lid);
      const r = l.status === "draft" && (await db.run("DELETE FROM listings WHERE id=? AND status='draft'", l.id)).changes;
      if (!r) throw fail(409, "Faqat qoralamani o‘chirish mumkin. Sotuvdagi taklifni to‘xtating");
      return { photos: l.photos };
    },

    /** `open(rows, from, days)` gives the free places of many listings; it is passed in so this module does not depend on availability. */
    async search({ region, category, date, guests, lang: lg, source = "web", log = true }, open) {
      const r = known(REGIONS, region), c = known(CATEGORIES, category), d = isDate(date) ? date : null;
      const n = Number.isInteger(guests) && guests > 0 ? Math.min(guests, 1000) : 1;
      let rows = await db.all(`${LISTING} WHERE ${ON_SALE} AND (?::text IS NULL OR l.region=?) AND (?::text IS NULL OR l.category=?) AND l.capacity >= ? ORDER BY l.published_at DESC, l.id LIMIT 200`, r, r, c, c, n);
      const at = rows.length ? await open(rows, d ?? today(), d ? 1 : LOOK_AHEAD) : new Map(), next = new Map(rows.map((l) => [l.id, nextSlot(l, at.get(l.id), n)]));
      if (d) rows = rows.filter((l) => next.get(l.id));
      // Only a search that names a region or an activity says something about demand.
      if (log && (r || c)) { await db.run("INSERT INTO searches (region,category,results,lang,source,for_date,guests) VALUES (?,?,?,?,?,?,?)", r, c, rows.length, lang(lg), source, d, n > 1 ? n : null); events.emit("numbers"); }
      return rows.map((l) => ({ ...publicListing(l), next: next.get(l.id) }));
    },
    /** Only the next free time of some listings: what a card on screen needs after a change. */
    async nextTimes(ids, { date, guests } = {}, open) {
      const list = [...new Set(ids)].filter((x) => /^[\w-]{1,64}$/.test(x)).slice(0, 60), d = isDate(date) ? date : null, n = Number.isInteger(guests) && guests > 0 ? Math.min(guests, 1000) : 1;
      const rows = list.length ? await db.all(`SELECT l.* FROM listings l JOIN hosts h ON h.id=l.host_id WHERE ${ON_SALE} AND l.id = ANY(?::text[])`, list) : [];
      const at = rows.length ? await open(rows, d ?? today(), d ? 1 : LOOK_AHEAD) : new Map();
      return Object.fromEntries(rows.map((l) => [l.id, nextSlot(l, at.get(l.id), n)]));
    },
    /** Everything on sale for a group of this size, with the schedule (the trip planner needs it). */
    onSale: (guests) => db.all(`${LISTING} WHERE ${ON_SALE} AND l.capacity >= ? ORDER BY l.published_at DESC, l.id LIMIT 300`, guests),
    async listing(lid) {
      const l = await published(lid);
      const rows = await db.all("SELECT r.rating, r.text, r.lang, r.created_at, b.guest_name FROM reviews r JOIN bookings b ON b.id=r.booking_id WHERE r.listing_id=? AND r.hidden_at IS NULL ORDER BY r.created_at DESC LIMIT 20", l.id);
      return { ...publicListing(l), reviewList: rows.map(({ guest_name, created_at, ...r }) => ({ ...r, date: created_at.slice(0, 10), by: `${[...guest_name][0].toUpperCase()}.` })) }; // initial only
    },
    /** A provider's public page. Only what helps a traveller decide. */
    async provider(hid) {
      const h = await db.one(`SELECT h.id, h.name, h.type, h.verified_at, h.demo, h.created_at FROM hosts h WHERE h.id=? AND h.suspended_at IS NULL AND EXISTS (SELECT 1 FROM listings l WHERE l.host_id=h.id AND l.status='published')`, String(hid));
      if (!h) throw notFound("Mezbon topilmadi");
      const stats = await db.one(`SELECT COUNT(b.decided_at) answered, percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM b.decided_at - b.asked_at)) seconds FROM bookings b JOIN listings l ON l.id=b.listing_id
        WHERE l.host_id=? AND b.decided_at >= b.asked_at AND b.decided_at > now() - interval '180 days'`, h.id);
      const rows = (await db.all(`${LISTING} WHERE l.host_id=? AND ${ON_SALE} ORDER BY l.published_at DESC`, h.id)).map(publicListing), rated = rows.filter((l) => l.reviews), reviews = rated.reduce((s, l) => s + l.reviews, 0);
      return {
        id: h.id, name: h.name, type: h.type, verified: Boolean(h.verified_at), demo: h.demo, since: h.created_at.slice(0, 7), hosted: rows.reduce((s, l) => s + l.hosted, 0), reviews,
        rating: reviews ? Math.round((rated.reduce((s, l) => s + l.rating * l.reviews, 0) / reviews) * 10) / 10 : null,
        reply_hours: stats.answered >= 3 ? Math.max(1, Math.ceil(stats.seconds / 3600)) : null, listings: rows,
      };
    },
    async report(lid, { reason, details } = {}) {
      const l = await published(lid);
      if (!["unsafe", "false", "offensive", "other"].includes(reason)) throw bad("Sabab noto‘g‘ri");
      await db.run("INSERT INTO reports (listing_id,reason,details) VALUES (?,?,?)", l.id, reason, details ? str(details, "Izoh", 600) : null);
      return { ok: true };
    },
    hotel: async (code) => (typeof code === "string" && code.length <= 64 ? (await db.one("SELECT * FROM hotels WHERE code=?", code.replace(/\u0000/g, ""))) ?? null : null),
    hotels: () => db.all("SELECT * FROM hotels ORDER BY name"),

    /** Neutral channel feed: what a distribution partner would import. */
    feed: async () => ({
      generated_at: new Date().toISOString(), currency: "UZS",
      products: (await db.all(`${LISTING} WHERE ${ON_SALE} ORDER BY l.id`)).map(publicListing).map((l) => ({
        external_id: l.id, title: l.i18n.en.title, description: l.i18n.en.description, languages: Object.keys(l.i18n), category: l.category,
        region: l.region, retail_price: l.price_uzs, duration_minutes: l.duration_min, max_participants: l.capacity, rating: l.rating, review_count: l.reviews,
        availability: { iso_weekdays: l.weekdays, start_times: l.times, timezone: "Asia/Tashkent" }, sample: l.demo,
      })),
    }),
  };
  return api;
}
