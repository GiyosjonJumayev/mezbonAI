import test from "node:test";
import assert from "node:assert/strict";
import { tashkentNow } from "../src/lib/util.mjs";
import { SAY, day, freeAt, req, settle, setup, status } from "./helpers.mjs";

test("guest cancellation: free in time, refused late, gives the place back", async () => {
  const { payTest, db, core, host, l, events } = await setup();
  const b = await core.book(req(l, { date: day(3), guests: 4 }));
  await payTest(b.token);
  assert.equal(await freeAt(core, l, 3), 0);
  assert.equal((await core.cancel(b.token)).status, "cancelled");
  assert.equal(await freeAt(core, l, 3), 4);
  await settle();
  assert.deepEqual(events, ["booking", "cancelled"]);
  await status(() => core.cancel(b.token), 409);

  const late = await core.book(req(l));
  await payTest(late.token);
  await db.run("UPDATE bookings SET date=?, time='00:00' WHERE token=?", day(1), late.token);
  await status(() => core.cancel(late.token), 409);

  const unpaid = await core.book(req(l, { date: day(4) }));
  await core.cancel(unpaid.token);
  await settle();
  assert.equal(events.length, 3, "an unpaid hold is released silently");
  assert.ok(!(await core.hostHome(host.key)).bookings.some((x) => x.date === day(4)));
});

test("reviews: only after a confirmed visit, once, shown with an initial", async () => {
  const { payTest, db, core, host, l } = await setup();
  const b = await core.book(req(l));
  await payTest(b.token);
  await core.decide(host.key, (await core.hostHome(host.key)).bookings[0].id, true);
  await status(() => core.review(b.token, { rating: 5 }), 409);
  await db.run("UPDATE bookings SET date=?", day(-1));
  await status(() => core.review(b.token, { rating: 6 }), 400);
  assert.equal((await core.review(b.token, { rating: 4, text: "很好" })).my_rating, 4);
  await status(() => core.review(b.token, { rating: 5 }), 409);
  const pub = await core.listing(l.id);
  assert.deepEqual([pub.rating, pub.reviews, pub.reviewList[0].by], [4, 1, "L."]);
  assert.ok(!JSON.stringify(pub).includes("Wei"));
});

test("closed dates block booking and search by date", async () => {
  const { core, host, l } = await setup();
  assert.equal((await core.search({ date: day(2), guests: 2 })).length, 1);
  assert.equal((await core.search({ guests: 5 })).length, 0);
  await core.updateListing(host.key, l.id, { closed: [day(2)] });
  assert.deepEqual(await core.availability(l.id, day(2), 1), []);
  assert.equal((await core.search({ date: day(2) })).length, 0);
  await status(() => core.book(req(l)), 409);
  await status(() => core.updateListing(host.key, l.id, { closed: ["2026-13-01"] }), 400);
});

test("availability never shows past slots", async () => {
  const { core, l } = await setup();
  const clock = tashkentNow().slice(0, 16);
  for (const d of await core.availability(l.id, "2020-01-01", 60)) for (const t of d.times) assert.ok(`${d.date}T${t.time}` > clock);
});

test("hand-edited text survives later number changes; other languages follow", async () => {
  const { core, host, l } = await setup();
  await core.updateListing(host.key, l.id, { text: { lang: "en", title: "My kiln", description: "Come and see." } });
  const r = await core.updateListing(host.key, l.id, { capacity: 9 });
  assert.equal(r.i18n.en.title, "My kiln");
  assert.match(r.i18n.de.description, /bis zu 9/);
  await core.updateListing(host.key, l.id, { text: { lang: "fr", title: "Mon four" } });
  const fr = (await core.updateListing(host.key, l.id, { duration_min: 75 })).i18n.fr;
  assert.equal(fr.title, "Mon four");
  assert.match(fr.description, /75 minutes/, "editing only the title must not freeze the description");
  await status(() => core.updateListing(host.key, l.id, { text: { lang: "xx", title: "a", description: "b" } }), 400);
});

test("only drafts can be deleted; paused listings keep their bookings", async () => {
  const { payTest, core, host, l } = await setup();
  const draft = await core.createDraft(host.key, SAY);
  await core.deleteDraft(host.key, draft.id);
  await status(() => core.deleteDraft(host.key, l.id), 409);
  const b = await core.book(req(l));
  await payTest(b.token);
  await core.pause(host.key, l.id);
  await status(() => core.listing(l.id), 404);
  assert.equal((await core.guestBooking(b.token)).status, "paid");
});

test("calendar file is in UTC and cannot be broken by text", async () => {
  const { payTest, core, host, l } = await setup();
  const b = await core.book(req(l));
  await status(() => core.calendar(b.token), 409);
  await payTest(b.token);
  await core.updateListing(host.key, l.id, { text: { lang: "zh", title: "a;b,c\r\nATTENDEE:x", description: "d" } });
  const ics = await core.calendar(b.token);
  assert.ok(ics.includes(`DTSTART:${day(2).replaceAll("-", "")}T050000Z`));
  assert.ok(!/^ATTENDEE/m.test(ics));
});

test("panel can leave out sample searches and old periods", async () => {
  const { db, core } = await setup();
  await db.run("INSERT INTO searches (region,results,lang,source,demo,created_at) VALUES ('navoiy',0,'en','seed',true,?)", new Date().toISOString());
  await db.run("INSERT INTO searches (region,category,results,lang,source,created_at) VALUES ('navoiy','wood',0,'en','web','2020-01-01T00:00:00Z')");
  const unmet = async (o) => (await core.panel(o)).regions.find((r) => r.region === "navoiy").unmet;
  assert.deepEqual([await unmet(), await unmet({ demo: false }), await unmet({ days: 7 }), await unmet({ days: 7, demo: false })], [2, 1, 1, 0]);
  assert.equal((await core.panel()).categories[0].category, "wood");
});
