// Administration console. The session is an HttpOnly cookie that ends after eight hours.
import { PAY_NAME, act, api, ask, copy, el, som, toast } from "/common.js";
import { icon } from "/art.js";
import { themePicker } from "/pwa.js";

const app = document.getElementById("app"), prefs = document.getElementById("prefs");
const page = (...kids) => app.replaceChildren(el("div.wrap", {}, ...kids));
const when = (iso) => new Intl.DateTimeFormat("uz", { timeZone: "Asia/Tashkent", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const theme = themePicker({ theme: "Mavzu", auto: "Avtomatik", light: "Yorug‘", dark: "Qorong‘i" });
const PROVIDER = { ...PAY_NAME, octo: "Octo", test: "Sinov", credit: "Hisobdan" };
const PAY_STATUS = { created: ["Kutilmoqda", ".warn"], paid: ["To‘langan", ".ok"], cancelled: ["Bekor", ""], failed: ["Xato", ".bad"], refund_due: ["Qaytarish kerak", ".bad"], refunded: ["Qaytarilgan", ""] };
const REASON = { unsafe: "Xavfli yoki noqonuniy", false: "Noto‘g‘ri ma’lumot", offensive: "Haqoratli", other: "Boshqa" };
const ACTION = { payment_paid: "To‘lov keldi", refund_due: "Qaytarish navbatga qo‘yildi", refunded: "Pul qaytarildi", payout: "O‘tkazma yozildi", host_verified: "Mezbon tekshirildi", host_unverified: "Tekshiruv bekor qilindi", host_suspended: "Mezbon to‘xtatildi", host_restored: "Mezbon tiklandi", listing_blocked: "Taklif to‘xtatildi", listing_unblocked: "Taklif ochildi", report_resolved: "Shikoyat yopildi", recovery_link: "Tiklash havolasi", key_rotated: "Kalit almashtirildi", passkey_added: "Passkey qo‘shildi", passkey_removed: "Passkey o‘chirildi", calendar_link: "Taqvim havolasi", anonymized: "Shaxsiy ma’lumot o‘chirildi" };
const table = (label, head, rows) => el("div.scroll.tall", { tabindex: 0, role: "region", "aria-label": label }, el("table", {}, el("thead", {}, el("tr", {}, head.map((h) => el("th", { scope: "col" }, h)))), el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c) => el("td", {}, c)))))));
const card = (title, ...kids) => el("section.card", {}, el("h2", {}, title), ...kids);
const explain = (e) => { if (e.status === 401) login(); return e.message; };
const run = (fn) => act(fn, explain);

function login() {
  prefs.replaceChildren(theme);
  const key = el("input", { type: "password", required: true, autocomplete: "current-password", maxlength: 200 });
  const go = run(async () => { await api("/api/admin/login", { key: key.value }); key.value = ""; await start(); });
  page(el("form.card", { style: "max-width:460px;margin-inline:auto;width:100%", onsubmit: (e) => { e.preventDefault(); go({ currentTarget: e.submitter }); } }, el("h1", {}, "Ma’muriyat"), el("label", {}, "Ma’muriyat kaliti", key), el("button.primary", { type: "submit" }, icon("key", 20), "Kirish"), el("p.small.muted", {}, "Kalit serverdagi ADMIN_KEY sozlamasida turadi.")));
}

let q = "";
const post = (path, body = {}) => api(`/api/admin/${path}`, body);

