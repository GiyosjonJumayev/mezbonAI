// Trip planner and trip page. `ctx` carries the shared helpers of the traveller app.
import { api, el, store, toast, visual } from "/common.js";
import { icon } from "/art.js";

/** Remembers the form while the traveller looks at one experience and comes back. */
let form = null, plan = null, skip = [], read = "";
let touched = null;
/** Fields filled in from the traveller's own words; they give way when the words change. */
const auto = new Set();

export function planner(ctx, id) {
  const { t, cfg, lang, run, money, longDate, regionName, placeOf, link, page, back, alive, go, why, hotel, addDays, today } = ctx;
  form ??= { from: addDays(today(), 3), days: 3, guests: 2, pace: "full", budget: "", wish: "", regions: new Set(), interests: new Set() };
  touched ??= new Set();
  const out = el("div.stack", { style: "gap:26px", "aria-live": "polite" });
  const chips = (k, label, set, opts, name, pic) => el("div.stack", { style: "gap:8px" }, el("span.small.muted", {}, label), el("div.chips", { role: "group", "aria-label": label }, opts.map((o) => el("button", { type: "button", "aria-pressed": String(set.has(o)), onclick: (e) => { auto.delete(k); set.has(o) ? set.delete(o) : set.add(o); e.currentTarget.setAttribute("aria-pressed", String(set.has(o))); } }, pic && icon(o, 18), name(o)))));
  const field = (k, props) => { const i = el("input", { ...props, value: form[k], oninput: () => { form[k] = i.value; auto.delete(k); touched.add(k); } }); return i; };
  const pace = el("select", { onchange: () => { form.pace = pace.value; auto.delete("pace"); touched.add("pace"); } }, el("option", { value: "full" }, t("paceFull")), el("option", { value: "calm" }, t("paceCalm")));
  pace.value = form.pace;
  const wish = el("textarea", { maxlength: 600, rows: 2, oninput: () => { form.wish = wish.value; } });
  wish.value = form.wish;

  const build = run(async () => {
    const words = form.wish.trim(), fresh = words !== read;
    // A field the traveller did not touch does not overrule what they wrote.
    const own = (k) => !words || (fresh ? touched.has(k) && !auto.has(k) : true), num = (k) => (own(k) ? Number(form[k]) || null : null), list = (k) => (fresh && auto.has(k) ? [] : [...form[k]]);
    out.replaceChildren(el("div.skeleton", { style: "height:180px" }));
    try {
      plan = await api("/api/trips/plan", { from: form.from, days: num("days"), guests: num("guests"), pace: own("pace") ? form.pace : null, budget: num("budget"), wish: fresh ? words : "", regions: list("regions"), interests: list("interests"), skip });
    } catch (e) { out.replaceChildren(); throw e; }
    if (words && fresh) { // show what was understood, so it can be corrected
      const a = plan.asked;
      for (const [k, v] of [["days", a.days], ["guests", a.guests], ["pace", a.perDay === 1 ? "calm" : "full"], ["budget", a.budget ?? ""]]) if (String(form[k]) !== String(v)) { form[k] = v; auto.add(k); }
      for (const k of ["regions", "interests"]) { const set = new Set(a[k]); if (set.size) { if (set.size !== form[k].size || a[k].some((x) => !form[k].has(x))) auto.add(k); form[k] = set; } else if (auto.has(k)) form[k] = new Set(); }
      read = words;
      if (alive(id)) planner(ctx, id);
    } else if (alive(id)) show();
    out.isConnected || document.querySelector(".route")?.scrollIntoView({ block: "start" });
  });
  function show() {
    const count = plan.days.reduce((s, d) => s + d.items.length, 0);
    if (!count) return out.replaceChildren(el("div.note.warn", { role: "status" }, t("tripNone")));
    const name = el("input", { maxlength: 80, autocomplete: "name", required: true, value: store.get("name") ?? "" });
    const total = plan.days.flatMap((d) => d.items).reduce((s, x) => s + x.price_uzs, 0) * plan.asked.guests;
    let before = null;
    out.replaceChildren(
      el("ol.route", {}, plan.days.map((d, n) => {
        const moved = before && before !== d.region;
        before = d.region;
        return el("li", {}, el("div.row.between", {}, el("h2", {}, `${lang === "zh" ? `第${n + 1}天` : lang === "ko" || lang === "ja" ? `${n + 1}${t("tripDay")}` : `${t("tripDay")} ${n + 1}`}`), el("span.muted", {}, `${longDate(d.date)} · ${regionName(d.region)}`)),
          moved && el("p.small.travel", {}, icon("route", 18), `${t("tripMove")} ${regionName(d.region)}`),
          d.items.length ? d.items.map((x) => el("article.stop", {}, el("div.art", {}, visual({ ...x, id: x.listing_id }), x.demo && el("span.badge", {}, t("sample"))),
            el("div.stack", { style: "gap:5px" }, el("b", { dir: "ltr", style: "justify-self:start" }, x.time), el("h3", {}, x.i18n[lang].title), el("p.small.muted", {}, `${x.host} · ${placeOf(x)} · ${x.duration_min} ${t("minutes")}`), el("span.price", {}, money(x.price_uzs), " ", el("small", {}, t("perPerson"))),
              el("div.row", {}, link({ l: x.listing_id }, "a", {}, t("open")), x.more && el("button.ghost.mini.text", { type: "button", "aria-label": `${t("swap")}: ${x.i18n[lang].title}`, onclick: (e) => { skip = [...skip, x.listing_id]; build(e); } }, t("swap")),
                el("button.ghost.mini.text", { type: "button", "aria-label": `${t("remove")}: ${x.i18n[lang].title}`, onclick: () => { d.items = d.items.filter((y) => y !== x); show(); } }, t("remove"))))))
            : el("p.muted", {}, t("tripFree")));
      })),
      el("form.card", { onsubmit: (e) => { e.preventDefault(); reserve({ currentTarget: e.submitter }); } }, el("dl.sum", {}, el("dt.all", {}, `${t("total")} (${count} × ${plan.asked.guests})`), el("dd.all", {}, money(total))), el("label", {}, t("name"), name), el("button.primary.wide", { type: "submit" }, t("tripHold")), el("p.small.muted", {}, t("tripAll"))));
    const reserve = run(async () => {
      store.set("name", name.value.trim());
      try {
        const trip = await api("/api/trips", { guests: plan.asked.guests, guest_name: name.value, lang, hotel_code: hotel?.code, items: plan.days.flatMap((d) => d.items.map((x) => ({ listing_id: x.listing_id, date: d.date, time: x.time }))) });
        store.set("trips", JSON.stringify([trip.token, ...store.json("trips", [])].slice(0, 10)));
        store.set("bookings", JSON.stringify([...trip.bookings.map((b) => b.token), ...store.json("bookings", [])].slice(0, 40)));
        plan = null;
        skip = [];
        go({ trip: trip.token });
      } catch (e) {
        if (!["full", "closed", "past", "notfound"].includes(e.code)) throw e;
        toast(why(e), true); // someone was faster: look again at what is free now
        await build({});
      }
    });
  }
  page(back(), el("div.stack", { style: "gap:10px" }, el("h1", {}, t("trip")), el("p.muted", { style: "max-width:64ch" }, t("tripSub"))),
    el("form.card", { onsubmit: (e) => { e.preventDefault(); skip = []; build({ currentTarget: e.submitter }); } }, el("label", {}, t("tripWish"), wish),
      el("div.fields", {}, el("label", {}, t("date"), field("from", { type: "date", min: addDays(today(), 1), max: addDays(today(), 330), required: true })), el("label", {}, t("tripDays"), field("days", { type: "number", min: 1, max: 14, inputmode: "numeric" })), el("label", {}, t("guests"), field("guests", { type: "number", min: 1, max: 30, inputmode: "numeric" })), el("label", {}, t("pace"), pace), el("label", {}, t("tripBudget"), field("budget", { type: "number", min: 1000, step: 1000, inputmode: "numeric" }))),
      chips("regions", t("region"), form.regions, Object.keys(cfg.regions), regionName), chips("interests", t("activity"), form.interests, Object.keys(cfg.categories), (o) => cfg.categories[o][lang], true),
      el("button.primary.wide", { type: "submit" }, icon("route", 20), t("tripBuild"))), out);
  if (plan) show();
}

