import { PAY_NAME, act, api, ask, copy, el, plate, store, subscribe, toast, uzs, visual } from "/common.js";
import { art, icon } from "/art.js";
import { explore } from "/explore.js";
import { extrasCost, unitPrice } from "/price.js";
import { planner, tripPage } from "/trip.js";
import { demoBanner, enablePush, installButton, pushSupported, themePicker } from "/pwa.js";

const app = document.getElementById("app");
const query = () => new URLSearchParams(location.search);
/** Shown inside a provider's own website: the booking box of one offer, nothing around it. */
const embedded = query().get("embed") === "1" && Boolean(query().get("l"));
if (embedded) document.documentElement.classList.add("embed");
let cfg;
try { cfg = await api("/api/config"); } catch (e) {
  app.replaceChildren(el("div.wrap", {}, el("div.note.bad", { role: "alert" }, e.message), el("button", { onclick: () => location.reload() }, "↻")));
  throw e;
}
let lang = [query().get("lang"), store.get("lang"), ...(navigator.languages ?? []).map((l) => l.slice(0, 2))].find((l) => cfg.langs.includes(l)) ?? "en";
demoBanner(cfg, cfg.ui.testNote[lang]);
let poll, renderId = 0, watch, ends = [];
/** Something to stop when the page is left. */
const keep = (stop) => ends.push(stop);
const t = (k) => cfg.ui[k][lang];
// Prices also in the visitor's own money; the first visit guesses it from the language.
const GUESS = { en: "USD", ru: "RUB", zh: "CNY", ko: "KRW", ja: "JPY", tr: "TRY", ar: "SAR", de: "EUR", fr: "EUR" };
const rates = cfg.fx?.rates ?? {};
const fx = () => { const c = store.get("fx") ?? GUESS[lang] ?? "UZS"; return rates[c] ? { code: c, rate: rates[c] } : null; };
const money = (n) => uzs(n, lang, fx());
const whyNot = (e) => (cfg.ui[`e_${e.code}`] ?? cfg.ui.e_other)[lang];
const run = (fn) => act(fn, whyNot);
const regionName = (r) => cfg.regionNames[r][lang];
const fmt = (o) => { try { return new Intl.DateTimeFormat(lang, { timeZone: "UTC", ...o }); } catch { return new Intl.DateTimeFormat("en", { timeZone: "UTC", ...o }); } };
const asDate = (d) => new Date(`${d}T00:00:00Z`);
const longDate = (d) => fmt({ weekday: "long", day: "numeric", month: "long" }).format(asDate(d));
const today = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10); // Tashkent
const addDays = (d, n) => new Date(+asDate(d) + n * 864e5).toISOString().slice(0, 10);
/** Today, tomorrow, or the date. */
function dayName(d) {
  const n = Math.round((asDate(d) - asDate(today())) / 864e5);
  if (n >= 0 && n < 2) try { const w = new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(n, "day"); return w[0].toLocaleUpperCase(lang) + w.slice(1); } catch {}
  return fmt({ weekday: "short", day: "numeric", month: "short" }).format(asDate(d));
}
const inDays = (d) => { const n = Math.round((asDate(d) - asDate(today())) / 864e5); try { return new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(n, "day"); } catch { return longDate(d); } };
const placeOf = (l) => (l.place && l.place !== cfg.regions[l.region] ? `${l.place}, ${regionName(l.region)}` : regionName(l.region));
const star = () => el("span.star", { "aria-hidden": "true" }, "★");
const rating = (l) => l.reviews > 0 && el("span.rating", { "aria-label": `${l.rating} / 5, ${t("reviews")}: ${l.reviews}` }, star(), ` ${l.rating} (${l.reviews})`);
const verified = (l) => l.verified && el("span.verified", {}, icon("shield", 18), t("verified"));
const clockTime = (iso) => new Intl.DateTimeFormat(lang, { timeZone: "Asia/Tashkent", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const calm = matchMedia("(prefers-reduced-motion: reduce)");

// A hotel QR code sets the referrer for this browser tab only.
let hotel = null;
const session = { get: () => { try { return sessionStorage.getItem("mezbon.h"); } catch { return null; } }, set: (v) => { try { v ? sessionStorage.setItem("mezbon.h", v) : sessionStorage.removeItem("mezbon.h"); } catch {} } };
const code = query().get("h") ?? session.get();
if (code) try { hotel = await api(`/api/hotels/${encodeURIComponent(code)}`); session.set(code); } catch { session.set(null); }

// Saved experiences live on this device only.
const favs = new Set(store.json("saved", []));
const isFav = (id) => favs.has(id);
function heart(l) {
  const b = el("button.heart", { type: "button", "aria-pressed": String(isFav(l.id)), "aria-label": `${t("save")}: ${l.i18n[lang].title}`, onclick: () => {
    isFav(l.id) ? favs.delete(l.id) : favs.add(l.id);
    store.set("saved", JSON.stringify([...favs].slice(-100)));
    b.setAttribute("aria-pressed", String(isFav(l.id)));
  } }, icon("heart"));
  return b;
}

const pick = document.getElementById("lang");
pick.append(...cfg.langs.map((l) => el("option", { value: l }, cfg.langNames[l])));
pick.onchange = () => { lang = pick.value; store.set("lang", lang); render(); };

/** Animates between pages when the browser can; always updates either way. */
async function swap(update) {
  if (!document.startViewTransition || calm.matches || document.hidden) return update();
  await document.startViewTransition(update).updateCallbackDone;
}
function go(params, focus = true) {
  const q = new URLSearchParams(params).toString();
  history.pushState(null, "", q ? `/?${q}` : "/");
  swap(render).then(() => { if (focus) { scrollTo(0, 0); app.focus({ preventScroll: true }); } });
}
addEventListener("popstate", () => swap(render));
const link = (params, spec, props, ...kids) => el(spec, { ...props, href: "/?" + new URLSearchParams(params), onclick: (e) => { if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return; e.preventDefault(); props?.before?.(e); go(params); } }, ...kids);
const offlineNote = () => (navigator.onLine && !document.documentElement.hasAttribute("data-saved") ? null : el("div.note.warn", { role: "status" }, t("offline")));
const page = (...kids) => app.replaceChildren(el("div.wrap", {}, offlineNote(), ...kids));
const back = () => el("div", {}, link({}, "a.back", {}, t("back")));

// ---- cards ----------------------------------------------------------------------------------
/** A price with what it was before, when a rule of the provider makes it lower. */
function priceOf(p, spec = "span.price") {
  const off = p.unit < p.before;
  return el(spec, {}, off && el("s", {}, uzs(p.before, lang, null)), off && " ", money(p.unit), " ", el("small", {}, t("perPerson")), off && el("span.off", { title: p.why === "weekend" ? t("p_weekend") : t(`p_${p.why}`) }, `−${Math.abs(p.pct)}%`));
}
function nextLine(l) {
  if (l.next === undefined) return null;
  if (!l.next) return el("span.soon.none", {}, t("fullSoon"));
  return el("span.soon" + (l.next.free <= 3 ? ".few" : ""), {}, el("i"), `${dayName(l.next.date)}, ${l.next.time} · ${l.next.free} ${t("left")}`);
}
function card(l, level = "h3", extra = {}) {
  const pic = el("div.art", {}, visual(l), l.demo && el("span.badge", {}, t("sample")), l.promoted && el("span.badge.ad", {}, t("promoted"))), spot = el("div.spot"), foot = el("div.foot");
  const fill = (x) => { spot.replaceChildren(...[nextLine(x)].filter(Boolean)); foot.replaceChildren(...[priceOf(x.next ?? { unit: x.price_uzs, before: x.price_uzs }), rating(x)].filter(Boolean)); };
  fill(l);
  const n = el("article.tile-l", {}, link({ l: l.id, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v)) }, "a", { before: () => { pic.style.viewTransitionName = "pic"; } }, pic,
    el("div.stack", { style: "gap:5px" }, el(level, {}, l.i18n[lang].title), el("div.meta", {}, el("span", {}, regionName(l.region)), el("span", {}, `${l.duration_min} ${t("minutes")}`), el("span", {}, `${l.capacity} ${t("upTo")}`), verified(l)), spot, foot)), heart(l));
  /** New places or a new price, without losing the reader's place. */
  n.refresh = (x) => { fill(x); spot.firstChild?.classList.add("changed"); };
  return n;
}

