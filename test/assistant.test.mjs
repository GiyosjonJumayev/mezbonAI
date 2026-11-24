import test from "node:test";
import assert from "node:assert/strict";

process.env.MEZBON_OFFLINE = "1";
const { openDb } = await import("../src/db.mjs");
const { createCore, tashkentNow } = await import("../src/core.mjs");
const { quality, readAmount, readDate, readTime } = await import("../src/assistant.mjs");

const DAY = 864e5;
const day = (n) => tashkentNow(new Date(Date.now() + n * DAY)).slice(0, 10);
const rejects = (p, s) => assert.rejects(p, (e) => { assert.equal(e.status, s, e.message); return true; });

async function setup({ publish = true } = {}) {
  const db = openDb(":memory:"), events = [], core = createCore(db, { notify: (h, e) => events.push(e.type) });
  const host = core.createHost("Rustam");
  const add = async (say = "Rishtonda kulolman, ikki soat, yuz ellik ming so'm, 4 kishi") => {
    const l = await core.createDraft(host.key, say);
    core.updateListing(host.key, l.id, { weekdays: [1, 2, 3, 4, 5, 6, 7] });
    return publish ? core.publish(host.key, l.id) : core.hostHome(host.key).listings.find((x) => x.id === l.id);
  };
  const l = await add();
  const book = (o = {}) => { const b = core.book({ listing_id: l.id, date: day(3), time: "10:00", guests: 2, guest_name: "Li Wei", lang: "zh", ...o }); core.payTest(b.token); return b; };
  const say = (text, history) => core.assistantChat(host.key, { text, history });
  const approve = (a) => core.assistantApply(host.key, a.action ?? a);
  const listing = () => core.hostHome(host.key).listings.find((x) => x.id === l.id);
  return { db, core, host, add, l, book, say, approve, listing, events };
}

// ---- understanding Uzbek ------------------------------------------------------------------------
test("Uzbek dates", () => {
  const t = "2026-11-24"; // a Tuesday
  for (const [s, v] of [["bugun", t], ["Ertaga 10:00 ni yop", "2026-11-25"], ["indinga", "2026-11-26"], ["27-noyabrni yop", "2026-11-27"], ["27 noyabr", "2026-11-27"], ["3-yanvar", "2027-01-03"], ["2026-12-31", "2026-12-31"], ["seshanba", t], ["dushanba kuni", "2026-11-30"], ["shanba", "2026-11-28"], ["yakshanba", "2026-11-29"], ["31-fevral", null], ["salom", null]])
    assert.equal(readDate(s, t), v, s);
});
test("Uzbek times and amounts", () => {
  for (const [s, v] of [["10:00 ni yop", "10:00"], ["soat 9 da", "09:00"], ["9.30", "09:30"], ["25:00", null], ["150000", null]]) assert.equal(readTime(s), v, s);
  for (const [s, v] of [["narxni 180 ming qil", 180000], ["narxini bir yuz sakson ming so'mga o'zgartir", 180000], ["180 000 so‘m", 180000], ["200000ga", 200000], ["narx qancha", null]]) assert.equal(readAmount(s), v, s);
});

// ---- nothing happens without approval ------------------------------------------------------------
test("a request changes nothing until approved, then goes through the normal rules", async () => {
  const { say, approve, listing } = await setup();
  const r = await say("narxni 180 ming qil");
  assert.equal(r.actions.length, 1);
  assert.match(r.actions[0].label, /150 000 so‘m → 180 000 so‘m/);
  assert.equal(listing().price_uzs, 150000);
  await approve(r.actions[0]);
  assert.equal(listing().price_uzs, 180000);
});

test("closing and reopening a time and a day keeps existing bookings", async () => {
  const { core, host, l, book, say, approve, listing } = await setup();
  const b = book({ date: day(1) });
  await approve((await say("Ertaga 10:00 ni yop")).actions[0]);
  assert.equal(core.slotCalendar(host.key, l.id, day(1), 1).days[0].slots[0].capacity, 0);
  assert.equal(core.guestBooking(b.token).status, "paid");
  await approve((await say("ertaga 10:00 ni och")).actions[0]);
  assert.equal(core.slotCalendar(host.key, l.id, day(1), 1).days[0].slots[0].capacity, 4);
  await approve((await say("ertaga dam olaman")).actions[0]);
  assert.deepEqual(listing().closed, [day(1)]);
  await approve((await say("ertangi kunni och")).actions[0] ?? { type: "open_day", listing_id: l.id, date: day(1) });
  assert.deepEqual(listing().closed, []);
  assert.match((await say("ertaga 11:00 ni yop")).reply, /jadvalda yo‘q/);
  assert.match((await say("kunni yop")).reply, /Qaysi kun/);
  await approve((await say(`${day(2)} 10:00 da 7 ta joy bo'lsin`)).actions[0]);
  assert.equal(core.slotCalendar(host.key, l.id, day(2), 1).days[0].slots[0].capacity, 7);
});

