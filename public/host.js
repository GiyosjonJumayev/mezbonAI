import { act, api, ask, copy, counter, el, listen, plate, som, store, tint, toast, visual } from "/common.js";
import { account, enter, keyCard } from "/account.js";
import { authScreen, secureCard } from "/auth.js";
import { assistant, forget } from "/assistant.js";
import { icon } from "/art.js";
import { demoBanner, installButton, themePicker } from "/pwa.js";
import { EXTRAS, PRICE_LIMITS, unitPrice } from "/price.js";
import { analytics, calendar, market, PLAN_NAME, plans, tickets } from "/studio.js";

const app = document.getElementById("app");
let cfg;
try { cfg = await api("/api/config"); } catch (e) { app.replaceChildren(el("div.wrap", {}, el("div.note.bad", { role: "alert" }, e.message))); throw e; }
demoBanner(cfg, "Namoyish sayti: ma’lumotlar namuna, pul yechilmaydi.");
document.getElementById("mode").textContent = cfg.ai ? "Matn va tarjima: Claude AI" : "Demo rejim: matn shablondan olinadi, erkin yozishma tarjima qilinmaydi";

document.getElementById("prefs").append(installButton("Ilovani o‘rnatish"), themePicker({ theme: "Mavzu", auto: "Avtomatik", light: "Yorug‘", dark: "Qorong‘i" }), el("a", { href: "/" }, "Sayt"), el("a", { href: "/panel" }, "Talab paneli"), el("a", { href: "/qr" }, "QR kodlar"));

const SAMPLE = "Assalomu alaykum! Men Rishtonda kulolman. Mehmonlarga loydan lagan yasashni o‘rgataman. Ikki soat davom etadi, narxi yuz ellik ming so‘m, sakkiz kishigacha qabul qilaman.";
const DAYS = ["Du", "Se", "Ch", "Pa", "Ju", "Sh", "Ya"];
const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
const WEEK = ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"];
const CHANNEL = { web: "Sayt", hotel: "Mehmonxona QR", ai: "AI yordamchi", widget: "Sayt vidjeti", partner: "Sotuv hamkori" };
const STATUS = { paid: ["Javob kutilmoqda", ".warn"], confirmed: ["Tasdiqlangan", ".ok"], declined: ["Rad etilgan", ""], cancelled: ["Bekor qilingan", ".bad"] };
const STATE = { draft: ["Qoralama", ".warn"], published: ["Sotuvda", ".ok"], paused: ["To‘xtatilgan", ""], blocked: ["Ma’muriyat to‘xtatgan", ".bad"] };
const uzDate = (d) => `${+d.slice(8)}-${MONTHS[+d.slice(5, 7) - 1]}, ${WEEK[new Date(d + "T00:00:00Z").getUTCDay()]}`;
const today = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const page = (...kids) => app.replaceChildren(el("div.wrap", {}, ...kids));

let show = "all", find = "";
let home = null, stop = null, dirty = false, speech = "", freshKey = null, fresh = null;
const tab = () => location.hash.slice(1) || "yordamchi";

function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text), v = speechSynthesis.getVoices();
    // Few devices ship an Uzbek voice; Turkish reads Uzbek Latin closest.
    u.voice = v.find((x) => x.lang.startsWith("uz")) ?? v.find((x) => x.lang.startsWith("tr")) ?? null;
    u.lang = u.voice?.lang ?? "uz-UZ";
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}

const PILLARS = [
  ["AI Business Assistant", "Professional raqamli xizmat yaratadi va boshqarishga yordam beradi: matn, narx, jadval, javoblar."],
  ["Smart Experience Booking", "Xizmat, vaqt, sig‘im, bron va QR check-in bitta joyda."],
  ["Tourism Intelligence", "Turistlar nimani qidirayotgani va biznesingiz natijalari."],
];

// ---- first visit ----------------------------------------------------------------------------
/** Signed out: the sign-in and sign-up screen. */
function welcome() {
  document.getElementById("bottom").replaceChildren();
  page(authScreen({ cfg, start, onCreated: (f) => { fresh = f; } }));
}

// ---- new listing ----------------------------------------------------------------------------
function composer() {
  const text = el("textarea", { maxlength: 4000, placeholder: "Nima o‘rgatasiz, qayerda, qancha vaqt, narxi va necha kishi?", oninput: () => { speech = text.value; } });
  text.value = speech;
  const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  const label = el("span", {}, "Gapirishni boshlash");
  const mic = el("button.mic", { type: "button" }, el("i"), label);
  if (SR) {
    let rec = null, final = "";
    mic.onclick = () => {
      if (rec) return rec.stop();
      final = text.value ? text.value.trim() + " " : "";
      rec = new SR();
      rec.lang = "uz-UZ";
      rec.continuous = rec.interimResults = true;
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) e.results[i].isFinal ? (final += e.results[i][0].transcript + " ") : (interim += e.results[i][0].transcript);
        speech = text.value = final + interim;
      };
      rec.onerror = (e) => { if (e.error !== "no-speech" && e.error !== "aborted") toast({ "not-allowed": "Mikrofonga ruxsat bering", network: "Nutqni tanish uchun internet kerak", "language-not-supported": "Bu brauzer o‘zbekchani tanimaydi. Matn yozing" }[e.error] ?? "Nutqni tanib bo‘lmadi. Matn yozing", true); };
      rec.onend = () => { rec = null; mic.classList.remove("on"); label.textContent = "Gapirishni boshlash"; };
      try { rec.start(); } catch { rec = null; return toast("Mikrofonni ishga tushirib bo‘lmadi", true); }
      mic.classList.add("on");
      label.textContent = "Eshityapman. To‘xtatish";
    };
  }
  const clock = el("span.muted", { role: "status" });
  return el("div.two", {}, el("div.card", {}, el("h2", {}, "Hunaringiz haqida gapiring"), SR ? mic : el("p.note", {}, "Bu brauzer nutqni tanimaydi. Matn yozing yoki Chrome’da oching."), el("label", {}, "Aytganlaringiz (tuzatish mumkin)", text),
    el("div.row", {},
      el("button.primary", { onclick: act(async () => {
        if (text.value.trim().length < 10) throw new Error("Avval gapiring yoki bir-ikki gap yozing");
        const t0 = performance.now(), sec = () => ((performance.now() - t0) / 1000).toFixed(1);
        const timer = setInterval(() => (clock.textContent = `Tayyorlanmoqda: ${sec()} s`), 100);
        try {
          const l = await api("/api/host/drafts", { transcript: text.value });
          if (l.note) toast(`${l.note}. Demo rejimda tayyorlandi`, true);
          speech = "";
          await reload();
          location.hash = `taklif/${l.id}`;
          toast(`10 tilda tayyor: ${sec()} soniya`);
        } finally { clearInterval(timer); clock.textContent = ""; }
      }) }, "Taklifni tayyorlash"),
      el("button", { onclick: () => { speech = text.value = SAMPLE; text.focus(); } }, "Namuna matn"), clock)),
  el("div.card", {}, el("h2", {}, "Nimalarni ayting"), el("ol.steps", { style: "grid-template-columns:1fr" }, ["Nima o‘rgatasiz yoki ko‘rsatasiz", "Qayerda: shahar yoki tuman", "Qancha davom etadi", "Bir kishi uchun narxi", "Necha kishini qabul qilasiz"].map((x) => el("li", {}, x)))));
}