// ---- listing --------------------------------------------------------------------------------
function gallery(l) {
  const src = l.photos.length ? l.photos.map((p, i) => () => el("img.photo", { src: `/photos/${p}`, alt: i ? "" : l.i18n[lang].title, loading: i ? "lazy" : null })) : [0, 1, 2, 3, 4].map((i) => () => art(l.id + (i || ""), l.category));
  const shown = src.slice(0, 6).map((make, i) => el("button.art.pic", { type: "button", "aria-label": `${l.i18n[lang].title}: ${i + 1} / ${src.length}${l.demo && !i ? `, ${t("sample")}` : ""}`, onclick: () => lightbox(src, i, l.i18n[lang].title) }, make()));
  shown[0].style.viewTransitionName = "pic";
  if (l.demo) shown[0].append(el("span.badge", {}, t("sample")));
  return el("div.gallery", { dataset: { n: shown.length } }, shown);
}
/** Photos on the whole screen: swipe, arrow keys or buttons. */
function lightbox(src, at, title) {
  const strip = el("div.lightstrip", { tabindex: 0 }, src.map((make) => el("div", {}, make()))), n = el("span", { role: "status" });
  const turn = (k) => { at = (at + k + src.length) % src.length; strip.children[at].scrollIntoView({ behavior: calm.matches ? "auto" : "smooth", inline: "center", block: "nearest" }); say(); };
  const say = () => { n.textContent = `${at + 1} / ${src.length}`; };
  const d = el("dialog.light", { "aria-label": title, onkeydown: (e) => { const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (k) { e.preventDefault(); turn(document.dir === "rtl" ? -k : k); } } }, strip,
    el("div.lightbar", {}, n, src.length > 1 && el("button", { type: "button", "aria-label": t("prevPhoto"), onclick: () => turn(-1) }, "‹"), src.length > 1 && el("button", { type: "button", "aria-label": t("nextPhoto"), onclick: () => turn(1) }, "›"), el("button", { type: "button", onclick: () => d.close() }, t("close"))));
  strip.onscrollend = () => { at = Math.max(0, Math.min(src.length - 1, Math.round(Math.abs(strip.scrollLeft) / strip.clientWidth))); say(); };
  d.onclose = () => d.remove();
  document.body.append(d);
  d.showModal();
  strip.children[at].scrollIntoView({ inline: "center", block: "nearest" });
  say();
}

