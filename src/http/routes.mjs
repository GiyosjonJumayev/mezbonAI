// Every JSON endpoint. A handler gets { id, q, body, key, ip, label, session } and returns what to send.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { aiEnabled } from "../ai/claude.mjs";
import { CANCEL_HOURS } from "../domain/bookings.mjs";
import { MAX_PHOTOS } from "../domain/catalog.mjs";
import { HOTEL_FEE, PLANS } from "../domain/plans.mjs";
import { CATEGORIES, LANGS, LANG_NAMES, PHRASES, PROVIDER_TYPES, REGIONS, REGION_NAMES, UI } from "../lib/i18n.mjs";
import { fail } from "../lib/util.mjs";
import { counter, limiter } from "./guard.mjs";

function sniffImage(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))) return ".png";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return ".webp";
  return null;
}

export function createRoutes({ core, payments, admin, config, db, push, photos }) {
  mkdirSync(photos, { recursive: true });
  const limitAi = limiter(20, 60e3), limitSignup = limiter(10, 10 * 60e3), limitLogin = limiter(20, 10 * 60e3), limitTicket = limiter(60, 60e3), limitAdmin = limiter(5, 15 * 60e3), limitReport = limiter(5, 3600e3), limitPay = limiter(20, 60e3), limitBook = limiter(20, 10 * 60e3), limitTrip = limiter(5, 10 * 60e3);
  const newSearch = counter(1, 10 * 60e3); // one visitor repeating a search is one signal of demand
  const newView = counter(1, 30 * 60e3);
  const dropPhoto = (f) => (f ? unlink(path.join(photos, path.basename(f))).catch(() => {}) : null);
  const signedIn = async (session, opening) => { const s = await opening; session.set(s.token, s.maxAge); return s.host; };

  const open = {
    "GET /healthz": async () => ({ ok: await db.ping() }),
    "GET /api/config": () => ({ langs: LANGS, langNames: LANG_NAMES, regions: REGIONS, regionNames: REGION_NAMES, categories: CATEGORIES, ui: UI, phrases: PHRASES, providerTypes: PROVIDER_TYPES, plans: PLANS, hotelFee: HOTEL_FEE, cancelHours: CANCEL_HOURS, maxPhotos: MAX_PHOTOS, ai: aiEnabled(), payMethods: payments.methods(), testPayments: config.testPayments, usdRate: config.usdRate }),
    "GET /api/listings": async ({ q, ip }) => {
      const f = { region: q.get("region"), category: q.get("category"), date: q.get("date"), guests: Number(q.get("guests")), lang: q.get("lang"), source: q.get("source") === "ai" ? "ai" : "web" };
      return core.search({ ...f, log: newSearch([ip, f.source, f.region, f.category].join("|")) });
    },
    "GET /api/listings/:id": async ({ id, q, ip }) => {
      const l = await core.listing(id);
      if (q.get("lang") && newView([ip, id].join("|"))) await core.view(id, q.get("lang")); // only the traveller site sends lang
      return l;
    },
    "GET /api/listings/:id/availability": ({ id, q }) => core.availability(id, q.get("from"), Number(q.get("days")) || 21),
    "GET /api/providers/:id": ({ id }) => core.provider(id),
    "POST /api/trips/plan": ({ body, ip }) => { limitAi(ip); return core.planTrip(body); },
    "POST /api/trips": ({ body, ip }) => { limitTrip(ip); return core.bookTrip(body); },
    "GET /api/trips/:id": ({ id }) => core.trip(id),
    "POST /api/listings/:id/report": ({ id, body, ip }) => { limitReport(ip); return core.report(id, body); },
    "GET /api/hotels": () => core.hotels(),
    "GET /api/hotels/:id": async ({ id }) => { const h = await core.hotel(id); if (!h) throw fail(404, "Mehmonxona topilmadi", "notfound"); return h; },
    "GET /api/panel": async ({ q }) => {
      const { platform, ...p } = await core.panel({ days: Number(q.get("days")) || 0, demo: q.get("demo") !== "0" });
      return config.testPayments ? { ...p, platform } : p; // platform income is for the demo, never public in production
    },
    "GET /feeds/products.json": () => core.feed(),
    "GET /api/push/key": () => ({ key: push.publicKey }),
  };

  const guest = {
    "POST /api/bookings": ({ body, ip }) => { limitBook(ip); const { trip_id, ...b } = body; return core.book(b); },
    "GET /api/bookings/:id": ({ id }) => core.guestBooking(id),
    "POST /api/bookings/:id/pay": ({ id, body, ip }) => { limitPay(ip); return payments.startBooking(id, body.method); },
    /** After coming back from the payment page: asks the payment company instead of trusting the address bar. */
    "POST /api/bookings/:id/refresh": async ({ id, ip }) => { limitPay(ip); await payments.refresh("booking", await core.bookingId(id)); return core.guestBooking(id); },
    "POST /api/bookings/:id/cancel": ({ id }) => core.cancel(id),
    "POST /api/bookings/:id/reschedule": ({ id, body }) => core.reschedule(id, body),
    "POST /api/bookings/:id/review": ({ id, body }) => core.review(id, body),
    "POST /api/bookings/:id/messages": ({ id, body, ip }) => { limitAi(ip); return core.message("guest", id, body); },
    "POST /api/push/guest/:id": async ({ id, body }) => push[body.off ? "unsubscribe" : "subscribe"]("guest", await core.bookingId(id), body.off ?? body.subscription),
  };

  const auth = {
    "POST /api/hosts": async ({ body, ip, label, session }) => {
      limitSignup(ip);
      const h = await core.createHost(body.name, { type: body.type ?? "artisan" });
      const s = await core.openSession(h.id, label);
      session.set(s.token, s.maxAge);
      return h;
    },
    "POST /api/auth/key": ({ body, ip, label, session }) => { limitLogin(ip); return signedIn(session, core.signIn(body.key, label)); },
    "POST /api/auth/link": ({ body, ip, label, session }) => { limitLogin(ip); return signedIn(session, core.useLink(body.token, label)); },
    "POST /api/auth/sign-out": async ({ session }) => { await core.signOut(session.token); session.set("", 0); return { ok: true }; },
    "POST /api/auth/rotate": async ({ key, ip, label, session }) => {
      limitLogin(ip);
      const { key: fresh } = await core.rotateKey(key);
      const s = await core.signIn(fresh, label);
      session.set(s.token, s.maxAge);
      return { key: fresh };
    },
    "POST /api/auth/passkey/options": ({ ip }) => { limitLogin(ip); return core.passkeyLoginOptions(); },
    "POST /api/auth/passkey": ({ body, ip, label, session }) => { limitLogin(ip); return signedIn(session, core.passkeyLogin(body, label)); },
    "POST /api/host/passkeys/options": ({ key }) => core.passkeyRegisterOptions(key),
    "POST /api/host/passkeys": ({ key, body }) => core.passkeyRegister(key, body),
    "POST /api/host/passkeys/remove": ({ key, body }) => core.passkeyRemove(key, body.id),
  };

  const host = {
    "GET /api/host": ({ key }) => core.hostHome(key),
    "GET /api/host/account": ({ key }) => core.account(key),
    "GET /api/host/balance": ({ key }) => payments.hostBalance(key),
    "POST /api/host/calendar-link": async ({ key }) => ({ url: `${config.publicUrl}/calendar/${await core.calendarLink(key)}.ics` }),
    "POST /api/host/drafts": ({ key, body, ip }) => { limitAi(ip); return core.createDraft(key, body.transcript); },
    "POST /api/host/listings/:id": ({ key, id, body }) => core.updateListing(key, id, body),
    "POST /api/host/listings/:id/publish": ({ key, id }) => core.publish(key, id),
    "POST /api/host/listings/:id/pause": ({ key, id }) => core.pause(key, id),
    "POST /api/host/listings/:id/delete": async ({ key, id }) => { await Promise.all((await core.deleteDraft(key, id)).photos.map(dropPhoto)); return { ok: true }; },
    "POST /api/host/listings/:id/photo": async ({ key, id, body }) => {
      await core.ownListing(key, id); // before anything touches the disk
      const buf = Buffer.from(String(body.data ?? ""), "base64"), ext = sniffImage(buf);
      if (!ext) throw fail(400, "Faqat JPG, PNG yoki WebP rasm");
      const name = randomBytes(8).toString("hex") + ext;
      await writeFile(path.join(photos, name), buf);
      try { return await core.addPhoto(key, id, name); } catch (e) { await dropPhoto(name); throw e; }
    },
    "POST /api/host/listings/:id/photo-remove": async ({ key, id, body }) => { const l = await core.removePhoto(key, id, body.file); await dropPhoto(body.file); return l; },
    "POST /api/host/listings/:id/photo-cover": ({ key, id, body }) => core.coverPhoto(key, id, body.file),
    "POST /api/push/host": async ({ key, body }) => push[body.off ? "unsubscribe" : "subscribe"]("host", (await core.authHost(key)).id, body.off ?? body.subscription),
    "POST /api/host/bookings/:id/accept": ({ key, id }) => core.decide(key, id, true),
    "POST /api/host/bookings/:id/decline": ({ key, id }) => core.decide(key, id, false),
    "POST /api/host/bookings/:id/messages": ({ key, id, body, ip }) => { limitAi(ip); return core.message("host", key, { ...body, booking_id: id }); },
    "GET /api/host/listings/:id/calendar": ({ key, id, q }) => core.slotCalendar(key, id, q.get("from"), Number(q.get("days")) || 14),
    "POST /api/host/listings/:id/slot": ({ key, id, body }) => core.setSlot(key, id, body),
    "GET /api/host/tickets/:id": ({ key, id, ip }) => { limitTicket(ip); return core.ticket(key, id); },
    "POST /api/host/tickets/:id/check-in": ({ key, id }) => core.checkIn(key, id),
    "GET /api/host/analytics": ({ key, q }) => core.analytics(key, Number(q.get("days")) || 30),
    "GET /api/host/intelligence": ({ key }) => core.intelligence(key),
    "GET /api/host/assistant": ({ key }) => core.assistantBrief(key),
    "POST /api/host/assistant": ({ key, body, ip }) => { limitAi(ip); return core.assistantChat(key, body); },
    "POST /api/host/assistant/apply": ({ key, body, ip }) => { limitAi(ip); return core.assistantApply(key, body); },
    "GET /api/host/plans": async ({ key }) => { const p = await core.plans(key); return { ...p, payMethods: payments.methods() }; },
    "POST /api/host/plans/:id/pay": ({ key, id, body, ip }) => { limitPay(ip); return payments.startPlan(key, id, body.method); },
    "POST /api/host/plans/refresh": async ({ key, ip }) => { limitPay(ip); await payments.refresh("plan", (await core.authHost(key)).id); return core.plans(key); },
  };

  // Everything below needs an administrator session; `admin: true` is checked before the handler runs.
  const adminOnly = {
    "GET /api/admin": () => admin.overview(),
    "GET /api/admin/hosts": ({ q }) => admin.hosts(q.get("q") ?? ""),
    "POST /api/admin/hosts/:id/verify": ({ id, body }) => admin.verifyHost(id, body.on),
    "POST /api/admin/hosts/:id/suspend": ({ id, body }) => admin.suspendHost(id, body.on),
    "POST /api/admin/hosts/:id/recovery": ({ id }) => admin.recoveryLink(id),
    "POST /api/admin/hosts/:id/payout": ({ id, body }) => payments.recordPayout(id, body.amount, body.reference),
    "POST /api/admin/listings/:id/block": ({ id, body }) => admin.blockListing(id, body.on),
    "POST /api/admin/reports/:id/resolve": ({ id }) => admin.resolveReport(id),
    "POST /api/admin/refunds/:id/done": ({ id }) => payments.confirmRefund(id),
    "POST /api/admin/refunds/:id/retry": ({ id }) => payments.retryRefund(id),
  };
  const adminDoor = {
    "POST /api/admin/login": ({ body, ip, adminSession }) => { limitAdmin(ip); adminSession.open(body.key); return { ok: true }; },
    "POST /api/admin/logout": ({ adminSession }) => { adminSession.close(); return { ok: true }; },
  };

  const list = (group, isAdmin = false) => Object.entries(group).map(([k, fn]) => {
    const [method, p] = k.split(" ");
    return { method, admin: isAdmin, re: new RegExp("^" + p.replaceAll(".", "\\.").replace(":id", "([A-Za-z0-9_-]{1,64})") + "$"), fn };
  });
  return [...list(open), ...list(guest), ...list(auth), ...list(host), ...list(adminDoor), ...list(adminOnly, true)];
}
