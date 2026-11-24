import http from "node:http";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import QRCode from "qrcode";
import { openDb, ROOT, DATA_DIR } from "./db.mjs";
import { AppError, CANCEL_HOURS, createCore, HOTEL_FEE } from "./core.mjs";
import { CATEGORIES, LANGS, LANG_NAMES, PHRASES, PROVIDER_TYPES, REGIONS, REGION_NAMES, UI } from "./i18n.mjs";
import { PLANS } from "./business.mjs";
import { aiEnabled } from "./ai.mjs";
import { seed } from "./seed.mjs";
import { bookingNotice, telegramSender } from "./telegram.mjs";

const PUBLIC = path.join(ROOT, "public");
const PHOTOS = path.join(DATA_DIR, "photos");
const PAGES = { "/": "index.html", "/mezbon": "host.html", "/panel": "panel.html", "/qr": "qr.html" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2" };
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

async function readJson(req, limit) {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new AppError(415, "JSON kutilgan");
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new AppError(413, "So‘rov juda katta");
    chunks.push(c);
  }
  let v;
  try { v = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { throw new AppError(400, "JSON noto‘g‘ri"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new AppError(400, "JSON noto‘g‘ri");
  return v;
}

function sniffImage(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))) return ".png";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return ".webp";
  return null;
}

/** Sliding-window counter per key. `take` returns false when the limit is reached. */
function counter(max, ms) {
  const hits = new Map();
  return function take(k) {
    const t = Date.now(), a = (hits.get(k) ?? []).filter((x) => t - x < ms);
    if (a.length >= max) return false;
    if (hits.size > 5000) hits.clear();
    a.push(t);
    hits.set(k, a);
    return true;
  };
}
const limiter = (max, ms) => {
  const take = counter(max, ms);
  return (k) => { if (!take(k)) throw new AppError(429, "Juda ko‘p so‘rov. Bir daqiqadan keyin urinib ko‘ring", "rate"); };
};

const env = {
  telegram: process.env.TELEGRAM_BOT_TOKEN ? telegramSender(process.env.TELEGRAM_BOT_TOKEN) : null,
  // Test payments must never be reachable on a production deployment by accident.
  testPayments: process.env.NODE_ENV !== "production" || process.env.ALLOW_TEST_PAYMENTS === "1",
};

