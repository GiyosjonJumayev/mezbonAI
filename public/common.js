import { art } from "/art.js";

/** A signed-in provider is recognised by an HttpOnly cookie, so no secret passes through this code. */
export async function api(path, body) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  let r;
  try { r = await fetch(path, { method: body ? "POST" : "GET", headers, body: body && JSON.stringify(body) }); }
  catch { throw Object.assign(new Error("Serverga ulanib bo‘lmadi. Internetni tekshiring"), { code: "network" }); }
  document.documentElement.toggleAttribute("data-saved", r.headers.get("X-Saved") === "1");
  const v = await r.json().catch(() => ({ error: "Server javobi noto‘g‘ri", code: "other" }));
  if (!r.ok) throw Object.assign(new Error(v.error), { status: r.status, code: v.code });
  return v;
}

/** el("button.primary", { onclick }, "text", child). Strings are always inserted as text, never as HTML. */
export function el(spec, props = {}, ...kids) {
  const [tag, ...cls] = spec.split(".");
  const n = document.createElement(tag || "div");
  if (cls.length) n.className = cls.join(" ");
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false || k === "before") continue;
    if (k.startsWith("on")) n[k] = v;
    else if (k === "style") n.style.cssText = v; // set through the CSSOM, so the CSP can forbid inline styles
    else if (k === "dataset") Object.assign(n.dataset, v);
    else if (k === "value" || k === "textContent") n[k] = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  n.append(...kids.flat(2).filter((x) => x != null && x !== false && x !== ""));
  return n;
}

export const store = {
  get(k) { try { return localStorage.getItem("mezbon." + k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem("mezbon." + k) : localStorage.setItem("mezbon." + k, v); } catch {} },
  json(k, d) { try { return JSON.parse(this.get(k)) ?? d; } catch { return d; } },
};

const group = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+$)/g, " ");
export const som = (n) => `${group(n)} so‘m`;
/** `fx` is { code, rate } of the currency the visitor chose; the real price is always in so'm. */
export function uzs(n, lang, fx) {
  const real = lang === "uz" ? som(n) : `${group(n)} UZS`;
  if (!fx) return real;
  let about;
  try { about = new Intl.NumberFormat(lang, { style: "currency", currency: fx.code, maximumFractionDigits: n / fx.rate < 10 ? 2 : 0 }).format(n / fx.rate); } catch { about = `${Math.round(n / fx.rate)} ${fx.code}`; }
  return `${real} (≈ ${about})`;
}

export function toast(text, bad) {
  let box = document.querySelector(".toasts");
  if (!box) document.body.append((box = el("div.toasts", { "aria-live": "polite" })));
  const t = el("div.toast" + (bad ? ".bad" : ""), { role: bad ? "alert" : null }, text);
  box.replaceChildren(...[...box.children].slice(-2), t);
  setTimeout(() => t.remove(), 5000);
}

/** Runs an async handler with the button disabled; `explain` turns an error into what the person sees. */
export const act = (fn, explain = (e) => e.message) => async (e) => {
  const b = e?.currentTarget;
  if (b?.disabled) return;
  if (b) { b.disabled = true; b.setAttribute("aria-busy", "true"); }
  try { await fn(e); } catch (err) { if (!err.code && !err.status) console.error(err); toast(explain(err), true); } finally { if (b) { b.disabled = false; b.removeAttribute("aria-busy"); } }
};

export function ask(text, yes, no) {
  return new Promise((done) => {
    const d = el("dialog", { "aria-label": text }, el("p", {}, text), el("div.row", {},
      el("button", { onclick: () => d.close("no") }, no), el("button.primary", { onclick: () => d.close("yes") }, yes)));
    d.onclose = () => { d.remove(); done(d.returnValue === "yes"); };
    document.body.append(d);
    d.showModal();
  });
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  // Clipboard API needs HTTPS; phones on the demo Wi-Fi use plain HTTP.
  const t = el("textarea", { style: "position:fixed;opacity:0" });
  t.value = text;
  document.body.append(t);
  t.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  t.remove();
  return ok;
}

