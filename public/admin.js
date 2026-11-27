// Administration console. The session is an HttpOnly cookie that ends after eight hours.
import { PAY_NAME, act, api, ask, copy, el, som, toast } from "/common.js";
import { icon } from "/art.js";
import { themePicker } from "/pwa.js";

const app = document.getElementById("app"), prefs = document.getElementById("prefs");
const page = (...kids) => app.replaceChildren(el("div.wrap", {}, ...kids));
const when = (iso) => new Intl.DateTimeFormat("uz", { timeZone: "Asia/Tashkent", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const theme = themePicker({ theme: "Mavzu", auto: "Avtomatik", light: "Yorug‘", dark: "Qorong‘i" });
const KIND = { plan: "Tarif", trip: "Sayohat", boost: "Reklama" };
const PROVIDER = { ...PAY_NAME, octo: "Octo", click: "Click", test: "Sinov", credit: "Hisobdan", reseller: "Sotuv hamkori" };
const PAY_STATUS = { created: ["Kutilmoqda", ".warn"], paid: ["To‘langan", ".ok"], cancelled: ["Bekor", ""], failed: ["Xato", ".bad"], refund_due: ["Qaytarish kerak", ".bad"], refunded: ["Qaytarilgan", ""] };
const REASON = { unsafe: "Xavfli yoki noqonuniy", false: "Noto‘g‘ri ma’lumot", offensive: "Haqoratli", other: "Boshqa" };
const ACTION = { payment_paid: "To‘lov keldi", refund_due: "Qaytarish navbatga qo‘yildi", refunded: "Pul qaytarildi", payout: "O‘tkazma yozildi", host_verified: "Mezbon tekshirildi", host_unverified: "Tekshiruv bekor qilindi", host_suspended: "Mezbon to‘xtatildi", host_restored: "Mezbon tiklandi", listing_blocked: "Taklif to‘xtatildi", listing_unblocked: "Taklif ochildi", report_resolved: "Shikoyat yopildi", recovery_link: "Tiklash havolasi", key_rotated: "Kalit almashtirildi", passkey_added: "Passkey qo‘shildi", passkey_removed: "Passkey o‘chirildi", calendar_link: "Taqvim havolasi", email_confirmed: "Email tasdiqlandi", anonymized: "Shaxsiy ma’lumot o‘chirildi", letter_verified: "Niyat xati tasdiqlandi", letter_joined: "Hamkor qo‘shildi", letter_rejected: "Niyat xati rad etildi", letter_signed: "Niyat xati qaytarildi", letter_withdrawn: "Niyat xati qaytarib olindi" };
const table = (label, head, rows) => el("div.scroll.tall", { tabindex: 0, role: "region", "aria-label": label }, el("table", {}, el("thead", {}, el("tr", {}, head.map((h) => el("th", { scope: "col" }, h)))), el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c) => el("td", {}, c)))))));
const card = (title, ...kids) => el("section.card", {}, el("h2", {}, title), ...kids);
const explain = (e) => { if (e.status === 401) login(); return e.message; };
const run = (fn) => act(fn, explain);

