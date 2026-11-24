import { act, api, ask, copy, el, GEO, plate, store, toast, uzs, visual } from "/common.js";
import { art, icon } from "/art.js";
import { enablePush, installButton, pushSupported, themePicker } from "/pwa.js";

const app = document.getElementById("app");
const query = () => new URLSearchParams(location.search);
let cfg;
try { cfg = await api("/api/config"); } catch (e) {
  app.replaceChildren(el("div.wrap", {}, el("div.note.bad", { role: "alert" }, e.message), el("button", { onclick: () => location.reload() }, "↻")));
  throw e;
}
let lang = [query().get("lang"), store.get("lang"), ...(navigator.languages ?? []).map((l) => l.slice(0, 2))].find((l) => cfg.langs.includes(l)) ?? "en";
let poll, renderId = 0, watch;
const t = (k) => cfg.ui[k][lang];
const money = (n) => uzs(n, lang, cfg.usdRate);
const why = (e) => (cfg.ui[`e_${e.code}`] ?? cfg.ui.e_other)[lang];
const run = (fn) => act(fn, why);
const regionName = (r) => cfg.regionNames[r][lang];
const fmt = (o) => { try { return new Intl.DateTimeFormat(lang, { timeZone: "UTC", ...o }); } catch { return new Intl.DateTimeFormat("en", { timeZone: "UTC", ...o }); } };
const asDate = (d) => new Date(`${d}T00:00:00Z`);
const longDate = (d) => fmt({ weekday: "long", day: "numeric", month: "long" }).format(asDate(d));
const today = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10); // Tashkent
const placeOf = (l) => (l.place && l.place !== cfg.regions[l.region] ? `${l.place}, ${regionName(l.region)}` : regionName(l.region));
const star = () => el("span.star", { "aria-hidden": "true" }, "★");
const rating = (l) => l.reviews > 0 && el("span.rating", { "aria-label": `${l.rating} / 5, ${t("reviews")}: ${l.reviews}` }, star(), ` ${l.rating} (${l.reviews})`);
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
function card(l, level = "h3") {
  const pic = el("div.art", {}, visual(l), l.demo && el("span.badge", {}, t("sample")));
  return el("article.tile-l", {}, link({ l: l.id }, "a", { before: () => { pic.style.viewTransitionName = "pic"; } }, pic,
    el("div.stack", { style: "gap:5px" }, el(level, {}, l.i18n[lang].title), el("div.meta", {}, el("span", {}, regionName(l.region)), el("span", {}, `${l.duration_min} ${t("minutes")}`), el("span", {}, `${l.capacity} ${t("upTo")}`)),
      el("div.foot", {}, el("span.price", {}, money(l.price_uzs), " ", el("small", {}, t("perPerson"))), rating(l)))), heart(l));
}
const skeletons = (n) => el("div.grid", { "aria-hidden": "true" }, Array.from({ length: n }, () => el("div.stack", {}, el("div.skeleton", { style: "aspect-ratio:4/3" }), el("div.skeleton.line"), el("div.skeleton.line", { style: "width:60%" }))));

// ---- catalogue ------------------------------------------------------------------------------
const SORTS = { sortNew: () => 0, sortCheap: (a, b) => a.price_uzs - b.price_uzs, sortBest: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.reviews - a.reviews, sortShort: (a, b) => a.duration_min - b.duration_min };

