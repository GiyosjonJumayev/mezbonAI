import { api, counter, el, GEO, som, subscribe, toast } from "/common.js";
import { themePicker } from "/pwa.js";

document.getElementById("prefs").append(themePicker({ theme: "Mavzu", auto: "Avtomatik", light: "Yorug‘", dark: "Qorong‘i" }));

const app = document.getElementById("app");
const CHANNEL = { web: "Sayt", hotel: "Mehmonxona QR", ai: "AI yordamchi" };
const RANGE = [[0, "Hammasi"], [30, "30 kun"], [7, "7 kun"]];
let days = 0, demo = true, last = "", data = null;

const tile = (label, value, show) => el("div.card.tile", {}, counter(label, value, show), el("span.muted", {}, label));
const liveBadge = el("span.live", { hidden: true }, el("i"), "Jonli");
const bars = (rows, name, cols) => {
  const max = Math.max(1, ...rows.map((r) => r.unmet));
  return el("div.scroll", { tabindex: 0 }, el("table", {}, el("thead", {}, el("tr", {}, el("th", { scope: "col" }, name), el("th", { scope: "col" }, "Javobsiz qidiruv"), cols.map(([h]) => el("th.n", { scope: "col" }, h)))),
    el("tbody", {}, rows.map((r) => el("tr", { title: `${r.name}: ${r.searches} qidiruvdan ${r.unmet} tasi javobsiz` }, el("td", {}, r.name),
      el("td.barcell", {}, el("div.bar", {}, r.unmet > 0 && el("i", { style: `width:${(r.unmet / max) * 80}%` }), el("span", {}, String(r.unmet)))), cols.map(([, k]) => el("td.n", {}, String(r[k]))))))));
};

const LANG = { uz: "O‘zbekcha", en: "Inglizcha", ru: "Ruscha", zh: "Xitoycha", ko: "Koreyscha", ja: "Yaponcha", tr: "Turkcha", ar: "Arabcha", de: "Nemischa", fr: "Fransuzcha" };
const simple = (name, rows) => el("div.scroll", { tabindex: 0 }, el("table", {}, el("thead", {}, el("tr", {}, el("th", { scope: "col" }, name), el("th.n", { scope: "col" }, "Qidiruv"), el("th.n", { scope: "col" }, "Javobsiz"))), el("tbody", {}, rows.map(([k, x]) => el("tr", {}, el("td", {}, k), el("td.n", {}, String(x.n)), el("td.n", {}, String(x.unmet)))))));

function tileMap(rows) {
  const max = Math.max(1, ...rows.map((r) => r.unmet));
  return el("ul.tilemap.geo", {}, rows.map((r) => el("li", { style: `--c:${GEO[r.region][0]};--r:${GEO[r.region][1]}` }, el("div" + (r.unmet ? "" : ".none"), { title: `${r.name}: ${r.unmet} javobsiz, ${r.listings} ta taklif`, style: r.unmet ? `background:color-mix(in srgb, var(--bar) ${Math.round(6 + (r.unmet / max) * 30)}%, var(--card))` : null }, r.name, el("b", {}, String(r.unmet))))));
}