async function shrink(file) {
  const img = await createImageBitmap(file).catch(() => { throw new Error("Rasm ochilmadi. JPG yoki PNG tanlang"); });
  const k = Math.min(1, 1280 / Math.max(img.width, img.height)), c = el("canvas");
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.82).split(",")[1];
}

// ---- listing editor -------------------------------------------------------------------------
function editor(l) {
  const need = new Set(l.missing.map((m) => m.field)), touch = () => { dirty = true; };
  const num = (f, label) => el("label", {}, label, el("input", { type: "number", name: f, value: l[f] ?? "", inputmode: "numeric", "aria-invalid": need.has(f) ? "true" : null, oninput: touch }));
  const opts = (m, name) => Object.keys(m).map((k) => el("option", { value: k }, name(k)));
  const region = el("select", { onchange: touch, "aria-invalid": need.has("region") ? "true" : null }, el("option", { value: "" }, "Tanlang"), opts(cfg.regions, (k) => cfg.regions[k]));
  region.value = l.region ?? "";
  const cert = el("input", { maxlength: 40, value: l.cert_no ?? "", oninput: touch, "aria-invalid": need.has("cert_no") ? "true" : null });
  const certLabel = el("label", {}, "Gid sertifikati raqami", cert);
  const category = el("select", { onchange: () => { touch(); certLabel.hidden = category.value !== "tour"; } }, opts(cfg.categories, (k) => cfg.categories[k].uz));
  category.value = l.category;
  certLabel.hidden = l.category !== "tour";
  const place = el("input", { maxlength: 60, value: l.place ?? "", oninput: touch });
  const address = el("input", { maxlength: 200, value: l.address ?? "", oninput: touch, placeholder: "Masalan: Kulollar ko‘chasi 12, Rishton" });
  let point = l.lat == null ? null : { lat: l.lat, lng: l.lng };
  const pointText = el("span.small.muted", { role: "status" }), showPoint = () => { pointText.textContent = point ? `Nuqta belgilangan: ${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}` : "Xaritada nuqta belgilanmagan"; };
  const locate = el("button", { type: "button", onclick: act(() => new Promise((done, fail) => {
    if (!navigator.geolocation) return fail(new Error("Bu qurilma joylashuvni bilmaydi"));
    navigator.geolocation.getCurrentPosition((p) => { point = { lat: p.coords.latitude, lng: p.coords.longitude }; touch(); showPoint(); done(); }, () => fail(new Error("Joylashuvga ruxsat berilmadi")), { enableHighAccuracy: true, timeout: 15000 });
  })) }, icon("pin", 20), "Hozir turgan joyim");
  showPoint();
  const times = el("input", { value: l.times.join(", "), oninput: touch });
  const days = new Set(l.weekdays), closed = new Set(l.closed.filter((d) => d >= today()));
  const form = el("form.fields", { onsubmit: (e) => e.preventDefault() },
    el("label", {}, "Mashg‘ulot", category), el("label", {}, "Viloyat", region), el("label", {}, "Joy", place),
    num("price_uzs", "Narx, so‘m / kishi"), num("duration_min", "Davomiyligi, daqiqa"), num("capacity", "Mehmonlar, kishi"),
    el("label", {}, "Boshlanish vaqtlari", times), certLabel);
  const meeting = el("div.stack", { style: "gap:8px" }, el("label", {}, "Aniq manzil (faqat tasdiqlangan mehmonga ko‘rinadi)", address), el("div.row", {}, locate, point && el("button.ghost", { type: "button", onclick: (e) => { point = null; touch(); showPoint(); e.currentTarget.remove(); } }, "Nuqtani olib tashlash"), pointText));
  const dayOff = el("input", { type: "date", min: today(), "aria-label": "Dam olish kuni" });
  const closedList = el("div.chips");
  const drawClosed = () => closedList.replaceChildren(...[...closed].sort().map((d) => el("button", { type: "button", "aria-label": `${uzDate(d)} kunini ochish`, onclick: () => { closed.delete(d); touch(); drawClosed(); } }, `${uzDate(d)} ×`)));
  drawClosed();

  // Text editing, one language at a time.
  let lg = "uz";
  const title = el("input", { maxlength: 120, dir: "auto", oninput: () => { touch(); textDirty = true; } }), desc = el("textarea", { maxlength: 1500, dir: "auto", oninput: () => { touch(); textDirty = true; } });
  let textDirty = false;
  const texts = structuredClone(l.i18n);
  const keep = () => { if (textDirty) { texts[lg] = { title: title.value, description: desc.value }; textDirty = false; } };
  const chips = el("div.chips", { role: "group", "aria-label": "Til" }, cfg.langs.map((g) => el("button", { type: "button", dataset: { lang: g }, onclick: () => { keep(); lg = g; showText(); } }, cfg.langNames[g])));
  function showText() {
    title.lang = desc.lang = lg;
    title.value = texts[lg].title;
    desc.value = texts[lg].description;
    for (const c of chips.children) c.setAttribute("aria-pressed", String(c.dataset.lang === lg));
  }
  showText();

  const rules = priceRules(l, form, touch), sell = channels(l, touch);

  async function save() {
    keep();
    const p = { category: category.value, place: place.value, address: address.value, point, weekdays: [...days], closed: [...closed], pricing: rules.value(), ...sell.value(), times: times.value.split(/[,;\s]+/).filter(Boolean) };
    if (region.value) p.region = region.value;
    if (category.value === "tour") p.cert_no = cert.value;
    for (const f of ["price_uzs", "duration_min", "capacity"]) { const v = form.elements[f].value; if (v !== "") p[f] = Number(v); }
    let out = await api(`/api/host/listings/${l.id}`, p);
    for (const g of cfg.langs) {
      // Send only what the host rewrote, so untouched template text keeps following the numbers.
      const diff = Object.fromEntries(["title", "description"].filter((f) => texts[g][f] !== l.i18n[g][f]).map((f) => [f, texts[g][f]]));
      if (Object.keys(diff).length) out = await api(`/api/host/listings/${l.id}`, { text: { lang: g, ...diff } });
    }
    dirty = false;
    if (out.engine === "claude" && ["price_uzs", "duration_min", "capacity"].some((f) => l[f] != null && out[f] !== l[f])) toast("Raqamlar o‘zgardi. Matnda eski raqam qolmaganini tekshiring");
    return out;
  }
  const file = el("input", { type: "file", accept: "image/*", multiple: true, onchange: async () => {
    const chosen = [...file.files].slice(0, cfg.maxPhotos - l.photos.length);
    if (!chosen.length) return;
    file.disabled = true;
    try { await save(); for (const f of chosen) await api(`/api/host/listings/${l.id}/photo`, { data: await shrink(f) }); toast(`${chosen.length} ta rasm saqlandi`); } catch (e) { toast(e.message, true); }
    await reload();
    draw();
  } });
  const photo = (what, f) => act(async () => { await save(); await api(`/api/host/listings/${l.id}/photo-${what}`, { file: f }); await reload(); draw(); });
  const photos = el("div.stack", { style: "gap:10px" }, l.photos.length ? el("div.photos", {}, l.photos.map((f, i) => el("figure", {}, el("img", { src: `/photos/${f}`, alt: `${i + 1}-rasm`, loading: "lazy" }), el("div.row", { style: "gap:6px" }, i === 0 ? el("span.badge.ok", {}, "Muqova") : el("button", { type: "button", onclick: photo("cover", f) }, "Muqova qilish"), el("button.danger", { type: "button", "aria-label": `${i + 1}-rasmni o‘chirish`, onclick: photo("remove", f) }, "O‘chirish"))))) : el("div.art", {}, visual(l)),
    l.photos.length < cfg.maxPhotos ? el("label", {}, `Rasm qo‘shish (${l.photos.length}/${cfg.maxPhotos})`, file) : el("p.small.muted", {}, "Barcha rasm joylari band"));

  return el("div.stack", { style: "gap:20px" },
    el("div.row.between", {}, el("a", { href: "#takliflar" }, "Takliflarimga qaytish"), el("div.row", {}, el("span.badge" + STATE[l.status][1], {}, STATE[l.status][0]), el("span.badge" + (l.engine === "claude" ? ".ok" : ".warn"), {}, l.engine === "claude" ? "Claude AI matni" : "Shablon matn"))),
    need.size > 0 && el("div.note.warn", { role: "status" }, "E’lon qilish uchun: ", l.missing.map((m) => m.text).join(" ")),
    el("div.two", {},
      el("div.card", {}, el("h2", {}, "Ma’lumotlar"), form, meeting,
        el("div.stack", { style: "gap:6px" }, el("span.small.muted", {}, "Ish kunlari"), el("div.chips", { role: "group", "aria-label": "Ish kunlari" }, DAYS.map((d, i) => el("button", { type: "button", "aria-pressed": String(days.has(i + 1)), onclick: (e) => { touch(); days.has(i + 1) ? days.delete(i + 1) : days.add(i + 1); e.currentTarget.setAttribute("aria-pressed", String(days.has(i + 1))); } }, d)))),
        el("div.stack", { style: "gap:6px" }, el("span.small.muted", {}, "Dam olish kunlari (bron qabul qilinmaydi)"), el("div.compose", {}, dayOff, el("button", { type: "button", onclick: () => { if (!dayOff.value) return toast("Avval sanani tanlang", true); closed.add(dayOff.value); dayOff.value = ""; touch(); drawClosed(); } }, "Qo‘shish")), closedList),
        rules.node, sell.node),
      el("div.card", {}, el("h2", {}, "Mehmon nimani ko‘radi"), photos, chips, el("label", {}, "Sarlavha", title), el("label", {}, "Tavsif", desc))),
    el("div.row", {},
      el("button.primary", { onclick: act(async () => { const first = l.status !== "published"; await save(); await api(`/api/host/listings/${l.id}/publish`, {}); await reload(); location.hash = first ? `tayyor/${l.id}` : "takliflar"; toast(first ? "E’lon qilindi" : "Saqlandi"); }) }, l.status === "published" ? "Saqlash" : "E’lon qilish"),
      l.status !== "published" && el("button", { onclick: act(async () => { await save(); await reload(); draw(); toast("Saqlandi"); }) }, "Qoralamani saqlash"),
      l.status === "draft" && el("button.danger", { onclick: act(async () => { if (!(await ask("Qoralama butunlay o‘chirilsinmi?", "O‘chirish", "Qoldirish"))) return; await api(`/api/host/listings/${l.id}/delete`, {}); dirty = false; await reload(); location.hash = "takliflar"; }) }, "O‘chirish")));
}

