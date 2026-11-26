// Public impact page: where travellers' money goes. Uzbek, English and Russian.
import { api, counter, el, GEO, store, subscribe, uzs } from "/common.js";
import { icon } from "/art.js";
import { demoBanner, themePicker } from "/pwa.js";

const T = {
  uz: { title: "Sayyoh puli qayerga boradi?", sub: "Har bir so‘m hisobda: qancha qismi mahalliy oilalarga yetgani shu yerda, ma’lumotlar bazasidan jonli.", sample: "Namuna ma’lumot: bu raqamlar namoyish uchun, haqiqiy daromad emas.", share: "har 100 so‘mdan mezbonga", income: "mahalliy oilalarga tushgan", hosts: "daromad olgan mezbon", perHost: "bir mezbonga o‘rtacha", outside: "poytaxtdan tashqarida qolgan", guests: "mehmon kutib olindi", langs: "tilda xizmat", map: "Hududlar bo‘yicha tashriflar", mapNote: "Sxematik xarita. Daromad faqat kamida 3 ta mezbon ishlagan hududda ko‘rsatiladi.", table: "Hudud", visits: "Tashrif", money: "Mezbonlar daromadi", few: "kam ma’lumot", how: "Qanday hisoblanadi", how1: "Faqat bo‘lib o‘tgan va puli qaytarilmagan tashriflar sanaladi.", how2: "Mezbon ulushi har bir bronda oldindan ko‘rinadi va bazada tekshiriladi: ulushlar yig‘indisi jamiga teng bo‘lmasa, bron yozilmaydi.", how3: "Ism va shaxsiy ma’lumot yo‘q, faqat jami sonlar.", now: "Hozir sotuvda", offers: "ta taklif", regions: "ta hudud", panel: "Talab paneli", here: "Ta’sir", foot: "Har bir mahalliy tajriba. Bitta raqamli platforma.", theme: ["Mavzu", "Avtomatik", "Yorug‘", "Qorong‘i"], empty: "Hali tugallangan tashrif yo‘q. Birinchi mehmonlardan keyin raqamlar shu yerda paydo bo‘ladi." },
  en: { title: "Where does the traveller’s money go?", sub: "Every so‘m is accounted for: this is how much reached local families, live from the database.", sample: "Sample data: these numbers are for demonstration and are not real income.", share: "of every 100 so‘m goes to the host", income: "reached local families", hosts: "hosts earned", perHost: "average per host", outside: "stayed outside the capital", guests: "guests welcomed", langs: "languages served", map: "Visits by region", mapNote: "Schematic map. Income is shown only where at least 3 hosts earned.", table: "Region", visits: "Visits", money: "Host income", few: "too few hosts", how: "How it is counted", how1: "Only visits that took place and were not refunded.", how2: "The host’s share is shown on every booking, and the database refuses a booking whose shares do not add up.", how3: "No names or personal data, only totals.", now: "On sale now", offers: "experiences", regions: "regions", panel: "Demand panel", here: "Impact", foot: "Every Local Experience. One Digital Platform.", theme: ["Theme", "Auto", "Light", "Dark"], empty: "No completed visits yet. The numbers appear after the first guests." },
  ru: { title: "Куда идут деньги туриста?", sub: "Учтён каждый сум: здесь видно, сколько получили местные семьи, напрямую из базы данных.", sample: "Демонстрационные данные: это не реальный доход.", share: "из каждых 100 сумов получает мастер", income: "получили местные семьи", hosts: "мастеров заработали", perHost: "в среднем на мастера", outside: "осталось за пределами столицы", guests: "гостей принято", langs: "языков обслуживания", map: "Визиты по регионам", mapNote: "Схема. Доход показан там, где заработали не менее 3 мастеров.", table: "Регион", visits: "Визиты", money: "Доход мастеров", few: "мало данных", how: "Как считается", how1: "Только состоявшиеся визиты без возврата денег.", how2: "Доля мастера видна в каждой брони, а база не примет бронь, если доли не сходятся.", how3: "Без имён и личных данных, только суммы.", now: "Сейчас в продаже", offers: "предложений", regions: "регионов", panel: "Панель спроса", here: "Влияние", foot: "Все местные впечатления. Одна цифровая платформа.", theme: ["Тема", "Авто", "Светлая", "Тёмная"], empty: "Завершённых визитов пока нет. Цифры появятся после первых гостей." },
};
const app = document.getElementById("app"), pick = document.getElementById("lang"), $ = (id) => document.getElementById(id);
let lang = [new URLSearchParams(location.search).get("lang"), store.get("lang")].find((l) => T[l]) ?? "uz";
pick.value = lang;
pick.onchange = () => { lang = pick.value; store.set("lang", lang); draw(); };
let data = null, cfg = null;
const liveBadge = el("span.live", { hidden: true }, el("i"), el("span"));
const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);

