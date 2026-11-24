import { act, api, ask, copy, el, plate, store, tint, toast, uzs, visual } from "/common.js";

const app = document.getElementById("app");
const query = () => new URLSearchParams(location.search);
let cfg;
try { cfg = await api("/api/config"); } catch (e) {
  app.replaceChildren(el("div.wrap", {}, el("div.note.bad", { role: "alert" }, e.message), el("button", { onclick: () => location.reload() }, "↻")));
  throw e;
}
let lang = [query().get("lang"), store.get("lang"), ...(navigator.languages ?? []).map((l) => l.slice(0, 2))].find((l) => cfg.langs.includes(l)) ?? "en";
let poll, renderId = 0;
const t = (k) => cfg.ui[k][lang];
const money = (n) => uzs(n, lang, cfg.usdRate);
const why = (e) => (cfg.ui[`e_${e.code}`] ?? cfg.ui.e_other)[lang];
const run = (fn) => act(fn, why);
const regionName = (r) => cfg.regionNames[r][lang];
// Uzbek has no Intl month data in some browsers, so fall back to numbers.
const fmt = (o) => { try { return new Intl.DateTimeFormat(lang, { timeZone: "UTC", ...o }); } catch { return new Intl.DateTimeFormat("en", { timeZone: "UTC", ...o }); } };
const asDate = (d) => new Date(`${d}T00:00:00Z`);
const longDate = (d) => fmt({ weekday: "long", day: "numeric", month: "long" }).format(asDate(d));
const today = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10); // Tashkent
const placeOf = (l) => (l.place && l.place !== cfg.regions[l.region] ? `${l.place}, ${regionName(l.region)}` : regionName(l.region));
const star = () => el("span.star", { "aria-hidden": "true" }, "★");
const rating = (l) => l.reviews > 0 && el("span.rating", { "aria-label": `${l.rating} / 5, ${t("reviews")}: ${l.reviews}` }, star(), ` ${l.rating} (${l.reviews})`);

// A hotel QR code sets the referrer for this browser tab only.
let hotel = null;
const session = { get: () => { try { return sessionStorage.getItem("mezbon.h"); } catch { return null; } }, set: (v) => { try { v ? sessionStorage.setItem("mezbon.h", v) : sessionStorage.removeItem("mezbon.h"); } catch {} } };
const code = query().get("h") ?? session.get();
if (code) try { hotel = await api(`/api/hotels/${encodeURIComponent(code)}`); session.set(code); } catch { session.set(null); }

const pick = document.getElementById("lang");
pick.append(...cfg.langs.map((l) => el("option", { value: l }, cfg.langNames[l])));
pick.onchange = () => { lang = pick.value; store.set("lang", lang); render(); };

function go(params, focus = true) {
  const q = new URLSearchParams(params).toString();
  history.pushState(null, "", q ? `/?${q}` : "/");
  render().then(() => { if (focus) { scrollTo(0, 0); app.focus({ preventScroll: true }); } });
}
addEventListener("popstate", render);
const link = (params, spec, props, ...kids) => el(spec, { ...props, href: "/?" + new URLSearchParams(params), onclick: (e) => { if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return; e.preventDefault(); go(params); } }, ...kids);
const page = (...kids) => app.replaceChildren(el("div.wrap", {}, ...kids));
const back = () => el("div", {}, link({}, "a", {}, t("back")));