test("with several listings it asks which one, and finds it by name", async () => {
  const { add, say } = await setup();
  await add("Samarqandda tandirda non yopamiz, 90 daqiqa, 100 ming so'm, 5 kishi");
  const r = await say("narxni 180 ming qil");
  assert.deepEqual([r.actions.length, r.chips.length], [0, 2]);
  assert.equal((await say(r.chips[0])).actions.length, 1);
  assert.match((await say("kulolchilik darsi narxini 200 ming qil")).actions[0].label, /Kulolchilik/);
  assert.match((await say("tandirda non narxini 120 ming qil")).actions[0].label, /non/);
  assert.equal((await say("Tandirda non yopish haqida maslahat ber")).actions.some((a) => a.action.type === "close_day"), false, "a title is not a request");
  assert.match((await say("tandirda non yopishni ertaga 10:00 ga yop")).actions[0].label, /non.*10:00: yopish/);
});

test("bookings, income, schedule and advice answers use real numbers", async () => {
  const { core, host, book, say, approve } = await setup();
  assert.match((await say("daromadim qancha?")).reply, /hali tasdiqlangan bron yo‘q/);
  book({ date: day(1) });
  assert.match((await say("ertaga kimlar keladi?")).reply, /Li Wei, 2 kishi \(javob kutmoqda\)/);
  const r = await say("bronlarni qabul qil");
  await approve(r.actions[0]);
  assert.match((await say("oxirgi 30 kun daromadim")).reply, /1 ta tasdiqlangan bron, 2 mehmon, sizga 264 000 so‘m/);
  assert.match((await say("maslahat ber")).reply, /tayyorligi/);
  assert.equal((await say("abrakadabra")).chips.length, 6);
  assert.equal(core.hostHome(host.key).bookings[0].status, "confirmed");
});

test("a described service becomes a draft, never a live listing", async () => {
  const { core, host, say, approve } = await setup();
  const r = await say("Buxoroda palov damlashni o'rgataman, uch soat, ikki yuz ming so'm, 10 kishi");
  const { link } = await approve(r.actions[0]);
  assert.equal(core.hostHome(host.key).listings.find((x) => `taklif/${x.id}` === link).status, "draft");
});

// ---- safety ----------------------------------------------------------------------------------------
test("actions on other providers, unknown types and impossible values are refused", async () => {
  const { core, host, l, book } = await setup();
  const other = core.createHost("Boshqa"), b = book();
  const bid = core.hostHome(host.key).bookings.find((x) => x.guest_name === "Li Wei").id;
  for (const a of [{ type: "set_price", listing_id: l.id, price_uzs: 5000 }, { type: "pause", listing_id: l.id }, { type: "accept_booking", booking_id: bid }, { type: "reply_guest", booking_id: bid, text: "x" }, { type: "close_day", listing_id: l.id, date: day(1) }])
    await assert.rejects(core.assistantApply(other.key, a), (e) => e.status === 400, a.type);
  for (const a of [{ type: "constructor" }, {}, null, { type: "set_price", listing_id: l.id, price_uzs: 1 }, { type: "set_price", listing_id: l.id, price_uzs: "200000" }, { type: "set_slot", listing_id: l.id, date: day(-1), time: "10:00", capacity: 1 }, { type: "set_slot", listing_id: l.id, date: day(1), time: "10:00", capacity: 101 }, { type: "set_text", listing_id: l.id, lang: "xx", title: "a" }, { type: "reply_guest", booking_id: bid, text: " " }])
    await assert.rejects(core.assistantApply(host.key, a), (e) => e.status === 400, JSON.stringify(a));
  await rejects(core.assistantApply("", { type: "pause", listing_id: l.id }), 401);
  await rejects(core.assistantChat("", { text: "salom" }), 401);
  await rejects(core.assistantChat(host.key, { text: " " }), 400);
  await rejects(core.assistantChat(host.key, { text: "a".repeat(1001) }), 400);
  await core.assistantApply(host.key, { type: "accept_booking", booking_id: bid });
  await rejects(core.assistantApply(host.key, { type: "accept_booking", booking_id: bid }), 409);
  assert.equal(core.guestBooking(b.token).status, "confirmed");
});

// ---- daily brief -----------------------------------------------------------------------------------
test("brief lists what needs attention, most urgent first, with working actions", async () => {
  const { core, host, l, book, approve } = await setup();
  const b = book({ guests: 4 });
  await core.message("guest", b.token, { code: "q_children" });
  const draft = await core.createDraft(host.key, "Men somsa pishiraman");
  const { tasks } = core.assistantBrief(host.key);
  const has = (re) => tasks.find((t) => re.test(t.text));
  assert.ok(has(/1 ta bron javobingizni/) && has(/Bolalar bilan/) && has(/to‘ldi\. Joy qo‘shasizmi/) && has(/tayyorligi/) && has(new RegExp("qoralamasi")));
  assert.deepEqual([...new Set(tasks.map((t) => t.level))], ["now", "soon", "grow"]);
  await approve(has(/to‘ldi/).actions[0]);
  assert.equal(core.slotCalendar(host.key, l.id, day(3), 1).days[0].slots[0].capacity, 6);
  assert.equal(has(/somsa|Oshpaz/).link, `taklif/${draft.id}`);
});

