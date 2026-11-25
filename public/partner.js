// Letter of intent: read it, sign it, keep the link. The link is the only key to the letter.
import { act, api, ask, copy, el, som, toast } from "/common.js";
import { icon } from "/art.js";
import { demoBanner, themePicker } from "/pwa.js";

const app = document.getElementById("app"), page = (...kids) => app.replaceChildren(el("div.wrap", {}, ...kids));
document.getElementById("prefs").append(themePicker({ theme: "Mavzu", auto: "Avtomatik", light: "Yorug‘", dark: "Qorong‘i" }));
const day = (iso) => new Intl.DateTimeFormat("uz", { timeZone: "Asia/Tashkent", day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));
const STATE = { signed: ["Imzolandi. Jamoa qo‘ng‘iroq qiladi", ".warn"], verified: ["Qo‘ng‘iroq bilan tasdiqlangan", ".ok"], joined: ["Siz platformadasiz", ".ok"], rejected: ["Qabul qilinmadi", ""], withdrawn: ["Qaytarib olingan", ""] };
let cfg;

function letterPage(p) {
  const link = `${location.origin}/hamkor#xat/${p.token}`;
  page(el("div.row.between.noprint", {}, el("a.back", { href: "/hamkor", onclick: () => { location.hash = ""; } }, "Yangi xat"), el("span.badge" + STATE[p.status][1], {}, STATE[p.status][0])), el("h1", {}, "Niyat xati"),
    el("article.letter", {}, el("p", {}, p.letter), el("div.sign", {}, el("span", {}, `Imzo: ${p.signed_name}`), el("span", {}, day(p.created_at)))), el("code.print", {}, `SHA-256: ${p.letter_hash}`),
    el("div.row.noprint", {}, el("button.primary", { onclick: () => print() }, "Chop etish"), el("button", { onclick: async () => toast((await copy(link)) ? "Nusxalandi" : link) }, icon("share", 20), "Havolani nusxalash"),
      p.status !== "withdrawn" && el("button.danger", { onclick: act(async () => { if (await ask("Niyat xati qaytarib olinsinmi? Telefon va email o‘chiriladi.", "Qaytarib olish", "Yo‘q")) letterPage(await api(`/api/partners/${p.token}/withdraw`, {})); }) }, "Qaytarib olish")),
    el("p.small.muted.noprint", {}, "Havolani saqlang: xatni faqat shu havola orqali ochasiz yoki qaytarib olasiz."),
    p.kind === "host" && p.status !== "withdrawn" && el("div.card.noprint", {}, el("h2", {}, "Keyingi qadam"), el("p", {}, "Kabinet oching va hunaringiz haqida gapiring: taklifingiz 10 tilda tayyor bo‘ladi."), el("a.btn.primary", { href: "/mezbon" }, "Kabinet ochish")));
}