function done(l) {
  const link = `${location.origin}/?l=${l.id}`;
  return el("div.card.empty", {}, plate(l.id, l.category), el("h2", {}, "Taklifingiz sotuvda"), el("p.muted", {}, "Havolani ulashing yoki QR kodni do‘koningizga osib qo‘ying."),
    el("img.qr", { src: `/api/qr.svg?text=${encodeURIComponent(link)}`, alt: "Taklif QR kodi" }), el("a", { href: link, target: "_blank", rel: "noopener" }, link),
    el("div.row", {}, el("button.primary", { onclick: async () => { if (await copy(link)) toast("Nusxalandi"); } }, "Havolani nusxalash"), el("a.btn", { href: "#yangi" }, "Yana taklif qo‘shish")));
}

// ---- add-ons and channels -------------------------------------------------------------------------
const EXTRA_NAME = { transfer: "Mehmonxonadan olib ketish va qaytarish", lunch: "Oila bilan tushlik", souvenir: "Yasagan buyumi, yo‘lga qadoqlangan", photo: "Tashrif suratlari" };
/** Paid add-ons, resale through partners, and the booking box for the provider's own website. */
function channels(l, touch) {
  const rows = EXTRAS.map((kind) => {
    const had = l.extras.find((x) => x.kind === kind), price = el("input", { type: "number", min: 1000, step: 1000, inputmode: "numeric", value: had?.price ?? "", "aria-label": `${EXTRA_NAME[kind]}: narx, so‘m`, placeholder: "yo‘q", oninput: touch });
    const per = el("select", { "aria-label": `${EXTRA_NAME[kind]}: kim uchun`, onchange: touch }, el("option", { value: "person" }, "kishiga"), el("option", { value: "booking" }, "guruhga"));
    per.value = had?.per ?? "person";
    return { kind, price, per, node: el("div.extra", {}, el("span", {}, EXTRA_NAME[kind]), price, per) };
  });
  const resell = el("input", { type: "checkbox", checked: l.resell, onchange: touch }), instant = el("input", { type: "checkbox", checked: l.instant, onchange: touch });
  const code = `<iframe src="${location.origin}/?l=${l.id}&embed=1&lang=en" title="${l.i18n.en.title.replace(/"/g, "")}" width="100%" height="760" style="border:0" loading="lazy"></iframe>`;
  const node = el("div.stack.rules", { style: "gap:12px" },
    el("div.stack", { style: "gap:2px" }, el("h3", {}, "Qo‘shimcha xizmatlar"), el("span.small.muted", {}, "Mehmon bron qilayotganda belgilaydi. Bo‘sh qoldirilgani ko‘rinmaydi.")), el("div.stack", { style: "gap:8px" }, rows.map((r) => r.node)),
    el("label.check", {}, instant, el("span", {}, el("b", {}, "Darhol tasdiqlash"), el("br"), el("span.small.muted", {}, "To‘langan bron o‘zi tasdiqlanadi va mehmon chiptani darhol oladi. Ko‘proq mehmon bron qiladi, lekin har bir bronga tayyor bo‘lishingiz kerak."))),
    el("label.check", {}, resell, el("span", {}, el("b", {}, "Sotuv hamkorlari ham sotsin"), el("br"), el("span.small.muted", {}, "Turoperatorlar, mehmonxonalar va bron saytlari. Hamkor ulushi (odatda 10–15%) sizning ulushingizdan olinadi."))),
    l.status === "published" && el("details", {}, el("summary", { style: "cursor:pointer;font-weight:600" }, "O‘z saytingizga bron oynasi"), el("p.small.muted", {}, "Bu kodni saytingizga qo‘ying. Mehmon sizning saytingizda bron qiladi."), el("code.secret", {}, code), el("button", { type: "button", onclick: async () => { if (await copy(code)) toast("Nusxalandi"); } }, "Kodni nusxalash")));
  const value = () => ({ instant: instant.checked, resell: resell.checked, extras: rows.filter((r) => r.price.value !== "").map((r) => ({ kind: r.kind, price: Number(r.price.value), per: r.per.value })) });
  return { node, value };
}

