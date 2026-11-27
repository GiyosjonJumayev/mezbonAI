// The OCTO supplier API (https://docs.octo.travel): how resellers and booking sites sell our offers.
// Every answer is 200 or, for any problem, 400 with an error code, as the standard asks.
import { octoError } from "../domain/resellers.mjs";
import { limiter, readJson } from "./guard.mjs";

const CAPABILITIES = ["octo/pricing"];

export function createOctoApi({ resellers, config }) {
  const limit = limiter(600, 60e3);
  const routes = [
    ["GET", /^\/supplier\/?$/, () => resellers.supplier(config.publicUrl)],
    ["GET", /^\/products\/?$/, ({ r, pricing }) => resellers.products(r, pricing)],
    ["GET", /^\/products\/([\w-]{1,64})\/?$/, ({ r, m, pricing }) => resellers.product(r, m[1], pricing)],
    ["POST", /^\/availability\/calendar\/?$/, ({ r, body, pricing }) => resellers.calendar(r, body, pricing)],
    ["POST", /^\/availability\/?$/, ({ r, body, pricing }) => resellers.availability(r, body, pricing)],
    ["POST", /^\/bookings\/?$/, ({ r, body, pricing }) => resellers.reserve(r, body, pricing)],
    ["GET", /^\/bookings\/?$/, ({ r, q, pricing }) => resellers.list(r, { resellerReference: q.get("resellerReference"), localDate: q.get("localDate") }, pricing)],
    ["POST", /^\/bookings\/([\w-]{1,64})\/confirm\/?$/, ({ r, m, body, pricing }) => resellers.confirm(r, m[1], body, pricing)],
    ["POST", /^\/bookings\/([\w-]{1,64})\/cancel\/?$/, ({ r, m, pricing }) => resellers.cancel(r, m[1], pricing)],
    ["DELETE", /^\/bookings\/([\w-]{1,64})\/?$/, ({ r, m, pricing }) => resellers.cancel(r, m[1], pricing)],
    ["GET", /^\/bookings\/([\w-]{1,64})\/?$/, ({ r, m, pricing }) => resellers.get(r, m[1], pricing)],
  ];

  return async function octo(req, res, path, q) {
    const asked = String(req.headers["octo-capabilities"] ?? "").split(",").map((s) => s.trim()).filter((s) => CAPABILITIES.includes(s));
    const send = (v) => { res.writeHead(v?.error ? 400 : 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Octo-Capabilities": asked.join(", ") }); res.end(JSON.stringify(v)); };
    try {
      const r = await resellers.reseller(req.headers.authorization);
      try { limit(r.id); } catch { throw octoError("BAD_REQUEST", "Too many requests. Try again in a minute"); }
      for (const [method, re, fn] of routes) {
        const m = req.method === method && re.exec(path);
        if (!m) continue;
        let body = {};
        if (method === "POST") try { body = await readJson(req, 20e3); } catch (e) { throw octoError("BAD_REQUEST", e.message); }
        return send(await fn({ r, m, q, body, pricing: asked.includes("octo/pricing") }));
      }
      throw octoError("BAD_REQUEST", "Unknown endpoint");
    } catch (e) {
      if (e.octo) return send(e.octo);
      if (!e.status) console.error("[octo]", e);
      send({ error: e.status && e.status < 500 ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR", errorMessage: e.status && e.status < 500 ? e.message : "Something went wrong" });
    }
  };
}