async function login() {
  const { twoStep } = await api("/api/admin/door");
  prefs.replaceChildren(theme);
  const code = el("input", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: 8, required: twoStep });
  const key = el("input", { type: "password", required: true, autocomplete: "current-password", maxlength: 200 });
  const go = run(async () => { await api("/api/admin/login", { key: key.value, code: code.value }); key.value = ""; await start(); });
  page(el("form.card", { style: "max-width:460px;margin-inline:auto;width:100%", onsubmit: (e) => { e.preventDefault(); go({ currentTarget: e.submitter }); } }, el("h1", {}, "Ma’muriyat"), el("label", {}, "Ma’muriyat kaliti", key), twoStep && el("label", {}, "Ilovadagi 6 xonali kod", code), el("button.primary", { type: "submit" }, icon("key", 20), "Kirish"), el("p.small.muted", {}, "Kalit serverdagi ADMIN_KEY sozlamasida turadi.")));
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
  sample ??= !a.methods.some((m) => m !== "test"); // a demonstration starts with its sample data
  const c = a.counts, box = el("div"), letters = el("div", {}, el("p.muted", { role: "status" }, "Yuklanmoqda…")), sellers = el("div", {}, el("p.muted", { role: "status" }, "Yuklanmoqda…")), codes = el("div", {}, el("p.muted", { role: "status" }, "Yuklanmoqda…")), payouts = el("div", {}, el("p.muted", { role: "status" }, "Yuklanmoqda…")), numbers = el("div", {}, el("p.muted", { role: "status" }, "Yuklanmoqda…")), search = el("input", { type: "search", value: q, placeholder: "Ism yoki ID", "aria-label": "Mezbon qidirish" });
  const pay = (p) => el("span.badge" + (PAY_STATUS[p.status]?.[1] ?? ""), {}, PAY_STATUS[p.status]?.[0] ?? p.status);
  page(el("h1", {}, "Boshqaruv"),
    el("div.tiles", {}, [["Mezbonlar", c.hosts], ["Sotuvdagi takliflar", c.listings], ["Javob kutayotgan bronlar", c.waiting], ["Tasdiqlangan bronlar", c.confirmed], ["Qabul qilingan pul", som(c.received)]].map(([k, v]) => el("div.card.tile", {}, el("b", {}, String(v)), el("span.muted", {}, k)))),
    el("div.note" + (a.methods.some((m) => m !== "test") ? ".ok" : ".warn"), {}, a.methods.some((m) => m !== "test") ? `Ulangan to‘lovlar: ${a.methods.map((m) => PROVIDER[m]).join(", ")}` : "Haqiqiy to‘lov hali ulanmagan: Octo, Click yoki Payme shartnomasi va kalitlari kerak. Tekshirish: npm run doctor"),
    a.refunds.length > 0 && card(`Qaytarilishi kerak bo‘lgan pul (${a.refunds.length})`, el("p.small.muted", {}, "Payme pulini uning kabinetida qaytaring: tizim buni o‘zi biladi. Octo va Click avtomatik qaytaradi, bo‘lmasa shu yerdan takrorlang."),
      table("Qaytarishlar", ["To‘lov", "Summa", "Sabab", "Urinish", "Amallar"], a.refunds.map((r) => [el("div", {}, PROVIDER[r.provider], el("div.small.muted", {}, r.payment_id)), el("div", {}, som(r.amount_uzs), r.amount_uzs < r.payment_uzs && el("div.small.muted", {}, `${som(r.payment_uzs)} dan`)), r.note ?? "", String(r.attempts), el("div.row", {}, r.provider !== "payme" && el("button.mini.text", { onclick: run(async () => { await post(`refunds/${r.id}/retry`); await start(); }) }, "Takrorlash"), el("button.mini.text", { onclick: run(async () => { if (!(await ask("Pul to‘lov kabinetida haqiqatan qaytarildimi? Buni bekor qilib bo‘lmaydi.", "Ha, qaytarildi", "Yo‘q"))) return; await post(`refunds/${r.id}/done`); await start(); }) }, "Qaytarildi"))]))),
    a.reports.length > 0 && card(`Shikoyatlar (${a.reports.length})`, table("Shikoyatlar", ["Taklif", "Sabab", "Izoh", "Vaqt", "Amallar"], a.reports.map((r) => [el("div", {}, el("a", { href: `/?l=${r.listing_id}`, target: "_blank", rel: "noopener" }, r.title), el("div.small.muted", {}, r.host)), REASON[r.reason], r.details ?? "", when(r.created_at),
      el("div.row", {}, el("button.mini.text.danger", { onclick: run(async () => { const on = r.status !== "blocked"; if (!(await ask(on ? "Taklif sotuvdan olinsinmi?" : "Taklif qayta ochilsinmi?", "Ha", "Yo‘q"))) return; await post(`listings/${r.listing_id}/block`, { on }); await start(); }) }, r.status === "blocked" ? "Ochish" : "To‘xtatish"), el("button.mini.text", { onclick: run(async () => { await post(`reports/${r.id}/resolve`); await start(); }) }, "Yopish"))]))),
    card("Mezbonlarga to‘lov", payouts),
    card("Promo kodlar", codes),
    card("Sotuv hamkorlari (OCTO API)", sellers),
    card("Niyat xatlari", letters),
    card("Investor ko‘rsatkichlari", numbers),
    card("Mezbonlar", el("form.compose", { role: "search", onsubmit: (e) => { e.preventDefault(); q = search.value.trim(); hosts(box).catch((x) => toast(explain(x), true)); } }, search, el("button", { type: "submit" }, icon("search", 20), "Qidirish")), box),
    card("So‘nggi to‘lovlar", a.payments.length ? table("To‘lovlar", ["Vaqt", "Turi", "Usul", "Summa", "Holati", "Izoh"], a.payments.map((p) => [when(p.created_at), KIND[p.kind] ?? "Bron", PROVIDER[p.provider], som(p.amount_uzs), pay(p), p.note ?? ""])) : el("p.muted", {}, "Hali to‘lov yo‘q.")),
    card("Amallar jurnali", a.audit.length ? table("Jurnal", ["Vaqt", "Kim", "Amal", "Obyekt"], a.audit.map((x) => [when(x.at), x.actor === "system" ? "tizim" : x.actor === "admin" ? "ma’mur" : x.actor, ACTION[x.action] ?? x.action, x.target])) : el("p.muted", {}, "Hali yozuv yo‘q.")));
  await Promise.all([hosts(box), investor(numbers), letterList(letters), sellerList(sellers), promoList(codes), payoutList(payouts)]);
}

