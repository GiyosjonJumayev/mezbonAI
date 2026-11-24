// Provider studio: slot calendar, ticket check-in, revenue analytics, market intelligence, plans.
import { act, api, ask, el, plate, som, toast } from "/common.js";

const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
const WEEK = ["Yak", "Du", "Se", "Chor", "Pay", "Ju", "Shan"];
const day = (d) => `${+d.slice(8)}-${MONTHS[+d.slice(5, 7) - 1]}`;
const weekday = (d) => WEEK[new Date(d + "T00:00:00Z").getUTCDay()];
export const PLAN_NAME = { free: "Bepul", pro: "Pro", business: "Business" };
const CHANNEL = { web: "Sayt", hotel: "Mehmonxona QR", ai: "AI yordamchi" };
const STATUS = { confirmed: "Tasdiqlangan", paid: "Javob kutilmoqda", declined: "Rad etilgan", cancelled: "Bekor qilingan" };
const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const card = (title, ...kids) => el("section.card", {}, el("h2", {}, title), ...kids);
const tiles = (list) => el("div.tiles", {}, list.map(([k, v, sub]) => el("div.card.tile", {}, el("b", {}, v), el("span.muted", {}, k), sub && el("span.small.muted", {}, sub))));
const table = (head, rows) => el("div.scroll", {}, el("table", {}, el("thead", {}, el("tr", {}, head.map(([h, n]) => el(n ? "th.n" : "th", { scope: "col" }, h)))), el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c, i) => el(head[i][1] ? "td.n" : "td", {}, c)))))));
const lock = (text) => el("div.card.empty", {}, plate("qulf", "metal"), el("p", {}, text), el("a.btn.primary", { href: "#tarif" }, "Tariflarni ko‘rish"));

/** A view that loads its own data; it shows errors in place and ignores answers that arrive after it was replaced. */
function live(load) {
  const box = el("div.stack", { style: "gap:22px" }, el("p.muted", { role: "status" }, "Yuklanmoqda…"));
  let turn = 0;
  const refresh = async (...args) => {
    const mine = ++turn;
    try { const kids = await load(refresh, ...args); if (mine === turn) box.replaceChildren(...[kids].flat().filter(Boolean)); }
    catch (e) { if (!e.code && !e.status) console.error(e); if (mine === turn) box.replaceChildren(el("div.note.bad", { role: "alert" }, e.message), el("button", { onclick: () => refresh(...args) }, "Qayta urinish")); }
  };
  refresh();
  return box;
}