// ---- price rules ------------------------------------------------------------------------------
/** Weekend, last-minute and group prices, with what a guest would really pay. */
function priceRules(l, form, touch) {
  const p = structuredClone(l.pricing ?? {}), box = el("output.small"), pick = (value, opts, set, label) => { const s = el("select", { "aria-label": label, onchange: () => { set(Number(s.value)); touch(); say(); } }, opts.map(([v, text]) => el("option", { value: v }, text))); s.value = String(value); return s; };
  const pcts = ([lo, hi], sign) => [[0, "yo‘q"], ...[5, 10, 15, 20, 25, 30, 40, 50].filter((n) => n >= lo && n <= hi).map((n) => [n, `${sign}${n}%`])];
  const last = { hours: p.last?.hours ?? 24, pct: p.last?.pct ?? 0 }, group = { from: p.group?.from ?? 4, pct: p.group?.pct ?? 0 };
  let weekend = p.weekend ?? 0;
  const value = () => ({ ...(weekend && { weekend }), ...(last.pct && { last: { ...last } }), ...(group.pct && { group: { ...group } }) });
  // A value set elsewhere stays selectable, so saving never changes it silently.
  const withOwn = (opts, v, text) => (opts.some(([x]) => x === v) ? opts : [...opts, [v, text]]);
  function say() {
    const price = Number(form.elements.price_uzs.value), x = { price_uzs: price, pricing: value() };
    if (!(price >= 1000)) return box.replaceChildren("Avval narxni kiriting");
    const d = (n) => new Date(Date.now() + 5 * 3600e3 + n * 864e5).toISOString().slice(0, 10), far = [10, 11, 12, 13, 14, 15, 16].map(d), week = (s) => [6, 0].includes(new Date(s + "T00:00:00Z").getUTCDay());
    const normal = unitPrice(x, far.find((s) => !week(s)), "10:00").unit, sat = unitPrice(x, far.find(week), "10:00").unit, many = unitPrice(x, far.find((s) => !week(s)), "10:00", group.from).unit;
    const soon = unitPrice({ ...x, pricing: { last: value().last } }, d(0), "10:00", 1, Date.parse(`${d(0)}T09:30:00+05:00`)).unit;
    box.replaceChildren(...[["Oddiy kun", normal], ["Dam olish kuni", sat], [`${group.from} kishidan`, many], ["Oxirgi daqiqa", soon]].map(([k, v]) => el("span", {}, `${k}: `, el("b", {}, som(v)))));
  }
  form.elements.price_uzs.addEventListener("input", say);
  const node = el("div.stack.rules", { style: "gap:10px" }, el("div.stack", { style: "gap:2px" }, el("h3", {}, "Moslashuvchan narx"), el("span.small.muted", {}, "Chegirmalar qo‘shilmaydi, kattasi ishlaydi. Eski bronlar o‘zgarmaydi.")),
    el("div.fields", {}, el("label", {}, "Shanba va yakshanba", pick(weekend, withOwn([[-20, "−20%"], [-10, "−10%"], [0, "farqsiz"], [10, "+10%"], [20, "+20%"], [30, "+30%"], [50, "+50%"]], weekend, `${weekend}%`), (v) => { weekend = v; }, "Shanba va yakshanba narxi")),
      el("label", {}, "Oxirgi daqiqa chegirmasi", pick(last.pct, withOwn(pcts(PRICE_LIMITS.last, "−"), last.pct, `−${last.pct}%`), (v) => { last.pct = v; }, "Oxirgi daqiqa chegirmasi")), el("label", {}, "Necha soat qolganda", pick(last.hours, PRICE_LIMITS.hours.map((h) => [h, `${h} soat`]), (v) => { last.hours = v; }, "Necha soat qolganda")),
      el("label", {}, "Guruh chegirmasi", pick(group.pct, withOwn(pcts(PRICE_LIMITS.group, "−"), group.pct, `−${group.pct}%`), (v) => { group.pct = v; }, "Guruh chegirmasi")), el("label", {}, "Necha kishidan", pick(group.from, withOwn([2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30].map((n) => [n, `${n} kishi`]), group.from, `${group.from} kishi`), (v) => { group.from = v; }, "Necha kishidan"))), box);
  say();
  return { node, value };
}