// ---- payouts ----------------------------------------------------------------------------------------
/** What each maker is owed, as a list the bank imports; recorded in one step once the bank carried it out. */
async function payoutList(box) {
  const list = await api("/api/admin/payouts"), again = () => payoutList(box).catch((x) => toast(explain(x), true));
  const ready = list.filter((x) => x.account), missing = list.filter((x) => !x.account), total = ready.reduce((s, x) => s + x.amount_uzs, 0);
  const csv = () => {
    const rows = [["hisob_raqami", "mfo", "oluvchi", "summa_som", "izoh"], ...ready.map((x) => [x.account, x.mfo, x.holder ?? x.name, x.amount_uzs, `SilkRoad ${x.id}`])];
    const a = el("a", { href: URL.createObjectURL(new Blob(["\ufeff" + rows.map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(",")).join("\r\n")], { type: "text/csv" })), download: `silkroad-tolov-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const ref = el("input", { maxlength: 80, required: true, "aria-label": "Bank hujjati raqami", placeholder: "Bank hujjati raqami" });
  const done = run(async () => { if (!(await ask(`${ready.length} ta mezbonga jami ${som(total)} o‘tkazildi deb yozilsinmi? Faqat bank o‘tkazmani bajarganidan keyin.`, "Ha, o‘tkazildi", "Yo‘q"))) return; await api("/api/admin/payouts", { reference: ref.value, items: ready.map((x) => ({ id: x.id, amount_uzs: x.amount_uzs })) }); toast("Yozildi"); await again(); });
  box.replaceChildren(el("div.stack", { style: "gap:16px" },
    list.length ? [el("p.small.muted", {}, "Ro‘yxatni CSV qilib bankka yuklang. Bank o‘tkazgandan keyin hujjat raqamini yozib, bir bosishda belgilang. Sotuv hamkorlari puli kelmagan bo‘lsa, kutib turing."),
      table("To‘lovlar ro‘yxati", ["Mezbon", "Hisob", "Summa"], list.map((x) => [el("b", {}, x.name), x.account ? `${x.account} · ${x.mfo}` : el("span.badge.warn", {}, "Bank ma’lumoti yo‘q"), som(x.amount_uzs)])),
      missing.length > 0 && el("div.note.warn", {}, `${missing.length} ta mezbon bank hisobini kiritmagan: ular ro‘yxatga kirmaydi.`),
      ready.length > 0 && el("div.row", {}, el("button", { onclick: csv }, `CSV yuklash (${ready.length}, ${som(total)})`)),
      ready.length > 0 && el("form.compose", { onsubmit: (e) => { e.preventDefault(); done({ currentTarget: e.submitter }); } }, ref, el("button.primary", { type: "submit" }, "O‘tkazildi deb belgilash"))]
      : el("p.muted", {}, "Hozir to‘lanadigan pul yo‘q.")));
}

// ---- promo codes -----------------------------------------------------------------------------------
/** Codes for hotels, guides, bloggers and campaigns. The platform pays the discount; makers earn the same. */
async function promoList(box) {
  const { list, referral: ref } = await api("/api/admin/promos"), again = () => promoList(box).catch((x) => toast(explain(x), true));
  const code = el("input", { maxlength: 20, required: true, "aria-label": "Kod", placeholder: "KOD" }), pct = el("select", { "aria-label": "Chegirma" }, [5, 8, 10, 12, 15, 20].map((n) => el("option", { value: n, selected: n === 10 }, `${n}%`)));
  const uses = el("input", { type: "number", min: 1, inputmode: "numeric", "aria-label": "Necha marta", placeholder: "Cheksiz" }), until = el("input", { type: "date", "aria-label": "Muddati" }), note = el("input", { maxlength: 120, "aria-label": "Kim uchun", placeholder: "Kim uchun: mehmonxona, gid, blog" });
  const add = run(async () => { await api("/api/admin/promos", { code: code.value, pct: Number(pct.value), uses_max: uses.value ? Number(uses.value) : null, valid_until: until.value || null, note: note.value }); await again(); toast("Kod yaratildi"); });
  box.replaceChildren(el("div.stack", { style: "gap:16px" }, el("p.small.muted", {}, "Chegirma platforma ulushidan to‘lanadi va hech qachon undan oshmaydi: mezbon daromadi o‘zgarmaydi. Havola: /?promo=KOD"),
    el("form.fields", { onsubmit: (e) => { e.preventDefault(); add({ currentTarget: e.submitter }); } }, el("label", {}, "Kod", code), el("label", {}, "Chegirma", pct), el("label", {}, "Necha marta", uses), el("label", {}, "Muddati", until), el("label", {}, "Kim uchun", note), el("button", { type: "submit", style: "align-self:end" }, "Kod yaratish")),
    list.length ? table("Promo kodlar", ["Kod", "Chegirma", "Ishlatildi", "Aylanma", "Narxi", "Holati"], list.map((p) => [el("div", {}, el("b", {}, p.code), p.note && el("div.small.muted", {}, p.note)), `${p.pct}%`, `${p.sold}${p.uses_max ? ` / ${p.uses_max}` : ""}`, som(p.gross), som(p.cost),
      el("button.mini.text" + (p.active ? ".danger" : ""), { onclick: run(async () => { await post(`promos/${p.code}`, { active: !p.active }); await again(); }) }, p.active ? "O‘chirish" : "Yoqish")])) : el("p.muted", {}, "Hali kod yo‘q."),
    el("div.note", {}, `Do‘stga 10% dasturi: ${ref.codes} ta mehmon kod oldi, ${ref.friends} ta do‘st to‘ladi. Aylanma ${som(ref.gross)}, chegirma ${som(ref.cost)}.`)));
}

// ---- resellers ------------------------------------------------------------------------------------
/** Agencies, hotels and booking sites that sell through the OCTO standard. The key is shown once. */
async function sellerList(box) {
  const list = await api("/api/admin/resellers"), name = el("input", { maxlength: 80, required: true, "aria-label": "Hamkor nomi", placeholder: "Hamkor nomi" }), pct = el("select", { "aria-label": "Hamkor ulushi" }, [0, 5, 8, 10, 12, 15, 20, 25].map((n) => el("option", { value: n, selected: n === 10 }, `${n}%`)));
  const again = () => sellerList(box).catch((x) => toast(explain(x), true)), made = el("div");
  const add = run(async () => { const r = await api("/api/admin/resellers", { name: name.value, pct: Number(pct.value) }); name.value = ""; await again(); box.prepend(el("div.card.keycard", { role: "status" }, el("b", {}, `${r.name} uchun kalit (faqat hozir ko‘rinadi)`), el("code.secret", {}, r.key), el("p.small.muted", {}, `Manzil: ${location.origin}/octo · Sarlavha: Authorization: Bearer <kalit>`))); });
  box.replaceChildren(el("div.stack", { style: "gap:16px" }, made, el("p.small.muted", {}, "Hamkor faqat mezboni ruxsat bergan takliflarni sotadi. Ulush mehmon to‘lagan narxdan olinadi; hamkor qolganini oyma-oy to‘laydi. Pul kelmaguncha mezbonga uning ulushini o‘tkazmang."),
    el("form.compose", { onsubmit: (e) => { e.preventDefault(); add({ currentTarget: e.submitter }); } }, name, pct, el("button", { type: "submit" }, "Kalit yaratish")),
    list.length ? table("Sotuv hamkorlari", ["Hamkor", "Ulush", "Sotildi", "Shu oy to‘laydi", "Jami to‘laydi", "Holati"], list.map((r) => [el("b", {}, r.name), `${r.pct}%`, `${r.sold} · ${som(r.gross)}`, som(r.month), som(r.owed),
      el("button.mini.text" + (r.active ? ".danger" : ""), { onclick: run(async () => { if (r.active && !(await ask(`${r.name}: kalit o‘chirilsinmi? Sotuv darhol to‘xtaydi.`, "O‘chirish", "Yo‘q"))) return; await post(`resellers/${r.id}`, { active: !r.active }); await again(); }) }, r.active ? "O‘chirish" : "Yoqish")])) : el("p.muted", {}, "Hali hamkor yo‘q.")));
}

// ---- letters of intent ----------------------------------------------------------------------------
const LETTER = { signed: ["Qo‘ng‘iroq kutmoqda", ".warn"], verified: ["Tasdiqlangan", ".ok"], joined: ["Platformada", ".ok"], rejected: ["Rad etilgan", ""], withdrawn: ["Qaytarib olgan", ""] };
const WHO = { host: "Hunarmand", hotel: "Mehmonxona", guide: "Gid", operator: "Turoperator" };
async function letterList(box) {
  const { totals: t, list } = await api("/api/admin/partners"), set = (p, status, text) => run(async () => { if (text && !(await ask(text, "Ha", "Yo‘q"))) return; await post(`partners/${p.id}`, { status }); await letterList(box); });
  const share = (n) => (t.confirmed ? `${Math.round((n / t.confirmed) * 100)}%` : "—");
  box.replaceChildren(el("div.stack", { style: "gap:18px" }, el("p.small.muted", {}, "Faqat qo‘ng‘iroq qilib tasdiqlangan xatlar natija hisoblanadi. Imzolash sahifasi: ", el("a", { href: "/hamkor", target: "_blank", rel: "noopener" }, "/hamkor")),
    el("div.tiles.three", {}, [["Tasdiqlangan xat", t.confirmed, `${t.waiting} ta qo‘ng‘iroq kutmoqda`], ["Hunarmand / mehmonxona", `${t.hosts} / ${t.hotels}`, `${t.regions} ta hudud`], ["Haftasiga guruh", t.groups_week, t.price ? `narx medianasi ${som(t.price)}` : null], ["12% ga rozi", share(t.c12)], ["15% ga rozi", share(t.c15)], ["18% ga rozi", share(t.c18)]].map(([k, v, sub]) => el("div.card.tile", {}, el("b", {}, String(v)), el("span.muted", {}, k), sub && el("span.small.muted", {}, sub)))),
    list.length ? table("Niyat xatlari", ["Hamkor", "Taklif", "Komissiya", "Holati", "Amallar"], list.map((p) => [el("div", {}, el("b", {}, p.name), el("div.small.muted", {}, WHO[p.kind], " · ", p.region), p.phone && el("a", { href: `tel:${p.phone}` }, p.phone)), el("div", {}, p.offer, el("div.small.muted", {}, [p.price_uzs && som(p.price_uzs), p.groups_week && `haftasiga ${p.groups_week}`].filter(Boolean).join(" · "))), p.max_commission ? `${p.max_commission}%` : "keyin", el("span.badge" + LETTER[p.status][1], {}, LETTER[p.status][0]),
      p.status === "withdrawn" ? "" : el("div.row", {}, p.status === "signed" && el("button.mini.text", { onclick: set(p, "verified", `${p.name}: qo‘ng‘iroq qildingizmi va niyatini tasdiqladimi?`) }, "Tasdiqlash"), p.status === "verified" && el("button.mini.text", { onclick: set(p, "joined") }, "Platformada"), p.status !== "rejected" && el("button.mini.text.danger", { onclick: set(p, "rejected", "Xat rad etilsinmi?") }, "Rad etish"))])) : el("p.muted", {}, "Hali xat yo‘q.")));
}

// ---- numbers for investors ----------------------------------------------------------------------
let range = 90, sample = null;
async function investor(box) {
  const m = await api(`/api/admin/metrics?days=${range}&sample=${sample ? 1 : 0}`), pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`), again = () => investor(box).catch((x) => toast(explain(x), true));
  const tiles = (list) => el("div.tiles.three", {}, list.map(([k, v, sub]) => el("div.card.tile", {}, el("b", {}, v), el("span.muted", {}, k), sub && el("span.small.muted", {}, sub))));
  const csv = () => {
    const rows = [["oy", "bronlar", "aylanma_som", "komissiya_som", "obuna_som", "faol_mezbonlar", "yangi_mezbonlar"], ...m.months.map((x) => [x.month, x.bookings, x.gmv, x.fees, x.plans, x.active, x.joined])];
    const a = el("a", { href: URL.createObjectURL(new Blob(["\ufeff" + rows.map((r) => r.join(",")).join("\r\n")], { type: "text/csv" })), download: `silkroad-oylik${sample ? "-namuna" : ""}.csv` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const f = m.funnel, max = Math.max(1, f.views, f.holds), steps = [["Ko‘rishlar", f.views], ["Band qilindi", f.holds], ["To‘landi", f.paid], ["Tasdiqlandi", f.confirmed], ["Tashrif bo‘ldi", f.visited]];
  const top = Math.max(1, ...m.months.map((x) => x.gmv));
  box.replaceChildren(el("div.stack", { style: "gap:20px" },
    el("div.row.between", {}, el("div.chips", { role: "group", "aria-label": "Davr" }, [30, 90, 365].map((d) => el("button", { "aria-pressed": String(d === range), onclick: () => { range = d; again(); } }, d === 365 ? "1 yil" : `${d} kun`)), el("button", { "aria-pressed": String(sample), onclick: () => { sample = !sample; again(); } }, "Namunani ham sanash")), el("button", { onclick: csv }, "CSV yuklash")),
    m.sample ? el("div.note.warn", { role: "status" }, "Namuna va sinov to‘lovlari ham sanaldi. Bu raqamlarni investorga haqiqiy natija deb ko‘rsatmang.") : el("div.note", {}, "Faqat haqiqiy mezbonlar va haqiqiy to‘lovlar."),
    tiles([["Aylanma (GMV)", som(m.money.gmv)], ["Platforma daromadi", som(m.money.revenue), `komissiya ${som(m.money.fees)}, obuna ${som(m.money.plans)}`], ["Komissiya ulushi", pct(m.money.take_rate)], ["O‘rtacha bron", som(m.money.average)], ["Qaytarish ulushi", pct(m.money.refund_rate)], ["Qayta kelgan mehmon", pct(m.repeat.rate), `${m.repeat.again} / ${m.repeat.guests}`]]),
    el("div.two", {}, el("div.stack", {}, el("h3", {}, "Sotuv voronkasi"), el("ol.funnel", {}, steps.map(([k, v], i) => el("li", {}, el("div.row.between", {}, el("span", {}, k), el("b", {}, String(v), i > 0 && steps[i - 1][1] >= v && steps[i - 1][1] > 0 && el("span.small.muted", {}, ` ${pct(v / steps[i - 1][1])}`))), el("div.meter", {}, el("i", { style: `width:${(v / max) * 100}%` })))))),
      el("div.stack", {}, el("h3", {}, "Mezbonlar"), el("dl.sum", {}, [["Ro‘yxatdan o‘tgan", m.hosts.registered], ["Qoralama yaratgan", m.hosts.drafted], ["E’lon qilgan", m.hosts.published], ["Sotgan", m.hosts.selling], ["5 va undan ko‘p sotgan", m.hosts.five], ["E’longacha, kun (mediana)", m.hosts.days_to_publish ?? "—"], ["Javob vaqti, soat (mediana)", m.quality.reply_hours ?? "—"], ["Rad etish", pct(m.quality.decline_rate)], ["Kelmaganlar", pct(m.quality.no_show)], ["O‘rtacha baho", m.quality.rating ?? "—"]].map(([k, v]) => [el("dt", {}, k), el("dd", {}, String(v))])))),
    el("div.stack", {}, el("h3", {}, "Oylar bo‘yicha"), table("Oylik natija", ["Oy", "Bron", "Aylanma", "Komissiya", "Obuna", "Faol mezbon", "Yangi mezbon"], m.months.map((x) => [x.month, String(x.bookings), el("div", {}, som(x.gmv), el("div.meter", {}, el("i", { style: `width:${(x.gmv / top) * 100}%` }))), som(x.fees), som(x.plans), String(x.active), String(x.joined)])))));
}
start().catch((e) => { if (e.status === 401) login(); else page(el("div.note.bad", { role: "alert" }, e.message), el("button", { onclick: () => location.reload() }, "Qayta urinish")); });