test("today's visits show who has arrived", async () => {
  const { db, core, host, book } = await setup();
  const b = book();
  core.decide(host.key, core.hostHome(host.key).bookings[0].id, true);
  db.prepare("UPDATE bookings SET date=?").run(day(0));
  assert.equal(core.assistantBrief(host.key).visits[0].arrived, false);
  core.checkIn(host.key, core.guestBooking(b.token).ticket.code);
  assert.equal(core.assistantBrief(host.key).visits[0].arrived, true);
});

test("readiness score adds up to 100 and explains the next step", () => {
  const full = { photos: ["a", "b", "c"], i18n: { uz: { description: "a".repeat(120) } }, engine: "claude", edited: [], place: "Rishton", times: ["10:00", "15:00"], weekdays: [1, 2, 3, 4, 5], reviews: 1 };
  assert.deepEqual(quality(full), { score: 100, next: [] });
  const bare = quality({ ...full, photos: [], i18n: { uz: { description: "" } }, engine: "demo", place: null, times: ["10:00"], weekdays: [1], reviews: 0 });
  assert.deepEqual([bare.score, bare.next.length], [0, 7]);
});

// ---- smart booking: moving a visit -----------------------------------------------------------------
test("a guest can move a visit in time: same price, provider approves again, new ticket", async () => {
  const { core, host, book, events } = await setup();
  const b = book({ guests: 3 }), approve = () => core.decide(host.key, core.hostHome(host.key).bookings.find((x) => x.status === "paid").id, true);
  approve();
  const first = core.guestBooking(b.token).ticket.code;
  const moved = core.reschedule(b.token, { date: day(4), time: "15:00" });
  assert.deepEqual([moved.date, moved.time, moved.status, moved.ticket, moved.total_uzs], [day(4), "15:00", "paid", null, b.total_uzs]);
  assert.equal(events.at(-1), "moved");
  assert.throws(() => core.ticket(host.key, first), (e) => e.status === 404);
  assert.equal(core.availability(b.listing_id, day(3), 1)[0].times[0].free, 4);
  approve();
  assert.notEqual(core.guestBooking(b.token).ticket.code, first);
});

test("moving is refused when full, closed, past, unchanged, too late or unpaid", async () => {
  const { db, core, host, l, book } = await setup();
  const b = book({ guests: 3 });
  book({ date: day(4), guests: 2, guest_name: "B" });
  const bad = (o, s, token = b.token) => assert.throws(() => core.reschedule(token, { date: day(4), time: "10:00", ...o }), (e) => { assert.equal(e.status, s, e.message); return true; });
  bad({}, 409);
  bad({ date: day(3) }, 400);
  bad({ date: day(-1) }, 400);
  bad({ date: "x" }, 400);
  bad({ time: "11:00" }, 409);
  core.updateListing(host.key, l.id, { closed: [day(5)] });
  bad({ date: day(5) }, 409);
  const unpaid = core.book({ listing_id: l.id, date: day(6), time: "10:00", guests: 1, guest_name: "U", lang: "en" });
  bad({ date: day(7) }, 409, unpaid.token);
  db.prepare("UPDATE bookings SET date=?, time='00:00' WHERE token=?").run(day(1), b.token);
  bad({ date: day(7) }, 409);
});

// ---- tourism intelligence --------------------------------------------------------------------------
test("travel dates and busy hours are reported", async () => {
  const { db, core, host, book } = await setup();
  core.search({ region: "surxondaryo", date: day(9), guests: 3, lang: "ko" });
  core.search({ region: "surxondaryo", date: day(9), lang: "ko" });
  const p = core.panel();
  assert.deepEqual([p.dates[0].date, p.dates[0].n, p.dates[0].unmet, p.languages[0].lang], [day(9), 2, 2, "ko"]);
  core.subscribeTest(host.key, "business");
  assert.equal(core.intelligence(host.key).dates[0].date, day(9));
  book();
  core.decide(host.key, core.hostHome(host.key).bookings[0].id, true);
  const a = core.analytics(host.key, 30);
  assert.deepEqual(a.busy, [{ weekday: new Date(`${day(3)}T00:00:00Z`).getUTCDay() || 7, time: "10:00", guests: 2 }]);
  assert.equal(a.noShow, 0);
  db.prepare("UPDATE bookings SET date=?").run(day(-2));
  assert.equal(core.analytics(host.key, 30).noShow, 1);
});
