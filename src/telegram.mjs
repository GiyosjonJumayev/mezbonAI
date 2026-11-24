// Telegram bot for hosts (long polling). Runs alongside the web server; both use the same database.
import { pathToFileURL } from "node:url";
import { openDb } from "./db.mjs";
import { createCore } from "./core.mjs";
import { REGIONS } from "./i18n.mjs";
import { extractFacts, norm } from "./extract.mjs";

const ASK = {
  price_uzs: "So‘mda yozing, masalan: 150000",
  duration_min: "Daqiqada yozing, masalan: 120",
  capacity: "Raqam bilan yozing, masalan: 8",
  region: "Masalan: Farg‘ona",
  cert_no: "Sertifikat raqamini yozing",
};
const regionOf = (t) => Object.keys(REGIONS).find((k) => norm(REGIONS[k]) === norm(t)) ?? extractFacts(t).region;

export function createBot(core, send, { baseUrl = "http://localhost:4321" } = {}) {
  const waiting = new Map(); // chat → { lid, field }

  function next(chat, l) {
    const gap = l.missing[0];
    if (gap) {
      waiting.set(chat, { lid: l.id, field: gap.field });
      return send(chat, `${gap.text}\n${ASK[gap.field]}`);
    }
    waiting.delete(chat);
    return send(chat, `Tayyor. Tekshirib tasdiqlang:\n\n${l.i18n.uz.title}\n${l.i18n.uz.description}\nNarx: ${l.price_uzs.toLocaleString("ru-RU")} so‘m / kishi\nTillar: ${Object.keys(l.i18n).length} ta`,
      [[{ text: "E’lon qilish", callback_data: `pub:${l.id}` }]]);
  }

  return async function handle(u) {
    const msg = u.message ?? u.callback_query?.message;
    if (!msg || (msg.chat.type && msg.chat.type !== "private")) return;
    const chat = String(msg.chat.id);
    const from = u.message?.from ?? u.callback_query?.from;
    const host = core.hostByTelegram(chat) ?? core.createHost((from?.first_name || "Mezbon").slice(0, 60), { telegramChat: chat });
    try {
      if (u.callback_query) {
        const [act, lid] = String(u.callback_query.data).split(":");
        if (act === "acc" || act === "dec") {
          core.decide(host.key, lid, act === "acc");
          return await send(chat, act === "acc" ? "Bron qabul qilindi" : "Bron rad etildi");
        }
        if (act !== "pub") return;
        core.publish(host.key, lid);
        return await send(chat, `E’lon qilindi: ${baseUrl}/?l=${lid}`);
      }
      if (msg.voice) return await send(chat, "Bu versiyada ovozli xabar matnga aylantirilmaydi. Klaviaturadagi mikrofon orqali aytib, matn qilib yuboring.");
      const text = msg.text?.trim();
      if (!text) return;
      if (text === "/start") {
        waiting.delete(chat);
        return await send(chat, "Assalomu alaykum! Nima o‘rgatasiz, qayerda, qancha vaqt, narxi va necha kishi? Bir xabarda yozing.\nMasalan: Rishtonda kulolman, ikki soat, 150 ming so‘m, 8 kishi");
      }
      const w = waiting.get(chat);
      if (w) {
        const value = w.field === "cert_no" ? text : w.field === "region" ? regionOf(text) : Number(text.replace(/\D/g, ""));
        return await next(chat, core.updateListing(host.key, w.lid, { [w.field]: value }));
      }
      await send(chat, "Tayyorlayapman…");
      return await next(chat, await core.createDraft(host.key, text));
    } catch (e) {
      if (!e.status) console.error(e);
      return send(chat, e.status ? e.message : "Xato yuz berdi, qayta urinib ko‘ring");
    }
  };
}

/** Sent by the web server when a Telegram host gets a paid booking or a guest message. */
export function bookingNotice(b, type) {
  if (type === "booking") return [`Yangi bron: ${b.title}\n${b.guest_name}, ${b.guests} kishi\n${b.date}, soat ${b.time}\nSizga: ${b.host_uzs.toLocaleString("ru-RU")} so‘m`,
    [[{ text: "Qabul qilish", callback_data: `acc:${b.id}` }, { text: "Rad etish", callback_data: `dec:${b.id}` }]]];
  if (type === "cancelled") return [`Bron bekor qilindi: ${b.title}\n${b.guest_name}, ${b.date}, soat ${b.time}`];
  return [`Mehmondan xabar (${b.guest_name}): ${b.messages.findLast((m) => m.sender === "guest")?.translated ?? ""}`];
}

export const telegramSender = (token) => async (chat_id, text, keyboard) =>
  (await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text, ...(keyboard && { reply_markup: { inline_keyboard: keyboard } }) }),
  })).json();

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN .env faylida yo‘q");
    process.exit(1);
  }
  const tg = async (method, body) => (await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  const handle = createBot(createCore(openDb()), telegramSender(token),{ baseUrl: process.env.MEZBON_URL });
  const pause = () => new Promise((s) => setTimeout(s, 5000));
  console.log("Telegram bot ishga tushdi");
  let offset = 0;
  for (;;) {
    try {
      const r = await tg("getUpdates", { offset, timeout: 30 });
      if (!r.ok) {
        console.error("Telegram:", r.description);
        await pause();
        continue;
      }
      for (const u of r.result) {
        offset = u.update_id + 1;
        if (u.callback_query) await tg("answerCallbackQuery", { callback_query_id: u.callback_query.id });
        await handle(u);
      }
    } catch (e) {
      console.error("Telegram ulanish xatosi:", e.cause?.code ?? e.name);
      await pause();
    }
  }
}
