// AI Business Assistant page: today's tasks and visits, and a chat that proposes actions for the provider to approve.
import { act, api, el, plate, toast } from "/common.js";

const LEVEL = { now: ["Hozir", ".bad"], soon: ["Tez orada", ".warn"], grow: ["O‘sish uchun", ".ok"] };
const STARTERS = ["Bugun kimlar keladi?", "Oxirgi 30 kun daromadim qancha?", "Ertaga 10:00 ni yop", "Maslahat ber"];
// The conversation lives in this tab only. It is never stored on the server.
let log = [];
export const forget = () => { log = []; };

export function assistant({ key, cfg, reload, speak }) {
  const box = el("div.stack", { style: "gap:22px" }, el("p.muted", { role: "status" }, "Yuklanmoqda…"));

  /** One proposed change with its own approve button. */
  const proposal = (p, after) => {
    const row = el("div.proposal", {}, el("span", {}, p.label));
    row.append(el("button.primary", { onclick: act(async () => {
      const r = await api("/api/host/assistant/apply", { ...p.action }, key);
      p.done = true;
      row.replaceChildren(el("span", {}, p.label), el("span.badge.ok", {}, "Bajarildi"));
      await reload();
      if (r.link) { location.hash = r.link; return toast(r.done); }
      toast("Bajarildi");
      after?.();
    }) }, "Tasdiqlash"));
    if (p.done) row.lastChild.replaceWith(el("span.badge.ok", {}, "Bajarildi"));
    return row;
  };

  // ---- chat ----
  const feed = el("div.chat.tall", { role: "log", "aria-live": "polite" });
  const input = el("input", { maxlength: 1000, required: true, placeholder: "Yozing yoki gapiring", "aria-label": "Yordamchiga savol" });
  const go = el("button.primary", { type: "submit" }, "Yuborish");
  const left = el("p.small.muted");
  const mode = el("span.badge");
  const bubble = (m) => [el("div.msg" + (m.role === "user" ? ".me" : ""), { style: "white-space:pre-line" }, m.text, m.note && el("small", {}, m.note)),
    m.actions?.length > 0 && el("div.stack.proposals", {}, m.actions.map((a) => proposal(a, refresh))), m.chips?.length > 0 && el("div.chips", {}, m.chips.map((c) => el("button", { type: "button", onclick: () => ask(c) }, c)))];
  const paint = () => {
    feed.replaceChildren(...(log.length ? log.flatMap(bubble).filter(Boolean) : [el("p.muted", {}, "Biznesingiz haqida o‘zbekcha so‘rang. Yordamchi o‘zgarish taklif qiladi, siz tasdiqlaysiz."), el("div.chips", {}, STARTERS.map((c) => el("button", { type: "button", onclick: () => ask(c) }, c)))]));
    feed.scrollTo(0, 1e6);
  };
  async function ask(text) {
    const history = log.map(({ role, text: t }) => ({ role, text: t })).slice(-8);
    log.push({ role: "user", text });
    paint();
    const wait = el("p.muted", { role: "status" }, "O‘ylayapti…");
    feed.append(wait);
    feed.scrollTo(0, 1e6);
    go.disabled = input.disabled = true;
    try {
      const r = await api("/api/host/assistant", { text, history }, key);
      log.push({ role: "assistant", text: r.reply, actions: r.actions, chips: r.chips, note: r.note });
      if (cfg.ai) left.textContent = `Bugun yana ${r.left} ta AI so‘rov`;
    } catch (e) { log.push({ role: "assistant", text: e.message }); }
    go.disabled = input.disabled = false;
    paint();
    input.focus();
  }
  const form = el("form.compose", { onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (!v) return; input.value = ""; ask(v); } }, input, go);
  const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (SR) {
    let rec = null;
    const mic = el("button", { type: "button", "aria-label": "Gapirish", onclick: () => {
      if (rec) return rec.stop();
      rec = new SR();
      rec.lang = "uz-UZ";
      rec.onresult = (e) => { input.value = e.results[0][0].transcript; };
      rec.onerror = (e) => { if (!["no-speech", "aborted"].includes(e.error)) toast("Nutqni tanib bo‘lmadi. Yozib yuboring", true); };
      rec.onend = () => { rec = null; mic.textContent = "Gapirish"; input.focus(); };
      try { rec.start(); mic.textContent = "Eshityapman…"; } catch { rec = null; }
    } }, "Gapirish");
    form.insertBefore(mic, go);
    form.classList.add("with-mic");
  }
  const chat = el("section.card", {}, el("div.row.between", {}, el("h2", {}, "Yordamchi bilan suhbat"), mode), feed, form, el("div.row.between", {}, left, el("div.row", {}, el("button.ghost", { onclick: () => { const last = log.findLast((m) => m.role === "assistant"); if (last) speak(last.text); } }, "Javobni eshitish"), el("button.ghost", { onclick: () => { forget(); paint(); } }, "Suhbatni tozalash"))));

  // ---- brief ----
  async function refresh() {
    let b;
    try { b = await api("/api/host/assistant", null, key); }
    catch (e) { return box.replaceChildren(el("div.note.bad", { role: "alert" }, e.message), el("button", { onclick: refresh }, "Qayta urinish")); }
    mode.textContent = b.ai ? "Claude AI" : "Oddiy rejim";
    mode.className = "badge " + (b.ai ? "ok" : "warn");
    left.textContent = b.ai ? `Bugun yana ${b.left} ta AI so‘rov` : "AI ulanmagan: yordamchi tayyor buyruqlarni tushunadi.";
    const task = (t) => el("li.task", {}, el("div.row", {}, el("span.badge" + LEVEL[t.level][1], {}, LEVEL[t.level][0]), el("span", { style: "flex:1 1 200px" }, t.text), t.link && el("a", { href: "#" + t.link }, "Ochish")), t.actions?.length > 0 && el("div.stack.proposals", {}, t.actions.map((a) => proposal(a, refresh))));
    const focused = document.activeElement === input;
    box.replaceChildren(el("div.two", {}, chat, el("div.stack", { style: "gap:22px" },
      el("section.card", {}, el("h2", {}, "Bugungi ishlar"), b.tasks.length ? el("ul.tasks", {}, b.tasks.map(task)) : el("div.row", {}, plate("tayyor", "village"), el("p", {}, "Hammasi joyida. Yangi ish yo‘q."))),
      el("section.card", {}, el("h2", {}, "Bugungi tashriflar"), b.visits.length ? el("ul.tasks", {}, b.visits.map((v) => el("li.task", {}, el("div.row.between", {}, el("span", {}, el("b", {}, v.time), ` ${v.guest_name}, ${v.guests} kishi (${cfg.langNames[v.lang]})`), v.arrived ? el("span.badge.ok", {}, "Keldi") : el("a", { href: "#chiptalar" }, "Chiptani tekshirish")), el("span.small.muted", {}, v.title)))) : el("p.muted", {}, "Bugun tasdiqlangan tashrif yo‘q.")),
      b.quality.length > 0 && el("section.card", {}, el("h2", {}, "Takliflar tayyorligi"), el("ul.tasks", {}, b.quality.map((q) => el("li.task", {}, el("div.row.between", {}, el("a", { href: `#taklif/${q.id}` }, q.title), el("b", {}, `${q.score}/100`)), el("div.meter", { role: "meter", "aria-valuenow": q.score, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": q.title }, el("i", { style: `width:${q.score}%` })), q.next[0] && el("span.small.muted", {}, `Keyingi qadam: ${q.next[0].toLowerCase()}`))))))));
    paint();
    if (focused) input.focus();
  }
  refresh();
  box.refresh = refresh;
  return box;
}