// ---- availability calendar ------------------------------------------------------------------------
export function calendar({ key, home }) {
  const mine = home.listings.filter((l) => l.status !== "draft");
  if (!mine.length) return el("div.card.empty", {}, plate("kalendar", "carpet"), el("h2", {}, "Kalendar bo‘sh"), el("p.muted", {}, "Taklif e’lon qilgach, har bir vaqtdagi joylarni shu yerda boshqarasiz."), el("a.btn.primary", { href: "#yangi" }, "Taklif qo‘shish"));
  let lid = mine[0].id, from = "";
  const pick = el("select", { onchange: () => { lid = pick.value; view(); } }, mine.map((l) => el("option", { value: l.id }, l.i18n.uz.title)));
  const start = el("input", { type: "date", min: new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10), onchange: () => { from = start.value; view(); } });
  let view;
  const box = live(async (refresh) => {
    view = refresh;
    const c = await api(`/api/host/listings/${lid}/calendar?days=14${from ? `&from=${from}` : ""}`, null, key);
    const set = (d, s, capacity) => act(async () => { await api(`/api/host/listings/${lid}/slot`, { date: d.date, time: s.time, capacity }, key); await refresh(); });
    return [c.status === "paused" && el("div.note.warn", {}, "Bu taklif to‘xtatilgan, yangi bron qabul qilinmaydi."),
      el("div.cal", {}, c.days.map((d) => el("section.day" + (d.open ? "" : ".off"), { "aria-label": day(d.date) }, el("h3", {}, `${weekday(d.date)}, ${day(d.date)}`),
        d.open ? d.slots.map((s) => {
          const full = s.booked >= s.capacity, over = s.booked > s.capacity;
          return el("div.slot" + (s.capacity === 0 ? ".shut" : ""), {}, el("div.row.between", {}, el("b", {}, s.time), el("span.badge" + (over ? ".bad" : s.capacity === 0 ? "" : full ? ".warn" : ".ok"), {}, s.capacity === 0 ? "Yopiq" : `${s.booked} / ${s.capacity}`)),
            over && el("span.small", {}, `${s.booked} kishi bron qilgan: bronlar saqlanadi`),
            el("div.row", {}, el("button.mini", { "aria-label": `${s.time}: joyni kamaytirish`, disabled: s.capacity === 0, onclick: set(d, s, s.capacity - 1) }, "−"), el("button.mini", { "aria-label": `${s.time}: joy qo‘shish`, disabled: s.capacity >= 100, onclick: set(d, s, s.capacity + 1) }, "+"),
              s.capacity > 0 ? el("button.mini.text", { onclick: set(d, s, 0) }, "Yopish") : el("button.mini.text", { onclick: set(d, s, null) }, "Ochish"), s.changed && s.capacity > 0 && el("button.mini.text", { onclick: set(d, s, null) }, `Odatdagi ${c.base}`)));
        }) : el("p.small.muted", {}, d.closed ? "Dam olish kuni" : "Ish kuni emas"))))];
  });
  return el("div.stack", { style: "gap:18px" }, el("div.fields", {}, el("label", {}, "Taklif", pick), el("label", {}, "Qaysi sanadan", start)), el("p.small.muted", {}, "Ko‘rsatkich: band / jami joy. Joyni kamaytirish mavjud bronlarni bekor qilmaydi. Doimiy jadval taklif sahifasida o‘zgaradi."), box);
}

// ---- tickets --------------------------------------------------------------------------------------
export const ticketCode = (text) => /chipta\/([0-9A-F-]{12,16})/i.exec(text)?.[1] ?? text;
const STATE = { valid: ["Yaroqli. Bugungi bron", ".ok"], used: ["Allaqachon ishlatilgan", ".bad"], early: ["Boshqa kun uchun", ".warn"], late: ["Muddati o‘tgan", ".bad"], void: ["Bron bekor qilingan", ".bad"] };

