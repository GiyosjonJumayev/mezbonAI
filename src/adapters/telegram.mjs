// Telegram bot for providers (long polling), started by the web server when a bot token is configured.
// Guests can also connect a booking to get its updates here.
import { LANGS, UI } from "../lib/i18n.mjs";
import { asHost } from "../domain/accounts.mjs";
import { REGIONS } from "../lib/i18n.mjs";
import { extractFacts, norm } from "../ai/extract.mjs";

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
    try {
      // A guest connecting a booking: never treated as a provider.
      const guest = /^\/start g_([A-Za-z0-9]{16,40})$/.exec((msg.text ?? "").trim());
      if (guest) {
        const b = await core.linkGuestChat(guest[1], chat);
        const t = (k) => UI[k][b && LANGS.includes(b.lang) ? b.lang : "en"];
        return await send(chat, b ? `${t("tgOn")}\n${b.i18n[b.lang]?.title ?? b.i18n.en.title}\n${baseUrl}/?b=${b.token}` : t("tgBad"));
      }
      const host = (await core.hostByTelegram(chat)) ?? (await core.createHost((from?.first_name || "Mezbon").slice(0, 60), { telegramChat: chat })), me = asHost(host.id);
      if (u.callback_query) {
        const [act, lid] = String(u.callback_query.data).split(":");
        if (act === "acc" || act === "dec") {
          await core.decide(me, lid, act === "acc");
          return await send(chat, act === "acc" ? "Bron qabul qilindi" : "Bron rad etildi");
        }
        if (act !== "pub") return;
        await core.publish(me, lid);
        return await send(chat, `E’lon qilindi: ${baseUrl}/?l=${lid}`);
      }
      if (msg.voice) return await send(chat, "Bu versiyada ovozli xabar matnga aylantirilmaydi. Klaviaturadagi mikrofon orqali aytib, matn qilib yuboring.");
      const text = msg.text?.trim();
      if (!text) return;
      if (text === "/start") {
        waiting.delete(chat);
        return await send(chat, "Assalomu alaykum! Nima o‘rgatasiz, qayerda, qancha vaqt, narxi va necha kishi? Bir xabarda yozing.\nMasalan: Rishtonda kulolman, ikki soat, 150 ming so‘m, 8 kishi\n\nVeb-kabinetga kirish: /kirish");
      }
      if (text === "/kirish") return await send(chat, `Kabinetga kirish havolasi. 15 daqiqa ichida va faqat bir marta ishlaydi, uni hech kimga yubormang:\n${baseUrl}/mezbon#kirish=${await core.loginLink(me)}`);
      const w = waiting.get(chat);
      if (w) {
        const value = w.field === "cert_no" ? text : w.field === "region" ? regionOf(text) : Number(text.replace(/\D/g, ""));
        return await next(chat, await core.updateListing(me, w.lid, { [w.field]: value }));
      }
      await send(chat, "Tayyorlayapman…");
      return await next(chat, await core.createDraft(me, text));
    } catch (e) {
      if (!e.status) console.error(e);
      return send(chat, e.status ? e.message : "Xato yuz berdi, qayta urinib ko‘ring");
    }
  };
}

/** Sent by the web server when a Telegram host gets a paid booking or a guest message. */
export function bookingNotice(b, type) {
  if (type === "booking" || type === "moved") return [`${type === "moved" ? "Mehmon vaqtni o‘zgartirdi" : "Yangi bron"}: ${b.title}\n${b.guest_name}, ${b.guests} kishi\n${b.date}, soat ${b.time}\nSizga: ${b.host_uzs.toLocaleString("ru-RU")} so‘m`,
    [[{ text: "Qabul qilish", callback_data: `acc:${b.id}` }, { text: "Rad etish", callback_data: `dec:${b.id}` }]]];
  if (type === "unanswered") return [`Javob berilmagani uchun bron rad etildi va pul qaytarildi: ${b.title}\n${b.guest_name}, ${b.date}, soat ${b.time}`];
  if (type === "cancelled") return [`Bron bekor qilindi: ${b.title}\n${b.guest_name}, ${b.date}, soat ${b.time}`];
  return [`Mehmondan xabar (${b.guest_name}): ${b.messages.findLast((m) => m.sender === "guest")?.translated ?? ""}`];
}

export const telegramSender = (token) => async (chat_id, text, keyboard) =>
  (await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text, ...(keyboard && { reply_markup: { inline_keyboard: keyboard } }) }),
  })).json();

/** Reads updates until `signal` is aborted. Only one server may poll a bot at a time. */
export async function runBot(core, token, { baseUrl, signal }) {
  const tg = async (method, body) => (await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]) })).json();
  const handle = createBot(core, telegramSender(token), { baseUrl });
  const pause = () => new Promise((s) => setTimeout(s, 5000).unref());
  let offset = 0;
  while (!signal.aborted) {
    try {
      const r = await tg("getUpdates", { offset, timeout: 30 });
      if (!r.ok) { console.error("Telegram:", r.description); await pause(); continue; }
      for (const u of r.result) {
        offset = u.update_id + 1;
        if (u.callback_query) await tg("answerCallbackQuery", { callback_query_id: u.callback_query.id });
        await handle(u);
      }
    } catch (e) {
      if (signal.aborted) return;
      console.error("Telegram ulanish xatosi:", e.cause?.code ?? e.name);
      await pause();
    }
  }
}
