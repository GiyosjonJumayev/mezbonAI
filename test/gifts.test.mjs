// Gift vouchers, guest updates in Telegram, the regional demand report, and payouts through a bank list.
import test from "node:test";
import assert from "node:assert/strict";
import { createBot } from "../src/adapters/telegram.mjs";
import { addDays, isoWeekday } from "../src/lib/util.mjs";
import { UI } from "../src/lib/i18n.mjs";
import { day, eventually, req, serve, settle, setup, status } from "./helpers.mjs";

const MAIL = { SMTP_URL: "smtp://mail.test", MAIL_FROM: "SilkRoad <x@example.com>" };
const weekday = (n) => { let d = day(n); while (isoWeekday(d) > 5) d = addDays(d, 1); return d; };
async function bought(s, amount = 500000) {
  const { token } = await s.core.createVoucher({ amount_uzs: amount, name: "Ali", email: "ali@example.com", recipient: "Malika", message: "Tug‘ilgan kuning bilan!", lang: "uz" });
  assert.equal((await s.core.voucher(token)).code, null, "no code before it is paid");
  await s.payments.startVoucher(token, "test");
  return s.core.voucher(token);
}

test("a voucher is bought, becomes usable only when paid, and is e-mailed as a gift card", async () => {
  const sent = [], s = await serve({ env: MAIL, mailer: { sendMail: async (m) => { sent.push(m); }, close() {} } });
  for (const bad of [{ amount_uzs: 1000 }, { amount_uzs: 99_000_000 }, { email: "" }, { name: "" }]) await status(s.core.createVoucher({ amount_uzs: 500000, name: "Ali", email: "ali@example.com", lang: "uz", ...bad }), 400);
  const v = await bought(s);
  assert.match(v.code, /^G[0-9A-F]{10}$/);
  assert.deepEqual([v.status, v.balance_uzs, v.recipient], ["active", 500000, "Malika"]);
  await status(s.payments.startVoucher(v.token, "test"), 409);
  await eventually(async () => { await s.mail.work(); return sent.length; });
  assert.ok(sent[0].to === "ali@example.com" && sent[0].text.includes(v.code) && sent[0].text.includes(`/?giftcard=${v.token}`));
  const t = (await s.metrics.investor({ sample: true })).money.gifts;
  assert.deepEqual([t.sold, t.amount, t.open], [1, 500000, 500000]);
});

test("a voucher pays all of a booking, or part of it with the rest by card; the balance is taken only when paid", async () => {
  const s = await setup(), v = await bought(s, 400000), d = weekday(3);
  const all = await s.core.book(req(s.l, { date: d, guests: 2, voucher: v.code }));
  assert.deepEqual([all.voucher_uzs, all.due_uzs], [300000, 0]);
  assert.equal((await s.core.voucher(v.token)).balance_uzs, 400000, "a hold takes nothing");
  await status(s.payments.startBooking(all.token, "test"), 400);
  await s.payments.startBooking(all.token, "voucher");
  assert.equal((await s.core.guestBooking(all.token)).status, "paid");
  assert.equal((await s.core.voucher(v.token)).balance_uzs, 100000);
  const part = await s.core.book(req(s.l, { date: d, time: "15:00", guests: 2, voucher: v.code }));
  assert.deepEqual([part.voucher_uzs, part.due_uzs], [100000, 200000]);
  await status(s.payments.startBooking(part.token, "voucher"), 400);
  await s.payTest(part.token);
  assert.equal((await s.db.one("SELECT amount_uzs FROM payments WHERE provider='test' AND kind='booking'")).amount_uzs, 200000, "the card pays only the rest");
  assert.equal((await s.core.voucher(v.token)).balance_uzs, 0);
  const b = await s.core.guestBooking(part.token);
  assert.equal(b.host_uzs + b.platform_uzs + b.hotel_uzs + b.partner_uzs, b.total_uzs, "the provider is paid on the whole price");
  await status(s.core.checkVoucher(v.code), 409);
  await assert.rejects(s.core.book(req(s.l, { date: addDays(d, 7), voucher: v.code })), { code: "voucher" });
});

test("two bookings cannot spend the same balance; the second one's card money goes back", async () => {
  const s = await setup(), v = await bought(s, 300000), d = weekday(3);
  const a = await s.core.book(req(s.l, { date: d, guests: 2, voucher: v.code })), b = await s.core.book(req(s.l, { date: d, time: "15:00", guests: 2, voucher: v.code }));
  await s.payments.startBooking(a.token, "voucher");
  await status(s.payments.startBooking(b.token, "voucher"), 409); // the money is not there any more
  assert.equal((await s.core.guestBooking(b.token)).status, "pending");
  assert.equal((await s.core.voucher(v.token)).balance_uzs, 0);
});

