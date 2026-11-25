// Web Push for providers and guests, and visit reminders. Payloads are end-to-end encrypted by the web-push library.
import * as webpush from "web-push";
import { LANGS, UI } from "../lib/i18n.mjs";
import { fail } from "../lib/util.mjs";

// The server POSTs to whatever endpoint a browser hands it, so only real push services are accepted.
const SERVICES = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)+notify\.windows\.com$/, /^web\.push\.apple\.com$/];
export function okEndpoint(s) {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.port && !u.username && !u.password && s.length < 1000 && SERVICES.some((re) => re.test(u.hostname));
  } catch { return false; }
}
const b64 = (s, n) => typeof s === "string" && /^[A-Za-z0-9_-]+=*$/.test(s) && Buffer.from(s, "base64url").length === n;

export async function createPush({ db, contact, send = (sub, body, opts) => webpush.sendNotification(sub, body, opts) }) {
  const keys = async () => Object.fromEntries((await db.all("SELECT k, v FROM settings WHERE k IN ('vapid_public','vapid_private')")).map((r) => [r.k, r.v]));
  let k = await keys();
  if (!k.vapid_public || !k.vapid_private) {
    const v = webpush.generateVAPIDKeys();
    // The first server to start decides; the others read its keys.
    await db.run("INSERT INTO settings (k,v) VALUES ('vapid_public',?),('vapid_private',?) ON CONFLICT (k) DO NOTHING", v.publicKey, v.privateKey);
    k = await keys();
  }
  const pub = k.vapid_public;
  const options = { vapidDetails: { subject: contact, publicKey: pub, privateKey: k.vapid_private }, TTL: 24 * 3600, timeout: 10_000 };

  async function deliver(rows, payload) {
    await Promise.all(rows.map(async (r) => {
      try { await send({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, JSON.stringify(payload), options); }
      catch (e) {
        // 404 and 410 mean the browser dropped the subscription.
        if (e.statusCode === 404 || e.statusCode === 410) await db.run("DELETE FROM push_subs WHERE endpoint=? AND kind=? AND ref=?", r.endpoint, r.kind, r.ref);
        else console.error("[push]", e.statusCode ?? e.code ?? "yuborilmadi");
      }
    }));
  }
  const subs = (kind, ref) => db.all("SELECT * FROM push_subs WHERE kind=? AND ref=?", kind, ref);

  return {
    publicKey: pub,
    async subscribe(kind, ref, s) {
      if (!okEndpoint(s?.endpoint) || !b64(s?.keys?.p256dh, 65) || !b64(s?.keys?.auth, 16)) throw fail(400, "Bildirishnoma obunasi noto‘g‘ri");
      await db.run("INSERT INTO push_subs (kind,ref,endpoint,p256dh,auth) VALUES (?,?,?,?,?) ON CONFLICT (kind,ref,endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, created_at=now()", kind, ref, s.endpoint, s.keys.p256dh, s.keys.auth);
      await db.run("DELETE FROM push_subs WHERE kind=? AND ref=? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE kind=? AND ref=? ORDER BY created_at DESC LIMIT 10)", kind, ref, kind, ref);
      return { ok: true };
    },
    async unsubscribe(kind, ref, endpoint) {
      await db.run("DELETE FROM push_subs WHERE kind=? AND ref=? AND endpoint=?", kind, ref, String(endpoint ?? "").slice(0, 1000));
      return { ok: true };
    },
    toHost: async (hostId, title, body, url = "/mezbon") => deliver(await subs("host", hostId), { title, body, url, tag: url }),
    /** b is a booking row with token, lang, i18n, date and time. */
    async toGuest(b, type, text) {
      const lang = LANGS.includes(b.lang) ? b.lang : "en";
      const body = { confirmed: UI.confirmed, declined: UI.declined, reminder: UI.remind }[type]?.[lang] ?? text;
      return deliver(await subs("guest", b.id), { title: b.i18n[lang].title, body: type === "reminder" ? `${body} ${b.date}, ${b.time}` : body, url: `/?b=${b.token}&lang=${lang}`, tag: b.id });
    },
  };
}