// ---- catalogue ------------------------------------------------------------------------------
async function catalog(id) {
  const f = Object.fromEntries(["region", "category", "date", "guests"].map((k) => [k, query().get(k) ?? ""]));
  const list = await api("/api/listings?" + new URLSearchParams({ ...f, lang }));
  if (id !== renderId) return;
  const filtered = Object.values(f).some(Boolean);
  const sel = (k, label, any, opts, name) => el("label", {}, label, el("select", { name: k }, el("option", { value: "" }, any), Object.keys(opts).map((o) => el("option", { value: o, selected: o === f[k] }, name(o)))));
  const form = el("form.finder", { role: "search", onsubmit: (e) => { e.preventDefault(); go(Object.fromEntries([...new FormData(form)].filter(([, v]) => v)), false); } },
    sel("region", t("region"), t("allRegions"), cfg.regions, regionName),
    sel("category", t("activity"), t("allCats"), cfg.categories, (o) => cfg.categories[o][lang]),
    el("label", {}, t("date"), el("input", { type: "date", name: "date", min: today(), value: f.date })),
    el("label", {}, t("guests"), el("input", { type: "number", name: "guests", min: 1, max: 100, inputmode: "numeric", value: f.guests, placeholder: "2" })),
    el("button.primary", { type: "submit" }, t("search")));
  app.replaceChildren(
    el("section.hero", {}, el("div.plates", {}, plate("rishton", "pottery"), plate("gijduvon", "cooking"), plate("margilon", "ikat")),
      el("div.wrap", {}, el("div.say", {}, el("h1", {}, t("headline")), el("p", {}, t("sub")), hotel && el("p.small", {}, `${t("via")} ${hotel.name}`)), form)),
    el("div.wrap", { style: "padding-block-start:28px" },
      filtered && el("div.row.between", {}, el("p.muted", { role: "status" }, `${list.length}`), el("button.ghost", { onclick: () => go({}, false) }, t("clear"))),
      list.length
        ? el("div.grid", {}, list.map((l) => link({ l: l.id }, "a.item", {}, el("div.art", { style: tint(l.category) }, visual(l), l.demo && el("span.badge.warn", {}, t("sample"))),
          el("div.in", {}, el("h3", {}, l.i18n[lang].title), el("p.muted.small", {}, `${regionName(l.region)} · ${l.duration_min} ${t("minutes")} · ${l.capacity} ${t("upTo")}`),
            el("div.foot", {}, el("span.price", {}, money(l.price_uzs), " ", el("small", {}, t("perPerson"))), rating(l))))))
        : el("div.card.empty", {}, plate("bosh", "village"), el("p", {}, f.date || f.guests ? t("noDate") : t("empty")), filtered && el("button", { onclick: () => go({}, false) }, t("clear"))),
      el("section.stack", { style: "margin-block-start:20px" }, el("h2", {}, t("howTitle")), el("ol.steps", {}, ["how1", "how2", "how3"].map((k) => el("li", {}, t(k)))))),
  );
}

// ---- listing --------------------------------------------------------------------------------
async function detail(id, lid) {
  const [l, open] = await Promise.all([api(`/api/listings/${encodeURIComponent(lid)}?lang=${lang}`), api(`/api/listings/${encodeURIComponent(lid)}/availability?days=30`)]);
  if (id !== renderId) return;
  document.title = `${l.i18n[lang].title} | SilkRoad`;
  const days = open.filter((d) => d.times.some((x) => x.free > 0));
  let day = days[0], slot = day?.times.find((x) => x.free > 0), guests = Math.min(2, slot?.free ?? 1);

  const name = el("input", { maxlength: 80, autocomplete: "name", required: true, value: store.get("name") ?? "" });
  const dayRow = el("div.days", { role: "radiogroup", "aria-label": t("date") });
  const timeRow = el("div.times", { role: "radiogroup", "aria-label": t("time") });
  const out = el("output"), total = el("dd.all"), count = el("dt.all");
  const less = el("button", { type: "button", "aria-label": t("fewer"), onclick: () => { guests--; draw(); } }, "−");
  const more = el("button", { type: "button", "aria-label": t("more"), onclick: () => { guests++; draw(); } }, "+");
  const submit = el("button.primary.wide", { type: "submit" }, t("book"));
  function draw() {
    guests = Math.max(1, Math.min(guests, slot.free));
    dayRow.replaceChildren(...days.map((d) => el("button", { type: "button", role: "radio", "aria-checked": String(d === day), "aria-label": longDate(d.date), onclick: () => { day = d; slot = d.times.find((x) => x.time === slot.time && x.free > 0) ?? d.times.find((x) => x.free > 0); draw(); } },
      el("span", {}, fmt({ weekday: "short" }).format(asDate(d.date))), el("b", {}, String(+d.date.slice(8))), el("span", {}, fmt({ month: "short" }).format(asDate(d.date))))));
    timeRow.replaceChildren(...day.times.map((x) => el("button", { type: "button", role: "radio", "aria-checked": String(x === slot), disabled: !x.free, onclick: () => { slot = x; draw(); } }, x.time, el("span", {}, x.free ? `${x.free} ${t("left")}` : t("soldOut")))));
    out.textContent = guests;
    less.disabled = guests <= 1;
    more.disabled = guests >= slot.free;
    count.textContent = `${t("total")} (${guests} × ${money(l.price_uzs)})`;
    total.textContent = money(l.price_uzs * guests);
  }
  // Redrawing replaces the focused chip; put focus back on the chosen one.
  for (const r of [dayRow, timeRow]) r.addEventListener("click", () => r.querySelector('[aria-checked="true"]')?.focus());

  const form = el("form.card.sticky", { onsubmit: async (e) => {
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
    el("div.stack", { style: "gap:6px" }, el("span.small.muted", {}, t("guests")), el("div.stepper", {}, less, out, more)), el("label", {}, t("name"), name), el("dl.sum", {}, count, total), submit, el("p.small.muted", {}, t("freeCancel"))]
    : el("p.note.warn", {}, t("noSlots")));
  if (days.length) draw();

  page(back(), el("div.two", {},
    el("div.stack", { style: "gap:22px" },
      el("div.card", {}, el("div.art", { style: tint(l.category) }, visual(l, l.i18n[lang].title), l.demo && el("span.badge.warn", {}, t("sample"))), el("h1", {}, l.i18n[lang].title), el("p", {}, l.i18n[lang].description),
        el("dl.facts", {}, [[t("host"), `${l.host}, ${cfg.providerTypes[l.host_type][lang].toLocaleLowerCase(lang)}`], [t("where"), placeOf(l)], [t("duration"), `${l.duration_min} ${t("minutes")}`], [t("group"), `${l.capacity} ${t("upTo")}`]].map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v))))),
      l.reviewList.length > 0 && el("section.card", {}, el("h2", {}, t("reviews")), l.reviewList.map((r) => el("div.review", {}, el("div.row", {}, el("span.star", { "aria-label": `${r.rating} / 5` }, "★".repeat(r.rating)), el("b", {}, r.by), el("span.muted.small", {}, r.date)), r.text && el("p", { dir: "auto", lang: r.lang }, r.text))))),
    form));
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