export async function tripPage(ctx, id, token) {
  const { t, lang, money, longDate, placeOf, link, page, alive, copy, every } = ctx;
  let last = "";
  const load = async () => {
    const trip = await api(`/api/trips/${encodeURIComponent(token)}`), sig = JSON.stringify(trip);
    if (!alive(id) || sig === last) return;
    last = sig;
    const tone = (s) => ({ confirmed: ".ok", declined: ".bad", expired: ".bad", cancelled: ".bad", pending: ".warn" })[s] ?? "";
    page(link({ my: 1 }, "a.back", {}, t("myBookings")), el("div.row.between", {}, el("h1", {}, t("tripMine")), el("button", { onclick: async () => { if (await copy(`${location.origin}/?trip=${trip.token}`)) toast(t("copied")); } }, icon("share", 20), t("copyLink"))),
      trip.waiting > 0 && el("div.note.warn", { role: "status" }, `${trip.waiting} ${t("tripLeft")}`),
      el("ol.route", {}, trip.bookings.map((b) => el("li", {}, el("div.row.between", {}, el("h2", {}, longDate(b.date)), el("span.badge" + tone(b.status), {}, t(b.status))),
        el("article.stop", {}, el("div.art", {}, visual({ ...b, id: b.listing_id })), el("div.stack", { style: "gap:5px" }, el("b", { dir: "ltr", style: "justify-self:start" }, b.time), el("h3", {}, b.i18n[lang].title), el("p.small.muted", {}, placeOf(b)), el("span.price", {}, money(b.total_uzs)),
          el("div", {}, link({ b: b.token }, "a.btn" + (b.status === "pending" ? ".primary" : ""), {}, t(b.status === "pending" ? "tripOpen" : "open")))))))),
      el("div.card", {}, el("dl.sum", {}, el("dt.all", {}, t("total")), el("dd.all", {}, money(trip.total_uzs))), el("p.small.muted", {}, t("keepLink"))));
  };
  await load();
  every(load, 5000);
}
