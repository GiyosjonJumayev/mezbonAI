// A month of sample activity for demonstrations. Every provider in it is marked as a sample.
import { seed } from "./seed.mjs";
import { addDays, DAY, today } from "./lib/util.mjs";

/** Fills an empty database; returns null when there is data already. */
export async function fillDemo({ db, core, payments, admin }) {
  const day = (n) => addDays(today(), n);
  if (!(await seed(db, core))) return null;

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
  await core.setContact(rustam.key, { phone: "+998 90 000 00 00" });
  for (const l of rustam.listings) await core.updateListing(rustam.key, l.id, { address: "Namuna ko‘chasi 1, Rishton", point: { lat: 40.3567, lng: 71.2834 } });
  for (const plan of ["pro", "business"]) await payments.startPlan(rustam.key, plan, "test");

  const names = ["Li Wei", "Emma", "Kim", "Anna", "Yuki", "Omar", "Paul"], langs = ["zh", "de", "ko", "en", "ja", "ar", "fr"], channel = ["web", "hotel", "ai"], out = { key: rustam.key, host: rustam.id, a: rustam.listings[0].id, b: rustam.listings[1].id };
  for (let i = 0; i < 26; i++) {
    const l = rustam.listings[i % 4 === 3 ? 1 : 0];
    const x = await core.book({ listing_id: l.id, date: day(1 + (i % 12)), time: i % 2 ? "10:00" : "15:00", guests: 1 + (i % 3), guest_name: names[i % 7], email: `mehmon${i % 9}@example.com`, phone: "+998900000001", lang: langs[i % 7], hotel_code: channel[i % 3] === "hotel" ? "vodiy" : undefined, source: channel[i % 3] === "ai" ? "ai" : undefined });
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
  for (const [i, o] of more.entries()) for (let k = 0; k < 3; k++) { // the other providers had visitors too
    const x = await core.book({ listing_id: o.listings[0].id, date: day(8 + k), time: "15:00", guests: 2, guest_name: names[(i + k) % 7], email: `mehmon${10 + i * 3 + k}@example.com`, lang: langs[(i + k) % 7] });
    await payments.startBooking(x.token, "test");
    await core.decide(o.key, await core.bookingId(x.token), true);
    await db.run("UPDATE bookings SET date=?, created_at=?, checked_in_at=now() - interval '1 day' WHERE token=?", day(-2 - k - i), new Date(Date.now() - (6 + k * 17 + i * 5) * DAY).toISOString(), x.token);
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
  // Prices that follow the day and the group
  await core.updateListing(rustam.key, out.a, { pricing: { weekend: 10, group: { from: 4, pct: 10 } } });
  await core.updateListing(more[0].key, more[0].listings[0].id, { pricing: { last: { hours: 72, pct: 20 } } });
  await core.updateListing(more[4].key, more[4].listings[0].id, { pricing: { last: { hours: 48, pct: 15 }, group: { from: 5, pct: 12 } } });
  await db.run("UPDATE searches SET demo=true");
  await core.report(more[4].listings[0].id, { reason: "false", details: "Namuna shikoyat" });

  return out;
}