async function hosts(box) {
  const rows = await api(`/api/admin/hosts?q=${encodeURIComponent(q)}`);
  const change = (text, path, body, yes) => run(async () => { if (text && !(await ask(text, yes, "Yo‘q"))) return; await post(path, body); await start(); });
  box.replaceChildren(rows.length ? table("Mezbonlar", ["Mezbon", "Holati", "Takliflar", "To‘lashga tayyor", "Amallar"], rows.map((h) => [
    el("div", {}, el("b", {}, h.name), el("div.small.muted", {}, h.id, h.demo && " · namuna", h.certificates && ` · sertifikat: ${h.certificates}`)),
    el("div.row", {}, h.verified_at && el("span.badge.ok", {}, "Tekshirilgan"), h.suspended_at && el("span.badge.bad", {}, "To‘xtatilgan"), !h.verified_at && !h.suspended_at && el("span.badge", {}, "Yangi")),
    String(h.listings), som(h.balance.available),
    el("div.row", {},
      el("button.mini.text", { onclick: change(h.verified_at ? "Tekshirilgan belgisi olib tashlansinmi?" : `${h.name}: hujjatlarni ko‘rib, tasdiqlaysizmi?`, `hosts/${h.id}/verify`, { on: !h.verified_at }, h.verified_at ? "Olib tashlash" : "Tasdiqlash") }, h.verified_at ? "Belgini olish" : "Tekshirildi"),
      h.balance.available > 0 && el("button.mini.text", { onclick: () => payout(h) }, "O‘tkazma"),
      el("button.mini.text", { onclick: run(async () => { if (!(await ask(`${h.name} shaxsini tekshirdingizmi? Havola 15 daqiqa va bir marta ishlaydi.`, "Havola yaratish", "Yo‘q"))) return; const { url } = await post(`hosts/${h.id}/recovery`); toast((await copy(url)) ? "Tiklash havolasi nusxalandi" : url); }) }, "Tiklash havolasi"),
      el("button.mini.text" + (h.suspended_at ? "" : ".danger"), { onclick: change(h.suspended_at ? "Mezbon qayta tiklansinmi?" : `${h.name} to‘xtatilsinmi? Takliflari sotuvdan olinadi, bronlari saqlanadi.`, `hosts/${h.id}/suspend`, { on: !h.suspended_at }, h.suspended_at ? "Tiklash" : "To‘xtatish") }, h.suspended_at ? "Tiklash" : "To‘xtatish")),
  ])) : el("p.muted", {}, "Topilmadi."));
}

function payout(h) {
  const amount = el("input", { type: "number", min: 1, max: h.balance.available, value: h.balance.available, required: true, inputmode: "numeric" }), ref = el("input", { maxlength: 80, required: true, placeholder: "Bank hujjati raqami" });
  const d = el("dialog", { "aria-label": "O‘tkazma" }, el("form.stack", { onsubmit: (e) => { e.preventDefault(); save({ currentTarget: e.submitter }); } }, el("h2", {}, `${h.name}: o‘tkazma`), el("p", {}, "Avval pulni bank orqali o‘tkazing. Bu yerda faqat yozib qo‘yiladi, server pul yubormaydi."), el("label", {}, "Summa, so‘m", amount), el("label", {}, "Bank to‘lov raqami", ref), el("div.row", {}, el("button", { type: "button", onclick: () => d.close() }, "Yopish"), el("button.primary", { type: "submit" }, "Yozib qo‘yish"))));
  const save = run(async () => { await post(`hosts/${h.id}/payout`, { amount: Number(amount.value), reference: ref.value }); d.close(); toast("Yozildi"); await start(); });
  d.onclose = () => d.remove();
  document.body.append(d);
  d.showModal();
}

