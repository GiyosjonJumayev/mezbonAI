// Composition: domain + notifications + HTTP. main.mjs starts it; tests start it with their own database.
import { bookingNotice, telegramSender } from "./adapters/telegram.mjs";
import { asHost } from "./domain/accounts.mjs";
import { createDomain } from "./domain/index.mjs";
import { createPush } from "./domain/push.mjs";
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

export async function createApp({ db, config, pushSend, telegram = config.telegramToken ? telegramSender(config.telegramToken) : null, fetchFn }) {
  const domain = createDomain({ db, config, fetchFn }), { core, payments, admin, events } = domain;
  const push = await createPush({ db, contact: config.pushContact, ...(pushSend && { send: pushSend }) });
  const http = createHttp({ ...domain, push });

  events.on("host", async ({ hostId, ...ev }) => {
    http.push(hostId, ev);
    const b = (await core.hostHome(asHost(hostId))).bookings.find((x) => x.id === ev.id);
    if (!b) return;
    const h = await db.one("SELECT telegram_chat FROM hosts WHERE id=?", hostId);
    await Promise.all([
      push.toHost(hostId, ...hostNotice(b, ev.type), "/mezbon#bronlar"),
      telegram && h.telegram_chat && Promise.resolve(telegram(h.telegram_chat, ...bookingNotice(b, ev.type))).catch(() => console.error("Telegram xabari yuborilmadi")),
    ]);
  });
  events.on("guest", ({ booking, type, text }) => push.toGuest(booking, type, text));

  const remind = async () => Promise.all((await core.takeReminders()).flatMap((b) => [push.toGuest(b, "reminder"), push.toHost(b.host_id, "Yaqin tashrif", `${b.guest_name}, ${b.guests} kishi, ${uzDate(b.date)}, ${b.time}`, "/mezbon#yordamchi")]));
  const jobs = [
    [2, "payments", payments.work],
    [2, "unanswered", core.declineUnanswered],
    [5, "reminders", remind],
    [60, "cleanup", admin.cleanup],
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
  return { ...domain, push, remind, server: http.server, startJobs, stopJobs: () => timers.forEach(clearInterval) };
}
