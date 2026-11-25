// What every request passes through: body size, rate limits, cookies, origin check, security headers.
import { fail } from "../lib/util.mjs";

export async function readBody(req, limit) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw fail(413, "So‘rov juda katta");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
export async function readJson(req, limit) {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw fail(415, "JSON kutilgan");
  let v;
  try { v = JSON.parse((await readBody(req, limit)).toString() || "{}"); } catch (e) { throw e.status ? e : fail(400, "JSON noto‘g‘ri"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw fail(400, "JSON noto‘g‘ri");
  return v;
}

/** Sliding-window counter per key. `take` returns false when the limit is reached. */
export function counter(max, ms) {
  const hits = new Map();
  return function take(k) {
    const t = Date.now(), a = (hits.get(k) ?? []).filter((x) => t - x < ms);
    if (a.length >= max) return false;
    if (hits.size > 5000) for (const [key, v] of hits) if (t - v.at(-1) >= ms) hits.delete(key); // forget the quiet ones first
    while (hits.size > 50_000) hits.delete(hits.keys().next().value); // memory stays bounded even under attack
    a.push(t);
    hits.delete(k);
    hits.set(k, a);
    return true;
  };
}
export const limiter = (max, ms) => {
  const take = counter(max, ms);
  return (k) => { if (!take(k)) throw fail(429, "Juda ko‘p so‘rov. Bir daqiqadan keyin urinib ko‘ring", "rate"); };
};

/** Behind a reverse proxy the last hop it added is the only address we can believe. One IPv6 home counts as one visitor. */
export function clientIp(req, trustProxy) {
  const raw = ((trustProxy && req.headers["x-forwarded-for"]?.split(",").at(-1).trim()) || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (!raw.includes(":")) return raw;
  const [a, b = ""] = raw.split("::"), left = a.split(":").filter(Boolean), right = b.split(":").filter(Boolean);
  return [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right].slice(0, 4).join(":");
}

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
export const cookie = (name, value, maxAge, https) => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${https ? "; Secure" : ""}`;

/** Another website must not be able to act with a visitor's cookies. */
export function checkOrigin(req, config, hasCookie) {
  const origin = req.headers.origin;
  if (!origin) {
    if (hasCookie) throw fail(403, "So‘rov manbasi noma’lum", "origin");
    return; // programs such as the MCP server send no Origin and have no cookies
  }
  let ok = origin === config.origin;
  if (!ok && !config.production) try { ok = new URL(origin).host === req.headers.host; } catch {}
  if (!ok) throw fail(403, "Boshqa saytdan so‘rov qabul qilinmaydi", "origin");
}

const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export function secureHeaders(res, config) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer"); // booking links are secrets
  res.setHeader("Permissions-Policy", "microphone=(self), camera=(self), geolocation=(self), payment=(), usb=()");
  res.setHeader("Content-Security-Policy", config.https ? `${CSP}; upgrade-insecure-requests` : CSP);
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (config.https) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

/** What PostgreSQL refuses because of the request itself is the visitor's mistake, not a server failure. */
export function toAppError(e) {
  if (e.status && e.code) return e;
  if (typeof e.code === "string") {
    if (/^22/.test(e.code) || e.code === "ERR_INVALID_URL") return fail(400, "Kiritilgan ma’lumot noto‘g‘ri");
    if (/^(08|53|57)/.test(e.code) || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(e.code)) return fail(503, "Baza vaqtincha javob bermayapti", "other");
  }
  return null;
}