function csv() {
  const rows = [["viloyat", "javobsiz_qidiruv", "jami_qidiruv", "taklif"], ...data.regions.map((r) => [r.name, r.unmet, r.searches, r.listings])];
  const blob = new Blob(["﻿" + rows.map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(",")).join("\r\n")], { type: "text/csv" });
  const a = el("a", { href: URL.createObjectURL(blob), download: "mezbon-talab.csv" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("CSV saqlandi");
}

async function load() {
  const p = await api(`/api/panel?days=${days}&demo=${demo ? 1 : 0}`);
  const sig = JSON.stringify([p, days, demo]);
  if (sig === last) return;
  last = sig;
  data = p;
  const focus = document.activeElement?.dataset?.f;
  const top = p.regions.find((r) => r.unmet > 0 && r.listings === 0);
  app.replaceChildren(el("div.wrap", {},
    el("div.stack", {}, el("div.row", {}, el("h1", {}, "Turist qidirdi, lekin topmadi"), liveBadge), el("p.muted", { style: "max-width:60ch" }, "Qaysi viloyatda talab bor-u, taklif yo‘q: yangi mezbonlarni qayerda tayyorlash kerakligini ko‘rsatadi.")),
    el("div.row.between", {}, el("div.chips", { role: "group", "aria-label": "Davr" }, RANGE.map(([d, t]) => el("button", { dataset: { f: "d" + d }, "aria-pressed": String(days === d), onclick: () => { days = d; safe(); } }, t))),
      el("div.row", {}, el("div.chips", {}, el("button", { dataset: { f: "demo" }, "aria-pressed": String(demo), onclick: () => { demo = !demo; safe(); } }, "Namuna qidiruvlar")), el("button", { dataset: { f: "csv" }, onclick: csv }, "CSV yuklash"))),
    p.demoSearches > 0 && el("div.note.warn", {}, `Diqqat: ${p.demoSearches} ta qidiruv namuna ma’lumot. Faqat haqiqiylarini ko‘rish uchun “Namuna qidiruvlar”ni o‘chiring.`),
    top && el("div.note", {}, `Eng katta bo‘shliq: ${top.name}. ${top.unmet} ta qidiruv javobsiz, hali birorta ham taklif yo‘q.`),
    el("div.tiles", {}, tile("Mezbonlar ulushi (sinov to‘lovi)", p.totals.host, som), tile("To‘langan bronlar", p.totals.bookings), tile("Mehmonlar", p.totals.guests), tile("Sotuvdagi takliflar", p.listings)),
    p.platform && el("section.card", {}, el("h2", {}, "Biznes model (sinov to‘lovlari)"), el("dl.facts", {}, [["Bron komissiyasi", som(p.totals.platform)], ["Faol obunalar", String(p.platform.subscribers)], ["Oylik obuna daromadi", som(p.platform.mrr)], ["Jami obuna to‘lovlari", som(p.platform.subscriptions)]].map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v)))), el("p.small.muted", {}, "Faqat sinov rejimida ko‘rinadi.")),
    el("section.card", {}, el("h2", {}, "Javobsiz qidiruvlar xaritasi"), el("p.small.muted", {}, "Sxematik xarita. Raqam: javobsiz qidiruvlar soni. To‘qroq rang: ko‘proq."), tileMap(p.regions)),
    el("section.card", {}, el("h2", {}, "Viloyatlar"), bars(p.regions, "Viloyat", [["Jami qidiruv", "searches"], ["Taklif", "listings"]])),
    el("div.two", {},
      el("section.card", {}, el("h2", {}, "Turistlar qaysi sanalarni qidirmoqda"), p.dates.length ? simple("Sana", p.dates.map((x) => [x.date, x])) : el("p.muted", {}, "Hali aniq sana bilan qidiruv yo‘q.")),
      el("section.card", {}, el("h2", {}, "Qidiruv tillari"), p.languages.length ? simple("Til", p.languages.map((x) => [LANG[x.lang] ?? x.lang, x])) : el("p.muted", {}, "Hali haqiqiy qidiruv yo‘q."))),
    el("div.two", {},
      el("section.card", {}, el("h2", {}, "Mashg‘ulot turlari"), p.categories.length ? bars(p.categories, "Mashg‘ulot", [["Jami qidiruv", "searches"]]) : el("p.muted", {}, "Bu davrda mashg‘ulot turi bo‘yicha qidiruv yo‘q.")),
      el("section.card", {}, el("h2", {}, "Savdo kanallari"),
        p.channels.length ? el("div.scroll", { tabindex: 0 }, el("table", {}, el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Kanal"), el("th.n", { scope: "col" }, "Bron"), el("th.n", { scope: "col" }, "Aylanma"))), el("tbody", {}, p.channels.map((c) => el("tr", {}, el("td", {}, CHANNEL[c.channel]), el("td.n", {}, String(c.n)), el("td.n", {}, som(c.gmv)))))))
          : el("p.muted", {}, "Bu davrda to‘langan bron yo‘q."),
        el("p.small.muted", {}, "GetYourGuide, Viator, Klook: ulanmagan, hamkorlik shartnomasi kerak. Tayyor eksport: ", el("a", { href: "/feeds/products.json" }, "products.json")))),
  ));
  if (focus) app.querySelector(`[data-f="${focus}"]`)?.focus();
}
const safe = () => load().catch((e) => { if (!data) app.replaceChildren(el("div.wrap", {}, el("div.note.bad", { role: "alert" }, e.message))); });
safe();
subscribe("/api/live", (ev) => { if (ev.t === "hello") liveBadge.hidden = false; else if (ev.t !== "slots") safe(); });
setInterval(() => { if (!document.hidden) safe(); }, 20000); // in case the stream is blocked