async function start() {
  const a = await api("/api/admin");
  prefs.replaceChildren(theme, el("button", { onclick: run(async () => { await api("/api/admin/logout", {}); login(); }) }, "Chiqish"));
  const c = a.counts, box = el("div"), search = el("input", { type: "search", value: q, placeholder: "Ism yoki ID", "aria-label": "Mezbon qidirish" });
  const pay = (p) => el("span.badge" + (PAY_STATUS[p.status]?.[1] ?? ""), {}, PAY_STATUS[p.status]?.[0] ?? p.status);
  page(el("h1", {}, "Boshqaruv"),
    el("div.tiles", {}, [["Mezbonlar", c.hosts], ["Sotuvdagi takliflar", c.listings], ["Javob kutayotgan bronlar", c.waiting], ["Tasdiqlangan bronlar", c.confirmed], ["Qabul qilingan pul", som(c.received)]].map(([k, v]) => el("div.card.tile", {}, el("b", {}, String(v)), el("span.muted", {}, k)))),
    el("div.note" + (a.methods.some((m) => m !== "test") ? ".ok" : ".warn"), {}, a.methods.some((m) => m !== "test") ? `Ulangan to‘lovlar: ${a.methods.map((m) => PROVIDER[m]).join(", ")}` : "Haqiqiy to‘lov hali ulanmagan: Octo yoki Payme shartnomasi va kalitlari kerak."),
    a.refunds.length > 0 && card(`Qaytarilishi kerak bo‘lgan pul (${a.refunds.length})`, el("p.small.muted", {}, "Payme pulini uning kabinetida qaytaring: tizim buni o‘zi biladi. Octo avtomatik qaytaradi, bo‘lmasa shu yerdan takrorlang."),
      table("Qaytarishlar", ["To‘lov", "Summa", "Sabab", "Urinish", "Amallar"], a.refunds.map((r) => [`${PROVIDER[r.provider]} · ${r.id}`, som(r.amount_uzs), r.note ?? "", String(r.attempts), el("div.row", {}, r.provider !== "payme" && el("button.mini.text", { onclick: run(async () => { await post(`refunds/${r.id}/retry`); await start(); }) }, "Takrorlash"), el("button.mini.text", { onclick: run(async () => { if (!(await ask("Pul to‘lov kabinetida haqiqatan qaytarildimi? Buni bekor qilib bo‘lmaydi.", "Ha, qaytarildi", "Yo‘q"))) return; await post(`refunds/${r.id}/done`); await start(); }) }, "Qaytarildi"))]))),
    a.reports.length > 0 && card(`Shikoyatlar (${a.reports.length})`, table("Shikoyatlar", ["Taklif", "Sabab", "Izoh", "Vaqt", "Amallar"], a.reports.map((r) => [el("div", {}, el("a", { href: `/?l=${r.listing_id}`, target: "_blank", rel: "noopener" }, r.title), el("div.small.muted", {}, r.host)), REASON[r.reason], r.details ?? "", when(r.created_at),
      el("div.row", {}, el("button.mini.text.danger", { onclick: run(async () => { const on = r.status !== "blocked"; if (!(await ask(on ? "Taklif sotuvdan olinsinmi?" : "Taklif qayta ochilsinmi?", "Ha", "Yo‘q"))) return; await post(`listings/${r.listing_id}/block`, { on }); await start(); }) }, r.status === "blocked" ? "Ochish" : "To‘xtatish"), el("button.mini.text", { onclick: run(async () => { await post(`reports/${r.id}/resolve`); await start(); }) }, "Yopish"))]))),
    card("Mezbonlar", el("form.compose", { role: "search", onsubmit: (e) => { e.preventDefault(); q = search.value.trim(); hosts(box).catch((x) => toast(explain(x), true)); } }, search, el("button", { type: "submit" }, icon("search", 20), "Qidirish")), box),
    card("So‘nggi to‘lovlar", a.payments.length ? table("To‘lovlar", ["Vaqt", "Turi", "Usul", "Summa", "Holati", "Izoh"], a.payments.map((p) => [when(p.created_at), p.kind === "plan" ? "Tarif" : "Bron", PROVIDER[p.provider], som(p.amount_uzs), pay(p), p.note ?? ""])) : el("p.muted", {}, "Hali to‘lov yo‘q.")),
    card("Amallar jurnali", a.audit.length ? table("Jurnal", ["Vaqt", "Kim", "Amal", "Obyekt"], a.audit.map((x) => [when(x.at), x.actor === "system" ? "tizim" : x.actor === "admin" ? "ma’mur" : x.actor, ACTION[x.action] ?? x.action, x.target])) : el("p.muted", {}, "Hali yozuv yo‘q.")));
  await hosts(box);
}
start().catch((e) => { if (e.status === 401) login(); else page(el("div.note.bad", { role: "alert" }, e.message), el("button", { onclick: () => location.reload() }, "Qayta urinish")); });