async function detail(id, lid) {
  const path = `/api/listings/${encodeURIComponent(lid)}`, places = () => api(`${path}/availability?days=30`);
  let [l, open] = await Promise.all([api(`${path}?lang=${lang}`), places()]);
  if (id !== renderId) return;
  document.title = `${l.i18n[lang].title} | SilkRoad`;
  store.set("recent", JSON.stringify([l.id, ...store.json("recent", []).filter((x) => x !== l.id)].slice(0, 12)));
  const bookable = () => open.filter((d) => d.times.some((x) => x.free > 0)), first = (d) => d?.times.find((x) => x.free > 0);
  let days = bookable(), day = days.find((d) => d.date === query().get("date")) ?? days[0], slot = first(day), guests = Math.min(Math.max(1, Number(query().get("g")) || 2), slot?.free ?? 1);
  const name = el("input", { maxlength: 80, autocomplete: "name", required: true, value: store.get("name") ?? "" });
  const contact = contactFields();
  const dayRow = el("div.days", { role: "radiogroup", "aria-label": t("date") }), timeRow = el("div.times", { role: "radiogroup", "aria-label": t("time") });
  const giftRow = el("div.sumrow"), discountRow = el("div.sumrow"), out = el("output"), total = el("dd.all"), count = el("dt.all"), head = el("div.pricehead"), why = el("p.small.row.deal", { role: "status" }), buy = el("span.price");
  const less = el("button", { type: "button", "aria-label": t("fewer"), onclick: () => { guests--; draw(); } }, "−"), more = el("button", { type: "button", "aria-label": t("more"), onclick: () => { guests++; draw(); } }, "+");
  const submit = el("button.primary.wide", { type: "submit" }, t("book"));
  let due = 0;
  let promo = null; // { code, pct } once the server accepted it for this offer
  const code = el("input", { maxlength: 20, autocomplete: "off", autocapitalize: "characters", spellcheck: "false", "aria-label": t("promoLabel"), value: query().get("promo") ?? store.get("promo") ?? "" });
  const promoSay = el("p.small", { role: "status" });
  const applyPromo = async (quiet) => {
    if (!code.value.trim()) { promo = null; promoSay.textContent = ""; return draw(); }
    try { promo = await api("/api/promo/check", { code: code.value, listing_id: l.id }); store.set("promo", promo.code); promoSay.className = "small deal"; promoSay.textContent = `${promo.code}: −${promo.pct}%`; }
    catch (e) { promo = null; if (!quiet) { promoSay.className = "small bad"; promoSay.textContent = whyNot(e); } }
    draw();
  };
  let gift = null; // { code, balance_uzs } once accepted
  const giftIn = el("input", { maxlength: 13, autocomplete: "off", autocapitalize: "characters", spellcheck: "false", "aria-label": t("giftUse"), value: query().get("gift") ?? "" }), giftSay = el("p.small", { role: "status" });
  const applyGift = async () => {
    if (!giftIn.value.trim()) { gift = null; giftSay.textContent = ""; return draw(); }
    try { gift = await api("/api/voucher/check", { code: giftIn.value }); giftSay.className = "small deal"; giftSay.textContent = `${t("giftLeft")}: ${money(gift.balance_uzs)}`; }
    catch (e) { gift = null; giftSay.className = "small bad"; giftSay.textContent = whyNot(e); }
    draw();
  };
  const giftBox = el("details.promo", { open: Boolean(giftIn.value) }, el("summary", {}, t("giftUse")), el("div.compose", {}, giftIn, el("button", { type: "button", onclick: applyGift }, t("promoApply"))), giftSay);
  const promoBox = el("details.promo", { open: Boolean(code.value) }, el("summary", {}, t("promoLabel")), el("div.compose", {}, code, el("button", { type: "button", onclick: () => applyPromo(false) }, t("promoApply"))), promoSay);
  const picked = new Set(), extraBox = (l.extras ?? []).length > 0 && el("fieldset.extras", {}, el("legend", {}, t("extrasTitle")), l.extras.map((x) => el("label.check", {}, el("input", { type: "checkbox", value: x.kind, onchange: (e) => { e.target.checked ? picked.add(x.kind) : picked.delete(x.kind); draw(); } }), el("span", {}, t(`x_${x.kind}`), el("small.muted", {}, ` +${uzs(x.price, lang, null)} ${x.per === "person" ? t("perPerson") : t("perGroup")}`)))));
  function draw() {
    guests = Math.max(1, Math.min(guests, slot.free));
    const focus = [dayRow, timeRow].find((r) => r.contains(document.activeElement)), p = unitPrice(l, day.date, slot.time, guests), lowest = (d) => Math.min(...d.times.filter((x) => x.free).map((x) => unitPrice(l, d.date, x.time).pct)); // what is special about the day, not about the group
    const add = extrasCost(l, [...picked], guests);
    const gross = p.unit * guests + add.total, off = promo ? Math.round((gross * promo.pct) / 100) : 0;
    due = gross - off;
    dayRow.replaceChildren(...days.map((d) => el("button", { type: "button", role: "radio", "aria-checked": String(d === day), tabindex: d === day ? 0 : -1, "aria-label": longDate(d.date), onclick: () => { day = d; slot = d.times.find((x) => x.time === slot.time && x.free > 0) ?? first(d); draw(); } },
      el("span", {}, fmt({ weekday: "short" }).format(asDate(d.date))), el("b", {}, String(+d.date.slice(8))), el("span", {}, fmt({ month: "short" }).format(asDate(d.date))), lowest(d) < 0 && el("span.off", {}, `−${-lowest(d)}%`))));
    timeRow.replaceChildren(...day.times.map((x) => el("button", { type: "button", role: "radio", "aria-checked": String(x === slot), tabindex: x === slot ? 0 : -1, disabled: !x.free, onclick: () => { slot = x; draw(); } }, x.time, el("span", {}, x.free ? `${x.free} ${t("left")}` : t("soldOut")))));
    if (focus) focus.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
    out.textContent = guests;
    less.disabled = guests <= 1;
    more.disabled = guests >= slot.free;
    head.replaceChildren(priceOf(p, "span.price.big"));
    buy.replaceChildren(...priceOf(p).childNodes);
    why.hidden = !p.why && !l.pricing.group;
    why.replaceChildren(icon("wallet", 18), p.why ? t(`p_${p.why}`) : `${t("groupFrom")}: ${l.pricing.group?.from} (−${l.pricing.group?.pct}%)`);
    count.textContent = `${t("total")} (${guests} × ${uzs(p.unit, lang, null)}${add.total ? ` + ${uzs(add.total, lang, null)}` : ""})`;
    total.textContent = money(due);
    const byGift = gift ? Math.min(gift.balance_uzs, due) : 0;
    discountRow.replaceChildren(...(off ? [el("dt", {}, `${t("discount")} (${promo.code})`), el("dd.deal", {}, `−${money(off)}`)] : []));
    giftRow.replaceChildren(...(byGift ? [el("dt", {}, t("giftPays")), el("dd.deal", {}, `−${money(byGift)}`), el("dt.all", {}, t("toPay")), el("dd.all", {}, money(due - byGift))] : []));
  }
  for (const r of [dayRow, timeRow]) {
    r.addEventListener("click", () => r.querySelector('[aria-checked="true"]')?.focus());
    r.addEventListener("keydown", (e) => { // arrow keys move through a radio group
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const all = [...r.querySelectorAll("button:not(:disabled)")], flip = document.dir === "rtl" && e.key.match(/Left|Right/) ? -1 : 1;
      all[(all.indexOf(document.activeElement) + step * flip + all.length) % all.length]?.click();
    });
  }
  const form = el("form.card", { id: "book", onsubmit: async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      store.set("name", name.value.trim());
      const b = await api("/api/bookings", { listing_id: l.id, date: day.date, time: slot.time, guests, guest_name: name.value, ...contact.value(), lang, hotel_code: hotel?.code, expect_uzs: due, extras: [...picked], ...(promo && { promo: promo.code }), ...(gift && { voucher: gift.code }), ...(embedded && { source: "widget" }) });
      store.set("bookings", JSON.stringify([b.token, ...store.json("bookings", [])].slice(0, 30)));
      if (embedded) { // payment pages do not open inside another website
        const url = `${location.origin}/?b=${b.token}&lang=${lang}`;
        window.open(url, "_blank", "noopener");
        return form.replaceChildren(el("div.note.ok", { role: "status" }, t("embedDone")), el("a.btn.primary.wide", { href: url, target: "_blank", rel: "noopener" }, t("embedOpen")));
      }
      go({ b: b.token });
    } catch (err) {
      toast(whyNot(err), true);
      submit.disabled = false;
      if (["full", "closed", "past"].includes(err.code)) refresh().catch(() => {});
      if (err.code === "price") { l = await api(path).catch(() => l); draw(); }
      if (err.code === "voucher") { gift = null; giftSay.className = "small bad"; giftSay.textContent = whyNot(err); draw(); }
      if (err.code === "promo") { promo = null; promoSay.textContent = whyNot(err); draw(); }
    }
  } },
  el("div.row.between", {}, days.length ? head : priceOf({ unit: l.price_uzs, before: l.price_uzs }, "span.price.big"), rating(l)),
  days.length ? [why, el("div.stack", { style: "gap:6px" }, el("span.small.muted.row", {}, t("date"), el("span.live", { hidden: true }, el("i"), t("liveOn"))), dayRow), el("div.stack", { style: "gap:6px" }, el("span.small.muted", {}, t("time")), timeRow),
    el("div.stack", { style: "gap:6px" }, el("span.small.muted", {}, t("guests")), el("div.stepper", {}, less, out, more)), extraBox, el("label", {}, t("name"), name), contact.node, promoBox, giftBox, el("dl.sum", {}, discountRow, count, total, giftRow), fx() && el("p.small.muted", {}, t("rateNote")), submit, el("p.small.muted.row", {}, icon("check", 18), t("freeCancel"))]
    : el("p.note.warn", {}, t("noSlots")));
  if (days.length) { draw(); if (code.value) applyPromo(true); if (giftIn.value) applyGift(); }
  const wait = el("div.stack", { style: "gap:16px" }, waitBox(l, () => open, () => guests), cfg.mail && groupBox(l));

  /** Places as they are now, keeping what the visitor chose if it is still free. */
  async function refresh() {
    open = await places();
    if (id !== renderId) return;
    const had = days.length, was = day && { date: day.date, time: slot.time };
    days = bookable();
    if (Boolean(had) !== Boolean(days.length)) { if (!form.contains(document.activeElement)) render(); return; }
    if (!days.length) return;
    day = days.find((d) => d.date === was.date) ?? days[0];
    slot = day.times.find((x) => x.time === was.time && x.free > 0) ?? first(day);
    draw();
    if (day.date !== was.date || slot.time !== was.time) toast(t("justTaken"), true);
    if (!wait.querySelector("details[open]")) wait.replaceChildren(...[waitBox(l, () => open, () => guests), cfg.mail && groupBox(l)].filter(Boolean));
  }
  keep(subscribe(`${path}/live`, async (ev) => {
    if (ev.t === "hello") for (const n of form.querySelectorAll(".live")) n.hidden = false;
    else if (ev.t === "listing") { const x = await api(path).catch(() => null); if (id === renderId && x) { l = x; await refresh().catch(() => {}); } }
    else refresh().catch(() => {});
  }));

  const share = el("button", { onclick: async () => {
    const url = `${location.origin}/?l=${l.id}`;
    try { if (navigator.share) return await navigator.share({ title: l.i18n[lang].title, url }); } catch (e) { if (e.name === "AbortError") return; }
    if (await copy(url)) toast(t("copied"));
  } }, icon("share", 20), t("share"));
  const fav = heart(l);
  fav.style.position = "static";
  const similar = el("section.stack", { style: "gap:18px" });
  const bar = days.length && el("div.buybar", {}, buy, el("button.primary", { onclick: () => { form.scrollIntoView({ behavior: calm.matches ? "auto" : "smooth", block: "start" }); } }, t("book")));
  if (embedded) { // the booking box alone, with the offer's name and a way to the full page
    app.replaceChildren(el("div.wrap.embedbox", {}, el("div.row.between", {}, el("h1.h2", {}, l.i18n[lang].title), el("a.small", { href: `/?l=${l.id}&lang=${lang}`, target: "_blank", rel: "noopener" }, t("poweredBy"))), form, wait));
    return;
  }
  page(el("div.row.between", {}, back(), el("div.row", {}, share, fav)), gallery(l), el("div.two", {},
    el("div.stack", { style: "gap:26px" },
      el("div.stack", { style: "gap:14px" }, el("h1", {}, l.i18n[lang].title),
        el("ul.specs", {}, [["pin", placeOf(l)], ["clock", `${l.duration_min} ${t("minutes")}`], ["people", `${l.capacity} ${t("upTo")}`]].map(([i, v]) => el("li", {}, icon(i, 20), v)), l.reviews > 0 && el("li", {}, rating(l)), l.instant && el("li.deal", {}, icon("check", 20), t("instantBadge")))),
      el("div.who", {}, el("span.avatar", { "aria-hidden": "true" }, [...l.host][0].toUpperCase()), el("div", {}, el("b", {}, link({ host: l.host_id }, "a", {}, l.host)), el("div.muted.small", {}, cfg.providerTypes[l.host_type][lang], l.hosted > 0 && ` · ${l.hosted} ${t("hosted")}`), verified(l))),
      el("p", { style: "font-size:1.08rem;max-width:62ch" }, l.i18n[lang].description),
      el("ul.promise", {}, [["check", "freeCancel"], ["chart", "trustPrice"], ["globe", "trustTalk"]].map(([i, k]) => el("li", {}, icon(i, 26), t(k)))),
      l.reviewList.length > 0 && el("section.card", {}, el("h2", {}, t("reviews")), l.reviewList.map((r) => el("div.review", {}, el("div.row", {}, el("span.star", { role: "img", "aria-label": `${r.rating} / 5` }, "★".repeat(r.rating)), el("b", {}, r.by), el("span.muted.small", {}, r.date)), r.text && el("p", { dir: "auto", lang: r.lang }, r.text)))),
      el("div", {}, el("button.ghost.mini.text", { type: "button", onclick: () => reportForm(l) }, icon("flag", 18), t("report")))),
    el("div.stack.sticky", {}, form, wait)), similar);
  if (bar) {
    app.append(bar);
    watch = new IntersectionObserver(([e]) => { e.isIntersecting ? bar.setAttribute("data-off", "") : bar.removeAttribute("data-off"); });
    watch.observe(form);
  }
  const rest = (await api("/api/listings?log=0").catch(() => [])).filter((x) => x.id !== l.id).map((x) => [x, (x.category === l.category) * 2 + (x.region === l.region)]).filter(([, s]) => s).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (id === renderId && rest.length) similar.replaceChildren(el("h2", {}, t("similar")), el("div.grid", {}, rest.map(([x]) => card(x))));
}

