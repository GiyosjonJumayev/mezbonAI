// Web Push for providers and guests, and visit reminders. Payloads are end-to-end encrypted by the web-push library.
import * as webpush from "web-push";
import { LANGS, UI } from "./i18n.mjs";

// The server POSTs to whatever endpoint a browser hands it, so only real push services are accepted.
const SERVICES = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)+notify\.windows\.com$/, /^web\.push\.apple\.com$/];
export function okEndpoint(s) {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.port && !u.username && !u.password && s.length < 1000 && SERVICES.some((re) => re.test(u.hostname));
  } catch { return false; }
}
const b64 = (s, n) => typeof s === "string" && /^[A-Za-z0-9_-]+=*$/.test(s) && Buffer.from(s, "base64url").length === n;

export function createPush(db, { send = (sub, body, opts) => webpush.sendNotification(sub, body, opts), fail, contact = process.env.PUSH_CONTACT || "mailto:noreply@example.com" } = {}) {
  const get = (k) => db.prepare("SELECT v FROM settings WHERE k=?").get(k)?.v;
  let pub = get("vapid_public"), priv = get("vapid_private");
  if (!pub || !priv) {
    ({ publicKey: pub, privateKey: priv } = webpush.generateVAPIDKeys());
    const put = db.prepare("INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v");
    put.run("vapid_public", pub);
    put.run("vapid_private", priv);
  }
  const options = { vapidDetails: { subject: contact, publicKey: pub, privateKey: priv }, TTL: 24 * 3600, timeout: 10_000 };

  async function deliver(rows, payload) {
    await Promise.all(rows.map(async (r) => {
      try { await send({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, JSON.stringify(payload), options); }
      catch (e) {
        // 404 and 410 mean the browser dropped the subscription.
        if (e.statusCode === 404 || e.statusCode === 410) db.prepare("DELETE FROM push_subs WHERE endpoint=? AND kind=? AND ref=?").run(r.endpoint, r.kind, r.ref);
        else console.error("[push]", e.statusCode ?? e.code ?? "yuborilmadi");
      }
    }));
  }
  const subs = (kind, ref) => db.prepare("SELECT * FROM push_subs WHERE kind=? AND ref=?").all(kind, ref);

  return {
    publicKey: pub,
    subscribe(kind, ref, s) {
      if (!okEndpoint(s?.endpoint) || !b64(s?.keys?.p256dh, 65) || !b64(s?.keys?.auth, 16)) throw fail(400, "Bildirishnoma obunasi noto‘g‘ri");
      if (subs(kind, ref).length >= 10) db.prepare("DELETE FROM push_subs WHERE rowid IN (SELECT rowid FROM push_subs WHERE kind=? AND ref=? ORDER BY created_at LIMIT 1)").run(kind, ref);
      db.prepare("INSERT INTO push_subs (kind,ref,endpoint,p256dh,auth,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(kind,ref,endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth").run(kind, ref, s.endpoint, s.keys.p256dh, s.keys.auth, new Date().toISOString());
      return { ok: true };
    },
    unsubscribe(kind, ref, endpoint) {
      db.prepare("DELETE FROM push_subs WHERE kind=? AND ref=? AND endpoint=?").run(kind, ref, String(endpoint ?? ""));
      return { ok: true };
    },
    toHost: (hostId, title, body, url = "/mezbon") => deliver(subs("host", hostId), { title, body, url, tag: url }),
    /** b is a booking row with token, lang, i18n, date and time. */
    toGuest(b, type, text) {
      const lang = LANGS.includes(b.lang) ? b.lang : "en";
      const body = { confirmed: UI.confirmed, declined: UI.declined, reminder: UI.remind }[type]?.[lang] ?? text;
      return deliver(subs("guest", b.id), { title: b.i18n[lang].title, body: type === "reminder" ? `${body} ${b.date}, ${b.time}` : body, url: `/?b=${b.token}&lang=${lang}`, tag: b.id });
    },
  };
}