// ---- bookings -------------------------------------------------------------------------------
function bookingCard(b) {
  const [label, tone] = STATUS[b.status], live = ["paid", "confirmed"].includes(b.status);
  const send = (body) => act(async () => { await api(`/api/host/bookings/${b.id}/messages`, body()); await reload(); draw(); });
  const draft = el("input", { maxlength: 1000, required: true, placeholder: "Javob yozing", "aria-label": "Javob yozing", dataset: { keep: b.id } });
  const guestMsg = b.messages.findLast((m) => m.sender === "guest");
  const decide = (what) => act(async () => { home = await api(`/api/host/bookings/${b.id}/${what}`, {}); draw(); });
  return el("div.card", {}, el("div.row.between", {}, el("h2.sm", {}, b.title), el("span.badge" + tone, {}, label)),
    b.extras?.length > 0 && el("div.note", {}, "Qo‘shimcha: ", b.extras.map((x) => EXTRA_NAME[x.kind]).join(", ")),
    el("dl.facts", {}, [["Mehmon", `${b.guest_name}, ${b.guests} kishi`], ...(b.guest_phone ? [["Telefon", el("a", { href: `tel:${b.guest_phone}` }, b.guest_phone)]] : []), ["Vaqt", `${uzDate(b.date)}, ${b.time}`], ["Sizga", som(b.host_uzs)], ["Tili va kanali", `${cfg.langNames[b.lang]}, ${CHANNEL[b.channel]}`]].map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v)))),
    b.checked_in_at && el("div.note.ok", {}, "Mehmon chipta bilan keldi"),
    b.moved_at && b.status === "paid" && el("div.note.warn", {}, "Mehmon vaqtni o‘zgartirdi. Yangi vaqtni tasdiqlang"),
    b.status === "paid" && b.decide_by && el("p.small.muted", {}, `Javob muddati: ${new Intl.DateTimeFormat("uz", { timeZone: "Asia/Tashkent", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(b.decide_by))}. Javob berilmasa, bron rad etiladi va pul mehmonga qaytadi.`),
    b.status === "paid" && el("div.row", {}, el("button.primary", { onclick: decide("accept") }, "Qabul qilish"),
      el("button", { onclick: act(async () => { if (await ask("Bron rad etilsinmi? Mehmonga xabar boradi va puli qaytariladi.", "Rad etish", "Yo‘q")) { home = await api(`/api/host/bookings/${b.id}/decline`, {}); draw(); } }) }, "Rad etish")),
    b.messages.length > 0 && el("div.chat", { role: "log" }, b.messages.map((m) => { const mine = m.sender === "host"; return el("div.msg" + (mine ? ".me" : ""), { dir: "auto" }, mine ? m.original : m.translated,
      m.engine === "untranslated" ? el("small", {}, "Tarjima qilinmadi (AI ulanmagan)") : !mine && m.original !== m.translated && el("small", {}, m.original)); })),
    live && guestMsg && el("div.chips", {}, el("button", { onclick: () => speak(guestMsg.translated) }, "Eshitish"), Object.keys(cfg.phrases).filter((k) => k[0] === "r").map((k) => el("button", { onclick: send(() => ({ code: k })) }, cfg.phrases[k].uz))),
    live && el("form.compose", { onsubmit: (e) => { e.preventDefault(); const v = draft.value; draft.value = ""; send(() => ({ text: v }))({ currentTarget: e.submitter }); } }, draft, el("button", { type: "submit" }, "Yuborish")));
}