/** Full times a guest can wait for. Needs a mail server. */
function waitBox(l, open, guests) {
  const full = cfg.mail ? open().flatMap((d) => d.times.filter((x) => x.free < guests()).map((x) => [d.date, x.time])).slice(0, 40) : [];
  if (!full.length) return null;
  const slot = el("select", {}, full.map(([d, tm]) => el("option", { value: `${d}|${tm}` }, `${dayName(d)}, ${tm}`))), email = el("input", { type: "email", required: true, maxlength: 120, autocomplete: "email", value: store.get("email") ?? "" });
  const send = run(async () => {
    const [date, time] = slot.value.split("|");
    await api(`/api/listings/${l.id}/waitlist`, { date, time, guests: Math.max(1, guests()), email: email.value, lang });
    store.set("email", email.value.trim());
    box.replaceChildren(el("div.note.ok", { role: "status" }, t("waitDone")));
  });
  const box = el("details.card.wait", {}, el("summary", {}, icon("bell", 20), t("waitTitle")), el("form.stack", { onsubmit: (e) => { e.preventDefault(); send({ currentTarget: e.submitter }); } }, el("p.small.muted", {}, t("waitText")), el("label", {}, t("date"), slot), el("label", {}, t("email"), email), el("button", { type: "submit" }, t("waitBtn"))));
  return box;
}
/** A larger group or a private visit: the host answers with one price. Needs a mail server for the answer. */
function groupBox(l) {
  const date = el("input", { type: "date", required: true, min: addDays(today(), 1), max: addDays(today(), 365) }), size = el("input", { type: "number", required: true, min: 1, max: 300, inputmode: "numeric", value: Math.max(l.capacity + 1, 6) });
  const only = el("input", { type: "checkbox" }), name = el("input", { required: true, maxlength: 80, autocomplete: "name", value: store.get("name") ?? "" }), email = el("input", { type: "email", required: true, maxlength: 120, autocomplete: "email", value: store.get("email") ?? "" }), note = el("textarea", { maxlength: 600, rows: 2 });
  const box = el("details.card.wait", {}, el("summary", {}, icon("people", 20), t("groupAsk")));
  const send = run(async () => {
    const r = await api(`/api/listings/${l.id}/group`, { date: date.value, guests: Number(size.value), private: only.checked, name: name.value, email: email.value, note: note.value.trim() || null, lang });
    store.set("name", name.value.trim()); store.set("email", email.value.trim());
    store.set("requests", JSON.stringify([r.token, ...store.json("requests", [])].slice(0, 20)));
    box.replaceChildren(el("div.note.ok", { role: "status" }, t("groupSent"), " ", link({ q: r.token }, "a", {}, t("open"))));
  });
  box.append(el("form.stack", { onsubmit: (e) => { e.preventDefault(); send({ currentTarget: e.submitter }); } }, el("p.small.muted", {}, t("groupText")),
    el("div.fields", {}, el("label", {}, t("date"), date), el("label", {}, t("guests"), size)), el("label.check", {}, only, el("span", {}, t("groupPrivate"))),
    el("label", {}, t("name"), name), el("label", {}, t("email"), email), el("label", {}, t("reportText"), note), el("button", { type: "submit" }, t("groupSend"))));
  return box;
}
/** Buying a gift: the amount, for whom, a message. It is paid on the next page. */
function giftPage() {
  const presets = [300_000, 500_000, 1_000_000], amount = el("input", { type: "number", required: true, min: cfg.voucher.min, max: cfg.voucher.max, step: 10000, inputmode: "numeric", value: 500_000 });
  const chips = el("div.chips", { role: "group", "aria-label": t("total") }, presets.map((n) => el("button", { type: "button", "aria-pressed": String(n === 500_000), onclick: () => { amount.value = n; for (const c of chips.children) c.setAttribute("aria-pressed", String(Number(c.dataset.n) === n)); }, dataset: { n } }, money(n))));
  amount.addEventListener("input", () => { for (const c of chips.children) c.setAttribute("aria-pressed", String(Number(c.dataset.n) === Number(amount.value))); });
  const recipient = el("input", { maxlength: 80 }), message = el("textarea", { maxlength: 400, rows: 3 }), name = el("input", { required: true, maxlength: 80, autocomplete: "name", value: store.get("name") ?? "" }), email = el("input", { type: "email", required: true, maxlength: 120, autocomplete: "email", value: store.get("email") ?? "" });
  const send = run(async () => { const r = await api("/api/vouchers", { amount_uzs: Number(amount.value), recipient: recipient.value.trim() || null, message: message.value.trim() || null, name: name.value, email: email.value, lang }); store.set("gifts", JSON.stringify([r.token, ...store.json("gifts", [])].slice(0, 20))); go({ giftcard: r.token }); });
  page(back(), el("div.two", {}, el("section.giftintro", {}, art("gift-hero", "embroidery"), el("div.stack", {}, el("h1", {}, t("giftTitle")), el("p", {}, t("giftText")))),
    el("form.card", { onsubmit: (e) => { e.preventDefault(); send({ currentTarget: e.submitter }); } }, el("div.stack", { style: "gap:8px" }, el("span.small.muted", {}, t("total")), chips, el("label", {}, t("giftOther"), amount)),
      el("label", {}, t("giftFor"), recipient), el("label", {}, t("giftMessage"), message), el("label", {}, t("name"), name), el("label", {}, t("email"), email), el("button.primary.wide", { type: "submit" }, icon("wallet", 20), t("giftBuy")))));
}
/** The gift card: pay for it, then print or send it. */
async function giftCardPage(id, token) {
  let v = await api(`/api/vouchers/${encodeURIComponent(token)}`);
  if (v.status === "unpaid") v = await api(`/api/vouchers/${encodeURIComponent(token)}/refresh`, {}).catch(() => v); // back from the payment page
  if (id !== renderId) return;
  if (v.status === "unpaid") return page(back(), el("div.card", { style: "max-width:560px" }, el("h1.h2", {}, t("giftTitle")), el("dl.sum", {}, el("dt.all", {}, t("total")), el("dd.all", {}, money(v.amount_uzs))),
    el("fieldset.pay", {}, el("legend", {}, t("payWith")), cfg.payMethods.map((method, n) => el("button" + (n ? "" : ".primary") + ".wide", { type: "button", onclick: run(async () => { const r = await api(`/api/vouchers/${encodeURIComponent(token)}/pay`, { method }); if (r.url) location.href = r.url; else render(); }) }, PAY_NAME[method] ? [icon("wallet", 20), PAY_NAME[method]] : t("pay"))))));
  const url = `${location.origin}/?gift=${v.code}&lang=${lang}`;
  page(el("div.noprint", {}, back()), el("section.giftcard", {}, art(`gift-${v.code}`, "embroidery"), el("div.stack", { style: "gap:10px" }, el("p.small", {}, "SilkRoad Experience OS"), el("h1", {}, t("giftTitle")),
    v.recipient && el("p", {}, `${t("giftFor")}: `, el("b", {}, v.recipient)), v.message && el("p.wish", { dir: "auto" }, v.message),
    el("b.code", { dir: "ltr" }, v.code), el("p", {}, `${t("giftLeft")}: `, el("b", {}, money(v.balance_uzs)), ` · ${t("giftValid")}: ${fmt({ day: "numeric", month: "long", year: "numeric" }).format(asDate(v.valid_until))}`))),
    el("div.row.noprint", {}, el("button.primary", { onclick: () => print() }, t("print")), el("button", { onclick: async () => { try { if (navigator.share) return await navigator.share({ title: t("giftTitle"), text: `${t("giftCode")}: ${v.code}`, url }); } catch (e) { if (e.name === "AbortError") return; } if (await copy(url)) toast(t("copied")); } }, icon("share", 20), t("share")), link({}, "a.btn", {}, t("explore"))));
}