function form() {
  const kind = el("select", { onchange: () => sync() }, Object.entries(cfg.partnerKinds).map(([k, v]) => el("option", { value: k }, v)));
  const region = el("select", { required: true }, el("option", { value: "" }, "Tanlang"), Object.entries(cfg.regions).map(([k, v]) => el("option", { value: k }, v)));
  const name = el("input", { required: true, maxlength: 80, autocomplete: "organization" }), person = el("input", { required: true, maxlength: 80, autocomplete: "name" }), phone = el("input", { type: "tel", required: true, maxlength: 24, autocomplete: "tel", placeholder: "+998 90 123 45 67" }), email = el("input", { type: "email", maxlength: 120, autocomplete: "email" });
  const offer = el("textarea", { required: true, maxlength: 300, rows: 2 }), price = el("input", { type: "number", min: 1000, step: 1000, inputmode: "numeric" }), groups = el("input", { type: "number", min: 1, max: 100, inputmode: "numeric" });
  const commission = el("select", {}, cfg.commissions.map((c) => el("option", { value: c, selected: c === 12 }, c ? `${c}% gacha` : "Keyin kelishamiz")));
  const hostOnly = el("div.fields", {}, el("label", {}, "Bir kishi narxi, so‘m", price), el("label", {}, "Haftasiga nechta guruh", groups)), offerLabel = el("span");
  const sync = () => { const h = kind.value === "host"; hostOnly.hidden = !h; offerLabel.textContent = h ? "Mehmonga nima taklif qilasiz" : "Qanday hamkorlik qilasiz"; offer.placeholder = h ? "Masalan: loydan lagan yasash darsi, 2 soat" : "Masalan: qabulxonaga QR kod qo‘yamiz va mehmonlarga tavsiya qilamiz"; };
  sync();
  const data = () => ({ kind: kind.value, region: region.value, name: name.value, signed_name: person.value, offer: offer.value, price_uzs: kind.value === "host" && price.value ? Number(price.value) : null, groups_week: kind.value === "host" && groups.value ? Number(groups.value) : null, max_commission: Number(commission.value) });
  const out = el("div", { "aria-live": "polite" });
  const preview = act(async () => {
    const body = data(), { letter } = await api("/api/partners/preview", body), agree = el("input", { type: "checkbox" });
    const sign = act(async () => {
      if (!agree.checked) throw new Error("Avval roziligingizni belgilang");
      const p = await api("/api/partners", { ...body, letter, agree: true, phone: phone.value, email: email.value || null });
      history.replaceState(null, "", `/hamkor#xat/${p.token}`);
      letterPage(p);
      scrollTo(0, 0);
    });
    out.replaceChildren(el("section.card", {}, el("h2", {}, "Xat matni"), el("article.letter", {}, el("p", {}, letter)), el("label.check", {}, agree, el("span", {}, "Matnni o‘qidim va roziman")), el("button.primary", { onclick: sign }, "Imzolash")));
    out.scrollIntoView({ block: "nearest" });
  });
  page(el("div.two", {}, el("div.stack", { style: "gap:18px" }, el("h1", {}, "Birinchi hamkorlardan bo‘ling"), el("p.muted", {}, "Niyat xati sizni majburlamaydi. U biz uchun muhim: shu bilan qaysi hududda, qanday narxda boshlashni bilamiz."),
      el("ul.promise", {}, [["check", "Shartnoma emas, istalgan vaqtda qaytarib olasiz"], ["shield", "Telefoningiz hech kimga ko‘rsatilmaydi, faqat jamoa qo‘ng‘iroq qiladi"], ["chart", "Investorlarga faqat jami son ko‘rsatiladi"]].map(([i, x]) => el("li", {}, icon(i, 26), x)))),
    el("form.card", { onsubmit: (e) => { e.preventDefault(); preview({ currentTarget: e.submitter }); } }, el("h2", {}, "Ma’lumotlaringiz"), el("div.fields", {}, el("label", {}, "Siz kimsiz", kind), el("label", {}, "Viloyat", region)), el("label", {}, "Hunar, uy yoki tashkilot nomi", name), el("label", {}, offerLabel, offer), hostOnly, el("label", {}, "Komissiya qancha bo‘lsa rozisiz", commission), el("div.fields", {}, el("label", {}, "To‘liq ismingiz", person), el("label", {}, "Telefon", phone), el("label", {}, "Email (ixtiyoriy)", email)), el("button.primary", { type: "submit" }, "Xatni ko‘rish"))), out);
}

async function open() {
  const token = /^#xat\/([\w-]{20,64})$/.exec(location.hash)?.[1];
  if (token) letterPage(await api(`/api/partners/${token}`)); else form();
}
addEventListener("hashchange", () => open().catch((e) => toast(e.message, true)));
try { cfg = await api("/api/config"); demoBanner(cfg, "Namoyish sayti: bu yerda haqiqiy ma’lumot yozmang."); await open(); } catch (e) { page(el("div.note.bad", { role: "alert" }, e.message), el("a.btn", { href: "/hamkor" }, "Qaytadan")); }