/** The coming visits on one line, with the time left to each. */
function dayLine(next) {
  const list = next.filter((b) => ["paid", "confirmed"].includes(b.status) && !b.checked_in_at && Date.parse(`${b.date}T${b.time}:00+05:00`) > Date.now() - 2 * 3600e3).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)).slice(0, 6);
  if (!list.length) return null;
  const left = (b) => { const min = Math.round((Date.parse(`${b.date}T${b.time}:00+05:00`) - Date.now()) / 60e3); return min < 0 ? "boshlandi" : min < 60 ? `${min} daqiqadan keyin` : min < 48 * 60 ? `${Math.round(min / 60)} soatdan keyin` : `${Math.round(min / 1440)} kundan keyin`; };
  return el("section.card", {}, el("h2", {}, "Yaqin tashriflar"), el("ol.dayline", { tabindex: 0, "aria-label": "Yaqin tashriflar" }, list.map((b) => el("li" + (b.status === "paid" ? ".wait" : ""), {}, el("b", {}, `${+b.date.slice(8)}-${MONTHS[+b.date.slice(5, 7) - 1]}, ${b.time}`), el("span", {}, `${b.guest_name}, ${b.guests} kishi`), el("span.small.muted", { dataset: { at: `${b.date}T${b.time}` } }, left(b)), b.status === "paid" && el("span.badge.warn", {}, "Javob bering")))));
}

function bookings() {
  const next = home.bookings.filter((b) => !b.past), past = home.bookings.filter((b) => b.past);
  if (!home.bookings.length) return el("div.card.empty", {}, plate("bron", "pottery"), el("h2", {}, "Hali bron yo‘q"), el("p.muted", {}, home.listings.some((l) => l.status === "published") ? "Yangi bron tushganda shu yerda chiqadi va ovoz chiqarib aytiladi." : "Avval taklif qo‘shing va e’lon qiling."), el("a.btn.primary", { href: "#yangi" }, "Taklif qo‘shish"));
  const d = today(), kinds = { all: ["Hammasi", () => true], wait: ["Javob kutmoqda", (b) => b.status === "paid"], today: ["Bugun", (b) => b.date === d], sure: ["Tasdiqlangan", (b) => b.status === "confirmed"] };
  const grid = el("div.grid.wide"), chips = el("div.chips", { role: "group", "aria-label": "Bronlarni saralash" }, Object.entries(kinds).map(([k, [name, is]]) => el("button", { type: "button", dataset: { k }, onclick: () => { show = k; fill(); } }, `${name} (${next.filter(is).length})`)));
  const word = el("input", { type: "search", placeholder: "Mehmon ismi yoki taklif", "aria-label": "Bron qidirish", value: find, oninput: () => { find = word.value; fill(); } });
  function fill() {
    const list = next.filter((b) => kinds[show][1](b) && `${b.guest_name} ${b.title}`.toLowerCase().includes(find.trim().toLowerCase()));
    for (const c of chips.children) c.setAttribute("aria-pressed", String(c.dataset.k === show));
    grid.replaceChildren(...(list.length ? list.map(bookingCard) : [el("p.muted", {}, "Bunday bron yo‘q.")]));
  }
  fill();
  return el("div.stack", { style: "gap:20px" }, dayLine(next), next.length ? [el("div.toolbar", {}, chips, next.length > 4 && word), grid] : el("p.muted", {}, "Kutilayotgan bron yo‘q."),
    past.length > 0 && el("details", {}, el("summary", { style: "cursor:pointer;padding:8px 0;font-weight:600" }, `O‘tgan bronlar (${past.length})`), el("div.grid.wide", { style: "margin-block-start:12px" }, past.map(bookingCard))));
}

// ---- group requests ---------------------------------------------------------------------------
/** Groups and private visits asking for a price. The guest's e-mail stays hidden; the answer goes to them by the platform. */
function requests() {
  const box = el("div.stack", { style: "gap:18px" }, el("p.muted", { role: "status" }, "Yuklanmoqda…"));
  api("/api/host/requests").then((list) => {
    if (!list.length) return box.replaceChildren(el("div.card.empty", {}, plate("guruh", "village"), el("h2", {}, "Hali so‘rov yo‘q"), el("p.muted", {}, "Katta guruh yoki alohida tashrif istagan mehmon narx so‘raganda shu yerda chiqadi.")));
    box.replaceChildren(el("div.grid.wide", {}, list.map((g) => {
      const time = el("select", { "aria-label": "Vaqt" }, g.times.map((x) => el("option", { value: x, selected: x === g.quote_time }, x)));
      const total = el("input", { type: "number", min: 1000, step: 1000, inputmode: "numeric", required: true, "aria-label": "Jami narx, so‘m", value: g.quote_uzs ?? g.price_uzs * g.guests }), note = el("input", { maxlength: 600, "aria-label": "Izoh", placeholder: "Izoh (ixtiyoriy)", value: g.quote_note ?? "" });
      const answer = (body) => act(async () => { await api(`/api/host/requests/${g.id}`, body()); toast("Javob mehmonga yuborildi"); draw(); });
      const STATE = { new: ["Javob kutmoqda", ".warn"], quoted: ["Narx yuborilgan", ""], booked: ["Bron qilindi", ".ok"], declined: ["Rad etilgan", ""] }[g.status];
      return el("div.card", {}, el("div.row.between", {}, el("h2.sm", {}, g.title), el("span.badge" + STATE[1], {}, STATE[0])),
        el("dl.facts", {}, [["Mehmon", `${g.name}, ${g.guests} kishi${g.private ? ", faqat o‘z guruhi" : ""}`], ["Sana", uzDate(g.date)], ["Tili", cfg.langNames[g.lang]], ...(g.phone ? [["Telefon", el("a", { href: `tel:${g.phone}` }, g.phone)]] : [])].map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v)))),
        g.note && el("p.note", { dir: "auto" }, g.note),
        ["new", "quoted"].includes(g.status) && el("form.stack", { style: "gap:10px", onsubmit: (e) => { e.preventDefault(); answer(() => ({ time: time.value, total_uzs: Number(total.value), note: note.value.trim() || null }))({ currentTarget: e.submitter }); } },
          el("div.fields", {}, el("label", {}, "Vaqt", time), el("label", {}, "Jami narx, so‘m", total)), el("label", {}, "Izoh", note),
          el("p.small.muted", {}, `Odatdagi narxda: ${som(g.price_uzs * g.guests)}. Mehmon to‘lasa, bron o‘zi tasdiqlanadi.`),
          el("div.row", {}, el("button.primary", { type: "submit" }, g.status === "quoted" ? "Narxni yangilash" : "Narx yuborish"), el("button", { type: "button", onclick: act(async () => { if (await ask("So‘rov rad etilsinmi? Mehmonga xabar boradi.", "Rad etish", "Yo‘q")) await answer(() => ({ decline: true }))({}); }) }, "Rad etish"))));
    })));
  }).catch((e) => box.replaceChildren(el("div.note.bad", { role: "alert" }, e.message)));
  return box;
}