/** The host's answer to a group, and booking it. */
async function quotePage(id, token) {
  const g = await api(`/api/requests/${encodeURIComponent(token)}`);
  if (id !== renderId) return;
  if (g.booking) return go({ b: g.booking });
  const title = g.i18n[lang].title;
  document.title = `${title} | SilkRoad`;
  const book = run(async () => { const r = await api(`/api/requests/${encodeURIComponent(token)}/book`, { expect_uzs: g.quote.total_uzs }); store.set("bookings", JSON.stringify([r.booking, ...store.json("bookings", [])].slice(0, 30))); go({ b: r.booking }); });
  page(back(), el("div.card", { style: "max-width:640px" }, el("h1.h2", {}, g.quote ? t("quoteTitle") : title), g.quote && el("p.muted", {}, title),
    el("dl.facts", {}, [[t("date"), longDate(g.date) + (g.quote ? `, ${g.quote.time}` : "")], [t("guests"), String(g.guests) + (g.private ? ` · ${t("groupPrivate")}` : "")], [t("where"), placeOf(g)]].map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v)))),
    g.status === "declined" ? el("div.note.bad", { role: "status" }, t("quoteDeclined"))
      : g.expired ? el("div.note.warn", { role: "status" }, t("noSlots"))
      : g.quote ? [g.quote.note && el("p", { dir: "auto" }, g.quote.note), el("dl.sum", {}, el("dt.all", {}, t("total")), el("dd.all", {}, money(g.quote.total_uzs))), el("button.primary.wide", { onclick: book }, t("quoteBook")), el("p.small.muted.row", {}, icon("check", 18), t("freeCancel"))]
      : el("div.note", { role: "status" }, t("quoteWait"))));
  if (!g.quote && g.status === "new") poll = setInterval(() => { if (!document.hidden) quotePage(id, token).catch(() => {}); }, 20000);
}

/** From the link in the e-mail. Opening a link never changes anything by itself. */
function leavePage(token) {
  page(back(), el("div.card", { style: "max-width:560px" }, el("h1.h2", {}, t("waitStop")), el("div.row", {}, el("button.primary", { onclick: run(async (e) => { const c = e.currentTarget.closest(".card"); await api(`/api/waitlist/${encodeURIComponent(token)}/leave`, {}); c.replaceChildren(el("div.note.ok", { role: "status" }, t("waitLeft"))); }) }, t("waitStop")))));
}

/** Remembered on this device only. */
function contactFields() {
  const email = el("input", { type: "email", maxlength: 120, autocomplete: "email", value: store.get("email") ?? "" }), phone = el("input", { type: "tel", maxlength: 24, autocomplete: "tel", value: store.get("phone") ?? "" });
  return {
    node: [el("div.fields", {}, cfg.mail && el("label", {}, t("email"), email), el("label", {}, t("phone"), phone)), el("p.small.muted", {}, t("contactWhy"))],
    value() { store.set("email", email.value.trim() || null); store.set("phone", phone.value.trim() || null); return { email: (cfg.mail && email.value.trim()) || null, phone: phone.value.trim() || null }; },
  };
}

function reportForm(l) {
  const reason = el("select", {}, ["r_unsafe", "r_false", "r_offensive", "r_other"].map((r) => el("option", { value: r.slice(2) }, t(r)))), text = el("textarea", { maxlength: 600 });
  const d = el("dialog", { "aria-label": t("report") }, el("form.stack", { onsubmit: (e) => { e.preventDefault(); send({ currentTarget: e.submitter }); } }, el("h2", {}, t("report")), el("label", {}, t("report"), reason), el("label", {}, t("reportText"), text), el("div.row", {}, el("button", { type: "button", onclick: () => d.close() }, t("close")), el("button.primary", { type: "submit" }, t("send")))));
  const send = run(async () => { await api(`/api/listings/${l.id}/report`, { reason: reason.value, details: text.value.trim() || null }); d.close(); toast(t("reported")); });
  d.onclose = () => d.remove();
  document.body.append(d);
  d.showModal();
}

// ---- one host ---------------------------------------------------------------------------------
async function hostPage(id, hid) {
  const h = await api(`/api/providers/${encodeURIComponent(hid)}`);
  if (id !== renderId) return;
  document.title = `${h.name} | SilkRoad`;
  const since = fmt({ month: "long", year: "numeric" }).format(asDate(`${h.since}-01`));
  page(back(), el("div.who.big", {}, el("span.avatar", { "aria-hidden": "true" }, [...h.name][0].toUpperCase()), el("div.stack", { style: "gap:6px" }, el("h1", {}, h.name),
    el("div.row", {}, el("span.muted", {}, cfg.providerTypes[h.type][lang]), verified(h), h.demo && el("span.badge", {}, t("sample"))),
    el("ul.specs.small", {}, [h.reviews > 0 && [star(), `${h.rating} (${h.reviews})`], h.hosted > 0 && [icon("people", 18), `${h.hosted} ${t("hosted")}`], h.reply_hours && [icon("clock", 18), `${t("replies")} ${h.reply_hours} ${t("hour")}`], [icon("calendar", 18), `${t("hostSince")} ${since}`]].filter(Boolean).map((x) => el("li", {}, x))))),
    el("div.grid", {}, h.listings.map((l) => card(l, "h2.sm"))));
}

// ---- one booking ----------------------------------------------------------------------------
function reviewForm(b, done) {
  let n = 0;
  const text = el("textarea", { maxlength: 600 });
  const send = el("button.primary", { disabled: true, onclick: run(async () => { await api(`/api/bookings/${b.token}/review`, { rating: n, text: text.value }); toast(t("thanks")); await done(); }) }, t("send"));
  const stars = el("div.stars", { role: "radiogroup", "aria-label": t("rate") }, [1, 2, 3, 4, 5].map((i) => el("button", { type: "button", role: "radio", "aria-checked": "false", "aria-label": `${i} / 5`, onclick: () => {
    n = i;
    send.disabled = false;
    [...stars.children].forEach((s, k) => { s.classList.toggle("on", k < i); s.setAttribute("aria-checked", String(k === i - 1)); });
  } }, "★")));
  return el("div.card", {}, el("h2", {}, t("rate")), stars, el("label", {}, t("rateText"), text), send);
}