function finder(f) {
  const sel = (k, label, any, opts, name) => el("label", {}, label, el("select", { name: k }, el("option", { value: "" }, any), Object.keys(opts).map((o) => el("option", { value: o, selected: o === f[k] }, name(o)))));
  const form = el("form.finder", { role: "search", onsubmit: (e) => { e.preventDefault(); go(Object.fromEntries([...new FormData(form)].filter(([, v]) => v)), false); } },
    sel("region", t("region"), t("allRegions"), cfg.regions, regionName),
    sel("category", t("activity"), t("allCats"), cfg.categories, (o) => cfg.categories[o][lang]),
    el("label", {}, t("date"), el("input", { type: "date", name: "date", min: today(), value: f.date })),
    el("label", {}, t("guests"), el("input", { type: "number", name: "guests", min: 1, max: 100, inputmode: "numeric", value: f.guests, placeholder: "2" })),
    el("button.primary", { type: "submit" }, icon("search"), t("search")));
  return form;
}
const rail = (f) => el("nav.rail", { "aria-label": t("activity") }, Object.keys(cfg.categories).map((c) => { const on = f.category === c, next = { ...f, category: on ? "" : c }; return link(Object.fromEntries(Object.entries(next).filter(([, v]) => v)), "a", { "aria-current": on ? "true" : null }, icon(c, 28), cfg.categories[c][lang]); }));

async function catalog(id) {
  const f = Object.fromEntries(["region", "category", "date", "guests"].map((k) => [k, query().get(k) ?? ""]));
  const filtered = Object.values(f).some(Boolean);
  const results = el("div.stack", { style: "gap:22px" }, skeletons(6));
  const below = el("div.stack", { style: "gap:clamp(40px,7vw,84px)" });
  const wall = ["pottery", "ikat", "carpet", "cooking", "tour", "embroidery", "wood", "bread", "village", "metal", "ikat", "pottery"];
  app.replaceChildren(
    filtered ? el("div.compactbar", {}, el("div.wrap", {}, finder(f)))
      : el("section.hero", {}, el("div.wall", { "aria-hidden": "true" }, [0, 1, 2].map((c) => el("div", {}, [0, 1, 2, 3].map((r) => art(`hero${c}${r}`, wall[(c * 4 + r) % wall.length]))))),
        el("div.wrap", {}, el("div.say", {}, el("h1", {}, t("headline")), el("p", {}, t("heart"), " ", t("sub")), hotel && el("p.small", {}, `${t("via")} ${hotel.name}`)), finder(f))),
    el("div.wrap", { style: "padding-block-start:28px;gap:30px" }, rail(f), results, below));

  const list = await api("/api/listings?" + new URLSearchParams({ ...f, lang }));
  if (id !== renderId) return;
  let sort = store.get("sort") in SORTS ? store.get("sort") : "sortNew";
  const grid = el("div.grid"), paint = () => grid.replaceChildren(...[...list].sort(SORTS[sort]).map((l) => card(l, filtered ? "h2.sm" : "h3")));
  const sorter = el("select", { "aria-label": t("sort"), onchange: () => { sort = sorter.value; store.set("sort", sort); swap(paint); } }, Object.keys(SORTS).map((s) => el("option", { value: s, selected: s === sort }, t(s))));
  paint();
  results.replaceChildren(...[offlineNote()].filter(Boolean),
    el("div.toolbar", {}, el("div", { role: "status" }, el((filtered ? "h1" : "h2") + ".h2", {}, `${list.length} ${t("results")}`)), el("div.row", {}, filtered && el("button.ghost", { onclick: () => go({}, false) }, t("clear")), list.length > 1 && sorter)),
    list.length ? grid : el("div.card.empty", {}, plate("bosh", "village"), el("p", {}, f.date || f.guests ? t("noDate") : t("empty")), el("button", { onclick: () => go({}, false) }, t("clear"))));
  if (filtered) return;

  const count = {};
  for (const l of list) count[l.region] = (count[l.region] ?? 0) + 1;
  below.replaceChildren(
    el("section.stack", { style: "gap:18px" }, el("div", {}, el("h2", {}, t("mapTitle")), el("p.muted.small", {}, t("mapNote"))),
      el("ul.tilemap.geo", {}, Object.keys(GEO).map((r) => el("li", { style: `--c:${GEO[r][0]};--r:${GEO[r][1]}` }, link({ region: r }, "a" + (count[r] ? "" : ".none"), { style: count[r] ? `background:color-mix(in srgb, var(--turq) ${8 + Math.min(4, count[r]) * 6}%, var(--card))` : null }, regionName(r), el("b", {}, String(count[r] ?? 0))))))),
    el("section.stack", { style: "gap:22px" }, el("h2", {}, t("howTitle")), el("ol.steps", {}, ["how1", "how2", "how3"].map((k) => el("li", {}, t(k)))),
      el("ul.promise", {}, [["check", "freeCancel"], ["chart", "trustPrice"], ["globe", "trustTalk"], ["ticket", "ticketHint"]].map(([i, k]) => el("li", {}, icon(i, 28), t(k))))),
    el("section.join", {}, art("join", "ikat"), el("h2", {}, t("becomeHost")), el("p", {}, t("becomeText")), el("a.btn", { href: "/mezbon" }, t("forHosts"))));
}