// ---- promotion ----------------------------------------------------------------------------------
/** A week at the top of search, always marked. Paid like a plan. */
function boost(x) {
  if (x.status !== "published") return null;
  const until = x.promoted_until && new Date(x.promoted_until) > new Date() ? new Intl.DateTimeFormat("uz", { day: "numeric", month: "long" }).format(new Date(x.promoted_until)) : null;
  const pay = (method) => act(async () => { const r = await api(`/api/host/listings/${x.id}/boost`, { method }); if (r.url) location.href = r.url; else { await reload(); draw(); toast("Taklif 7 kun qidiruvda birinchi ko‘rinadi"); } });
  return el("details.boost", {}, el("summary", {}, until ? `Reklamada: ${until} gacha` : "Ko‘proq ko‘rsatish"),
    el("p.small.muted", {}, `${cfg.boost.days} kun qidiruv boshida, “Reklama” belgisi bilan: ${som(cfg.boost.price)}. Muddat qo‘shilib boradi.`),
    el("div.row", {}, cfg.payMethods.map((m, i) => el("button" + (i ? "" : ".primary"), { onclick: pay(m) }, m === "test" ? "Sinov to‘lovi" : { octo: "Karta (Octo)", click: "Click", payme: "Payme" }[m]))));
}

function listings() {
  if (!home.listings.length) return el("div.card.empty", {}, plate("taklif", "ikat"), el("h2", {}, "Hali taklif yo‘q"), el("a.btn.primary", { href: "#yangi" }, "Taklif qo‘shish"));
  return el("div.grid", {}, home.listings.map((x) => el("div.item", {}, el("div.art", { style: tint(x.category) }, visual(x), el("span.badge" + STATE[x.status][1], {}, STATE[x.status][0])),
    el("div.in", {}, el("h2.sm", {}, x.i18n.uz.title), el("p.small.muted", {}, [x.price_uzs && som(x.price_uzs), x.duration_min && `${x.duration_min} daqiqa`, x.reviews > 0 && `★ ${x.rating} (${x.reviews})`].filter(Boolean).join(" · ")), Object.keys(x.pricing ?? {}).length > 0 && el("p.small", {}, el("span.off", { style: "margin:0" }, "Moslashuvchan narx")),
      el("div.row", {}, el("a.btn", { href: `#taklif/${x.id}` }, "Tahrirlash"), x.status === "published" && el("a", { href: `/?l=${x.id}`, target: "_blank", rel: "noopener" }, "Ko‘rish"),
        x.status === "published" && el("button.ghost", { onclick: act(async () => { if (!(await ask("Taklif qidiruvdan olinsinmi? Mavjud bronlar saqlanadi.", "To‘xtatish", "Yo‘q"))) return; await api(`/api/host/listings/${x.id}/pause`, {}); await reload(); draw(); }) }, "To‘xtatish")), boost(x)))));
}

async function signOut() {
  await api("/api/auth/sign-out", {});
  stop?.();
  forget();
  home = freshKey = null;
  history.replaceState(null, "", "/mezbon");
  document.getElementById("bottom").replaceChildren();
  welcome();
}

