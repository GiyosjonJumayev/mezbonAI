// One screen for a live pitch: the traveller, the provider and the public result, really connected.
import { act, api, el } from "/common.js";

const bar = document.getElementById("bar"), frames = document.getElementById("frames");
const STEPS = {
  uz: [["guest", "Sayyoh ingliz tilida bron qiladi: sana, vaqt, ism."], ["guest", "Sinov to‘lovi. Haqiqiy saytda bu yerda Octo, Click yoki Payme."], ["host", "Usta shu zahoti ko‘radi va ovoz eshitadi. “Qabul qilish”ni bosing."], ["guest", "Chipta, manzil va telefon ochildi."], ["guest", "Savol bosing: usta uni o‘zbekcha o‘qiydi."], ["guest", "Mehmon keldi: “QR skanerlash”ni bosing. Chipta bir marta ishlaydi."], ["impact", "Davlat va investor natijani ochiq ko‘radi."]],
  en: [["guest", "A traveller books in English: date, time, name."], ["guest", "Test payment. On the real site: Octo, Click or Payme."], ["host", "The maker sees and hears it at once. Press “Qabul qilish” (accept)."], ["guest", "Ticket, address and phone are now open."], ["guest", "Tap a question: the maker reads it in Uzbek."], ["guest", "The guest arrives: press “Scan QR”. A ticket works once."], ["impact", "Government and investors see the result openly."]],
};
const NAMES = { uz: { guest: "Sayyoh", host: "Usta", impact: "Natija", next: "Keyingi", prev: "Oldingi", again: "Boshidan", scan: "QR skanerlash", noTicket: "Ochiq chipta yo‘q: usta hali qabul qilmagan yoki chipta ishlatilgan" }, en: { guest: "Traveller", host: "Maker", impact: "Result", next: "Next", prev: "Back", again: "Restart", scan: "Scan QR", noTicket: "No open ticket: not accepted yet, or already used" } };
let lang = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "uz", at = 0, t0 = 0, box = {};

function caption() {
  const n = NAMES[lang], [where, text] = STEPS[lang][at];
  for (const [k, f] of Object.entries(box)) f.classList.toggle("on", k === where);
  const clock = el("span", { role: "timer" }, "0:00");
  bar.replaceChildren(...[el("b", {}, `${at + 1}/${STEPS[lang].length}`), el("span.say", { role: "status" }, text), clock,
    el("button", { onclick: act(scan) }, n.scan), el("button", { disabled: at === 0, onclick: () => { at--; caption(); } }, n.prev), el("button.primary", { disabled: at === STEPS[lang].length - 1, onclick: () => { at++; caption(); } }, n.next),
    el("button", { onclick: () => { lang = lang === "uz" ? "en" : "uz"; caption(); } }, lang === "uz" ? "EN" : "UZ"), el("button", { onclick: act(start) }, n.again), document.fullscreenEnabled && el("button", { "aria-label": "Fullscreen", onclick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()) }, "⛶")].filter(Boolean));
  clearInterval(caption.timer);
  const tick = () => { const s = Math.floor((Date.now() - t0) / 1000); clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  tick();
  caption.timer = setInterval(tick, 1000);
}
/** Stands in for the phone camera: reads the code from the traveller's screen and checks it in as the provider. */
async function scan() {
  const code = box.guest.querySelector("iframe").contentDocument.querySelector(".ticket .code")?.textContent.replace(/[^0-9A-F]/g, "");
  if (!code) throw new Error(NAMES[lang].noTicket);
  await api(`/api/host/tickets/${code}/check-in`, {});
  box.impact.querySelector("iframe").contentWindow.location.reload();
}
async function start() {
  const s = await api("/api/stage/start", {}), n = NAMES[lang];
  const frame = (k, src) => (box[k] = el("figure", {}, el("figcaption", {}, n[k]), el("iframe", { src, title: n[k], allow: "microphone; clipboard-write" })));
  frames.replaceChildren(frame("guest", `/?l=${s.listing}&lang=en`), frame("host", "/mezbon#bronlar"), frame("impact", `/impact?lang=${lang}`));
  at = 0;
  t0 = Date.now();
  caption();
}
addEventListener("keydown", (e) => { // a presenter's clicker sends these keys
  if (!box.guest) return;
  if (["ArrowRight", "PageDown"].includes(e.key) && at < STEPS[lang].length - 1) { at++; caption(); }
  if (["ArrowLeft", "PageUp"].includes(e.key) && at > 0) { at--; caption(); }
});
start().catch((e) => bar.append(el("span", { role: "alert" }, e.status === 404 ? "Sahna faqat namoyish rejimida ishlaydi: npm run demo" : e.message)));
