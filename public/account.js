// Sign-in, passkeys, devices and payouts for providers. The session itself is an HttpOnly cookie this code never sees.
import { act, api, ask, copy, el, som, store, toast } from "/common.js";
import { icon } from "/art.js";
import { enablePush, pushSupported } from "/pwa.js";

const bytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer;
const text = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const passkeys = () => window.isSecureContext && "PublicKeyCredential" in window;
const quiet = (e) => { if (e.name === "NotAllowedError" || e.name === "AbortError") throw new Error("Bekor qilindi yoki vaqt tugadi"); if (e.name === "InvalidStateError") throw new Error("Bu qurilmada passkey allaqachon bor"); throw e; };

/** Opens the studio with the fingerprint, face or PIN of this device. */
export async function passkeyLogin() {
  const { id, options } = await api("/api/auth/passkey/options", {});
  const c = await navigator.credentials.get({ publicKey: { ...options, challenge: bytes(options.challenge), allowCredentials: [] } }).catch(quiet);
  return api("/api/auth/passkey", { id, response: { id: c.id, rawId: text(c.rawId), type: c.type, clientExtensionResults: {}, response: { clientDataJSON: text(c.response.clientDataJSON), authenticatorData: text(c.response.authenticatorData), signature: text(c.response.signature), userHandle: c.response.userHandle ? text(c.response.userHandle) : undefined } } });
}
export async function passkeyAdd() {
  const { id, options: o } = await api("/api/host/passkeys/options", {});
  const c = await navigator.credentials.create({ publicKey: { ...o, challenge: bytes(o.challenge), user: { ...o.user, id: bytes(o.user.id) }, excludeCredentials: (o.excludeCredentials ?? []).map((x) => ({ ...x, id: bytes(x.id) })) } }).catch(quiet);
  await api("/api/host/passkeys", { id, response: { id: c.id, rawId: text(c.rawId), type: c.type, clientExtensionResults: {}, response: { clientDataJSON: text(c.response.clientDataJSON), attestationObject: text(c.response.attestationObject), transports: c.response.getTransports?.() ?? [] } } });
}

/** Signs in with a link or with the key an earlier version kept in this browser. Returns true when something worked. */
export async function enter(current) {
  const m = /^#kirish=([\w-]{10,64})$/.exec(location.hash)?.[1], old = store.get("hostKey");
  if (m) history.replaceState(null, "", "/mezbon"); // the secret must not stay in the address bar or history
  // Someone else's link must not silently move a provider into another account.
  if (m && current && !(await ask(`Siz “${current}” kabinetidasiz. Havoladagi kabinetga o‘tilsinmi?`, "O‘tish", "Qolish"))) return false;
  for (const s of [m, old].filter(Boolean)) {
    try {
      await api(s.startsWith("l_") ? "/api/auth/link" : "/api/auth/key", s.startsWith("l_") ? { token: s } : { key: s });
      store.set("hostKey", null);
      return true;
    } catch (e) {
      if (e.status !== 401) throw e;
      if (s === old) store.set("hostKey", null);
      if (s === m) toast("Kirish havolasi eskirgan yoki ishlatilgan", true);
    }
  }
  return false;
}