// ---- listing --------------------------------------------------------------------------------
function gallery(l) {
  const pics = l.photos.length ? l.photos.map((p, i) => el("div.art", {}, el("img.photo", { src: `/photos/${p}`, alt: i ? "" : l.i18n[lang].title, loading: i ? "lazy" : null }))) : [0, 1, 2, 3, 4].map((i) => el("div.art", {}, art(l.id + (i || ""), l.category)));
  const shown = pics.slice(0, 6);
  shown[0].style.viewTransitionName = "pic";
  if (l.demo) shown[0].append(el("span.badge", {}, t("sample")));
  return el("div.gallery", { dataset: { n: shown.length } }, shown);
}

async function detail(id, lid) {
  const [l, open] = await Promise.all([api(`/api/listings/${encodeURIComponent(lid)}?lang=${lang}`), api(`/api/listings/${encodeURIComponent(lid)}/availability?days=30`)]);
  if (id !== renderId) return;
  document.title = `${l.i18n[lang].title} | SilkRoad`;
  const days = open.filter((d) => d.times.some((x) => x.free > 0));
  let day = days[0], slot = day?.times.find((x) => x.free > 0), guests = Math.min(2, slot?.free ?? 1);
  const name = el("input", { maxlength: 80, autocomplete: "name", required: true, value: store.get("name") ?? "" });
  const dayRow = el("div.days", { role: "radiogroup", "aria-label": t("date") }), timeRow = el("div.times", { role: "radiogroup", "aria-label": t("time") });
  const out = el("output"), total = el("dd.all"), count = el("dt.all"), hostGets = el("dd");
  const less = el("button", { type: "button", "aria-label": t("fewer"), onclick: () => { guests--; draw(); } }, "−"), more = el("button", { type: "button", "aria-label": t("more"), onclick: () => { guests++; draw(); } }, "+");
  const submit = el("button.primary.wide", { type: "submit" }, t("book"));
  function draw() {
    guests = Math.max(1, Math.min(guests, slot.free));
    dayRow.replaceChildren(...days.map((d) => el("button", { type: "button", role: "radio", "aria-checked": String(d === day), tabindex: d === day ? 0 : -1, "aria-label": longDate(d.date), onclick: () => { day = d; slot = d.times.find((x) => x.time === slot.time && x.free > 0) ?? d.times.find((x) => x.free > 0); draw(); } },
      el("span", {}, fmt({ weekday: "short" }).format(asDate(d.date))), el("b", {}, String(+d.date.slice(8))), el("span", {}, fmt({ month: "short" }).format(asDate(d.date))))));
    timeRow.replaceChildren(...day.times.map((x) => el("button", { type: "button", role: "radio", "aria-checked": String(x === slot), tabindex: x === slot ? 0 : -1, disabled: !x.free, onclick: () => { slot = x; draw(); } }, x.time, el("span", {}, x.free ? `${x.free} ${t("left")}` : t("soldOut")))));
    out.textContent = guests;
    less.disabled = guests <= 1;
    more.disabled = guests >= slot.free;
    count.textContent = `${t("total")} (${guests} × ${money(l.price_uzs)})`;
    total.textContent = money(l.price_uzs * guests);
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
  const form = el("form.card.sticky", { id: "book", onsubmit: async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      store.set("name", name.value.trim());
      const b = await api("/api/bookings", { listing_id: l.id, date: day.date, time: slot.time, guests, guest_name: name.value, lang, hotel_code: hotel?.code });
      store.set("bookings", JSON.stringify([b.token, ...store.json("bookings", [])].slice(0, 30)));
      go({ b: b.token });
    } catch (err) {
      toast(why(err), true);
      submit.disabled = false;
      if (["full", "closed", "past"].includes(err.code)) render();
    }
  } },
  el("div.row.between", {}, el("span.price.big", {}, money(l.price_uzs), " ", el("small", {}, t("perPerson"))), rating(l)),
  days.length ? [el("div.stack", { style: "gap:6px" }, el("span.small.muted", {}, t("date")), dayRow), el("div.stack", { style: "gap:6px" }, el("span.small.muted", {}, t("time")), timeRow),
    el("div.stack", { style: "gap:6px" }, el("span.small.muted", {}, t("guests")), el("div.stepper", {}, less, out, more)), el("label", {}, t("name"), name), el("dl.sum", {}, count, total), submit, el("p.small.muted.row", {}, icon("check", 18), t("freeCancel"))]
    : el("p.note.warn", {}, t("noSlots")));
  if (days.length) draw();

  const share = el("button", { onclick: async () => {
    const url = `${location.origin}/?l=${l.id}`;
    try { if (navigator.share) return await navigator.share({ title: l.i18n[lang].title, url }); } catch (e) { if (e.name === "AbortError") return; }
    if (await copy(url)) toast(t("copied"));
  } }, icon("share", 20), t("share"));
  const fav = heart(l);
  fav.style.position = "static";
  const similar = el("section.stack", { style: "gap:18px" });
  const bar = days.length && el("div.buybar", {}, el("span.price", {}, money(l.price_uzs), " ", el("small", {}, t("perPerson"))), el("button.primary", { onclick: () => { form.scrollIntoView({ behavior: calm.matches ? "auto" : "smooth", block: "start" }); } }, t("book")));
  page(el("div.row.between", {}, back(), el("div.row", {}, share, fav)), gallery(l), el("div.two", {},
    el("div.stack", { style: "gap:26px" },
      el("div.stack", { style: "gap:14px" }, el("h1", {}, l.i18n[lang].title),
        el("ul.specs", {}, [["pin", placeOf(l)], ["clock", `${l.duration_min} ${t("minutes")}`], ["people", `${l.capacity} ${t("upTo")}`]].map(([i, v]) => el("li", {}, icon(i, 20), v)), l.reviews > 0 && el("li", {}, rating(l)))),
      el("div.who", {}, el("span.avatar", { "aria-hidden": "true" }, [...l.host][0].toUpperCase()), el("div", {}, el("b", {}, l.host), el("div.muted.small", {}, cfg.providerTypes[l.host_type][lang], l.hosted > 0 && ` · ${l.hosted} ${t("hosted")}`))),
      el("p", { style: "font-size:1.08rem;max-width:62ch" }, l.i18n[lang].description),
      el("ul.promise", {}, [["check", "freeCancel"], ["chart", "trustPrice"], ["globe", "trustTalk"]].map(([i, k]) => el("li", {}, icon(i, 26), t(k)))),
      l.reviewList.length > 0 && el("section.card", {}, el("h2", {}, t("reviews")), l.reviewList.map((r) => el("div.review", {}, el("div.row", {}, el("span.star", { "aria-label": `${r.rating} / 5` }, "★".repeat(r.rating)), el("b", {}, r.by), el("span.muted.small", {}, r.date)), r.text && el("p", { dir: "auto", lang: r.lang }, r.text))))),
    form), similar);
  if (bar) {
    app.append(bar);
    watch = new IntersectionObserver(([e]) => { e.isIntersecting ? bar.setAttribute("data-off", "") : bar.removeAttribute("data-off"); });
    watch.observe(form);
  }
  const rest = (await api("/api/listings?log=0").catch(() => [])).filter((x) => x.id !== l.id).map((x) => [x, (x.category === l.category) * 2 + (x.region === l.region)]).filter(([, s]) => s).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (id === renderId && rest.length) similar.replaceChildren(el("h2", {}, t("similar")), el("div.grid", {}, rest.map(([x]) => card(x))));
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
    const b = await api(`/api/bookings/${encodeURIComponent(token)}`);
    if (id !== renderId) return;
    const sig = JSON.stringify(b);
    if (sig === last && !force) return;
    // A poll must not wipe a half-finished date change or review.
    if (last && !force && app.querySelector(".movebox")) return;
    if (last && !force && b.can_review && document.activeElement?.closest?.("textarea, .stars")) return;
    last = sig;
    const focused = document.activeElement === draft, i = b.i18n[lang];
    const tone = { confirmed: ".ok", declined: ".bad", expired: ".bad", cancelled: ".bad", pending: ".warn" }[b.status] ?? "";
    const stage = { pending: 1, paid: 2, confirmed: 3 }[b.status] ?? 0;
    const send = (body) => run(async () => { await api(`/api/bookings/${b.token}/messages`, body()); draft.value = ""; await load(true); });
    const chatOpen = ["paid", "confirmed"].includes(b.status);
    document.title = `${i.title} | SilkRoad`;
    page(link({ my: 1 }, "a.back", {}, t("myBookings")), el("div.two", {},
      el("div.card", {}, el("h1", {}, i.title),
        stage > 0 && el("ol.track", {}, ["stepReserved", "stepPaid", "stepConfirmed"].map((k, n) => el("li" + (n < stage ? ".done" : ""), {}, t(k)))),
        el("div.note" + tone, { role: "status" }, t(b.status), b.expires_at && el("div.small", {}, `${t("holdUntil")} ${new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit" }).format(new Date(b.expires_at))}`)),
        el("dl.facts", {}, [[t("date"), longDate(b.date)], [t("time"), b.time], [t("guests"), String(b.guests)], [t("name"), b.guest_name], [t("where"), placeOf(b)]].map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v)))),
        el("dl.sum", {}, [[t("toHost"), b.host_uzs], ...(b.hotel ? [[b.hotel, b.hotel_uzs]] : []), ["SilkRoad", b.platform_uzs]].map(([k, v]) => [el("dt", {}, k), el("dd", {}, money(v))]), el("dt.all", {}, t("total")), el("dd.all", {}, money(b.total_uzs))),
        b.status === "pending" && cfg.testPayments && el("button.primary.wide", { onclick: run(async () => { await api(`/api/bookings/${b.token}/pay-test`, {}); await load(true); }) }, t("pay")),
        el("div.row", {},
          chatOpen && el("a.btn", { href: `/api/bookings/${b.token}/calendar.ics` }, icon("calendar", 20), t("calendar")),
          el("button", { onclick: async () => { if (await copy(`${location.origin}/?b=${b.token}`)) toast(t("copied")); } }, t("copyLink")),
          b.can_move && el("button", { onclick: run(async (e) => { const c = e.currentTarget.closest(".card"); app.querySelector(".movebox")?.remove(); c.after(await moveForm(b, () => load(true))); app.querySelector(".movebox")?.scrollIntoView({ block: "nearest" }); }) }, t("move")),
          b.can_cancel && el("button.danger", { onclick: run(async () => { if (!(await ask(t("cancelSure"), t("yes"), t("no")))) return; await api(`/api/bookings/${b.token}/cancel`, {}); await load(true); }) }, t("cancel"))),
        el("p.small.muted", {}, t("keepLink"))),
      el("div.stack", { style: "gap:24px" },
        b.ticket ? ticketCard(b) : b.status === "paid" && el("div.card", {}, el("h2", {}, t("ticket")), el("p.muted", {}, t("ticketWait"))),
        notifyCard(b),
        b.can_review && reviewForm(b, () => load(true)),
        b.my_rating && el("div.card", {}, el("p", {}, el("span.star", {}, "★".repeat(b.my_rating)), " ", t("thanks"))),
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
  if (id === renderId) poll = setInterval(() => { if (!document.hidden) load(false).catch(() => {}); }, 2500);
}

