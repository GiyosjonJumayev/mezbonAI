import { api, el, som, toast } from "/common.js";

const app = document.getElementById("app");
const CHANNEL = { web: "Sayt", hotel: "Mehmonxona QR", ai: "AI yordamchi" };
const RANGE = [[0, "Hammasi"], [30, "30 kun"], [7, "7 kun"]];
let days = 0, demo = true, last = "", data = null;

const tile = (label, value) => el("div.card.tile", {}, el("b", {}, value), el("span.muted", {}, label));
const bars = (rows, name, cols) => {
  const max = Math.max(1, ...rows.map((r) => r.unmet));
  return el("div.scroll", {}, el("table", {}, el("thead", {}, el("tr", {}, el("th", { scope: "col" }, name), el("th", { scope: "col" }, "Javobsiz qidiruv"), cols.map(([h]) => el("th.n", { scope: "col" }, h)))),
    el("tbody", {}, rows.map((r) => el("tr", { title: `${r.name}: ${r.searches} qidiruvdan ${r.unmet} tasi javobsiz` }, el("td", {}, r.name),
      el("td.barcell", {}, el("div.bar", {}, r.unmet > 0 && el("i", { style: `width:${(r.unmet / max) * 80}%` }), el("span", {}, String(r.unmet)))), cols.map(([, k]) => el("td.n", {}, String(r[k]))))))));
};

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
    el("div.stack", {}, el("h1", {}, "Turist qidirdi, lekin topmadi"), el("p.muted", { style: "max-width:60ch" }, "Qaysi viloyatda talab bor-u, taklif yo‘q: yangi mezbonlarni qayerda tayyorlash kerakligini ko‘rsatadi.")),
    el("div.row.between", {}, el("div.chips", { role: "group", "aria-label": "Davr" }, RANGE.map(([d, t]) => el("button", { dataset: { f: "d" + d }, "aria-pressed": String(days === d), onclick: () => { days = d; safe(); } }, t))),
      el("div.row", {}, el("div.chips", {}, el("button", { dataset: { f: "demo" }, "aria-pressed": String(demo), onclick: () => { demo = !demo; safe(); } }, "Namuna qidiruvlar")), el("button", { dataset: { f: "csv" }, onclick: csv }, "CSV yuklash"))),
    p.demoSearches > 0 && el("div.note.warn", {}, `Diqqat: ${p.demoSearches} ta qidiruv namuna ma’lumot. Faqat haqiqiylarini ko‘rish uchun “Namuna qidiruvlar”ni o‘chiring.`),
    top && el("div.note", {}, `Eng katta bo‘shliq: ${top.name}. ${top.unmet} ta qidiruv javobsiz, hali birorta ham taklif yo‘q.`),
    el("div.tiles", {}, tile("Mezbonlar ulushi (sinov to‘lovi)", som(p.totals.host)), tile("To‘langan bronlar", String(p.totals.bookings)), tile("Mehmonlar", String(p.totals.guests)), tile("Sotuvdagi takliflar", String(p.listings))),
    el("section.card", {}, el("h2", {}, "Viloyatlar"), bars(p.regions, "Viloyat", [["Jami qidiruv", "searches"], ["Taklif", "listings"]])),
    el("div.two", {},
      el("section.card", {}, el("h2", {}, "Mashg‘ulot turlari"), p.categories.length ? bars(p.categories, "Mashg‘ulot", [["Jami qidiruv", "searches"]]) : el("p.muted", {}, "Bu davrda mashg‘ulot turi bo‘yicha qidiruv yo‘q.")),
      el("section.card", {}, el("h2", {}, "Savdo kanallari"),
        p.channels.length ? el("div.scroll", {}, el("table", {}, el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Kanal"), el("th.n", { scope: "col" }, "Bron"), el("th.n", { scope: "col" }, "Aylanma"))), el("tbody", {}, p.channels.map((c) => el("tr", {}, el("td", {}, CHANNEL[c.channel]), el("td.n", {}, String(c.n)), el("td.n", {}, som(c.gmv)))))))
          : el("p.muted", {}, "Bu davrda to‘langan bron yo‘q."),
        el("p.small.muted", {}, "GetYourGuide, Viator, Klook: ulanmagan, hamkorlik shartnomasi kerak. Tayyor eksport: ", el("a", { href: "/feeds/products.json" }, "products.json")))),
  ));
  if (focus) app.querySelector(`[data-f="${focus}"]`)?.focus();
}
const safe = () => load().catch((e) => { if (!data) app.replaceChildren(el("div.wrap", {}, el("div.note.bad", { role: "alert" }, e.message))); });
safe();
setInterval(() => { if (!document.hidden) safe(); }, 4000);