const loginUrl = (key) => `${location.origin}/mezbon#kirish=${key}`;
/** Shown once, right after the account or a new key is made: the server keeps only a hash. */
export function keyCard(key, name, done) {
  const link = loginUrl(key);
  const save = () => {
    const a = el("a", { href: URL.createObjectURL(new Blob([`SilkRoad Experience OS\r\n${name}\r\nKirish havolasi (hech kimga bermang):\r\n${link}\r\n`], { type: "text/plain" })), download: "silkroad-kirish.txt" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return el("section.card.keycard", {}, el("div.row", {}, icon("key", 26), el("h2", {}, "Zaxira kirish havolangizni saqlang")), el("p", {}, "U faqat hozir ko‘rsatiladi. Telefon yo‘qolsa yoki passkey ishlamasa, kabinetga shu havola orqali qaytasiz. Hech kimga bermang."),
    el("code.secret", { dir: "ltr" }, link),
    el("div.row", {}, el("button.primary", { onclick: async () => toast((await copy(link)) ? "Nusxalandi" : "Nusxalab bo‘lmadi", false) }, "Nusxalash"), el("button", { onclick: save }, "Faylga saqlash"), el("button.ghost", { onclick: async () => { if (await ask("Havolani saqladingizmi? Uni qayta ko‘rsatib bo‘lmaydi.", "Saqladim", "Yo‘q")) done(); } }, "Saqladim, yopish")));
}

const when = (iso) => new Intl.DateTimeFormat("uz", { timeZone: "Asia/Tashkent", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const card = (title, ...kids) => el("section.card", {}, el("h2", {}, title), ...kids);

function contact(a, cfg, load) {
  const phone = el("input", { type: "tel", maxlength: 24, autocomplete: "tel", value: a.phone ?? "", placeholder: "+998 90 123 45 67" }), email = el("input", { type: "email", maxlength: 120, autocomplete: "email", value: a.email ?? "" });
  return el("div.stack", {}, el("label", {}, "Telefon (faqat tasdiqlangan mehmonga ko‘rinadi)", phone), el("div", {}, el("button", { onclick: act(async () => { await api("/api/host/contact", { phone: phone.value }); toast("Saqlandi"); await load(); }) }, "Telefonni saqlash")),
    cfg.mail && [el("label", {}, "Email (bron xabarlari va kirish havolasi uchun)", email), el("div", {}, el("button", { onclick: act(async () => { await api("/api/host/email", { email: email.value }); toast(email.value.trim() ? "Tasdiqlash havolasi emailingizga yuborildi" : "Email olib tashlandi"); await load(); }) }, "Emailni saqlash"))]);
}

/** The settings tab. Loads its own data. */
/** Where payouts go: a 20-digit account and the bank's 5-digit code (MFO). */
function bank(a, load) {
  const account = el("input", { inputmode: "numeric", maxlength: 24, autocomplete: "off", value: a.bank?.account ?? "", placeholder: "20 ta raqam", "aria-describedby": "bank-why" }), mfo = el("input", { inputmode: "numeric", maxlength: 5, autocomplete: "off", value: a.bank?.mfo ?? "", placeholder: "00000" }), holder = el("input", { maxlength: 80, autocomplete: "name", value: a.bank?.holder ?? "" });
  return el("form.stack", { style: "gap:12px", onsubmit: (e) => { e.preventDefault(); act(async () => { await api("/api/host/bank", { account: account.value, mfo: mfo.value, holder: holder.value }); toast("Bank ma’lumoti saqlandi"); await load(); })({ currentTarget: e.submitter }); } },
    el("p.small.muted", { id: "bank-why" }, "Pul shu hisobga bank orqali o‘tkaziladi. Karta raqami emas: bankdagi 20 xonali hisob raqami."),
    el("label", {}, "Hisob raqami", account), el("div.fields", {}, el("label", {}, "Bank kodi (MFO)", mfo), el("label", {}, "Kimning nomida", holder)), el("button", { type: "submit" }, "Saqlash"));
}

export function account({ home, cfg, planName, onKey, signOut, redraw }) {
  const box = el("div.stack", { style: "gap:22px" }, el("p.muted", { role: "status" }, "Yuklanmoqda…"));
  const load = async () => {
    const [a, money] = await Promise.all([api("/api/host/account"), api("/api/host/balance")]);
    const list = (rows) => el("ul.plain", {}, rows.map((r) => el("li.row.between", {}, ...r)));
    box.replaceChildren(el("div.stack", { style: "gap:22px" },
      a.suspended && el("div.note.bad", { role: "alert" }, "Hisobingiz ma’muriyat tomonidan to‘xtatilgan. Yangi bron qabul qilinmaydi, mavjud bronlar saqlanadi."),
      el("div.two", {},
        el("div.stack", { style: "gap:22px" },
          card("Passkey bilan kirish", el("p", {}, "Barmoq izi, yuz yoki PIN bilan kirasiz. Parol yo‘q, uni o‘g‘irlab bo‘lmaydi."),
            a.passkeys.length > 0 && list(a.passkeys.map((p) => [el("span", {}, `Qo‘shilgan: ${when(p.created_at)}`), el("button.danger.mini.text", { onclick: act(async () => { if (await ask("Bu passkey o‘chirilsinmi?", "O‘chirish", "Yo‘q")) { await api("/api/host/passkeys/remove", { id: p.id }); await load(); } }) }, "O‘chirish")])),
            passkeys() ? el("button.primary", { onclick: act(async () => { await passkeyAdd(); toast("Passkey qo‘shildi"); await load(); }) }, icon("key", 20), a.passkeys.length ? "Yana qo‘shish" : "Passkey qo‘shish") : el("p.small.muted", {}, "Bu brauzer yoki ulanish (HTTPS emas) passkey’ni qo‘llamaydi.")),
          card("Qurilmalar", list(a.sessions.map((s) => [el("span", {}, s.label || "Brauzer"), el("span.small.muted", {}, when(s.created_at))])),
            el("div.row", {}, el("button", { onclick: act(async () => { if (await ask(a.passkeys.length ? "Bu qurilmadan chiqasizmi?" : "Passkey yo‘q. Zaxira havolani saqlamagan bo‘lsangiz, qaytib kira olmaysiz. Chiqasizmi?", "Chiqish", "Qolish")) await signOut(); }) }, "Chiqish"),
              el("button.danger", { onclick: act(async () => { if (!(await ask("Barcha qurilmalar chiqariladi, eski zaxira havola va taqvim havolasi ishlamay qoladi. Davom etasizmi?", "Davom etish", "Yo‘q"))) return; onKey((await api("/api/auth/rotate", {})).key); await load(); }) }, "Hammasidan chiqish va yangi havola"))),
          card("Taqvim", el("p", {}, "Bronlarni Google, Apple yoki Outlook taqvimida ko‘ring. Havola maxfiy; yangisi eskisini bekor qiladi."), el("button", { onclick: act(async () => { if (a.calendar && !(await ask("Yangi havola eskisini bekor qiladi. Davom etasizmi?", "Davom etish", "Yo‘q"))) return; const { url } = await api("/api/host/calendar-link", {}); toast((await copy(url)) ? "Taqvim havolasi nusxalandi" : url); a.calendar = true; }) }, icon("calendar", 20), a.calendar ? "Yangi taqvim havolasi" : "Taqvim havolasini olish"))),
        el("div.stack", { style: "gap:22px" },
          card("Aloqa", contact(a, cfg, load)),
          card("Bank hisobi", bank(a, load)),
          card("Pulingiz", el("dl.sum", {}, [["To‘lashga tayyor", money.available], ["Kelgusi tashriflar", money.upcoming], ["To‘langan", money.paid_out]].map(([k, v], i) => [el("dt" + (i ? "" : ".all"), {}, k), el("dd" + (i ? "" : ".all"), {}, som(v))])),
            el("p.small.muted", {}, "Tashrif chipta bilan tasdiqlangach yoki 24 soat o‘tgach pul tayyor bo‘ladi. O‘tkazmani ma’muriyat bank orqali qiladi."), cfg.testPayments && el("div.note.warn", {}, "Sinov rejimi: bu haqiqiy pul emas."),
            money.payouts.length > 0 && list(money.payouts.map((p) => [el("span", {}, som(p.amount_uzs)), el("span.small.muted", {}, `${when(p.created_at)} · ${p.reference}`)]))),
          card("Bildirishnomalar", el("p", {}, "Ilova yopiq bo‘lsa ham yangi bron, xabar va yaqin tashrif haqida bilasiz."), pushSupported() ? el("button", { onclick: act(async () => { if (await enablePush({ path: "/api/push/host" })) { store.set("pushOn", "1"); toast("Bildirishnoma yoqildi"); redraw(); } else toast("Brauzer bildirishnomani to‘sgan. Sozlamadan ruxsat bering", true); }) }, icon("bell", 20), store.get("pushOn") ? "Yoqilgan. Qayta ulash" : "Bildirishnomani yoqish") : el("p.small.muted", {}, "Bu brauzer qo‘llamaydi. Telefonda HTTPS va zamonaviy brauzer kerak.")),
          card("Biznes ma’lumotlari", a.verified ? el("span.verified", {}, icon("shield", 18), "Tekshirilgan mezbon") : el("p.small.muted", {}, "Tekshirilgan belgisi ma’muriyat hujjatlaringizni ko‘rgach beriladi."), el("dl.sum", {}, [["Faoliyat turi", cfg.providerTypes[home.type].uz], ["Tarif", planName], ["Saytdan yoki AI orqali bron", `${100 - home.plan.commission}% sizga`], ["Mehmonxona QR orqali bron", `${100 - home.plan.commission - cfg.hotelFee}% sizga`]].map(([k, v]) => [el("dt", {}, k), el("dd.all", {}, v)]))))),
    ));
  };
  load().catch((e) => box.replaceChildren(el("div.note.bad", { role: "alert" }, e.message)));
  return box;
}
