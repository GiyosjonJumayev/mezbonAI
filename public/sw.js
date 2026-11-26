// Offline support and push notifications. Everything is network first, so an update is never hidden by the cache.
const CACHE = "silkroad-7";
const SHELL = ["/", "/theme.js", "/app.css", "/components.css", "/common.js", "/art.js", "/pwa.js", "/tourist.js", "/trip.js", "/icon.svg", "/fonts/onest-latin-wght-normal.woff2"];

self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });

/** A guest's own ticket and what they looked at stay readable offline. Provider data is never stored. */
const keep = (u) => /^\/api\/trips\/[\w-]{20,}$/.test(u.pathname) || u.pathname === "/api/config" || u.pathname === "/api/qr.svg" || /^\/api\/listings(\/[\w-]+)?$/.test(u.pathname) || /^\/api\/bookings\/[\w-]+$/.test(u.pathname);

async function saved(u, key, page) {
  // The unfiltered catalogue is the same list whatever the language or page that asked for it.
  const whole = u.pathname === "/api/listings" && !["region", "category", "date", "guests"].some((k) => u.searchParams.get(k));
  const r = (await caches.match(key)) ?? (whole ? await caches.match(key, { ignoreSearch: true }) : null) ?? (page ? await caches.match("/") : null);
  if (!r) return Response.error();
  if (!u.pathname.startsWith("/api/")) return r;
  const headers = new Headers(r.headers);
  headers.set("X-Saved", "1"); // lets the page say it is showing a saved copy
  return new Response(await r.blob(), { status: r.status, headers });
}

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  if (u.pathname.startsWith("/api/") && !keep(u)) return;
  if (u.pathname.startsWith("/feeds/") || u.pathname.startsWith("/calendar/") || u.pathname === "/admin" || u.pathname === "/stage" || u.pathname === "/hamkor" || u.pathname === "/healthz") return;
  const page = e.request.mode === "navigate";
  const key = page ? u.pathname : e.request;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {}); }
    return r;
  }).catch(() => saved(u, key, page)));
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch {}
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || "SilkRoad", { body: d.body || "", tag: d.tag, renotify: Boolean(d.tag), icon: "/icon192.png", badge: "/icon192.png", data: { url: d.url || "/" } }),
  ]));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data.url, location.origin);
  if (target.origin !== location.origin) return;
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((list) => {
    const open = list.find((c) => new URL(c.url).pathname === target.pathname);
    return open ? open.focus().then((c) => c.navigate(target.href)) : self.clients.openWindow(target.href);
  }));
});