const ticketText = (c) => c.replace(/(.{4})(?=.)/g, "$1-");
const ticketQr = (c) => el("img.qr", { src: `/api/qr.svg?text=${encodeURIComponent(`${location.origin}/mezbon#chipta/${c}`)}`, alt: `${t("ticket")} ${ticketText(c)}` });
function ticketCard(b) {
  if (b.ticket.used_at) return el("section.card", {}, el("h2", {}, t("ticket")), el("div.note.ok", { role: "status" }, t("ticketUsed")));
  return el("section.card.ticket", {}, el("h2", {}, t("ticket")), ticketQr(b.ticket.code), el("b.code", { dir: "ltr" }, ticketText(b.ticket.code)), el("p.muted.small", {}, t("ticketHint")), link({ b: b.token, ticket: 1 }, "a.btn", {}, t("printTicket")));
}

/** A single sheet to print or screenshot. */
async function ticketPage(id, token) {
  const b = await api(`/api/bookings/${encodeURIComponent(token)}`);
  if (id !== renderId) return;
  if (!b.ticket) return go({ b: token });
  page(el("div.noprint", {}, link({ b: token }, "a.back", {}, b.i18n[lang].title)), el("section.card.ticket.sheet", {}, el("p.muted", {}, "SilkRoad Experience OS"), el("h1", {}, b.i18n[lang].title), ticketQr(b.ticket.code), el("b.code", { dir: "ltr" }, ticketText(b.ticket.code)),
    el("dl.facts", {}, [[t("date"), longDate(b.date)], [t("time"), b.time], [t("guests"), String(b.guests)], [t("name"), b.guest_name], [t("where"), placeOf(b)]].map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v)))),
    b.ticket.used_at ? el("div.note.ok", {}, t("ticketUsed")) : el("p.muted", {}, t("ticketHint"))), el("button.primary.noprint", { style: "justify-self:center", onclick: () => print() }, t("printTicket")));
}

