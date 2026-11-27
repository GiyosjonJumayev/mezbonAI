// Resellers: travel agencies, hotels, other booking sites and apps that sell our providers' offers through the OCTO standard.
// They see only offers whose provider allowed resale, and pay for what they sell on a monthly statement.
import { randomUUID } from "node:crypto";
import { LANGS } from "../lib/i18n.mjs";
import { addDays, fail, id, isDate, secret, sha256, str, today } from "../lib/util.mjs";
import { cleanEmail, cleanPhone } from "./mail.mjs";
import { ON_SALE } from "./catalog.mjs";
import { unitPrice } from "./pricing.mjs";

/** OCTO answers every problem with HTTP 400 and a code. */
export const octoError = (error, errorMessage, extra = {}) => Object.assign(fail(400, errorMessage, error), { octo: { error, errorMessage, ...extra } });
const TZ = "+05:00", HOLD_MAX = 30, LOOK_MAX = 90, UNIT = "adult", OPTION = "DEFAULT";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plus = (date, time, min) => { const d = new Date(Date.parse(`${date}T${time}:00${TZ}`) + min * 60e3 + 5 * 3600e3); return d.toISOString().slice(0, 16) + TZ; };

export function createResellers({ db, audit, catalog, availability, bookings, payments }) {
  const offer = async (pid) => {
    const l = typeof pid === "string" ? await db.one(`SELECT l.* FROM listings l JOIN hosts h ON h.id=l.host_id WHERE ${ON_SALE} AND l.resell AND l.id=?`, pid) : null;
    if (!l) throw octoError("INVALID_PRODUCT_ID", "The Product ID was invalid or missing", { productId: pid ?? null });
    return l;
  };
  const option = (body) => { if (body.optionId !== OPTION) throw octoError("INVALID_OPTION_ID", "The Option ID was invalid or missing", { optionId: body.optionId ?? null }); };
  /** How many people. Every unit is a person of the one unit type. */
  const people = (items, key = "unitId") => {
    if (!Array.isArray(items) || !items.length) throw octoError("BAD_REQUEST", "unitItems are required");
    for (const u of items) if (u?.[key] !== UNIT) throw octoError("INVALID_UNIT_ID", "The Unit ID was invalid or missing", { unitId: u?.[key] ?? null });
    return items.length;
  };
  const count = (units) => (Array.isArray(units) ? units.reduce((n, u) => { if (u?.id !== UNIT) throw octoError("INVALID_UNIT_ID", "The Unit ID was invalid or missing", { unitId: u?.id ?? null }); return n + Math.max(0, u.quantity | 0); }, 0) : 0);
  const money = (n, r, pricing) => pricing && { original: n, retail: n, net: n - Math.round((n * r.pct) / 100), currency: "UZS", currencyPrecision: 0, includedTaxes: [] };

  function product(l, r, pricing) {
    const unit = { id: UNIT, internalName: "Person", reference: null, type: "ADULT", title: "Person", restrictions: { minAge: 0, maxAge: 120, idRequired: false, minQuantity: null, maxQuantity: l.capacity, paxCount: 1, accompaniedBy: [] }, requiredContactFields: [], ...(pricing && { pricingFrom: [money(l.price_uzs, r, true)] }) };
    return {
      id: l.id, internalName: l.i18n.en.title, reference: null, locale: "en", timeZone: "Asia/Tashkent", allowFreesale: false, instantConfirmation: l.instant, instantDelivery: false, availabilityRequired: true,
      availabilityType: "START_TIME", deliveryFormats: ["QRCODE"], deliveryMethods: ["TICKET"], redemptionMethod: "DIGITAL", title: l.i18n.en.title, shortDescription: null, description: l.i18n.en.description,
      durationMinutesFrom: l.duration_min, durationMinutesTo: l.duration_min, ...(pricing && { defaultCurrency: "UZS", availableCurrencies: ["UZS"], pricingPer: "UNIT" }),
      options: [{ id: OPTION, default: true, internalName: "Default", reference: null, availabilityLocalStartTimes: l.times, cancellationCutoff: "24 hours", cancellationCutoffAmount: 24, cancellationCutoffUnit: "hour",
        requiredContactFields: ["firstName", "lastName"], restrictions: { minUnits: 1, maxUnits: l.capacity }, units: [unit] }],
    };
  }
  function slot(l, date, t, r, pricing, n) {
    const status = !t.free ? "SOLD_OUT" : t.free < l.capacity / 2 ? "LIMITED" : "AVAILABLE", start = `${date}T${t.time}${TZ}`, p = unitPrice(l, date, t.time, Math.max(1, n));
    return { id: start, localDateTimeStart: start, localDateTimeEnd: plus(date, t.time, l.duration_min), utcCutoffAt: new Date(Date.parse(start)).toISOString(), allDay: false, available: t.free >= Math.max(1, n), status, vacancies: t.free, capacity: l.capacity, maxUnits: t.free, openingHours: [],
      ...(pricing && { unitPricing: [{ unitId: UNIT, ...money(p.unit, r, true) }] }) };
  }
  const range = (b) => {
    const from = isDate(b.localDateStart) ? b.localDateStart : today(), to = isDate(b.localDateEnd) ? b.localDateEnd : from;
    if (to < from) throw octoError("BAD_REQUEST", "localDateEnd is before localDateStart");
    const start = from < today() ? today() : from, days = Math.round((Date.parse(to) - Date.parse(start)) / 864e5) + 1;
    return { start, days: Math.min(LOOK_MAX, Math.max(0, days)) };
  };

  // ---- the booking as OCTO sees it -------------------------------------------------------------------
  const ROW = "SELECT b.*, l.i18n, l.duration_min, l.capacity, l.price_uzs, l.pricing FROM bookings b JOIN listings l ON l.id=b.listing_id";
  async function own(r, uuid) {
    const b = typeof uuid === "string" ? await db.one(`${ROW} WHERE b.reseller_id=? AND b.reseller_uuid=?`, r.id, uuid) : null;
    if (!b) throw octoError("INVALID_BOOKING_UUID", "The Booking UUID was invalid or missing", { uuid: uuid ?? null });
    return b;
  }
  function view(b, r, pricing) {
    const expired = b.status === "pending" && b.expires_at <= new Date().toISOString();
    const status = expired ? "EXPIRED" : b.status === "pending" ? "ON_HOLD" : b.status === "paid" ? "PENDING" : b.status === "declined" ? "REJECTED" : b.status === "cancelled" ? "CANCELLED" : b.checked_in_at ? "REDEEMED" : "CONFIRMED";
    const ticket = b.status === "confirmed" && b.ticket_code ? { redemptionMethod: "DIGITAL", utcRedeemedAt: b.checked_in_at, deliveryOptions: [{ deliveryFormat: "QRCODE", deliveryValue: b.ticket_code }] } : null;
    const [first, ...rest] = b.guest_name.split(/\s+/), contact = { fullName: b.guest_name, firstName: first, lastName: rest.join(" ") || null, emailAddress: b.guest_email, phoneNumber: b.guest_phone, postalCode: null, country: null, notes: null, locales: [b.lang] };
    const start = `${b.date}T${b.time}${TZ}`, can = ["pending", "paid", "confirmed"].includes(b.status) && !expired && !b.checked_in_at && (b.status === "pending" || Date.parse(start) - Date.now() >= 24 * 3600e3);
    return {
      id: b.id, uuid: b.reseller_uuid, testMode: false, resellerReference: b.reseller_ref, supplierReference: b.id, status,
      utcCreatedAt: b.created_at, utcUpdatedAt: b.created_at, utcExpiresAt: b.status === "pending" ? b.expires_at : null, utcRedeemedAt: b.checked_in_at, utcConfirmedAt: b.decided_at && b.status !== "declined" ? b.decided_at : null,
      productId: b.listing_id, optionId: OPTION, cancellable: can, cancellation: b.status === "cancelled" ? { refund: "FULL", reason: null, utcCancelledAt: b.created_at } : null, freesale: false,
      availabilityId: start, availability: { id: start, localDateTimeStart: start, localDateTimeEnd: plus(b.date, b.time, b.duration_min), allDay: false, openingHours: [] },
      contact, notes: null, deliveryMethods: ["TICKET"], voucher: null,
      unitItems: Array.from({ length: b.guests }, (_, i) => ({ uuid: `${b.reseller_uuid}-${i + 1}`, resellerReference: null, supplierReference: `${b.id}-${i + 1}`, unitId: UNIT, status, utcRedeemedAt: b.checked_in_at, contact, ticket })),
      ...(pricing && { pricing: money(b.total_uzs, r, true) }),
    };
  }

  return {
    // ---- administrators ------------------------------------------------------------------------------
    async createReseller({ name, pct } = {}) {
      const n = str(name, "Nomi", 80);
      if (!Number.isInteger(pct) || pct < 0 || pct > 25) throw fail(400, "Ulush 0–25% bo‘lsin");
      const key = `sr_${secret()}`, rid = id("rs_");
      await db.run("INSERT INTO resellers (id,name,key_hash,pct) VALUES (?,?,?,?)", rid, n, sha256(key), pct);
      await audit("admin", "reseller_created", rid);
      return { id: rid, name: n, pct, key }; // the key is shown once
    },
    async setReseller(rid, { active } = {}) {
      const r = await db.one("UPDATE resellers SET active=? WHERE id=? RETURNING id", Boolean(active), String(rid));
      if (!r) throw fail(404, "Topilmadi", "notfound");
      await audit("admin", active ? "reseller_on" : "reseller_off", r.id);
      return { ok: true };
    },
    /** What each reseller sold, and what it owes: the price minus its share, for sales that were not given back. */
    resellers: () => db.all(`SELECT r.id, r.name, r.pct, r.active, r.created_at,
        COUNT(b.id) FILTER (WHERE b.status IN ('paid','confirmed')) sold, COALESCE(SUM(b.total_uzs) FILTER (WHERE b.status IN ('paid','confirmed')),0) gross,
        COALESCE(SUM(b.total_uzs - b.partner_uzs) FILTER (WHERE b.status IN ('paid','confirmed')),0) owed,
        COALESCE(SUM(b.total_uzs - b.partner_uzs) FILTER (WHERE b.status IN ('paid','confirmed') AND b.created_at >= date_trunc('month', now())),0) AS month
      FROM resellers r LEFT JOIN bookings b ON b.reseller_id=r.id GROUP BY r.id ORDER BY r.created_at DESC`),

    // ---- OCTO --------------------------------------------------------------------------------------
    async reseller(header) {
      const key = /^Bearer (sr_[\w-]{32})$/.exec(header ?? "")?.[1];
      if (!header) throw octoError("UNAUTHORIZED", "No API key was given");
      const r = key && (await db.one("SELECT * FROM resellers WHERE key_hash=? AND active", sha256(key)));
      if (!r) throw octoError("FORBIDDEN", "The API key is not valid or was revoked");
      return r;
    },
    supplier: (publicUrl) => ({ id: "silkroad", name: "SilkRoad Experience OS", endpoint: `${publicUrl}/octo`, contact: { website: publicUrl, email: null, telephone: null, address: "Uzbekistan" }, shortDescription: "Local experiences in Uzbekistan, run by the families and craftspeople who host them." }),
    async products(r, pricing) { return (await db.all(`SELECT l.* FROM listings l JOIN hosts h ON h.id=l.host_id WHERE ${ON_SALE} AND l.resell ORDER BY l.published_at DESC, l.id LIMIT 500`)).map((l) => product(l, r, pricing)); },
    async product(r, pid, pricing) { return product(await offer(pid), r, pricing); },
    async availability(r, body, pricing) {
      const l = await offer(body.productId);
      option(body);
      const n = count(body.units), ids = Array.isArray(body.availabilityIds) ? body.availabilityIds : null;
      const { start, days } = ids ? { start: today(), days: LOOK_MAX } : range(body);
      const out = (await availability.slots(l, start, days)).flatMap((d) => d.times.map((t) => slot(l, d.date, t, r, pricing, n)));
      return ids ? out.filter((a) => ids.includes(a.id)) : out;
    },
    async calendar(r, body, pricing) {
      const l = await offer(body.productId);
      option(body);
      const n = Math.max(1, count(body.units)), { start, days } = range(body), open = new Map((await availability.slots(l, start, days)).map((d) => [d.date, d]));
      return Array.from({ length: days }, (_, i) => {
        const date = addDays(start, i), d = open.get(date), free = d ? d.times.reduce((s, t) => s + t.free, 0) : 0, cap = d ? d.times.length * l.capacity : 0, best = d ? Math.max(0, ...d.times.map((t) => t.free)) : 0;
        return { localDate: date, available: best >= n, status: !d ? "CLOSED" : !free ? "SOLD_OUT" : free < cap / 2 ? "LIMITED" : "AVAILABLE", vacancies: d ? free : null, capacity: d ? cap : null, openingHours: [],
          ...(pricing && d && { unitPricingFrom: [{ unitId: UNIT, ...money(Math.min(...d.times.map((t) => unitPrice(l, date, t.time, n).unit)), r, true) }] }) };
      });
    },
    /** Holds places. Asking again with the same uuid returns the same hold. */
    async reserve(r, body, pricing) {
      const uuid = body.uuid ?? randomUUID();
      if (!UUID.test(uuid)) throw octoError("BAD_REQUEST", "uuid must be a UUID");
      const again = await db.one("SELECT reseller_uuid FROM bookings WHERE reseller_id=? AND reseller_uuid=?", r.id, uuid);
      if (again) return view(await own(r, uuid), r, pricing);
      const l = await offer(body.productId);
      option(body);
      const guests = people(body.unitItems), m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})\+05:00$/.exec(body.availabilityId ?? "");
      if (!m || !l.times.includes(m[2])) throw octoError("INVALID_AVAILABILITY_ID", "The Availability ID was invalid or missing", { availabilityId: body.availabilityId ?? null });
      const hold = Math.min(HOLD_MAX, Math.max(1, Number.isInteger(body.expirationMinutes) ? body.expirationMinutes : HOLD_MAX));
      try { await bookings.book({ listing_id: l.id, date: m[1], time: m[2], guests, guest_name: r.name, lang: "en" }, { reseller: r, uuid, hold }); }
      catch (e) {
        if (e.code === "23505") return view(await own(r, uuid), r, pricing); // the same uuid, at the same moment
        if (["full", "closed", "past"].includes(e.code)) throw octoError("INVALID_AVAILABILITY_ID", "That time is not available", { availabilityId: body.availabilityId });
        throw e.status ? octoError("BAD_REQUEST", e.message) : e;
      }
      return view(await own(r, uuid), r, pricing);
    },
    /** The reseller vouches for the payment; the provider then accepts as with any booking. */
    async confirm(r, uuid, body, pricing) {
      const b = await own(r, uuid);
      if (b.status !== "pending") return view(b, r, pricing); // confirming twice changes nothing
      if (b.expires_at <= new Date().toISOString()) throw octoError("INVALID_BOOKING_UUID", "The hold has expired", { uuid }); // the standard: an expired hold cannot be confirmed
      const c = body.contact ?? {}, name = (c.fullName || [c.firstName, c.lastName].filter(Boolean).join(" ")).trim();
      if (!name || name.length > 80) throw octoError("BAD_REQUEST", "contact.fullName or firstName and lastName are required");
      let email, phone;
      try { email = cleanEmail(c.emailAddress); phone = cleanPhone(c.phoneNumber); } catch (e) { throw octoError("BAD_REQUEST", e.message); }
      const lang = Array.isArray(c.locales) && typeof c.locales[0] === "string" ? c.locales[0].slice(0, 2).toLowerCase() : "en";
      await db.run("UPDATE bookings SET guest_name=?, guest_email=?, guest_phone=?, reseller_ref=?, lang=CASE WHEN ? = ANY(?::text[]) THEN ? ELSE lang END WHERE id=? AND status='pending'",
        name, email, phone, typeof body.resellerReference === "string" ? body.resellerReference.slice(0, 80) : null, lang, LANGS, lang, b.id);
      if (!(await bookings.canPay(b.id))) throw octoError("INVALID_BOOKING_UUID", "The hold has expired", { uuid });
      await payments.settleReseller(b.id, r.id);
      return view(await own(r, uuid), r, pricing);
    },
    async cancel(r, uuid, pricing) {
      const b = await own(r, uuid);
      if (b.status === "cancelled") return view(b, r, pricing);
      try { await bookings.cancel(b.token); } catch (e) { if (e.status === 409) throw octoError("UNPROCESSABLE_ENTITY", "The booking can no longer be cancelled"); throw e; }
      return view(await own(r, uuid), r, pricing);
    },
    get: async (r, uuid, pricing) => view(await own(r, uuid), r, pricing),
    list: async (r, q, pricing) => (await db.all(`${ROW} WHERE b.reseller_id=? AND (?::text IS NULL OR b.reseller_ref=?) AND (?::text IS NULL OR b.date=?::date) ORDER BY b.created_at DESC LIMIT 200`, r.id, q.resellerReference, q.resellerReference, isDate(q.localDate) ? q.localDate : null, isDate(q.localDate) ? q.localDate : null)).map((b) => view(b, r, pricing)),
  };
}
