// The HTTP server: security first, then payment callbacks, then JSON routes, then files.
import http from "node:http";
import path from "node:path";
import QRCode from "qrcode";
import { adminSessions } from "../domain/admin.mjs";
import { fail } from "../lib/util.mjs";
import { checkOrigin, clientIp, cookie, cookies, limiter, readBody, readJson, secureHeaders, toAppError } from "./guard.mjs";
import { createRoutes } from "./routes.mjs";
import { createStatic } from "./static.mjs";

const device = (ua = "") => [/Edg/.test(ua) ? "Edge" : /Firefox/.test(ua) ? "Firefox" : /Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "Brauzer", /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : ""].filter(Boolean).join(", ");

export function createHttp(app) {
  const { core, payments, config } = app;
  const photos = path.join(config.dataDir, "photos");
  const routes = createRoutes({ ...app, photos }), serve = createStatic({ photos }), admins = adminSessions(config.adminKey);
  const streams = new Map(); // host id → Set of open event streams
  const limitWrite = limiter(90, 60e3), limitPayCallback = limiter(1200, 60e3), limitRead = limiter(600, 60e3);
  const SESSION = config.https ? "__Host-sr" : "sr", ADMIN = config.https ? "__Host-sra" : "sra";

  const server = http.createServer(async (req, res) => {
    secureHeaders(res, config);
    const json = (s, v) => {
      res.writeHead(s, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(v));
    };
    try {
      const url = new URL(req.url, "http://x"), { pathname } = url, ip = clientIp(req, config.trustProxy);

      // Payment companies: they have their own authentication and no cookies.
      if (pathname.startsWith("/pay/") && req.method === "POST") {
        limitPayCallback(ip);
        const raw = (await readBody(req, 20e3)).toString();
        if (pathname === "/pay/payme") return json(200, await payments.payme(req.headers.authorization, raw, ip));
        if (pathname === "/pay/octo") {
          let body;
          try { body = JSON.parse(raw); } catch { throw fail(400, "JSON noto‘g‘ri"); }
          return json(200, await payments.octoNotify(body));
        }
      }

      const jar = cookies(req), key = req.headers["x-host-key"] ?? jar[SESSION];
      if (req.method === "POST") checkOrigin(req, config, Boolean(jar[SESSION] || jar[ADMIN]));
      const setCookie = (c) => res.setHeader("Set-Cookie", [...[res.getHeader("Set-Cookie") ?? []].flat(), c]);
      const session = { token: jar[SESSION], set: (v, age) => setCookie(cookie(SESSION, v, age, config.https)) };
      const adminSession = { open: (k) => setCookie(cookie(ADMIN, admins.open(k), admins.maxAge, config.https)), close: () => setCookie(cookie(ADMIN, "", 0, config.https)) };

      if (pathname === "/api/host/events" && req.method === "GET") {
        const h = await core.authHost(key), set = streams.get(h.id) ?? new Set();
        if (set.size >= 10) throw fail(429, "Juda ko‘p ochiq oyna", "rate");
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        res.write(": ok\n\n");
        streams.set(h.id, set.add(res));
        const ping = setInterval(() => res.write(": ping\n\n"), 25e3);
        // A revoked session must not keep listening.
        const recheck = setInterval(() => core.authHost(key).catch((e) => { if (e.status === 401) res.end(); }), 60e3);
        res.on("close", () => {
          clearInterval(ping);
          clearInterval(recheck);
          set.delete(res);
          if (!set.size) streams.delete(h.id);
        });
        return;
      }
      if (pathname === "/api/qr.svg" && req.method === "GET") {
        limitRead(ip);
        const svg = await QRCode.toString((url.searchParams.get("text") ?? "").slice(0, 300) || " ", { type: "svg", margin: 1, color: { dark: "#0f2740", light: "#ffffff" } });
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=3600" });
        return res.end(svg);
      }
      const ics = req.method === "GET" && /^\/api\/bookings\/([A-Za-z0-9_-]{1,64})\/calendar\.ics$/.exec(pathname);
      if (ics) {
        const text = await core.calendar(ics[1]);
        res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="mezbon.ics"', "Cache-Control": "no-store" });
        return res.end(text);
      }
      const feed = req.method === "GET" && /^\/calendar\/([A-Za-z0-9_-]{32})\.ics$/.exec(pathname);
      if (feed) {
        limitRead(ip);
        const text = await core.hostCalendar(feed[1]);
        res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "private, no-store" });
        return res.end(text);
      }
      if (/^\/(api|feeds)\/|^\/healthz$/.test(pathname)) {
        for (const r of routes) {
          const m = r.method === req.method && r.re.exec(pathname);
          if (!m) continue;
          if (r.admin) admins.check(jar[ADMIN]);
          let body = {};
          if (req.method === "POST") {
            limitWrite(ip);
            body = await readJson(req, pathname.endsWith("/photo") ? 4e6 : 20e3);
          } else limitRead(ip);
          return json(200, await r.fn({ id: m[1], q: url.searchParams, body, key, ip, label: device(req.headers["user-agent"]), session, adminSession }));
        }
        throw fail(404, "Topilmadi", "notfound");
      }
      if (req.method !== "GET" && req.method !== "HEAD") throw fail(405, "Ruxsat yo‘q");
      await serve(req, res, pathname);
    } catch (e) {
      const known = toAppError(e);
      if (!known) console.error(e);
      if (res.headersSent) return res.end();
      json(known ? known.status : 500, { error: known ? known.message : "Serverda xato", code: known ? known.code : "other", ...(known?.item && { item: known.item }) });
    }
  });
  server.headersTimeout = 15e3;
  server.requestTimeout = 30e3;
  return { server, push: (hostId, ev) => { for (const r of streams.get(hostId) ?? []) r.write(`data: ${JSON.stringify(ev)}\n\n`); } };
}