export function tickets({ key, cfg, reload }, code) {
  const input = el("input", { autocapitalize: "characters", autocomplete: "off", spellcheck: "false", placeholder: "XXXX-XXXX-XXXX", maxlength: 200, required: true, value: code ?? "" });
  const out = el("div.stack", { "aria-live": "polite" });
  async function check(raw) {
    out.replaceChildren(el("p.muted", {}, "Tekshirilmoqda…"));
    try {
      const t = await api(`/api/host/tickets/${encodeURIComponent(ticketCode(raw).replace(/[^0-9a-f]/gi, "").slice(0, 12) || "x")}`, null, key);
      const [text, tone] = STATE[t.state];
      out.replaceChildren(el("div.card", {}, el("div.note" + tone, { role: "status" }, text, t.checked_in_at && t.state === "used" ? ` (${new Date(t.checked_in_at).toLocaleString("ru-RU")})` : ""),
        el("dl.facts", {}, [["Mehmon", `${t.guest_name}, ${t.guests} kishi`], ["Vaqt", `${day(t.date)}, ${t.time}`], ["Taklif", t.title], ["Tili", cfg.langNames[t.lang]]].map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v)))),
        t.state === "valid" && el("button.primary", { onclick: act(async () => { await api(`/api/host/tickets/${t.code}/check-in`, {}, key); await reload(); toast(`${t.guest_name} qabul qilindi`); await check(t.code); }) }, `${t.guests} kishini qabul qilish`)));
    } catch (e) { out.replaceChildren(el("div.note.bad", { role: "alert" }, e.message)); }
  }
  const scan = el("button.mic", { type: "button" }, el("i"), el("span", {}, "Kamera bilan skanerlash"));
  const video = el("video", { playsinline: true, muted: true, hidden: true });
  const canScan = "BarcodeDetector" in window && navigator.mediaDevices?.getUserMedia;
  let stream = null;
  const stop = () => { stream?.getTracks().forEach((x) => x.stop()); stream = null; video.hidden = true; scan.classList.remove("on"); scan.lastChild.textContent = "Kamera bilan skanerlash"; };
  scan.onclick = async () => {
    if (stream) return stop();
    try {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      video.srcObject = stream;
      video.hidden = false;
      await video.play();
      scan.classList.add("on");
      scan.lastChild.textContent = "To‘xtatish";
      while (stream && video.isConnected) {
        const found = await detector.detect(video).catch(() => []);
        if (found[0]) { input.value = ticketCode(found[0].rawValue); stop(); return check(input.value); }
        await new Promise((r) => setTimeout(r, 250));
      }
      stop(); // the page moved on: release the camera
    } catch { stop(); toast("Kamera ochilmadi. Kodni qo‘lda kiriting", true); }
  };
  if (code) check(code);
  return el("div.two", {}, el("div.card", {}, el("h2", {}, "Chiptani tekshirish"), canScan ? [scan, video] : el("p.note", {}, "Telefon kamerasi bilan mehmonning QR kodini skanerlang: havola shu sahifani ochadi. Yoki kodni kiriting."),
    el("form.compose", { onsubmit: (e) => { e.preventDefault(); check(input.value); } }, input, el("button.primary", { type: "submit" }, "Tekshirish"))), out);
}

// ---- analytics ------------------------------------------------------------------------------------
function columns(series, bucket) {
  const max = Math.max(1, ...series.map((s) => s.earned)), peak = series.findIndex((s) => s.earned === max);
  const span = (s) => (bucket === 1 ? day(s.from) : `${day(s.from)} – ${day(s.to)}`);
  const tip = el("div.tip", { hidden: true });
  const show = (s, e) => { tip.hidden = false; tip.replaceChildren(el("b", {}, som(s.earned)), el("span", {}, `${span(s)}, ${s.bookings} ta bron`)); const r = e.currentTarget.getBoundingClientRect(), p = plot.getBoundingClientRect(); tip.style.left = `${Math.min(Math.max(r.left + r.width / 2 - p.left, 90), p.width - 90)}px`; };
  const plot = el("div.plot", { role: "group", "aria-label": "Daromad grafigi" }, series.map((s, i) => el("button.col", { type: "button", "aria-label": `${span(s)}: ${som(s.earned)}, ${s.bookings} ta bron`, onpointerenter: (e) => show(s, e), onfocus: (e) => show(s, e), onpointerleave: () => { tip.hidden = true; }, onblur: () => { tip.hidden = true; } },
    i === peak && s.earned > 0 && el("span.peak", {}, som(s.earned)), el("i", { style: `height:${s.earned ? Math.max(2, (s.earned / max) * 100) : 0}%` }))), tip);
  return el("figure", {}, plot, el("div.row.between.small.muted", {}, el("span", {}, day(series[0].from)), el("span", {}, day(series.at(-1).to))));
}