test("a refunded booking gives the voucher's part back, once", async () => {
  const s = await setup(), v = await bought(s, 500000), d = weekday(5);
  const b = await s.core.book(req(s.l, { date: d, guests: 2, voucher: v.code }));
  await s.payments.startBooking(b.token, "voucher");
  assert.equal((await s.core.voucher(v.token)).balance_uzs, 200000);
  await s.core.cancel(b.token);
  assert.equal((await s.core.voucher(v.token)).balance_uzs, 500000);
  await s.payments.refundBooking((await s.core.byId(await s.core.bookingId(b.token))).id, "again");
  assert.equal((await s.core.voucher(v.token)).balance_uzs, 500000, "never more than once");
  // the provider declining also gives it back, including a mixed payment
  const m = await s.core.book(req(s.l, { date: addDays(d, 7), guests: 4, voucher: v.code }));
  await s.payTest(m.token);
  assert.equal((await s.core.voucher(v.token)).balance_uzs, 0);
  await s.core.decide(s.host.key, await s.core.bookingId(m.token), false);
  assert.equal((await s.core.voucher(v.token)).balance_uzs, 500000);
});

test("guests connect a booking to Telegram and get its updates there, in their language; a guest never becomes a provider", async () => {
  const sent = [], s = await serve({ env: { TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_BOT_NAME: "SilkRoadBot" }, telegram: async (chat, text) => { sent.push({ chat, text }); } });
  assert.equal((await s.get("/api/config")).telegramBot, "SilkRoadBot");
  const h = await s.core.createHost("Rustam"), l = await s.publishListing(h.key), b = await s.core.book(req(l, { lang: "de" }));
  const { url } = await (await s.post(`/api/bookings/${b.token}/telegram`, {})).json();
  assert.match(url, /^https:\/\/t\.me\/SilkRoadBot\?start=g_[A-Za-z0-9]{16,40}$/);
  const out = [], bot = createBot(s.core, async (chat, text) => out.push({ chat, text }));
  await bot({ message: { chat: { id: 77, type: "private" }, from: { first_name: "Anna" }, text: `/start ${url.split("start=")[1]}` } });
  assert.ok(out[0].text.startsWith(UI.tgOn.de));
  await bot({ message: { chat: { id: 78, type: "private" }, text: "/start g_unknowncode1234567" } });
  assert.equal(out[1].text, UI.tgBad.en);
  assert.equal((await s.db.one("SELECT COUNT(*) n FROM hosts")).n, 1, "no provider account was made for a guest");
  assert.equal((await s.core.guestBooking(b.token)).telegram, true);
  await s.payTest(b.token);
  await s.core.decide(h.key, await s.core.bookingId(b.token), true);
  assert.ok(await eventually(() => sent.some((m) => m.chat === "77" && m.text.includes(UI.confirmed.de))));
  const off = await serve();
  assert.equal((await off.post(`/api/bookings/${b.token}/telegram`, {})).status, 404, "only where a bot is configured");
});

test("the regional report counts real demand, hides income below three hosts, and refuses unknown regions", async () => {
  const s = await setup();
  for (let i = 0; i < 3; i++) await s.core.search({ region: "fargona", category: "pottery", lang: "de" });
  await s.core.search({ region: "fargona", category: "wood", lang: "ko" });
  await s.db.run("INSERT INTO searches (region,category,results,lang,source,demo) VALUES ('fargona','wood',0,'en','web',true)");
  const r = await s.metrics.regionReport("fargona", 90);
  assert.deepEqual([r.searches, r.unmet, r.categories[0].category, r.categories[0].unmet, r.host_income_uzs], [4, 1, "wood", 1, null]);
  await status(s.metrics.regionReport("atlantis"), 400);
  const http = await serve();
  assert.equal((await http.get("/api/panel/report?region=fargona")).name, "Farg‘ona");
});

test("payouts: bank details are checked, the list shows what is owed, and recording it is all or nothing", async () => {
  const s = await serve({ env: { ADMIN_KEY: "k".repeat(30) } }), h = await s.core.createHost("Rustam"), l = await s.publishListing(h.key);
  for (const bad of [{ account: "123", mfo: "00440" }, { account: "2020800000000000000x", mfo: "00440" }, { account: "20208000000000000001", mfo: "44" }]) await status(s.core.setBank(h.key, bad), 400);
  await s.core.setBank(h.key, { account: "2020 8000 0000 0000 0001", mfo: "00440", holder: "Rustam Usta" });
  assert.deepEqual((await s.core.account(h.key)).bank, { account: "20208000000000000001", mfo: "00440", holder: "Rustam Usta" });
  const b = await s.core.book(req(l, { date: day(1) }));
  await s.db.run("UPDATE payments SET provider='test'"); // test money counts on a test site
  await s.payTest(b.token);
  await s.core.decide(h.key, await s.core.bookingId(b.token), true);
  await s.db.run("UPDATE bookings SET date=current_date - 2");
  const [row] = await s.payments.payoutList();
  assert.deepEqual([row.account, row.amount_uzs > 0], ["20208000000000000001", true]);
  await assert.rejects(s.db.tx(async () => { for (const x of [row, { ...row, amount_uzs: 1 }]) await s.payments.recordPayout(x.id, x.amount_uzs, "BANK-1"); }), { status: 409 });
  assert.equal((await s.db.one("SELECT COUNT(*) n FROM payouts")).n, 0, "nothing is recorded when one line fails");
  await s.payments.recordPayout(row.id, row.amount_uzs, "BANK-1");
  assert.deepEqual(await s.payments.payoutList(), []);
  await settle();
});