function draw() {
  const t = T[lang], k = data.totals, fx = lang === "en" && cfg.fx?.rates?.USD ? { code: "USD", rate: cfg.fx.rates.USD } : null, money = (n) => (n == null ? "—" : uzs(n, lang, fx)), name = (r) => cfg.regionNames[r][lang];
  document.documentElement.lang = lang;
  liveBadge.lastChild.textContent = { uz: "Jonli", en: "Live", ru: "Онлайн" }[lang];
  document.title = `${t.title} | SilkRoad`;
  $("toPanel").textContent = t.panel;
  $("here").textContent = t.here;
  $("foot").textContent = t.foot;
  $("prefs").replaceChildren(themePicker({ theme: t.theme[0], auto: t.theme[1], light: t.theme[2], dark: t.theme[3] }));
  const max = Math.max(1, ...data.regions.map((r) => r.visits)), live = data.regions.filter((r) => r.visits).sort((a, b) => b.visits - a.visits);
  const tile = (key, v, label, show) => el("div.card.tile", {}, v == null ? el("b", {}, "—") : counter(key, v, show), el("span.muted", {}, label)), whole = (n) => `${Math.round(n)}%`;
  app.replaceChildren(el("div.wrap", {}, el("div.stack", { style: "gap:10px" }, el("div.row", {}, el("h1", {}, t.title), liveBadge), el("p.muted", { style: "max-width:64ch" }, t.sub)), data.sample && el("div.note.warn", { role: "status" }, t.sample),
    k.visits === 0 ? el("div.card.empty", {}, el("p", {}, t.empty)) : [
      el("section.card.bigshare", {}, el("div", {}, counter("share", Math.round((k.host_share ?? 0) * 100), String, "b.huge"), el("p", {}, t.share)), el("div.sharebar", { role: "img", "aria-label": `${pct(k.host_share)} ${t.share}` }, el("i", { style: `width:${(k.host_share ?? 0) * 100}%` }))),
      el("div.tiles.three", {}, tile("income", k.host_income_uzs, t.income, money), tile("hosts", k.hosts, t.hosts), tile("per", k.per_host_uzs, t.perHost, money), tile("out", k.outside_capital == null ? null : Math.round(k.outside_capital * 100), t.outside, whole), tile("guests", k.guests, t.guests), tile("langs", k.languages, t.langs)),
      el("section.stack", { style: "gap:16px" }, el("div", {}, el("h2", {}, t.map), el("p.muted.small", {}, t.mapNote)),
        el("ul.tilemap.geo", {}, data.regions.map((r) => el("li", { style: `--c:${GEO[r.region][0]};--r:${GEO[r.region][1]}` }, el("div" + (r.visits ? "" : ".none"), { style: r.visits ? `background:color-mix(in srgb, var(--turq) ${8 + Math.round((r.visits / max) * 26)}%, var(--card))` : null }, name(r.region), el("b", {}, String(r.visits)))))),
        el("div.scroll", { tabindex: 0, role: "region", "aria-label": t.map }, el("table", {}, el("thead", {}, el("tr", {}, el("th", { scope: "col" }, t.table), el("th.n", { scope: "col" }, t.visits), el("th.n", { scope: "col" }, t.money))), el("tbody", {}, live.map((r) => el("tr", {}, el("td", {}, name(r.region)), el("td.n", {}, String(r.visits)), el("td.n", {}, r.income_uzs == null ? t.few : money(r.income_uzs))))))))],
    el("section.card", {}, el("h2", {}, t.how), el("ul.promise", {}, [["check", t.how1], ["shield", t.how2], ["people", t.how3]].map(([i, x]) => el("li", {}, icon(i, 26), x))), el("p.muted.small", {}, `${t.now}: ${data.supply.listings} ${t.offers}, ${data.supply.regions} ${t.regions}`))));
}
try { [data, cfg] = await Promise.all([api("/api/impact"), api("/api/config")]); demoBanner(cfg, "Demo"); draw();
  const again = async () => { const d = await api("/api/impact").catch(() => null); if (d && JSON.stringify(d) !== JSON.stringify(data)) { data = d; if (!app.contains(document.activeElement) || document.activeElement === app) draw(); } };
  subscribe("/api/live", (ev) => { if (ev.t === "hello") liveBadge.hidden = false; else if (ev.t !== "slots") again(); });
} catch (e) { app.replaceChildren(el("div.wrap", {}, el("div.note.bad", { role: "alert" }, e.message))); }
