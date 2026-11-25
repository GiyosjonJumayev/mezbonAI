// A complete, throw-away demonstration for a pitch: its own database, a month of sample activity, test payments only.
// Every provider in it is marked as a sample. Your real database is not touched.
//   npm run demo            fresh data on http://localhost:4322
//   PORT=5000 npm run demo
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { createApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { createDatabase } from "../src/db/database.mjs";
import { addDays, DAY, today } from "../src/lib/util.mjs";
import { seed } from "../src/seed.mjs";
import { startLocal } from "./localdb.mjs";

const port = Number(process.env.PORT) || 4322, name = "silkroad_demo", adminKey = `demo-${randomBytes(12).toString("hex")}`;
const local = await startLocal();
const c = new pg.Client({ connectionString: local.owner.replace(/[^/]+$/, "postgres") });
await c.connect();
await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
await c.query(`CREATE DATABASE ${name}`);
await c.end();
const at = (u) => u.replace(/[^/]+$/, name), owner = createDatabase(at(local.owner), { max: 1 });
await owner.migrate({ grantTo: "silkroad_app" });
await owner.close();

const db = createDatabase(at(local.app));
const config = { ...loadConfig({ DATABASE_URL: at(local.app), PORT: String(port), ADMIN_KEY: adminKey, PUBLIC_URL: `http://localhost:${port}` }), dataDir: mkdtempSync(path.join(os.tmpdir(), "silkroad-demo-")) };
const app = await createApp({ db, config, telegram: null, pushSend: async () => {} }), { core, payments, admin } = app;
const day = (n) => addDays(today(), n);
await seed(db, core);

const offer = async (who, type, texts) => {
  const h = await core.createHost(who, { type, demo: true }), out = [];
  for (const t of texts) {
    const l = await core.createDraft(h.key, t);
    await core.updateListing(h.key, l.id, { weekdays: [1, 2, 3, 4, 5, 6, 7] });
    out.push(await core.publish(h.key, l.id));
  }
  return { ...h, listings: out };
};
const rustam = await offer("Rustam usta", "artisan", ["Men Rishtonda kulolman. Loydan lagan yasashni o‘rgataman. Ikki soat, yuz ellik ming so‘m, sakkiz kishi.", "Rishtonda qishloq hayotini ko‘rsataman, uch soat, 80 ming so‘m, olti kishi"]);
const more = [];
for (const x of [
  ["Samarqand oilasi", "guesthouse", ["Samarqandda palov damlashni o‘rgataman, uch soat, 180 ming so‘m, 8 kishi", "Samarqandda kashta tikamiz, ikki soat, 110 ming so‘m, 6 kishi"]],
  ["Buxoro misgari", "artisan", ["Buxoroda misgarlik, ikki soat, 140 ming so‘m, 5 kishi"]],
  ["Xiva yog‘och ustasi", "artisan", ["Xivada yog‘och o‘ymakorligi, ikki soat, 160 ming so‘m, 4 kishi"]],
  ["Toshkent sayohat", "provider", ["Toshkentda milliy taomlar pishiramiz, uch soat, 190 ming so‘m, 10 kishi"]],
  ["Kulol Aziz", "artisan", ["Rishtonda kulolman, ikki soat, 170 ming so'm, 6 kishi"]], ["Kulol Baxrom", "artisan", ["Rishtonda kulolman, ikki soat, 200 ming so'm, 6 kishi"]], ["Kulol Dilshod", "artisan", ["Rishtonda kulolman, ikki soat, 230 ming so'm, 6 kishi"]],
]) more.push(await offer(...x));
for (const h of [rustam, more[0], more[1]]) await admin.verifyHost(h.id, true);
for (const plan of ["pro", "business"]) await payments.startPlan(rustam.key, plan, "test");

const names = ["Li Wei", "Emma", "Kim", "Anna", "Yuki", "Omar", "Paul"], langs = ["zh", "de", "ko", "en", "ja", "ar", "fr"], channel = ["web", "hotel", "ai"], out = { key: rustam.key, host: rustam.id, a: rustam.listings[0].id, b: rustam.listings[1].id, adminKey };
for (let i = 0; i < 26; i++) {
  const l = rustam.listings[i % 4 === 3 ? 1 : 0];
  const x = await core.book({ listing_id: l.id, date: day(1 + (i % 12)), time: i % 2 ? "10:00" : "15:00", guests: 1 + (i % 3), guest_name: names[i % 7], lang: langs[i % 7], hotel_code: channel[i % 3] === "hotel" ? "vodiy" : undefined, source: channel[i % 3] === "ai" ? "ai" : undefined });
  await payments.startBooking(x.token, "test");
  if (i < 24) await core.decide(rustam.key, await core.bookingId(x.token), true);
  await db.run("UPDATE bookings SET created_at=?, asked_at = CASE WHEN decided_at IS NULL THEN asked_at ELSE decided_at - interval '2 hours' END WHERE token=?", new Date(Date.now() - ((i * 7) % 29) * DAY - 3600e3).toISOString(), x.token);
  if (i === 0) out.today = x.token;
  if (i === 1) out.future = x.token;
  if (i === 25) out.waiting = x.token;
  if (i > 1 && i < 10) { // visits that already happened, with reviews
    await db.run("UPDATE bookings SET date=?, checked_in_at=now() - interval '1 day' WHERE token=?", day(-i), x.token);
    if (i < 7) await core.review(x.token, { rating: i === 4 ? 4 : 5 });
  }
}
await db.run("UPDATE bookings SET date=?, time='23:30' WHERE token=?", day(0), out.today);
out.code = (await core.guestBooking(out.today)).ticket.code;
await core.message("guest", out.future, { code: "q_vegetarian" });
const back = await core.book({ listing_id: more[0].listings[0].id, date: day(6), time: "10:00", guests: 2, guest_name: "Emma", lang: "de" });
await payments.startBooking(back.token, "test");
await core.cancel(back.token);
out.refunded = back.token;
out.pending = (await core.book({ listing_id: more[1].listings[0].id, date: day(7), time: "10:00", guests: 2, guest_name: "Kim", lang: "ko" })).token;
const plan = await core.planTrip({ from: day(4), days: 5, guests: 2 });
out.trip = (await core.bookTrip({ items: plan.days.flatMap((d) => d.items.map((x) => ({ listing_id: x.listing_id, date: d.date, time: x.time }))), guests: 2, guest_name: "Anna", lang: "en" })).token;
for (let i = 0; i < 90; i++) await core.view(i % 3 ? out.a : out.b, langs[i % 7]);
for (const [region, category, n, lang] of [["surxondaryo", "wood", 6, "ko"], ["namangan", "metal", 4, "zh"], ["fargona", "pottery", 9, "de"], ["buxoro", "wood", 3, "en"]]) for (let i = 0; i < n; i++) await core.search({ region, category, lang });
await db.run("UPDATE searches SET demo=true");
await core.report(more[4].listings[0].id, { reason: "false", details: "Namuna shikoyat" });

if (process.env.DEMO_OUT) writeFileSync(process.env.DEMO_OUT, JSON.stringify(out));
app.server.listen(port, process.env.HOST || "127.0.0.1", () => console.log(`
Namoyish tayyor (barcha ma'lumot namuna, pul yechilmaydi):
  Sayohatchi   http://localhost:${port}/
  Reja         http://localhost:${port}/?plan=1
  Kabinet      http://localhost:${port}/mezbon#kirish=${out.key}
  Ma'muriyat   http://localhost:${port}/admin   kalit: ${adminKey}
  Talab        http://localhost:${port}/panel
To'xtatish: Ctrl+C`));
app.startJobs();
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { app.stopJobs(); app.server.closeAllConnections(); app.server.close(() => db.close().then(() => process.exit(0))); });
