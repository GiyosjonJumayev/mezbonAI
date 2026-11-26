// Composition: domain + notifications + HTTP. main.mjs starts it; tests start it with their own database.
import { bookingNotice, telegramSender } from "./adapters/telegram.mjs";
import { asHost } from "./domain/accounts.mjs";
import { createDomain } from "./domain/index.mjs";
import { createMail } from "./domain/mail.mjs";
import { createPush } from "./domain/push.mjs";
import { createRates } from "./domain/rates.mjs";
import { createLive } from "./http/live.mjs";
import { createHttp } from "./http/server.mjs";

const uzDate = (d) => d.split("-").reverse().join(".");
/** What a provider reads on the lock screen. */
function hostNotice(b, type) {
  const who = `${b.guest_name}, ${b.guests} kishi, ${uzDate(b.date)}, ${b.time}`;
  if (type === "booking") return ["Yangi bron", who];
  if (type === "moved") return ["Mehmon vaqtni o‘zgartirdi", who];
  if (type === "cancelled") return ["Bron bekor qilindi", who];
  if (type === "unanswered") return ["Javob berilmagan bron rad etildi", who];
  return [`Xabar: ${b.guest_name}`, b.messages.findLast((m) => m.sender === "guest")?.translated ?? ""];
}

const PUSHED = new Set(["confirmed", "declined", "message"]);

export async function createApp({ db, config, pushSend, mailer, telegram = config.telegramToken ? telegramSender(config.telegramToken) : null, fetchFn = fetch }) {
  const domain = createDomain({ db, config, fetchFn }), { core, payments, admin, events } = domain;
  const push = await createPush({ db, contact: config.pushContact, ...(pushSend && { send: pushSend }) });
  const mail = createMail({ db, config, ...(mailer && { transport: mailer }) }), rates = await createRates({ db, config, fetchFn });
  const live = createLive(), http = createHttp({ ...domain, push, mail, rates, live });

  // Open pages hear that something changed, never what: they ask again for what they may see.
  const listed = async (lid) => (await db.one("SELECT unlisted FROM listings WHERE id=?", lid))?.unlisted === false;
  const bookingChanged = async (bid, lid) => { live.booking(bid); live.slots(lid, await listed(lid)); live.numbers(); };
  events.on("booking", ({ id, listing }) => bookingChanged(id, listing));
  events.on("slots", async ({ listing }) => live.slots(listing, await listed(listing)));
  events.on("listing", async ({ listing }) => { live.listing(listing, await listed(listing)); live.numbers(); });
  events.on("numbers", () => live.numbers());

  events.on("host", async ({ hostId, listing, ...ev }) => {
    http.push(hostId, ev);
    if (listing) await bookingChanged(ev.id, listing);
    const b = (await core.hostHome(asHost(hostId))).bookings.find((x) => x.id === ev.id);
    if (!b) return;
    const h = await db.one("SELECT telegram_chat, email FROM hosts WHERE id=?", hostId);
    await Promise.all([
      push.toHost(hostId, ...hostNotice(b, ev.type), "/mezbon#bronlar"),
      mail.queue(h.email, `${hostNotice(b, ev.type)[0]}: ${b.title}`, { title: hostNotice(b, ev.type)[0], lines: [b.title, hostNotice(b, ev.type)[1]], button: { text: "Kabinetni ochish", url: `${config.publicUrl}/mezbon#bronlar` } }),
      telegram && h.telegram_chat && Promise.resolve(telegram(h.telegram_chat, ...bookingNotice(b, ev.type))).catch(() => console.error("Telegram xabari yuborilmadi")),
    ]);
  });
  // The row may be older than the change it reports, so the newest one is read for the e-mail.
  events.on("guest", async ({ booking, type, text }) => {
    if (type !== "reminder") await bookingChanged(booking.id, booking.listing_id);
    if (PUSHED.has(type)) await push.toGuest(booking, type, text);
    await mail.guest((await core.byId(booking.id)) ?? booking, type, text);
  });

  const remind = async () => Promise.all((await core.takeReminders()).flatMap((b) => [push.toGuest(b, "reminder"), mail.guest(b, "reminder"), push.toHost(b.host_id, "Yaqin tashrif", `${b.guest_name}, ${b.guests} kishi, ${uzDate(b.date)}, ${b.time}`, "/mezbon#yordamchi")]));
  const openings = async () => {
    if (!mail.on) return 0;
    const list = await core.takeOpenings();
    for (const w of list) await mail.placeOpen(w);
    return list.length;
  };
  const jobs = [
    [2, "payments", payments.work],
    [2, "unanswered", core.declineUnanswered],
    [5, "reminders", remind],
    [1, "waitlist", openings],
    [1, "mail", mail.work],
    [24 * 60, "waitlist cleanup", core.cleanWaitlist],
    [6 * 60, "rates", rates.work],
    [60, "cleanup", admin.cleanup],
    [60, "stage", domain.stage.cleanStage],
    [24 * 60, "partners", domain.partners.cleanPartners],
    [24 * 60, "retention", admin.retention],
  ];
  const timers = [];
  function startJobs() {
    for (const [min, name, fn] of jobs) {
      let busy = false;
      const tick = async () => {
        if (busy) return;
        busy = true;
        try { await fn(); } catch (e) { console.error(`[${name}]`, e.code ?? e.message); } finally { busy = false; }
      };
      timers.push(setInterval(tick, min * 60e3).unref());
      tick();
    }
  }
  return { ...domain, push, mail, rates, live, remind, openings, server: http.server, startJobs, stopJobs: () => timers.forEach(clearInterval) };
}
