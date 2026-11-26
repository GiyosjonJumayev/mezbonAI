// The catalogue: results follow every keystroke, cards follow the real places. `ctx` carries the shared helpers of the traveller app.
import { GEO, api, el, plate, store, subscribe } from "/common.js";
import { art, icon } from "/art.js";

const KEYS = ["q", "region", "category", "date", "guests", "max"];
const PRICES = [100_000, 150_000, 200_000, 300_000, 500_000];
const WHOLE = 200; // up to this many offers the page filters by itself
const WALL = ["pottery", "ikat", "carpet", "cooking", "tour", "embroidery", "wood", "bread", "village", "metal", "ikat", "pottery"];

const when = (l) => (l.next ? `${l.next.date}T${l.next.time}` : "9");
const SORTS = {
  sortSoon: (a, b) => when(a).localeCompare(when(b)), sortNew: () => 0, sortCheap: (a, b) => cost(a) - cost(b),
  sortBest: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.reviews - a.reviews, sortShort: (a, b) => a.duration_min - b.duration_min,
};
const cost = (l) => l.next?.unit ?? l.price_uzs;
const fold = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[ʻʼ‘’'`]/g, "");

export async function explore(ctx, id) {
  const { t, cfg, lang, app, query, swap, link, card, money, regionName, today, addDays, dayName, alive, keep, hotel, offlineNote, calm } = ctx;
  const f = Object.fromEntries(KEYS.map((k) => [k, query().get(k) ?? ""]));
  if (f.date < today()) f.date = "";
  if (!(f.region in cfg.regions)) f.region = "";
  if (!(f.category in cfg.categories)) f.category = "";
  let list = [], base = [], whole = true, turn = 0, small = KEYS.some((k) => f[k]), order = "", sort = store.get("sort") in SORTS ? store.get("sort") : "sortSoon";
  let nodes = new Map(); // listing id → its card in the grid
  const rows = new Map(); // listing id → cards in the rows below
  const filtered = () => KEYS.some((k) => f[k]);

  // ---- what matches -------------------------------------------------------------------------
  const texts = new Map();
  const text = (l) => {
    if (!texts.has(l.id)) texts.set(l.id, fold([...Object.values(l.i18n).map((x) => x.title), l.host, l.place ?? "", ...Object.values(cfg.regionNames[l.region]), ...Object.values(cfg.categories[l.category])].join(" ")));
    return texts.get(l.id);
  };
  const match = (l, skip) => (skip === "region" || !f.region || l.region === f.region) && (skip === "category" || !f.category || l.category === f.category) && (!f.max || cost(l) <= Number(f.max))
    && fold(f.q).split(/\s+/).every((w) => text(l).includes(w));

  // ---- controls -----------------------------------------------------------------------------
  const pick = (k, label, any, opts, name) => el("label", {}, label, el("select", { name: k, onchange: (e) => set(k, e.target.value) }, el("option", { value: "" }, any), opts.map((o) => el("option", { value: o }, name(o)))));
  const later = (fn, ms) => { let timer; return (...a) => { clearTimeout(timer); timer = setTimeout(() => fn(...a), ms); }; };
  const form = el("form.finder", { role: "search", onsubmit: (e) => { e.preventDefault(); shrink(); results.scrollIntoView({ behavior: calm.matches ? "auto" : "smooth", block: "start" }); } },
    el("label", {}, t("search"), el("input", { type: "search", name: "q", maxlength: 60, autocomplete: "off", enterkeyhint: "search", placeholder: t("searchText"), oninput: (e) => set("q", e.target.value) })),
    pick("region", t("region"), t("allRegions"), Object.keys(cfg.regions), regionName),
    pick("category", t("activity"), t("allCats"), Object.keys(cfg.categories), (o) => cfg.categories[o][lang]),
    el("label", {}, t("date"), el("input", { type: "date", name: "date", min: today(), max: addDays(today(), 360), onchange: (e) => set("date", e.target.value) })),
    el("label", {}, t("guests"), el("input", { type: "number", name: "guests", min: 1, max: 100, inputmode: "numeric", placeholder: "2", oninput: (e) => set("guests", e.target.value) })),
    el("button.primary", { type: "submit" }, icon("search"), t("search")));
  const saturday = () => { for (let n = 0; n < 7; n++) { const d = addDays(today(), n), w = new Date(`${d}T00:00:00Z`).getUTCDay(); if (w === 6 || w === 0) return d; } };
  const quick = el("div.chips", { role: "group", "aria-label": t("date") }, [[today(), dayName(today())], [addDays(today(), 1), dayName(addDays(today(), 1))], [saturday(), t("weekend")]].filter(([d], i, all) => all.findIndex((x) => x[0] === d) === i)
    .map(([d, name]) => el("button", { type: "button", dataset: { d }, onclick: () => set("date", f.date === d ? "" : d) }, name)));
  const price = el("select", { name: "max", "aria-label": t("priceTo"), onchange: () => set("max", price.value) }, el("option", { value: "" }, t("anyPrice")), PRICES.map((n) => el("option", { value: n }, `≤ ${money(n)}`)));
  const rail = el("div.rail", { role: "group", "aria-label": t("activity") }, Object.keys(cfg.categories).map((c) => el("button", { type: "button", dataset: { c }, onclick: () => set("category", f.category === c ? "" : c) }, icon(c, 28), el("span", {}, cfg.categories[c][lang]), el("small"))));
  const sorter = el("select", { "aria-label": t("sort"), onchange: () => { sort = sorter.value; store.set("sort", sort); paint(); } }, Object.keys(SORTS).map((s) => el("option", { value: s, selected: s === sort }, t(s))));
  const liveBadge = el("span.live", { hidden: true }, el("i"), t("liveOn"));
  const count = el("h2"), clear = el("button.ghost", { type: "button", onclick: () => { for (const k of KEYS) f[k] = ""; write(); sync(); refresh(); } }, t("clear"));
  const grid = el("div.grid"), empty = el("div");
  const results = el("section.stack", { style: "gap:22px" }, el("div.toolbar", {}, el("div.row", { role: "status" }, count, liveBadge), el("div.row", {}, clear, sorter)), el("div.grid", { "aria-hidden": "true" }, Array.from({ length: 6 }, () => el("div.stack", {}, el("div.skeleton", { style: "aspect-ratio:4/3" }), el("div.skeleton.line"), el("div.skeleton.line", { style: "width:60%" })))));
  const below = el("div.stack", { style: "gap:clamp(40px,7vw,84px)" });
  const wall = el("div.wall", { "aria-hidden": "true" }, [0, 1, 2].map((c) => el("div", {}, [0, 1, 2, 3].map((r) => art(`hero${c}${r}`, WALL[(c * 4 + r) % WALL.length])))));
  const hero = el("section.hero", { onpointermove: (e) => { // the wall leans a little towards the pointer
    if (small || calm.matches || e.pointerType !== "mouse") return;
    const r = hero.getBoundingClientRect();
    wall.style.setProperty("--mx", ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
    wall.style.setProperty("--my", ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
  } }, wall, el("div.wrap", {}, el("div.say", {}, el("h1", {}, t("headline")), el("p", {}, t("heart"), " ", t("sub")), hotel && el("p.small", {}, `${t("via")} ${hotel.name}`)), form, el("div.quick", {}, quick, price, link({ plan: 1 }, "a.btn.onhero", {}, icon("route", 20), t("trip")))));

  const sync = () => {
    for (const k of ["q", "region", "category", "date", "guests"]) if (form.elements[k].value !== f[k]) form.elements[k].value = f[k];
    price.value = PRICES.includes(Number(f.max)) ? f.max : "";
    for (const b of quick.children) b.setAttribute("aria-pressed", String(b.dataset.d === f.date));
    hero.toggleAttribute("data-small", small);
  };
  const write = () => { const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString(); history.replaceState(null, "", q ? `/?${q}` : "/"); };
  function shrink() { if (!small) { small = true; swap(sync); } }
  const refreshSoon = later(() => refresh(), 220);
  /** Only a search that names a region or an activity says something about demand. The answer is not needed. */
  const tell = later(() => { if ((f.region || f.category) && alive(id)) api("/api/listings?" + new URLSearchParams({ region: f.region, category: f.category, date: f.date, guests: f.guests, lang })).catch(() => {}); }, 700);
  function set(k, v) {
    f[k] = v;
    write();
    if (!small && v) { small = true; swap(sync); scrollTo(0, 0); } else sync();
    if (["region", "category", "date"].includes(k)) tell();
    if (["date", "guests"].includes(k) || (!whole && ["region", "category"].includes(k))) refreshSoon(); else paint();
  }

  // ---- results ------------------------------------------------------------------------------
  async function refresh() {
    const mine = ++turn, ask = new URLSearchParams({ date: f.date, guests: f.guests, ...(!whole && { region: f.region, category: f.category }) });
    grid.toggleAttribute("aria-busy", true);
    try {
      const got = await api(`/api/listings?log=0&${ask}`);
      const all = f.date || f.guests ? (base.length ? base : await api("/api/listings?log=0")) : got;
      if (mine !== turn || !alive(id)) return;
      list = got;
      base = all;
      whole = base.length < WHOLE;
      nodes = new Map();
      order = "";
      paint();
      if (!below.firstChild) more();
    } finally { grid.removeAttribute("aria-busy"); }
  }
  function paint() {
    const now = list.filter((l) => match(l)).sort(SORTS[sort]);
    count.textContent = `${now.length} ${t("results")}`;
    clear.hidden = !filtered();
    sorter.hidden = now.length < 2;
    below.hidden = filtered();
    const tally = (k) => { const n = {}; for (const l of list) if (match(l, k)) n[l[k]] = (n[l[k]] ?? 0) + 1; return n; };
    const byCategory = tally("category"), byRegion = tally("region");
    for (const b of rail.children) { const n = byCategory[b.dataset.c] ?? 0; b.setAttribute("aria-pressed", String(f.category === b.dataset.c)); b.classList.toggle("none", !n); b.lastChild.textContent = n; }
    for (const b of below.querySelectorAll("[data-r]")) b.querySelector("b").textContent = byRegion[b.dataset.r] ?? 0;
    if (grid.parentNode !== results) { results.replaceChildren(results.firstChild, grid, empty); const note = offlineNote(); if (note) results.prepend(note); }
    const ids = now.map((l) => l.id).join();
    if (ids !== order) {
      const was = new Map([...nodes].filter(([, n]) => n.isConnected).map(([k, n]) => [k, n.getBoundingClientRect()]));
      const cards = now.map((l) => { if (!nodes.has(l.id)) nodes.set(l.id, card(l, "h3", { date: f.date, g: f.guests })); return nodes.get(l.id); });
      grid.replaceChildren(...cards);
      if (!calm.matches && !document.hidden && order) now.slice(0, 40).forEach((l, i) => { // cards slide to their new place
        const a = was.get(l.id), b = cards[i].getBoundingClientRect();
        if (!a) cards[i].animate([{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "ease-out" });
        else if (a.left !== b.left || a.top !== b.top) cards[i].animate([{ transform: `translate(${a.left - b.left}px,${a.top - b.top}px)` }, { transform: "none" }], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
      });
      order = ids || "-";
    }
    grid.hidden = !now.length;
    empty.replaceChildren(...(now.length ? [] : [el("div.card.empty", {}, plate("bosh", "village"), el("p", {}, filtered() ? t("noDate") : t("empty")), days(), filtered() && el("button", { onclick: () => clear.click() }, t("clear")))]));
  }
  /** When the chosen day is full, the nearest days that are not. */
  function days() {
    const near = f.date ? [...new Set(base.filter((l) => match(l) && l.next).map((l) => l.next.date))].sort().slice(0, 4) : [];
    return near.length > 0 && el("div.stack", { style: "justify-items:center" }, el("p.muted", {}, t("tryDay")), el("div.chips", {}, near.map((d) => el("button", { onclick: () => set("date", d) }, dayName(d)))));
  }

  // ---- below the results ----------------------------------------------------------------------
  function strip(title, items) {
    const cards = items.map((l) => { const c = card(l, "h3"); rows.set(l.id, [...(rows.get(l.id) ?? []), c]); return c; });
    return items.length > 0 && el("section.stack.reveal", { style: "gap:18px" }, el("h2", {}, title), el("div.strip", { tabindex: 0, role: "group", "aria-label": title }, cards));
  }
  function more() {
    const limit = addDays(today(), 1), soon = base.filter((l) => l.next && l.next.date <= limit).sort(SORTS.sortSoon), seen = store.json("recent", []).map((x) => base.find((l) => l.id === x)).filter(Boolean).slice(0, 8);
    below.replaceChildren(...[strip(t("recent"), seen), soon.length > 2 && soon.length < base.length && strip(t("soonTitle"), soon.slice(0, 10)),
      el("section.stack.reveal", { style: "gap:18px" }, el("div", {}, el("h2", {}, t("mapTitle")), el("p.muted.small", {}, t("mapNote"))),
        el("ul.tilemap.geo", {}, Object.keys(GEO).map((r) => { const n = base.filter((l) => l.region === r).length; return el("li", { style: `--c:${GEO[r][0]};--r:${GEO[r][1]}` }, el("button" + (n ? "" : ".none"), { type: "button", dataset: { r }, onclick: () => { set("region", r); scrollTo(0, 0); }, style: n ? `background:color-mix(in srgb, var(--turq) ${8 + Math.min(4, n) * 6}%, var(--card))` : null }, regionName(r), el("b", {}, String(n)))); }))),
      el("section.stack.reveal", { style: "gap:22px" }, el("h2", {}, t("howTitle")), el("ol.steps", {}, ["how1", "how2", "how3"].map((k) => el("li", {}, t(k)))),
        el("ul.promise", {}, [["check", "freeCancel"], ["chart", "trustPrice"], ["globe", "trustTalk"], ["ticket", "ticketHint"]].map(([i, k]) => el("li", {}, icon(i, 28), t(k))))),
      el("section.join.reveal", {}, art("join", "ikat"), el("h2", {}, t("becomeHost")), el("p", {}, t("becomeText")), el("a.btn", { href: "/mezbon" }, t("forHosts")))].filter(Boolean));
  }

  // ---- live -----------------------------------------------------------------------------------
  let waiting = new Set();
  const update = later(async () => {
    const ids = [...waiting].slice(0, 60);
    waiting = new Set();
    if (!ids.length || !alive(id)) return;
    const next = await api("/api/next?" + new URLSearchParams({ ids, date: f.date, guests: f.guests })).catch(() => null);
    if (!next || !alive(id)) return;
    const own = f.date || f.guests ? [] : base; // the plain list is about any day and any size of group
    for (const l of [...list, ...own]) if (l.id in next) l.next = next[l.id];
    for (const i of ids) for (const c of [nodes.get(i), ...(own.length ? rows.get(i) ?? [] : [])]) if (c && i in next) c.refresh({ ...base.find((l) => l.id === i), next: next[i] });
  }, 350);
  const again = later(() => { if (alive(id)) { base = f.date || f.guests ? [] : base; refresh().then(() => { if (alive(id) && !below.contains(document.activeElement)) { rows.clear(); more(); } }).catch(() => {}); } }, 900);
  keep(subscribe("/api/live", (ev) => {
    if (ev.t === "hello") liveBadge.hidden = false;
    else if (ev.t === "slots") { for (const x of ev.ids) if (base.some((l) => l.id === x)) waiting.add(x); if (waiting.size) update(); }
    else if (ev.t === "catalog" || ev.t === "back") again();
  }));

  sync();
  app.replaceChildren(hero, el("div.wrap", { style: "padding-block-start:28px;gap:30px" }, rail, results, below));
  count.textContent = "…";
  clear.hidden = sorter.hidden = true;
  if (f.region || f.category) tell();
  await refresh();
}