// ---- my bookings and saved --------------------------------------------------------------------
async function mine(id) {
  const tokens = store.json("bookings", []);
  const found = (await Promise.all(tokens.map((x) => api(`/api/bookings/${encodeURIComponent(x)}`).catch(() => null)))).filter(Boolean);
  if (id !== renderId) return;
  page(el("h1", {}, t("myBookings")), found.length
    ? el("div.grid", {}, found.map((b) => el("article.tile-l", {}, link({ b: b.token }, "a", {}, el("div.art", {}, visual({ ...b, id: b.listing_id }), el("span.badge" + ({ confirmed: ".ok", pending: ".warn", declined: ".bad", expired: ".bad", cancelled: ".bad" }[b.status] ?? ""), {}, t(b.status))),
      el("div.stack", { style: "gap:4px" }, el("h2.sm", {}, b.i18n[lang].title), el("div.meta", {}, `${longDate(b.date)}, ${b.time}`), el("span.price", {}, money(b.total_uzs)))))))
    : el("div.card.empty", {}, plate("bron", "bread"), el("p", {}, t("noBookings")), link({}, "a.btn.primary", {}, t("explore"))));
}
async function saved(id) {
  const all = (await api("/api/listings?log=0")).filter((l) => isFav(l.id));
  if (id !== renderId) return;
  page(el("h1", {}, t("saved")), all.length ? el("div.grid", {}, all.map((l) => card(l, "h2.sm"))) : el("div.card.empty", {}, plate("yurak", "embroidery"), el("p", {}, t("noSaved")), link({}, "a.btn.primary", {}, t("explore"))));
}

