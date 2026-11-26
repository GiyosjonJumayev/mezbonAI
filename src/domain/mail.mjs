// E-mail: receipts, confirmations, reminders, sign-in links. Messages wait in PostgreSQL, so a restart or a mail outage loses nothing.
import nodemailer from "nodemailer";
import { LANGS, REGION_NAMES, UI } from "../lib/i18n.mjs";
import { ago, DAY, fail } from "../lib/util.mjs";

const MAX_ATTEMPTS = 8;
export const isEmail = (v) => typeof v === "string" && v.length <= 120 && /^[^\s@<>(),;:"\\[\]]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v);
export function cleanEmail(v) {
  if (v == null || v === "") return null;
  if (!isEmail(String(v).trim())) throw fail(400, "Email noto‘g‘ri", "email");
  return String(v).trim();
}
export function cleanPhone(v) {
  if (v == null || v === "") return null;
  const d = String(v).replace(/[\s()-]/g, "");
  if (!/^\+?\d{7,15}$/.test(d)) throw fail(400, "Telefon raqami noto‘g‘ri", "phone");
  return d.startsWith("+") ? d : d.length === 9 ? `+998${d}` : `+${d}`;
}
export const mapLink = (b) => (b.lat == null ? null : `https://www.google.com/maps/search/?api=1&query=${b.lat},${b.lng}`);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** Plain text and simple HTML from the same lines. */
export function render({ title, lines, button }, lang) {
  const text = [title, "", ...lines, ...(button ? ["", button.text, button.url] : []), "", "SilkRoad Experience OS"].join("\n");
  const html = `<!doctype html><html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}"><body style="margin:0;padding:24px;background:#f4f8f9;font-family:Segoe UI,Arial,sans-serif;color:#0c1f33"><div style="max-width:560px;margin:auto;background:#fff;border-radius:16px;padding:28px"><h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>${lines.map((l) => `<p style="margin:0 0 10px;line-height:1.5">${esc(l)}</p>`).join("")}${button ? `<p style="margin:22px 0 0"><a href="${esc(button.url)}" style="background:#1746a2;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;display:inline-block">${esc(button.text)}</a></p>` : ""}<p style="margin:26px 0 0;color:#4a6074;font-size:13px">SilkRoad Experience OS</p></div></body></html>`;
  return { text, html };
}

export function createMail({ db, config, transport = config.mail && nodemailer.createTransport(config.mail.url, { connectionTimeout: 15_000, socketTimeout: 20_000 }) }) {
  const on = Boolean(config.mail && transport);
  /** Without a mail server nothing is stored: no pile of addresses waits for a setting that may never come. */
  async function queue(to, subject, parts, lang = "uz") {
    if (!on || !isEmail(to)) return false;
    await db.run("INSERT INTO emails (recipient,subject,body,lang) VALUES (?,?,?,?)", to, subject.replace(/[\r\n]+/g, " ").slice(0, 180), JSON.stringify(parts), lang);
    return true;
  }
  const longDate = (d, lang) => { const o = { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }; try { return new Intl.DateTimeFormat(lang, o).format(new Date(`${d}T00:00:00Z`)); } catch { return d; } };
  const uzs = (n, lang) => `${String(n).replace(/\B(?=(\d{3})+$)/g, " ")} ${lang === "uz" ? "so‘m" : "UZS"}`;

  return {
    on, queue,
    /** Tells a guest what happened to a booking. `b` is a booking row. */
    async guest(b, type, text) {
      if (!b.guest_email) return false;
      const lang = LANGS.includes(b.lang) ? b.lang : "en", t = (k) => UI[k][lang];
      const says = { paid: t("paid"), confirmed: t("confirmed"), declined: t("declined"), cancelled: t("cancelled"), refunded: t("refunded"), reminder: t("remind"), message: text, unanswered: t("declined") }[type];
      if (!says) return false;
      const lines = [says, `${t("date")}: ${longDate(b.date, lang)}, ${b.time}`, `${t("guests")}: ${b.guests}`];
      if (["paid", "confirmed", "reminder"].includes(type)) lines.push(`${t("where")}: ${[type === "paid" ? null : b.address, b.address?.includes(b.place) && type !== "paid" ? null : b.place, REGION_NAMES[b.region]?.[lang]].filter(Boolean).join(", ")}`);
      if (["confirmed", "reminder"].includes(type)) { if (b.host_phone) lines.push(`${t("callHost")}: ${b.host_phone}`); if (b.lat != null) lines.push(`${t("openMap")}: ${mapLink(b)}`); }
      if (["paid", "refunded"].includes(type)) lines.push(`${t("total")}: ${uzs(b.total_uzs, lang)}`);
      return queue(b.guest_email, `${b.i18n[lang].title}: ${says}`, { title: b.i18n[lang].title, lines, button: { text: t("open"), url: `${config.publicUrl}/?b=${b.token}&lang=${lang}` } }, lang);
    },
    /** A place opened for someone on the waiting list. */
    async placeOpen(w) {
      const lang = LANGS.includes(w.lang) ? w.lang : "en", t = (k) => UI[k][lang];
      return queue(w.email, `${w.i18n[lang].title}: ${t("waitMail")}`, { title: t("waitMail"), lines: [w.i18n[lang].title, `${t("date")}: ${longDate(w.date, lang)}, ${w.time}`, `${t("guests")}: ${w.guests}`, t("waitHurry"), `${t("waitStop")}: ${config.publicUrl}/?leave=${w.token}&lang=${lang}`], button: { text: t("book"), url: `${config.publicUrl}/?l=${w.listing_id}&date=${w.date}&lang=${lang}` } }, lang);
    },
    /** All recent bookings of one address. The answer to the visitor never says whether there were any. */
    async findBookings(address, lang) {
      const to = cleanEmail(address), g = LANGS.includes(lang) ? lang : "en";
      if (!to) throw fail(400, "Email kerak", "email");
      const rows = await db.all("SELECT b.token, b.date, b.time, l.i18n FROM bookings b JOIN listings l ON l.id=b.listing_id WHERE lower(b.guest_email)=lower(?) AND b.created_at > ? ORDER BY b.date DESC LIMIT 20", to, ago(180 * DAY));
      if (rows.length) await queue(to, UI.myBookings[g], { title: UI.myBookings[g], lines: rows.map((r) => `${r.date} ${r.time}, ${r.i18n[g].title}: ${config.publicUrl}/?b=${r.token}&lang=${g}`) }, g);
      return { ok: true };
    },
    /** Sends what is waiting. Each message is taken by one worker only. */
    async work() {
      if (!on) return 0;
      let sent = 0;
      for (let i = 0; i < 50; i++) {
        const m = await db.one(`UPDATE emails SET attempts=attempts+1, next_at = now() + (interval '1 minute' * power(2, attempts + 1)) WHERE id = (SELECT id FROM emails WHERE next_at <= now() AND attempts < ${MAX_ATTEMPTS} ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`);
        if (!m) break;
        try {
          await transport.sendMail({ from: config.mail.from, to: m.recipient, subject: m.subject, ...render(JSON.parse(m.body), m.lang) });
          await db.run("DELETE FROM emails WHERE id=?", m.id);
          sent++;
        } catch (e) { console.error("[mail]", e.responseCode ?? e.code ?? e.message); }
      }
      await db.run("DELETE FROM emails WHERE created_at < ?", ago(3 * DAY)); // too late to be useful
      return sent;
    },
    close: () => transport?.close?.(),
  };
}