const ticketLink = (code) => `${location.origin}/mezbon#chipta/${code}`;
const ticketText = (code) => code.replace(/(.{4})(?=.)/g, "$1-");
const ticketQr = (code) => el("img.qr", { src: `/api/qr.svg?text=${encodeURIComponent(ticketLink(code))}`, alt: `${t("ticket")} ${ticketText(code)}` });

function ticketCard(b) {
  if (b.ticket.used_at) return el("section.card", {}, el("h2", {}, t("ticket")), el("div.note.ok", { role: "status" }, t("ticketUsed")));
  return el("section.card.ticket", {}, el("h2", {}, t("ticket")), ticketQr(b.ticket.code), el("b.code", { dir: "ltr" }, ticketText(b.ticket.code)), el("p.muted.small", {}, t("ticketHint")), link({ b: b.token, ticket: 1 }, "a.btn", {}, t("printTicket")));
}

/** A single sheet to print or screenshot. */
async function ticketPage(id, token) {
  const b = await api(`/api/bookings/${encodeURIComponent(token)}`);
  if (id !== renderId) return;
  if (!b.ticket) return go({ b: token });
  page(el("div.noprint", {}, link({ b: token }, "a", {}, b.i18n[lang].title)), el("section.card.ticket.sheet", {}, el("p.muted", {}, "SilkRoad Experience OS"), el("h1", {}, b.i18n[lang].title), ticketQr(b.ticket.code), el("b.code", { dir: "ltr" }, ticketText(b.ticket.code)),
    el("dl.facts", {}, [[t("date"), longDate(b.date)], [t("time"), b.time], [t("guests"), String(b.guests)], [t("name"), b.guest_name], [t("where"), placeOf(b)]].map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v)))),
    b.ticket.used_at ? el("div.note.ok", {}, t("ticketUsed")) : el("p.muted", {}, t("ticketHint"))), el("button.primary.noprint", { style: "justify-self:center", onclick: () => print() }, t("printTicket")));
}