/** Server-sent events over fetch, which reports a lost session and can wait longer between retries. */
export function listen(path, onEvent) {
  const ctl = new AbortController();
  (async () => {
    for (let wait = 1000; !ctl.signal.aborted; wait = Math.min(wait * 2, 20000)) {
      try {
        const r = await fetch(path, { signal: ctl.signal });
        if (r.status === 401) return;
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        for (let buf = ""; ;) {
          const { value, done } = await reader.read();
          if (done) break;
          wait = 1000;
          buf += value;
          const parts = buf.split("\n\n");
          buf = parts.pop();
          for (const p of parts) if (p.startsWith("data: ")) onEvent(JSON.parse(p.slice(6)));
        }
      } catch {}
      await new Promise((s) => setTimeout(s, wait));
    }
  })();
  return () => ctl.abort();
}

const NS = "http://www.w3.org/2000/svg";
const HUES = { pottery: ["#1746a2", "#0b7f7f"], ikat: ["#8c2f5b", "#c9811a"], embroidery: ["#a33327", "#1746a2"], cooking: ["#b0621a", "#2f7a4d"], bread: ["#a56a17", "#7a3b1d"], carpet: ["#8f2430", "#173a5c"], wood: ["#6f4a2b", "#0b7f7f"], metal: ["#3d566b", "#1746a2"], village: ["#2f7a4d", "#c9811a"], tour: ["#173a5c", "#0b7f7f"] };

/** A glazed-plate rosette drawn from a seed, so every host gets a stable, distinct plate. */
export function plate(seed, category) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const rnd = (n) => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return (h >>> 16) % n; };
  const [a, b] = HUES[category] ?? HUES.pottery;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "-100 -100 200 200");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("plate");
  const add = (tag, at) => { const n = document.createElementNS(NS, tag); for (const k in at) k === "style" ? (n.style.cssText = at[k]) : n.setAttribute(k, at[k]); svg.append(n); };
  const ring = (n, r, len, w, fill, turn = 0) => {
    for (let i = 0; i < n; i++) add("path", { d: `M0 ${-r} C ${w} ${-r - len * 0.35}, ${w} ${-r - len * 0.75}, 0 ${-r - len} C ${-w} ${-r - len * 0.75}, ${-w} ${-r - len * 0.35}, 0 ${-r} Z`, transform: `rotate(${(360 / n) * (i + turn)})`, fill });
  };
  const n = 8 + 2 * rnd(4);
  add("circle", { r: 97, style: "fill:var(--plate)" });
  add("circle", { r: 93, fill: "none", stroke: a, "stroke-width": 5 });
  ring(n * 2, 66, 20, 5, b);
  add("circle", { r: 62, fill: "none", stroke: a, "stroke-width": 1.5 });
  ring(n, 24, 36, 7 + rnd(5), a);
  for (let i = 0; i < n; i++) add("circle", { cx: 0, cy: -50, r: 2.6 + rnd(2), fill: b, transform: `rotate(${(360 / n) * (i + 0.5)})` });
  add("circle", { r: 20, fill: b });
  ring(6 + rnd(3), 2, 14, 4, "#fff");
  return svg;
}

/** A schematic position for each region: column, row. */
export const GEO = { qoraqalpogiston: [1, 1], xorazm: [2, 2], navoiy: [3, 2], buxoro: [3, 3], samarqand: [4, 3], jizzax: [5, 3], sirdaryo: [6, 3], toshkent: [6, 2], namangan: [7, 2], andijon: [8, 2], fargona: [7, 3], qashqadaryo: [4, 4], surxondaryo: [5, 4] };

/** The provider's cover photo, or generated artwork for the craft. */
export const visual = (l, alt = "") => (l.photo ? el("img.photo", { src: `/photos/${l.photo}`, alt, loading: "lazy" }) : art(l.id ?? l.listing_id, l.category));
export const tint = () => null;

/** Brand names, so they need no translation. Test payments have their own wording. */
export const PAY_NAME = { octo: "Visa, Mastercard, Uzcard, Humo (Octo)", click: "Click", payme: "Payme" };