// ---- shell ----------------------------------------------------------------------------------
function draw() {
  if (!home) return;
  // Keep half-typed replies across live updates.
  const kept = Object.fromEntries([...app.querySelectorAll("[data-keep]")].map((i) => [i.dataset.keep, i.value])), active = document.activeElement?.dataset?.keep;
  const [where, lid] = tab().split("/");
  const l = home.listings.find((x) => x.id === lid);
  const ctx = { cfg, home, reload, speak };
  const body = where === "yordamchi" ? assistant(ctx) : where === "yangi" ? composer() : where === "sorovlar" ? requests() : where === "kalendar" ? calendar(ctx) : where === "chipta" || where === "chiptalar" ? tickets(ctx, lid) : where === "tahlil" ? analytics(ctx) : where === "bozor" ? market(ctx) : where === "tarif" ? plans(ctx) : where === "taklif" && l ? editor(l) : where === "tayyor" && l ? done(l) : where === "takliflar" || (lid && where !== "chipta") ? listings() : where === "hisob" ? account({ home, cfg, planName: PLAN_NAME[home.plan.plan], onKey: (k) => { freshKey = k; draw(); }, signOut, redraw: draw }) : bookings();
  const cur = { taklif: "takliflar", tayyor: "takliflar", chipta: "chiptalar" }[where] ?? where;
  const GROUPS = [["AI yordamchi", [["yordamchi", "AI yordamchi"]]], ["Smart bron", [["bronlar", "Bronlar"], ["sorovlar", "Guruh so‘rovlari"], ["takliflar", "Takliflarim"], ["kalendar", "Kalendar"], ["chiptalar", "Chiptalar"]]], ["Tahlil", [["tahlil", "Daromad"], ["bozor", "Bozor tahlili"]]], ["Hisob", [["tarif", "Tarif"], ["hisob", "Sozlamalar"]]]];
  const group = GROUPS.find(([, t]) => t.some(([id]) => id === cur)) ?? GROUPS[1];
  const ICON = { yordamchi: "spark", sorovlar: "people", bronlar: "calendar", takliflar: "home", kalendar: "clock", chiptalar: "ticket", tahlil: "chart", bozor: "globe", tarif: "check", hisob: "gear" };
  const count = (id) => id === "bronlar" && home.sums.waiting > 0 && el("span.count", { "aria-label": `${home.sums.waiting} ta yangi` }, String(home.sums.waiting));
  document.getElementById("bottom").replaceChildren(...GROUPS.map((g) => el("a", { href: "#" + g[1][0][0], "aria-current": g === group ? "true" : null }, icon(ICON[g[1][0][0]], 23), g[0], count(g[1][0][0]))));
  page(el("div.shell", {}, el("nav.side", { "aria-label": "Kabinet" }, GROUPS.map(([name, items]) => el("section", {}, el("h2", {}, name), items.map(([id, text]) => el("a", { href: "#" + id, "aria-current": cur === id ? "page" : null }, icon(ICON[id], 20), text, count(id)))))), el("div.stack", {},
    el("div.row.between", {}, el("div.row", {}, el("h1", {}, home.name), home.verified && el("span.verified", {}, icon("shield", 18), "Tekshirilgan"), home.plan.plan !== "free" && el("span.badge.ok", {}, PLAN_NAME[home.plan.plan])), el("a.btn.primary", { href: "#yangi" }, "Yangi taklif")),
    fresh && secureCard({ cfg, fresh, name: home.name, close: () => { fresh = null; draw(); } }),
    freshKey && keyCard(freshKey, home.name, () => { freshKey = null; draw(); }),
    home.suspended && cur !== "hisob" && el("div.note.bad", { role: "alert" }, "Hisobingiz ma’muriyat tomonidan to‘xtatilgan. Takliflaringiz ko‘rinmaydi."),
    cur === "bronlar" && home.bookings.length > 0 && el("div.tiles", {}, [["Tasdiqlangan daromad" + (cfg.testPayments ? " (sinov)" : ""), home.sums.earned, som], ["Tasdiqlangan mehmonlar", home.sums.guests], ["Javob kutayotgan bronlar", home.sums.waiting]].map(([k, v, f]) => el("div.card.tile", {}, counter(k, v, f), el("span.muted", {}, k)))),
    group[1].length > 1 && el("nav.chips.sub", { "aria-label": group[0] }, group[1].map(([id, text]) => el("a.chip", { href: "#" + id, "aria-current": cur === id ? "page" : null }, text, count(id)))), body)));
  for (const i of app.querySelectorAll("[data-keep]")) { i.value = kept[i.dataset.keep] ?? ""; if (i.dataset.keep === active) i.focus(); }
  for (const c of app.querySelectorAll(".chat")) c.scrollTo(0, 1e6);
  app.querySelector(".sub [aria-current]")?.scrollIntoView({ block: "nearest", inline: "center" });
}
async function reload() { home = await api("/api/host"); }

let here = location.hash;
addEventListener("hashchange", async () => {
  if (location.hash.startsWith("#kirish=") || location.hash.startsWith("#email=")) return open().catch((e) => { if (e.status === 401) welcome(); else toast(e.message, true); });
  if (!home || location.hash === here) return;
  if (dirty && !(await ask("Saqlanmagan o‘zgarishlar bor. Chiqasizmi?", "Saqlamay chiqish", "Qolish"))) { history.replaceState(null, "", here || "/mezbon"); return; }
  dirty = false;
  here = location.hash;
  speechSynthesis?.cancel?.();
  draw();
  scrollTo(0, 0);
});
addEventListener("beforeunload", (e) => { if (dirty) e.preventDefault(); });

async function start() {
  await reload();
  here = location.hash;
  draw();
  stop?.();
  stop = listen("/api/host/events", async (ev) => {
    try { await reload(); } catch { return; }
    // Never redraw over a form or a recording; news still arrives as a toast and by voice.
    // A search being typed is not interrupted either.
    if (["bronlar", "takliflar"].includes(tab()) && document.activeElement?.type !== "search") draw();
    else if (tab() === "yordamchi") app.querySelector(".shell > .stack > .stack:last-child")?.refresh?.();
    const b = home.bookings.find((x) => x.id === ev.id);
    if (!b) return;
    const say = ev.type === "booking" ? `Yangi bron! ${b.guest_name}, ${b.guests} kishi, ${uzDate(b.date)}, soat ${b.time}. Sizga ${som(b.host_uzs)}.`
      : ev.type === "moved" ? `${b.guest_name} vaqtni o‘zgartirdi: ${uzDate(b.date)}, soat ${b.time}. Qayta tasdiqlang.`
      : ev.type === "unanswered" ? `Javob berilmagani uchun bron rad etildi: ${b.guest_name}, ${uzDate(b.date)}.`
      : ev.type === "cancelled" ? `${b.guest_name} bronni bekor qildi: ${uzDate(b.date)}, soat ${b.time}.`
      : `Mehmondan xabar: ${b.messages.findLast((m) => m.sender === "guest").translated}`;
    toast(say);
    speak(say);
  });
}

async function open() {
  const mail = /^#email=(e_[\w-]{32})$/.exec(location.hash)?.[1];
  if (mail) {
    history.replaceState(null, "", "/mezbon");
    try { await api("/api/auth/email-confirm", { token: mail }); toast("Email tasdiqlandi"); } catch (e) { toast(e.status === 401 ? "Havola eskirgan yoki ishlatilgan" : e.message, true); }
  }
  if (location.hash.startsWith("#kirish=")) await reload().catch((e) => { if (e.status !== 401) throw e; });
  if (await enter(home?.name)) { forget(); freshKey = null; }
  await start();
}
open().catch((e) => { if (e.status === 401) welcome(); else page(el("div.note.bad", { role: "alert" }, e.message), el("button", { onclick: () => location.reload() }, "Qayta urinish")); });
