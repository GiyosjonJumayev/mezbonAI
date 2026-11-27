// Pages, scripts, fonts and photos. Only names that match a pattern can be served, so paths cannot escape.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";
import { ROOT } from "../config.mjs";
import { fail } from "../lib/util.mjs";

const PUBLIC = path.join(ROOT, "public");
const PAGES = { "/": "index.html", "/mezbon": "host.html", "/panel": "panel.html", "/qr": "qr.html", "/admin": "admin.html", "/impact": "impact.html", "/hamkor": "partner.html", "/stage": "stage.html" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const TEXT = new Set([".html", ".js", ".css", ".svg", ".webmanifest"]);
const zip = { br: promisify(brotliCompress), gzip: promisify(gzip) };

/** `page(html, query)` may rewrite the traveller page, e.g. to add what search engines read. */
export function createStatic({ photos, page }) {
  const cache = new Map();
  async function load(file) {
    const s = await stat(file), hit = cache.get(file);
    if (hit?.mtime === s.mtimeMs) return hit;
    const data = await readFile(file);
    const v = { mtime: s.mtimeMs, data, etag: `"${createHash("sha256").update(data).digest("base64url").slice(0, 22)}"`, zipped: {} };
    if (file.startsWith(PUBLIC)) cache.set(file, v); // photos are not kept in memory
    return v;
  }
  return async function serve(req, res, pathname, query = new URLSearchParams()) {
    let file, keep = "no-cache";
    if (Object.hasOwn(PAGES, pathname)) file = path.join(PUBLIC, PAGES[pathname]);
    else if (/^\/photos\/[a-f0-9]{16}\.(jpg|png|webp)$/.test(pathname)) { file = path.join(photos, path.basename(pathname)); keep = "public, max-age=31536000, immutable"; }
    else if (/^\/fonts\/[a-z-]+\.woff2$/.test(pathname)) { file = path.join(PUBLIC, "fonts", path.basename(pathname)); keep = "public, max-age=31536000, immutable"; }
    else if (/^\/[a-z0-9]+\.(js|css|svg|png|webmanifest)$/.test(pathname)) file = path.join(PUBLIC, path.basename(pathname));
    else throw fail(404, "Sahifa topilmadi", "notfound");
    const f = await load(file).catch(() => { throw fail(404, "Fayl topilmadi", "notfound"); });
    const ext = path.extname(file), headers = { "Content-Type": TYPES[ext], "Cache-Control": keep, ETag: f.etag };
    if (req.headers["if-none-match"] === f.etag && !(pathname === "/" && page)) { res.writeHead(304, headers); return res.end(); }
    let data = f.data;
    if (pathname === "/" && page) {
      const html = await page(data.toString(), query);
      if (html !== data.toString()) { // a page of its own: it has its own tag and is not compressed from the cache
        data = Buffer.from(html);
        headers.ETag = `"${createHash("sha256").update(data).digest("base64url").slice(0, 22)}"`;
        if (req.headers["if-none-match"] === headers.ETag) { res.writeHead(304, headers); return res.end(); }
        res.writeHead(200, { ...headers, "Content-Length": data.length });
        return res.end(req.method === "HEAD" ? undefined : data);
      }
    }
    if (TEXT.has(ext)) {
      headers.Vary = "Accept-Encoding";
      const enc = ["br", "gzip"].find((x) => new RegExp(`\\b${x}\\b`).test(req.headers["accept-encoding"] ?? ""));
      if (enc && data.length > 1000) { data = await (f.zipped[enc] ??= zip[enc](data)); headers["Content-Encoding"] = enc; }
    }
    res.writeHead(200, { ...headers, "Content-Length": data.length });
    res.end(req.method === "HEAD" ? undefined : data);
  };
}