// ---- shell ------------------------------------------------------------------------------------
function chrome(q) {
  const here = q.has("my") || q.has("b") ? "my" : q.has("saved") ? "saved" : "explore";
  const items = [["explore", "search", {}], ["saved", "heart", { saved: 1 }], ["my", "ticket", { my: 1 }]];
  const label = { explore: "explore", saved: "saved", my: "myBookings" };
  const build = (size) => [...items.map(([k, i, p]) => link(p, "a", { "aria-current": k === here ? "page" : null }, icon(i, size), t(label[k]))), el("a", { href: "/mezbon" }, icon("user", size), t("forHosts"))];
  document.getElementById("nav").replaceChildren(...build(19));
  document.getElementById("bottom").replaceChildren(...build(23));
  document.getElementById("skip").textContent = t("skip");
  document.getElementById("foot").textContent = cfg.testPayments ? `${t("tagline")} ${t("testNote")}` : t("tagline");
  document.getElementById("prefs").replaceChildren(installButton(t("install")), themePicker({ theme: t("theme"), auto: t("auto"), light: t("light"), dark: t("dark") }), el("a.back", { href: "/panel" }, "Talab paneli"));
}

async function render() {
  const id = ++renderId;
  clearInterval(poll);
  watch?.disconnect();
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.title = `SilkRoad Experience OS: ${t("headline")}`;
  pick.value = lang;
  pick.setAttribute("aria-label", t("language"));
  const q = query();
  chrome(q);
  try {
    if (q.get("b") && q.has("ticket")) await ticketPage(id, q.get("b"));
    else if (q.get("b")) await bookingView(id, q.get("b"));
    else if (q.get("l")) await detail(id, q.get("l"));
    else if (q.has("my")) await mine(id);
    else if (q.has("saved")) await saved(id);
    else await catalog(id);
  } catch (e) {
    if (id !== renderId) return;
    if (!e.code) console.error(e);
    page(back(), el("div.note.bad", { role: "alert" }, why(e)));
  }
}
for (const ev of ["online", "offline"]) addEventListener(ev, () => { if (!app.querySelector("form :focus, .movebox")) render(); });
render();