export function createApp(db, { telegram = env.telegram, testPayments = env.testPayments } = {}) {
  const streams = new Map(); // host id → Set of open event streams
  const notify = (hostId, ev) => {
    for (const r of streams.get(hostId) ?? []) r.write(`data: ${JSON.stringify(ev)}\n\n`);
    const h = telegram && db.prepare("SELECT key, telegram_chat FROM hosts WHERE id=?").get(hostId);
    if (!h?.telegram_chat) return;
    const b = core.hostHome(h.key).bookings.find((x) => x.id === ev.id);
    if (b) Promise.resolve(telegram(h.telegram_chat, ...bookingNotice(b, ev.type))).catch(() => console.error("Telegram xabari yuborilmadi"));
  };
  const core = createCore(db, { notify });
  const limitAi = limiter(20, 60e3), limitWrite = limiter(90, 60e3), limitSignup = limiter(10, 10 * 60e3), limitTicket = limiter(60, 60e3);
  const newSearch = counter(1, 10 * 60e3); // one visitor repeating a search is one signal of demand
  const newView = counter(1, 30 * 60e3);
  const dropPhoto = (f) => (f ? unlink(path.join(PHOTOS, path.basename(f))).catch(() => {}) : null);

  const api = {
    "GET /healthz": () => ({ ok: true }),
    "GET /api/config": () => ({ langs: LANGS, langNames: LANG_NAMES, regions: REGIONS, regionNames: REGION_NAMES, categories: CATEGORIES, ui: UI, phrases: PHRASES, providerTypes: PROVIDER_TYPES, plans: PLANS, hotelFee: HOTEL_FEE, cancelHours: CANCEL_HOURS, ai: aiEnabled(), testPayments, usdRate: Number(process.env.USD_RATE) || null }),
    "GET /api/listings": ({ q, ip }) => {
      const f = { region: q.get("region"), category: q.get("category"), date: q.get("date"), guests: Number(q.get("guests")), lang: q.get("lang"), source: q.get("source") === "ai" ? "ai" : "web" };
      return core.search({ ...f, log: newSearch([ip, f.source, f.region, f.category].join("|")) });
    },
    "GET /api/listings/:id": ({ id, q, ip }) => {
      const l = core.listing(id);
      if (q.get("lang") && newView([ip, id].join("|"))) core.view(id, q.get("lang")); // only the traveller site sends lang
      return l;
    },
    "GET /api/listings/:id/availability": ({ id, q }) => core.availability(id, q.get("from"), Number(q.get("days")) || 21),
    "GET /api/hotels": () => core.hotels(),
    "GET /api/hotels/:id": ({ id }) => { const h = core.hotel(id); if (!h) throw new AppError(404, "Mehmonxona topilmadi", "notfound"); return h; },
    "POST /api/bookings": ({ body }) => core.book(body),
    "GET /api/bookings/:id": ({ id }) => core.guestBooking(id),
    "POST /api/bookings/:id/pay-test": ({ id }) => {
      if (!testPayments) throw new AppError(403, "Sinov to‘lovi o‘chirilgan", "state");
      return core.payTest(id);
    },
    "POST /api/bookings/:id/cancel": ({ id }) => core.cancel(id),
    "POST /api/bookings/:id/review": ({ id, body }) => core.review(id, body),
    "POST /api/bookings/:id/messages": ({ id, body, ip }) => { limitAi(ip); return core.message("guest", id, body); },
    "POST /api/hosts": ({ body, ip }) => { limitSignup(ip); return core.createHost(body.name, { type: body.type ?? "artisan" }); },
    "GET /api/host": ({ key }) => core.hostHome(key),
    "POST /api/host/drafts": ({ key, body, ip }) => { limitAi(ip); return core.createDraft(key, body.transcript); },
    "POST /api/host/listings/:id": ({ key, id, body }) => core.updateListing(key, id, body),
    "POST /api/host/listings/:id/publish": ({ key, id }) => core.publish(key, id),
    "POST /api/host/listings/:id/pause": ({ key, id }) => core.pause(key, id),
    "POST /api/host/listings/:id/delete": async ({ key, id }) => { await dropPhoto(core.deleteDraft(key, id).photo); return { ok: true }; },
    "POST /api/host/listings/:id/photo": async ({ key, id, body }) => {
      core.authHost(key);
      const buf = Buffer.from(String(body.data ?? ""), "base64");
      const ext = sniffImage(buf);
      if (!ext) throw new AppError(400, "Faqat JPG, PNG yoki WebP rasm");
      const name = randomBytes(8).toString("hex") + ext;
      await writeFile(path.join(PHOTOS, name), buf);
      try {
        const { listing, old } = core.setPhoto(key, id, name);
        await dropPhoto(old);
        return listing;
      } catch (e) { await dropPhoto(name); throw e; }
    },
    "POST /api/host/bookings/:id/accept": ({ key, id }) => core.decide(key, id, true),
    "POST /api/host/bookings/:id/decline": ({ key, id }) => core.decide(key, id, false),
    "POST /api/host/bookings/:id/messages": ({ key, id, body, ip }) => { limitAi(ip); return core.message("host", key, { ...body, booking_id: id }); },
    "GET /api/host/listings/:id/calendar": ({ key, id, q }) => core.slotCalendar(key, id, q.get("from"), Number(q.get("days")) || 14),
    "POST /api/host/listings/:id/slot": ({ key, id, body }) => core.setSlot(key, id, body),
    "GET /api/host/tickets/:id": ({ key, id, ip }) => { limitTicket(ip); return core.ticket(key, id); },
    "POST /api/host/tickets/:id/check-in": ({ key, id }) => core.checkIn(key, id),
    "GET /api/host/analytics": ({ key, q }) => core.analytics(key, Number(q.get("days")) || 30),
    "GET /api/host/intelligence": ({ key }) => core.intelligence(key),
    "GET /api/host/plans": ({ key }) => core.plans(key),
    "POST /api/host/plans/:id/subscribe-test": ({ key, id }) => {
      if (!testPayments) throw new AppError(403, "Sinov to‘lovi o‘chirilgan", "state");
      return core.subscribeTest(key, id);
    },
    "GET /api/panel": ({ q }) => {
      const { platform, ...p } = core.panel({ days: Number(q.get("days")) || 0, demo: q.get("demo") !== "0" });
      return testPayments ? { ...p, platform } : p; // platform income is for the demo, never public in production
    },
    "GET /feeds/products.json": () => core.feed(),
  };
  const routes = Object.entries(api).map(([k, fn]) => {
    const [method, p] = k.split(" ");
    return { method, re: new RegExp("^" + p.replaceAll(".", "\\.").replace(":id", "([A-Za-z0-9_-]{1,64})") + "$"), fn };
  });

  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer"); // booking links are secrets
    res.setHeader("Permissions-Policy", "microphone=(self), camera=(self), geolocation=()");
    res.setHeader("Content-Security-Policy", CSP);
    const json = (s, v) => {
      res.writeHead(s, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(v));
    };
    try {
      const url = new URL(req.url, "http://x");
      const ip = req.socket.remoteAddress;
      const key = req.headers["x-host-key"];

      if (url.pathname === "/api/host/events" && req.method === "GET") {
        const h = core.authHost(key);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
        res.write(": ok\n\n");
        if (!streams.has(h.id)) streams.set(h.id, new Set());
        streams.get(h.id).add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25e3);
        req.on("close", () => {
          clearInterval(ping);
          streams.get(h.id)?.delete(res);
          if (!streams.get(h.id)?.size) streams.delete(h.id);
        });
        return;
      }
      if (url.pathname === "/api/qr.svg" && req.method === "GET") {
        const svg = await QRCode.toString((url.searchParams.get("text") ?? "").slice(0, 300) || " ", { type: "svg", margin: 1, color: { dark: "#0f2740", light: "#ffffff" } });
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=3600" });
        return res.end(svg);
      }
      const ics = req.method === "GET" && /^\/api\/bookings\/([A-Za-z0-9_-]{1,64})\/calendar\.ics$/.exec(url.pathname);
      if (ics) {
        const text = core.calendar(ics[1]);
        res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="mezbon.ics"', "Cache-Control": "no-store" });
        return res.end(text);
      }
      if (/^\/(api|feeds)\/|^\/healthz$/.test(url.pathname)) {
        for (const r of routes) {
          const m = r.method === req.method && r.re.exec(url.pathname);
          if (!m) continue;
          let body = {};
          if (req.method === "POST") {
            limitWrite(ip);
            body = await readJson(req, url.pathname.endsWith("/photo") ? 3e6 : 20e3);
          }
          return json(200, await r.fn({ id: m[1], q: url.searchParams, body, key, ip }));
        }
        throw new AppError(404, "Topilmadi", "notfound");
      }
      if (req.method !== "GET" && req.method !== "HEAD") throw new AppError(405, "Ruxsat yo‘q");
      let file, cache = "no-cache";
      if (Object.hasOwn(PAGES, url.pathname)) file = path.join(PUBLIC, PAGES[url.pathname]);
      else if (/^\/photos\/[a-f0-9]{16}\.(jpg|png|webp)$/.test(url.pathname)) { file = path.join(PHOTOS, path.basename(url.pathname)); cache = "public, max-age=31536000, immutable"; }
      else if (/^\/fonts\/[a-z-]+\.woff2$/.test(url.pathname)) { file = path.join(PUBLIC, "fonts", path.basename(url.pathname)); cache = "public, max-age=31536000, immutable"; }
      else if (/^\/[a-z]+\.(js|css|svg)$/.test(url.pathname)) file = path.join(PUBLIC, path.basename(url.pathname));
      else throw new AppError(404, "Sahifa topilmadi", "notfound");
      const data = await readFile(file).catch(() => { throw new AppError(404, "Fayl topilmadi", "notfound"); });
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)], "Cache-Control": cache });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch (e) {
      const knownError = e instanceof AppError;
      if (!knownError) console.error(e);
      if (!res.headersSent) json(knownError ? e.status : 500, { error: knownError ? e.message : "Serverda xato", code: knownError ? e.code : "other" });
      else res.end();
    }
  });
  return { server, core };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const db = openDb();
  const { server, core } = createApp(db);
  if (process.env.SEED !== "0") seed(db, core);
  const port = Number(process.env.PORT) || 4321, host = process.env.HOST || "127.0.0.1";
  server.on("error", (e) => {
    console.error(e.code === "EADDRINUSE" ? `${port}-port band. Boshqa oynadagi serverni yoping yoki PORT ni o‘zgartiring.` : e.message);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`SilkRoad Experience OS: http://localhost:${port}   (AI: ${aiEnabled() ? "Claude" : "demo rejim"})`);
    if (host === "0.0.0.0") for (const i of Object.values(os.networkInterfaces()).flat()) if (i.family === "IPv4" && !i.internal) console.log(`Telefon uchun:  http://${i.address}:${port}`);
  });
  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => {
    server.closeAllConnections();
    server.close(() => { db.close(); process.exit(0); });
  });
}