/** Weekday by hour. One hue, darker means more guests; the number is always printed. */
function busyTable(rows) {
  if (!rows.length) return el("p.muted", {}, "Bu davrda ma’lumot yo‘q.");
  const times = [...new Set(rows.map((r) => r.time))].sort(), max = Math.max(...rows.map((r) => r.guests)), at = new Map(rows.map((r) => [`${r.weekday}|${r.time}`, r.guests]));
  return el("div.scroll", {}, el("table.heat", {}, el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Vaqt"), [1, 2, 3, 4, 5, 6, 7].map((d) => el("th.n", { scope: "col" }, WEEK[d % 7])))),
    el("tbody", {}, times.map((tm) => el("tr", {}, el("td", {}, tm), [1, 2, 3, 4, 5, 6, 7].map((d) => { const n = at.get(`${d}|${tm}`) ?? 0; return el("td.n", { style: n ? `background:color-mix(in srgb, var(--bar) ${Math.round(8 + (n / max) * 32)}%, var(--card))` : null, title: `${WEEK[d % 7]}, ${tm}: ${n} mehmon` }, n ? String(n) : "·"); }))))));
}

export function analytics({ key, cfg }) {
  let days = 30;
  return live(async (refresh) => {
    const a = await api(`/api/host/analytics?days=${days}`, null, key), t = a.totals;
    const diff = a.previous.earned ? `${t.earned >= a.previous.earned ? "+" : "−"}${Math.abs(Math.round((t.earned / a.previous.earned - 1) * 100))}% oldingi davrga nisbatan` : null;
    const download = () => {
      const head = ["bron_sanasi", "tashrif_sanasi", "vaqt", "taklif", "mehmonlar", "kanal", "holat", "jami_som", "platforma_som", "mehmonxona_som", "sizga_som"];
      // A leading = + - @ would run as a formula in Excel.
      const cell = (v) => `"${String(v).replace(/^[=+\-@\t]/, "'$&").replaceAll('"', '""')}"`;
      const lines = [head, ...a.rows.map((r) => [r.created, r.date, r.time, r.title, r.guests, CHANNEL[r.channel], STATUS[r.status], r.total, r.platform, r.hotel, r.host])];
      const link = el("a", { href: URL.createObjectURL(new Blob(["﻿" + lines.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv" })), download: `silkroad-daromad-${days}-kun.csv` });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    };
    const share = (rows, name, label) => card(label, rows.length ? table([["", 0], ["Bron", 1], ["Daromad", 1]], rows.map((r) => [name(r.key), String(r.bookings), som(r.earned)])) : el("p.muted", {}, "Bu davrda ma’lumot yo‘q."));
    return [
      el("div.row.between", {}, el("div.chips", { role: "group", "aria-label": "Davr" }, a.available.map((d) => el("button", { "aria-pressed": String(d === a.days), onclick: () => { if (!a.unlocked.includes(d)) { location.hash = "tarif"; return toast("Uzoqroq davr Pro tarifida ochiladi"); } days = d; refresh(); } }, d === 365 ? "1 yil" : `${d} kun`, !a.unlocked.includes(d) && el("span.small", {}, " Pro")))),
        a.detail && el("button", { onclick: download }, "CSV yuklash")),
      cfg.testPayments && el("div.note.warn", {}, "Sinov rejimi: bu summalar haqiqiy pul emas."),
      tiles([["Sizning daromadingiz", som(t.earned), diff], ["Kutilayotgan (javob bermagansiz)", som(t.expected)], ["Tasdiqlangan bronlar", String(t.bookings), `${t.guests} mehmon`], ["O‘rtacha bron", som(t.average)]]),
      card("Daromad, bron qilingan sana bo‘yicha", t.bookings ? columns(a.series, a.bucket) : el("p.muted", {}, "Bu davrda tasdiqlangan bron yo‘q."),
        t.bookings > 0 && el("dl.sum", {}, [["Mehmonlar to‘lagan", t.gross], ["Platforma va mehmonxona ulushi", -t.fees]].map(([k, v]) => [el("dt", {}, k), el("dd", {}, v < 0 ? `−${som(-v)}` : som(v))]), el("dt.all", {}, "Sizga"), el("dd.all", {}, som(t.earned)))),
      tiles([["Sahifa ko‘rishlar", String(t.views)], ["Ko‘rishdan bronga", pct(t.conversion)], ["Chipta bilan kelganlar", `${t.checkedIn} / ${t.bookings}`], ["Bekor qilingan / rad etilgan", `${t.cancelled} / ${t.declined}`], ["Kelmagan (chiptasiz o‘tgan)", String(a.noShow)]]),
      a.detail ? [card("Takliflar", table([["Taklif", 0], ["Ko‘rish", 1], ["Bron", 1], ["Daromad", 1], ["Baho", 1], ["14 kunlik bandlik", 1]], a.listings.map((l) => [l.title, String(l.views), String(l.bookings), som(l.earned), l.rating == null ? "—" : `★ ${l.rating}`, pct(l.fill)]))),
        card("Eng band vaqtlar (mehmonlar soni)", busyTable(a.busy)),
        el("div.two", {}, share(a.channels, (k) => CHANNEL[k], "Savdo kanallari"), share(a.languages, (k) => cfg.langNames[k], "Mehmonlar tili"))]
        : lock("Takliflar, kanallar va tillar kesimi, uzoq davr va CSV eksport Pro tarifida ochiladi."),
    ].flat();
  });
}

// ---- market intelligence --------------------------------------------------------------------------
export function market({ key, home, cfg }) {
  if (!home.plan.intelligence) return lock("Bozor tahlili: narxlar taqqosi, javobsiz talab, hududlar trendi va tavsiyalar. Business tarifida ochiladi.");
  return live(async () => {
    const m = await api("/api/host/intelligence", null, key);
    const gap = (rows) => (rows.length ? table([["", 0], ["Javobsiz", 1], ["Jami", 1], ["Namuna", 1]], rows.map((r) => [r.name, String(r.unmet), String(r.searches), String(r.sample)])) : el("p.muted", {}, "Hali qidiruv yo‘q."));
    const dates = m.dates.length ? table([["Sana", 0], ["Qidiruv", 1], ["Javobsiz", 1]], m.dates.map((x) => [`${day(x.date)}, ${weekday(x.date)}`, String(x.n), String(x.unmet)])) : el("p.muted", {}, "Turistlar hali aniq sana bilan qidirmagan.");
    return [
      m.sampleSearches > 0 && el("div.note.warn", {}, `Diqqat: ${m.sampleSearches} ta qidiruv namuna ma’lumot. “Namuna” ustuniga qarang.`),
      card("Tavsiyalar", m.tips.length ? el("ol.steps", { style: "grid-template-columns:1fr" }, m.tips.map((x) => el("li", {}, el("span", {}, x)))) : el("p.muted", {}, "Hozircha ma’lumot yetarli emas.")),
      card("Narxingiz bozorda", m.prices.length ? table([["Taklif", 0], ["Sizniki", 1], ["Eng past", 1], ["Mediana", 1], ["Eng yuqori", 1], ["Solishtirildi", 1]], m.prices.map((p) => [p.title, som(p.price), p.low == null ? "—" : som(p.low), p.median == null ? "—" : som(p.median), p.high == null ? "—" : som(p.high), `${p.sample}${p.demo ? " (namuna bor)" : ""}`])) : el("p.muted", {}, "Sotuvdagi taklifingiz yo‘q."),
        el("p.small.muted", {}, `Shu turdagi kamida ${m.minSample} ta boshqa taklif bo‘lsagina ko‘rsatiladi: bitta raqobatchining narxi ochilib qolmasligi uchun.`)),
      el("div.two", {}, card("Javobsiz talab: viloyatlar, 90 kun", gap(m.unmet.regions)), card("Javobsiz talab: mashg‘ulotlar, 90 kun", gap(m.unmet.categories))),
      card("Turistlar qaysi sanalarni qidirmoqda", dates),
      el("div.two", {}, card("Hududingizga qiziqish", m.trend.length ? table([["Viloyat", 0], ["Oxirgi 30 kun", 1], ["Oldingi 30 kun", 1]], m.trend.map((x) => [x.name, String(x.last), String(x.before)])) : el("p.muted", {}, "Sotuvdagi taklifingiz yo‘q.")),
        card("Qidiruv tillari, 90 kun", m.languages.length ? table([["Til", 0], ["Qidiruv", 1]], m.languages.map((x) => [cfg.langNames[x.lang] ?? x.lang, String(x.n)])) : el("p.muted", {}, "Hali haqiqiy qidiruv yo‘q."))),
    ];
  });
}

// ---- plans ----------------------------------------------------------------------------------------
const PERKS = {
  free: ["3 tagacha sotuvdagi taklif", "10 tilli matn, bron, kalendar, QR chipta", "30 kunlik daromad tahlili"],
  pro: ["Cheksiz taklif", "Pastroq komissiya", "1 yillik tahlil: taklif, kanal, til kesimi", "CSV eksport"],
  business: ["Pro’dagi hamma narsa", "Eng past komissiya", "Bozor tahlili: narx taqqosi, javobsiz talab, tavsiyalar"],
};
const KIND = { new: "Ulash", extend: "Uzaytirish", upgrade: "Tarifni oshirish" };
const until = (iso) => day(new Date(+new Date(iso) + 5 * 3600e3).toISOString().slice(0, 10));

export function plans({ key, cfg, reload }) {
  return live(async (refresh) => {
    const p = await api("/api/host/plans", null, key);
    return [
      el("div.note", {}, `Joriy tarif: ${PLAN_NAME[p.current.plan]}${p.current.until ? `, ${until(p.current.until)} gacha` : ""}. Komissiya ${p.current.commission}%. Obuna o‘zi uzaymaydi: muddat tugasa, Bepul tarifga qaytasiz, takliflaringiz va bronlaringiz saqlanadi.`),
      el("div.grid.plans", {}, p.options.map((o) => el("section.card" + (o.id === p.current.plan ? ".chosen" : ""), {}, el("div.row.between", {}, el("h2", {}, PLAN_NAME[o.id]), o.id === p.current.plan && el("span.badge.ok", {}, "Joriy")),
        el("p.price.big", {}, o.price ? som(o.price) : "0 so‘m", o.price > 0 && el("small", {}, " / 30 kun")), el("p", {}, `Har bir brondan ${o.commission}% komissiya`), el("ul.perks", {}, PERKS[o.id].map((x) => el("li", {}, x))),
        o.offer && cfg.testPayments && el("button" + (o.id === p.current.plan ? "" : ".primary"), { onclick: act(async () => {
          const q = o.offer;
          if (!(await ask(`${PLAN_NAME[o.id]}: sinov to‘lovi ${som(q.amount)}${q.credit ? ` (ishlatilmagan kunlar uchun ${som(q.credit)} chegirildi)` : ""}. ${until(q.until)} gacha. Haqiqiy pul yechilmaydi.`, "Davom etish", "Yo‘q"))) return;
          await api(`/api/host/plans/${o.id}/subscribe-test`, {}, key);
          await reload();
          toast(`${PLAN_NAME[o.id]} tarifi yoqildi`);
          await refresh();
        }) }, KIND[o.offer.kind])))),
      el("p.small.muted", {}, "Tarif o‘zgarsa, komissiya faqat yangi bronlarga ta’sir qiladi. Mehmonxona orqali kelgan brondan mehmonxona alohida ulush oladi."),
      p.invoices.length > 0 && card("To‘lovlar (sinov)", table([["Sana", 0], ["Tarif", 0], ["Chegirma", 1], ["To‘landi", 1], ["Amal qiladi", 0]], p.invoices.map((i) => [until(i.created_at), PLAN_NAME[i.plan], i.credit_uzs ? som(i.credit_uzs) : "—", som(i.amount_uzs), `${until(i.until)} gacha`]))),
    ];
  });
}