async function bookingView(id, token) {
  let last = "";
  const draft = el("input", { maxlength: 1000, "aria-label": t("ask"), placeholder: t("ask"), required: true });
  const load = async () => {
    const b = await api(`/api/bookings/${encodeURIComponent(token)}`);
    if (id !== renderId) return;
    const sig = JSON.stringify(b);
    if (sig === last) return;
    // A poll must not wipe a half-written review.
    if (last && app.querySelector(".stars") && b.can_review && document.activeElement?.closest?.("textarea, .stars")) return;
    last = sig;
    const focused = document.activeElement === draft, i = b.i18n[lang];
    const tone = { confirmed: ".ok", declined: ".bad", expired: ".bad", cancelled: ".bad", pending: ".warn" }[b.status] ?? "";
    const stage = { pending: 1, paid: 2, confirmed: 3 }[b.status] ?? 0;
    const send = (body) => run(async () => { await api(`/api/bookings/${b.token}/messages`, body()); draft.value = ""; await load(); });
    const chatOpen = ["paid", "confirmed"].includes(b.status);
    document.title = `${i.title} | SilkRoad`;
    page(link({ my: 1 }, "a", {}, t("myBookings")), el("div.two", {},
      el("div.card", {}, el("h1", {}, i.title),
        stage > 0 && el("ol.track", {}, ["stepReserved", "stepPaid", "stepConfirmed"].map((k, n) => el("li" + (n < stage ? ".done" : ""), {}, t(k)))),
        el("div.note" + tone, { role: "status" }, t(b.status), b.expires_at && el("div.small", {}, `${t("holdUntil")} ${new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit" }).format(new Date(b.expires_at))}`)),
        el("dl.facts", {}, [[t("date"), longDate(b.date)], [t("time"), b.time], [t("guests"), String(b.guests)], [t("name"), b.guest_name], [t("where"), placeOf(b)]].map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v)))),
        el("dl.sum", {}, [[t("toHost"), b.host_uzs], ...(b.hotel ? [[b.hotel, b.hotel_uzs]] : []), ["SilkRoad", b.platform_uzs]].map(([k, v]) => [el("dt", {}, k), el("dd", {}, money(v))]), el("dt.all", {}, t("total")), el("dd.all", {}, money(b.total_uzs))),
        b.status === "pending" && cfg.testPayments && el("button.primary.wide", { onclick: run(async () => { await api(`/api/bookings/${b.token}/pay-test`, {}); await load(); }) }, t("pay")),
        el("div.row", {},
          chatOpen && el("a.btn", { href: `/api/bookings/${b.token}/calendar.ics` }, t("calendar")),
          el("button", { onclick: async () => { if (await copy(`${location.origin}/?b=${b.token}`)) toast(t("copied")); } }, t("copyLink")),
          b.can_cancel && el("button.danger", { onclick: run(async () => { if (!(await ask(t("cancelSure"), t("yes"), t("no")))) return; await api(`/api/bookings/${b.token}/cancel`, {}); await load(); }) }, t("cancel"))),
        el("p.small.muted", {}, t("keepLink"))),
      el("div.stack", { style: "gap:24px" },
        b.ticket ? ticketCard(b) : b.status === "paid" && el("div.card", {}, el("h2", {}, t("ticket")), el("p.muted", {}, t("ticketWait"))),
        b.can_review && reviewForm(b, load),
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
  await load();
  if (id === renderId) poll = setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 2500);
}

// ---- my bookings ----------------------------------------------------------------------------
async function mine(id) {
  const tokens = store.json("bookings", []);
  const found = (await Promise.all(tokens.map((x) => api(`/api/bookings/${encodeURIComponent(x)}`).catch(() => null)))).filter(Boolean);
  if (id !== renderId) return;
  page(back(), el("h1", {}, t("myBookings")), found.length
    ? el("div.grid.wide", {}, found.map((b) => link({ b: b.token }, "a.item", { style: "grid-template-rows:1fr" }, el("div.in", {}, el("h3", {}, b.i18n[lang].title), el("p.muted", {}, `${longDate(b.date)}, ${b.time}`),
      el("div.foot", {}, el("span.badge" + ({ confirmed: ".ok", pending: ".warn", declined: ".bad", expired: ".bad", cancelled: ".bad" }[b.status] ?? ""), {}, t(b.status)), el("span.price", {}, money(b.total_uzs)))))))
    : el("div.card.empty", {}, plate("bron", "bread"), el("p", {}, t("noBookings")), link({}, "a.btn.primary", {}, t("back"))));
}

async function render() {
  const id = ++renderId;
  clearInterval(poll);
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.title = `SilkRoad Experience OS: ${t("headline")}`;
  pick.value = lang;
  pick.setAttribute("aria-label", t("language"));
  document.getElementById("skip").textContent = t("skip");
  document.getElementById("foot").textContent = cfg.testPayments ? `${t("tagline")} ${t("testNote")}` : t("tagline");
  const q = query();
  document.getElementById("nav").replaceChildren(link({ my: 1 }, "a", { "aria-current": q.has("my") ? "page" : null }, t("myBookings")), el("a", { href: "/mezbon" }, t("forHosts")));
  try {
    if (q.get("b") && q.has("ticket")) await ticketPage(id, q.get("b"));
    else if (q.get("b")) await bookingView(id, q.get("b"));
    else if (q.get("l")) await detail(id, q.get("l"));
    else if (q.has("my")) await mine(id);
    else await catalog(id);
  } catch (e) {
    if (id !== renderId) return;
    if (!e.code) console.error(e);
    page(back(), el("div.note.bad", { role: "alert" }, why(e)));
  }
}
render();
