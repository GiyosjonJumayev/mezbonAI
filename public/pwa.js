// Theme, installation, notifications and offline support shared by both apps.
import { api, el, store } from "/common.js";

export function themePicker(labels) {
  const s = el("select", { "aria-label": labels.theme, onchange: () => {
    const v = s.value;
    if (v === "auto") { delete document.documentElement.dataset.theme; store.set("theme", null); } else { document.documentElement.dataset.theme = v; store.set("theme", v); }
  } }, ["auto", "light", "dark"].map((v) => el("option", { value: v }, labels[v])));
  s.value = document.documentElement.dataset.theme ?? "auto";
  return s;
}

export const worker = "serviceWorker" in navigator ? navigator.serviceWorker.register("/sw.js").catch(() => null) : Promise.resolve(null);

/** Visible on every page of a public demonstration. */
export function demoBanner(cfg, text) {
  if (cfg.demoSite) document.querySelector("header.top").before(el("div.demobar", { role: "note" }, text));
}

let prompt = null;
const waiting = new Set();
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); prompt = e; waiting.forEach((f) => f()); });
/** A button that appears only when the browser offers installation. */
export function installButton(text) {
  const b = el("button", { hidden: !prompt, onclick: async () => { const p = prompt; prompt = null; b.hidden = true; await p?.prompt(); } }, text);
  waiting.add(() => { b.hidden = false; });
  return b;
}

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
/** target: { path: "/api/push/host" } or { path: "/api/push/guest/<token>" }. Returns true when on. */
export async function enablePush({ path }) {
  if (!pushSupported() || (await Notification.requestPermission()) !== "granted") return false;
  const reg = await worker;
  if (!reg) return false;
  const { key: pub } = await api("/api/push/key");
  const raw = Uint8Array.from(atob(pub.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key cannot be used.
  const same = sub && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey ?? []))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === pub;
  if (sub && !same) { await sub.unsubscribe(); sub = null; }
  try { sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw }); } catch { return false; }
  await api(path, { subscription: sub.toJSON() });
  return true;
}