function meetCard(b) {
  const m = b.meet;
  if (!m) return el("section.card", {}, el("div.row", {}, icon("pin", 24), el("h2", {}, t("meet"))), el("p.muted", {}, t("meetAfter")));
  const at = m.lat == null ? null : `${m.lat},${m.lng}`;
  return el("section.card", {}, el("div.row", {}, icon("pin", 24), el("h2", {}, t("meet"))), m.address ? el("p", { dir: "auto" }, m.address) : !at && el("p.muted", {}, t("meetAsk")),
    el("div.row", {}, (at || m.address) && el("a.btn.primary", { href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(at ?? `${m.address}, ${cfg.regions[b.region]}, Uzbekistan`)}`, target: "_blank", rel: "noopener noreferrer" }, t("openMap")),
      at && el("a.btn", { href: `https://yandex.com/maps/?pt=${m.lng},${m.lat}&z=16&l=map`, target: "_blank", rel: "noopener noreferrer" }, "Yandex"), m.phone && el("a.btn", { href: `tel:${m.phone}`, dir: "ltr" }, m.phone)));
}

/** A printable confirmation of what was paid and what came back. */
async function receiptPage(id, token) {
  const b = await api(`/api/bookings/${encodeURIComponent(token)}`), p = b.payment;
  if (id !== renderId) return;
  if (!p?.paid_at) return go({ b: token });
  const when = (iso) => new Intl.DateTimeFormat(lang, { timeZone: "Asia/Tashkent", dateStyle: "long", timeStyle: "short" }).format(new Date(iso)), real = (n) => uzs(n, lang, null);
  page(el("div.noprint", {}, link({ b: token }, "a.back", {}, b.i18n[lang].title)), el("section.card.ticket.sheet", {}, el("p.muted", {}, "SilkRoad Experience OS"), el("h1", {}, t("receipt")), el("h2", {}, b.i18n[lang].title),
    el("dl.facts", {}, [[t("date"), `${longDate(b.date)}, ${b.time}`], [t("guests"), String(b.guests)], [t("name"), b.guest_name], [t("where"), placeOf(b)], [t("payBy"), p.provider === "test" ? t("pay") : PAY_NAME[p.provider] ?? p.provider], [t("paidOn"), when(p.paid_at)], [t("receiptNo"), p.id]].map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", { dir: "auto" }, v)))),
    el("dl.sum.wide", {}, [[t("toHost"), b.host_uzs], ...(b.hotel ? [[b.hotel, b.hotel_uzs]] : []), ["SilkRoad", b.platform_uzs]].map(([k, v]) => [el("dt", {}, k), el("dd", {}, real(v))]), el("dt.all", {}, t("total")), el("dd.all", {}, real(p.amount_uzs))),
    ["refund_due", "refunded"].includes(p.status) && el("div.note" + (p.status === "refunded" ? ".ok" : ""), {}, t(p.status === "refunded" ? "refunded" : "refundDue"), p.refunded_at && `, ${when(p.refunded_at)}`),
    el("p.small.muted", {}, t("receiptNote"))), el("button.primary.noprint", { style: "justify-self:center", onclick: () => print() }, t("print")));
}

/** Pick another open slot for an existing booking. */
async function moveForm(b, done) {
  const open = (await api(`/api/listings/${encodeURIComponent(b.listing_id)}/availability?days=45`)).map((d) => ({ ...d, times: d.times.filter((x) => x.free >= b.guests && !(d.date === b.date && x.time === b.time)) })).filter((d) => d.times.length);
  if (!open.length) return el("div.card.movebox", {}, el("p.note.warn", {}, t("noSlots")));
  const date = el("select", { onchange: () => fill() }, open.map((d) => el("option", { value: d.date }, longDate(d.date)))), time = el("select");
  const fill = () => time.replaceChildren(...open.find((d) => d.date === date.value).times.map((x) => el("option", { value: x.time }, x.time)));
  fill();
  return el("div.card.movebox", {}, el("h2", {}, t("move")), el("div.fields", {}, el("label", {}, t("date"), date), el("label", {}, t("time"), time)), el("p.small.muted", {}, t("moveNote")),
    el("div.row", {}, el("button.primary", { onclick: run(async () => { await api(`/api/bookings/${b.token}/reschedule`, { date: date.value, time: time.value }); toast(t("moved")); await done(); }) }, t("move")), el("button", { onclick: () => done() }, t("no"))));
}

/** Give 10%, get 10%: the guest's own code to share. */
function referCard(b) {
  const box = el("section.card.refer", {}, el("h2", {}, t("refTitle")), el("p.muted", {}, t("refText")));
  const show = (code) => {
    const url = `${location.origin}/?promo=${code}&lang=${lang}`;
    box.replaceChildren(el("h2", {}, t("refTitle")), el("p.muted", {}, t("refText")), el("b.code", { dir: "ltr" }, code), el("div.row", {},
      el("button.primary", { onclick: async () => { try { if (navigator.share) return await navigator.share({ title: "SilkRoad", text: `${t("refTitle")}: ${code}`, url }); } catch (e) { if (e.name === "AbortError") return; } if (await copy(url)) toast(t("copied")); } }, icon("share", 20), t("share")),
      el("button", { onclick: async () => { if (await copy(code)) toast(t("copied")); } }, t("copyLink"))));
  };
  const saved = store.get(`ref.${b.token}`);
  if (saved) show(saved);
  else box.append(el("button.primary", { onclick: run(async () => { const r = await api(`/api/bookings/${b.token}/referral`, {}); store.set(`ref.${b.token}`, r.code); show(r.code); }) }, t("refButton")));
  return box;
}

function notifyCard(b) {
  if (!pushSupported() || store.get(`push.${b.token}`) || !["pending", "paid", "confirmed"].includes(b.status)) return null;
  const box = el("div.card", {}, el("div.row", {}, icon("bell"), el("b", {}, t("notifyOn"))), el("p.small.muted", {}, t("notifyWhy")), el("button", { onclick: run(async () => {
    if (!(await enablePush({ path: `/api/push/guest/${b.token}` }))) return toast(t("notifyBlocked"), true);
    store.set(`push.${b.token}`, "1");
    box.remove();
    toast(t("notifyDone"));
  }) }, t("notifyOn")));
  return box;
}

async function bookingView(id, token) {
  let last = "";
  const draft = el("input", { maxlength: 1000, "aria-label": t("ask"), placeholder: t("ask"), required: true });
  const load = async (force) => {
    let b = await api(`/api/bookings/${encodeURIComponent(token)}`);
    // Back from the payment page: the server asks Octo, the address bar is never trusted.
    if (!last && b.status === "pending" && b.payment?.provider === "octo") b = await api(`/api/bookings/${encodeURIComponent(token)}/refresh`, {}).catch(() => b);
    if (id !== renderId) return;
    const sig = JSON.stringify(b);
    if (sig === last && !force) return;
    // A poll must not wipe a half-finished date change or review.
    if (last && !force && app.querySelector(".movebox")) return;
    if (last && !force && b.can_review && document.activeElement?.closest?.("textarea, .stars")) return;
    if (last && !force && document.querySelector("dialog[open]")) return;
    last = sig;
    const focused = document.activeElement === draft, i = b.i18n[lang];
    const tone = { confirmed: ".ok", declined: ".bad", expired: ".bad", cancelled: ".bad", pending: ".warn" }[b.status] ?? "";
    const stage = { pending: 1, paid: 2, confirmed: 3 }[b.status] ?? 0;
    const send = (body) => run(async () => { await api(`/api/bookings/${b.token}/messages`, body()); draft.value = ""; await load(true); });
    const chatOpen = ["paid", "confirmed"].includes(b.status);
    document.title = `${i.title} | SilkRoad`;
    page(el("div.row", {}, link({ my: 1 }, "a.back", {}, t("myBookings")), b.trip && link({ trip: b.trip }, "a.back", {}, t("tripMine"))), el("div.two", {},
      el("div.card", {}, el("h1", {}, i.title),
        stage > 0 && el("ol.track", {}, ["stepReserved", "stepPaid", "stepConfirmed"].map((k, n) => el("li" + (n < stage ? ".done" : ""), {}, t(k)))),
        el("div.note" + tone, { role: "status" }, t(b.status), b.expires_at && el("div.small", {}, `${t("holdUntil")} ${clockTime(b.expires_at)}`), b.decide_by && el("div.small", {}, `${t("decideBy")} ${clockTime(b.decide_by)}. ${t("decideNote")}`)),
        ["refund_due", "refunded"].includes(b.payment?.status) && el("div.note" + (b.payment.status === "refunded" ? ".ok" : ""), { role: "status" }, t(b.payment.status === "refunded" ? "refunded" : "refundDue")),
        b.status === "pending" && ["failed", "cancelled"].includes(b.payment?.status) && el("div.note.bad", { role: "status" }, t("payFail")),
        el("dl.facts", {}, [[t("date"), longDate(b.date)], [t("time"), b.time], [t("guests"), String(b.guests)], [t("name"), b.guest_name], [t("where"), placeOf(b)]].map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v)))),
        b.extras.length > 0 && el("p.small", {}, `${t("extrasTitle")}: `, b.extras.map((x) => t(`x_${x.kind}`)).join(", ")),
        el("dl.sum", {}, [[t("toHost"), b.host_uzs], ...(b.hotel ? [[b.hotel, b.hotel_uzs]] : []), ...(b.reseller ? [[b.reseller, b.partner_uzs]] : []), ["SilkRoad", b.platform_uzs]].map(([k, v]) => [el("dt", {}, k), el("dd", {}, money(v))]), b.discount_uzs > 0 && [el("dt", {}, `${t("discount")} (${b.promo})`), el("dd.deal", {}, `−${money(b.discount_uzs)}`)], el("dt.all", {}, t("total")), el("dd.all", {}, money(b.total_uzs)), b.voucher_uzs > 0 && [el("dt", {}, t("giftPays")), el("dd.deal", {}, `−${money(b.voucher_uzs)}`), el("dt.all", {}, t("toPay")), el("dd.all", {}, money(b.due_uzs))]),
        (b.status === "pending" || b.can_revive) && b.due_uzs === 0 && el("button.primary.wide", { onclick: run(async () => { await api(`/api/bookings/${b.token}/pay`, { method: "voucher" }); await load(true); }) }, icon("wallet", 20), t("payGift")),
        (b.status === "pending" || b.can_revive) && b.due_uzs > 0 && cfg.payMethods.length > 0 && el("fieldset.pay", {}, el("legend", {}, t("payWith")), cfg.payMethods.map((method, n) => el("button" + (n ? "" : ".primary") + ".wide", { type: "button", onclick: run(async () => {
          const r = await api(`/api/bookings/${b.token}/pay`, { method });
          if (r.url) location.href = r.url; else await load(true);
        }) }, PAY_NAME[method] ? [icon("wallet", 20), PAY_NAME[method]] : t("pay"))), cfg.payMethods.some((m) => PAY_NAME[m]) && el("p.small.muted.row", {}, icon("shield", 18), t("paySafe"))),
        el("div.row", {},
          chatOpen && el("a.btn", { href: `/api/bookings/${b.token}/calendar.ics` }, icon("calendar", 20), t("calendar")),
          b.payment?.paid_at && link({ b: b.token, receipt: 1 }, "a.btn", {}, icon("wallet", 20), t("receipt")),
          el("button", { onclick: async () => { if (await copy(`${location.origin}/?b=${b.token}`)) toast(t("copied")); } }, t("copyLink")),
          b.can_move && el("button", { onclick: run(async (e) => { const c = e.currentTarget.closest(".card"); app.querySelector(".movebox")?.remove(); c.after(await moveForm(b, () => load(true))); app.querySelector(".movebox")?.scrollIntoView({ block: "nearest" }); }) }, t("move")),
          b.can_cancel && el("button.danger", { onclick: run(async () => { if (!(await ask(t("cancelSure"), t("yes"), t("no")))) return; await api(`/api/bookings/${b.token}/cancel`, {}); await load(true); }) }, t("cancel"))),
        el("p.small.muted", {}, t("keepLink"))),
      el("div.stack", { style: "gap:24px" },
        b.ticket ? ticketCard(b) : b.status === "paid" && el("div.card", {}, el("h2", {}, t("ticket")), el("p.muted", {}, t("ticketWait"))),
        cfg.telegramBot && ["pending", "paid", "confirmed"].includes(b.status) && el("div.card", {}, b.telegram ? el("p.deal.row", {}, icon("check", 20), t("tgDone")) : el("button", { onclick: run(async () => { const r = await api(`/api/bookings/${b.token}/telegram`, {}); window.open(r.url, "_blank", "noopener"); }) }, icon("bell", 20), t("tgButton"))),
        ["paid", "confirmed"].includes(b.status) && b.has_email && referCard(b),
        notifyCard(b),
        b.can_review && reviewForm(b, () => load(true)),
        b.my_rating && el("div.card", {}, el("p", {}, el("span.star", {}, "★".repeat(b.my_rating)), " ", t("thanks"))),
        ["paid", "confirmed"].includes(b.status) && meetCard(b),
        chatOpen && el("section.card", {}, el("h2", {}, t("ask")),
          b.messages.length > 0 && el("div.chat", { role: "log" }, b.messages.map((m) => { const mine = m.sender === "guest"; return el("div.msg" + (mine ? ".me" : ""), { dir: "auto" }, mine ? m.original : m.translated,
            !mine && m.engine === "untranslated" ? el("small", {}, t("untranslated")) : !mine && m.original !== m.translated && el("small", {}, m.original)); })),
          el("div.chips", {}, Object.keys(cfg.phrases).filter((k) => k[0] === "q").map((k) => el("button", { type: "button", onclick: send(() => ({ code: k })) }, cfg.phrases[k][b.lang]))),
          el("form.compose", { onsubmit: (e) => { e.preventDefault(); send(() => ({ text: draft.value }))({ currentTarget: e.submitter }); } }, draft, el("button.primary", { type: "submit" }, t("send"))))),
    ));
    if (focused) draft.focus();
    app.querySelector(".chat")?.scrollTo(0, 1e6);
  };
  await load(true);
  if (id !== renderId) return;
  keep(subscribe(`/api/bookings/${encodeURIComponent(token)}/live`, (ev) => { if (ev.t !== "hello") load(false).catch(() => {}); }));
  poll = setInterval(() => { if (!document.hidden) load(false).catch(() => {}); }, 15000); // in case the stream is blocked
}

// ---- my bookings and saved --------------------------------------------------------------------
async function mine(id) {
  const trips = (await Promise.all(store.json("trips", []).map((x) => api(`/api/trips/${encodeURIComponent(x)}`).catch(() => null)))).filter((x) => x?.bookings.length);
  const tokens = store.json("bookings", []);
  const found = (await Promise.all(tokens.map((x) => api(`/api/bookings/${encodeURIComponent(x)}`).catch(() => null)))).filter(Boolean);
  if (id !== renderId) return;
  page(el("h1", {}, t("myBookings")), trips.length > 0 && el("div.grid", {}, trips.map((x) => link({ trip: x.token }, "a.card.triplink", {}, icon("route", 26), el("b", {}, t("tripMine")), el("span.muted.small", {}, `${longDate(x.bookings[0].date)} · ${x.bookings.length} × ${t("ticket")}`), x.waiting > 0 && el("span.badge.warn", {}, `${x.waiting} ${t("tripLeft")}`)))), found.length
    ? el("div.grid", {}, found.map((b) => el("article.tile-l", {}, link({ b: b.token }, "a", {}, el("div.art", {}, visual({ ...b, id: b.listing_id }), el("span.badge" + ({ confirmed: ".ok", pending: ".warn", declined: ".bad", expired: ".bad", cancelled: ".bad" }[b.status] ?? ""), {}, t(b.status))),
      el("div.stack", { style: "gap:4px" }, el("h2.sm", {}, b.i18n[lang].title), el("div.meta", {}, `${longDate(b.date)}, ${b.time}`), ["paid", "confirmed"].includes(b.status) && b.date >= today() && el("span.soon", {}, el("i"), inDays(b.date)), el("span.price", {}, money(b.total_uzs)))))))
    : el("div.card.empty", {}, plate("bron", "bread"), el("p", {}, t("noBookings")), link({}, "a.btn.primary", {}, t("explore"))), cfg.mail && findForm());
}
function findForm() {
  const email = el("input", { type: "email", required: true, maxlength: 120, autocomplete: "email", value: store.get("email") ?? "" });
  const send = run(async () => { await api("/api/find", { email: email.value, lang }); toast(t("findSent")); });
  return el("form.card", { style: "max-width:560px", onsubmit: (e) => { e.preventDefault(); send({ currentTarget: e.submitter }); } }, el("h2", {}, t("findTitle")), el("p.muted", {}, t("findText")), el("label", {}, t("email"), email), el("button", { type: "submit" }, t("send")));
}
async function saved(id) {
  const all = (await api("/api/listings?log=0")).filter((l) => isFav(l.id));
  if (id !== renderId) return;
  page(el("h1", {}, t("saved")), all.length ? el("div.grid", {}, all.map((l) => card(l, "h2.sm"))) : el("div.card.empty", {}, plate("yurak", "embroidery"), el("p", {}, t("noSaved")), link({}, "a.btn.primary", {}, t("explore"))));
}

// ---- shell ------------------------------------------------------------------------------------
function chrome(q) {
  const here = q.has("my") || q.has("b") || q.has("trip") ? "my" : q.has("saved") ? "saved" : q.has("plan") ? "trip" : "explore";
  const items = [["explore", "search", {}], ["trip", "route", { plan: 1 }], ["saved", "heart", { saved: 1 }], ["my", "ticket", { my: 1 }]];
  const label = { explore: "explore", trip: "trip", saved: "saved", my: "myBookings" };
  const build = (size) => [...items.map(([k, i, p]) => link(p, "a", { "aria-current": k === here ? "page" : null }, icon(i, size), t(label[k]))), el("a", { href: "/mezbon" }, icon("user", size), t("forHosts"))];
  document.getElementById("nav").replaceChildren(...build(19));
  document.getElementById("bottom").replaceChildren(...build(23));
  document.getElementById("skip").textContent = t("skip");
  document.getElementById("foot").textContent = cfg.testPayments ? `${t("tagline")} ${t("testNote")}` : t("tagline");
  const cur = Object.keys(rates).length > 0 && el("select", { "aria-label": t("currency"), title: t("rateNote"), onchange: () => { store.set("fx", cur.value); render(); } }, ["UZS", ...Object.keys(rates)].map((c) => el("option", { value: c, selected: c === (fx()?.code ?? "UZS") }, c)));
  document.getElementById("prefs").replaceChildren(...[cur].filter(Boolean), installButton(t("install")), themePicker({ theme: t("theme"), auto: t("auto"), light: t("light"), dark: t("dark") }), el("a.back", { href: `/impact?lang=${["uz", "ru"].includes(lang) ? lang : "en"}` }, t("impact")), el("a.back", { href: "/?gift=1" }, t("giftNav")), el("a.back", { href: "/panel" }, "Talab paneli"));
}

const tripCtx = () => ({ app, query, swap, card, dayName, keep, offlineNote, calm, t, cfg, lang, run, why: whyNot, money, longDate, regionName, placeOf, link, page, back, go, hotel, contactFields, addDays, today, copy, alive: (id) => id === renderId, every: (fn, ms) => { poll = setInterval(() => { if (!document.hidden) fn().catch(() => {}); }, ms); } });

async function render() {
  const id = ++renderId;
  clearInterval(poll);
  watch?.disconnect();
  for (const stop of ends.splice(0)) stop();
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.title = `SilkRoad Experience OS: ${t("headline")}`;
  pick.value = lang;
  pick.setAttribute("aria-label", t("language"));
  const q = query();
  chrome(q);
  try {
    if (q.get("q")) await quotePage(id, q.get("q"));
    else if (q.get("giftcard")) await giftCardPage(id, q.get("giftcard"));
    else if (q.has("gift") && !q.get("l")) giftPage();
    else if (q.get("b") && q.has("receipt")) await receiptPage(id, q.get("b"));
    else if (q.get("b") && q.has("ticket")) await ticketPage(id, q.get("b"));
    else if (q.get("b")) await bookingView(id, q.get("b"));
    else if (q.get("trip")) await tripPage(tripCtx(), id, q.get("trip"));
    else if (q.has("plan")) planner(tripCtx(), id);
    else if (q.get("leave")) leavePage(q.get("leave"));
    else if (q.get("host")) await hostPage(id, q.get("host"));
    else if (q.get("l")) await detail(id, q.get("l"));
    else if (q.has("my")) await mine(id);
    else if (q.has("saved")) await saved(id);
    else await explore(tripCtx(), id);
  } catch (e) {
    if (id !== renderId) return;
    if (!e.code) console.error(e);
    page(back(), el("div.note.bad", { role: "alert" }, whyNot(e)));
  }
}
addEventListener("keydown", (e) => { // "/" goes to the search field
  const box = e.key === "/" && !e.ctrlKey && !e.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && document.querySelector('.finder [name="q"]');
  if (box) { e.preventDefault(); box.focus(); }
});
for (const ev of ["online", "offline"]) addEventListener(ev, () => { if (!app.querySelector("form :focus, .movebox, .route")) render(); });
render();
