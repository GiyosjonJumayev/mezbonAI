// Sign-in and sign-up for providers. Passkeys first (offered right in the email field by the browser), a six-digit e-mail code
// as the way in from any device, and no passwords at all. After sign-up a short checklist secures the account.
import { act, api, ask, copy, el, store, toast } from "/common.js";
import { art, icon } from "/art.js";
import { passkeyAdd, passkeyLogin, passkeys } from "/account.js";

const TYPE_ICON = { artisan: "pottery", guesthouse: "home", operator: "route", provider: "people" };
const POINTS = ["O‘zbekcha gapirasiz, mehmon o‘z tilida o‘qiydi", "Bron, to‘lov va QR chipta bitta joyda", "Parol yo‘q: barmoq izi, yuz yoki emailga kod"];

/** A message under the form instead of a toast, so a screen reader and the eye find it where the problem is. */
const alertBox = () => el("p.formerr", { role: "alert", hidden: true });
const say = (box, text) => { box.textContent = text ?? ""; box.hidden = !text; };

export function authScreen({ cfg, start, onCreated }) {
  let tab = location.hash === "#ochish" || !store.get("hostSeen") ? "up" : "in", stopAuto = null;
  const panel = el("div.authpanel");
  const tabs = el("div.authtabs", { role: "tablist", "aria-label": "Kirish yoki ro‘yxatdan o‘tish" }, [["in", "Kirish"], ["up", "Kabinet ochish"]].map(([k, text]) => el("button", { type: "button", role: "tab", id: `tab-${k}`, "aria-controls": "authpanel", onclick: () => show(k), onkeydown: (e) => { if (["ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); show(tab === "in" ? "up" : "in"); tabs.querySelector('[aria-selected="true"]').focus(); } } }, text)));
  function show(k) {
    stopAuto?.();
    stopAuto = null;
    tab = k;
    for (const b of tabs.children) { const on = b.id === `tab-${k}`; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; }
    panel.setAttribute("aria-labelledby", `tab-${k}`);
    panel.replaceChildren(k === "in" ? signIn() : signUp());
  }

  // ---- sign in ------------------------------------------------------------------------------------
  function signIn() {
    const err = alertBox(), email = el("input", { type: "email", name: "email", required: true, maxlength: 120, autocomplete: "username webauthn", inputmode: "email", value: store.get("hostEmail") ?? "" });
    const body = el("div.stack", { style: "gap:16px" });
    // The quiet offer in the email field must end first: a browser allows one passkey request at a time.
    const enterPasskey = act(async () => { say(err, ""); stopAuto?.(); stopAuto = null; await new Promise((r) => setTimeout(r, 50)); await passkeyLogin(); done(); }, (e) => { say(err, e.message); return e.message; });
    const done = () => { store.set("hostSeen", "1"); start(); };
    // The browser offers saved passkeys inside the email field; nothing to click if one is chosen.
    if (passkeys() && window.PublicKeyCredential?.isConditionalMediationAvailable) {
      const ctl = new AbortController();
      stopAuto = () => ctl.abort();
      PublicKeyCredential.isConditionalMediationAvailable().then(async (yes) => {
        while (yes && !ctl.signal.aborted) {
          try { await passkeyLogin({ conditional: true, signal: ctl.signal }); return done(); }
          catch (e) { if (ctl.signal.aborted) return; if (!/Bekor|vaqt/.test(e.message)) say(err, e.message); await new Promise((r) => setTimeout(r, 1500)); }
        }
      }).catch(() => {});
    }
    const askCode = act(async () => {
      say(err, "");
      if (!email.checkValidity()) { email.reportValidity(); return; }
      await api("/api/auth/email", { email: email.value });
      store.set("hostEmail", email.value.trim());
      codeStep();
    }, (e) => { say(err, e.message); return e.message; });
    function codeStep() {
      stopAuto?.();
      const code = el("input.code", { name: "code", required: true, inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9]{6}", maxlength: 6, "aria-describedby": "code-hint", oninput: () => { code.value = code.value.replace(/\D/g, "").slice(0, 6); if (code.value.length === 6) form.requestSubmit(); } });
      const again = el("button.ghost", { type: "button", disabled: true }, "Qayta yuborish: 30 s");
      let left = 30;
      const tick = setInterval(() => { left--; again.textContent = left > 0 ? `Qayta yuborish: ${left} s` : "Kodni qayta yuborish"; again.disabled = left > 0; if (left <= 0 || !again.isConnected) clearInterval(tick); }, 1000);
      again.onclick = act(async () => { await api("/api/auth/email", { email: email.value }); toast("Yangi kod yuborildi"); left = 30; again.disabled = true; codeStep(); });
      const form = el("form.stack", { style: "gap:14px", onsubmit: act(async (e) => { e.preventDefault(); say(err, ""); await api("/api/auth/code", { email: email.value, code: code.value }); done(); }, (e) => { code.select(); say(err, e.status === 429 ? e.message : "Kod noto‘g‘ri yoki eskirgan. Qayta urining yoki yangi kod so‘rang."); return ""; }) },
        el("p", { id: "code-hint" }, "6 xonali kod ", el("b", {}, email.value.trim()), " manziliga yuborildi, agar u kabinetga ulangan bo‘lsa. Kod 10 daqiqa amal qiladi."),
        el("label", {}, "Kod", code), err, el("button.primary.wide", { type: "submit" }, "Kirish"),
        el("div.row.between", {}, el("button.ghost", { type: "button", onclick: () => show("in") }, "← Boshqa email"), again));
      body.replaceChildren(form);
      code.focus();
    }
    body.replaceChildren(...[
      cfg.mail && el("form.stack", { style: "gap:14px", onsubmit: (e) => { e.preventDefault(); askCode({ currentTarget: e.submitter }); } }, el("label", {}, "Email", email), err, el("button.primary.wide", { type: "submit" }, "Davom etish")),
      !cfg.mail && err,
      cfg.mail && passkeys() && el("p.or", {}, el("span", {}, "yoki")),
      passkeys() && el("button.wide" + (cfg.mail ? "" : ".primary"), { type: "button", onclick: enterPasskey }, icon("key", 20), "Passkey bilan kirish"),
      el("details.other", {}, el("summary", {}, "Boshqa yo‘llar"), el("ul.plain", {},
        el("li", {}, el("b", {}, "Zaxira havola. "), "Kabinet ochilganda saqlagan havolangizni shu qurilmada oching."),
        el("li", {}, el("b", {}, "Telegram. "), "Botga /kirish deb yozing: bir martalik havola keladi."),
        !cfg.mail && el("li", {}, el("b", {}, "Email. "), "Bu saytda email ulanmagan.")))].filter(Boolean));
    return el("div.stack", { style: "gap:18px" }, el("div.stack", { style: "gap:4px" }, el("h2", {}, "Kabinetingizga kiring"), el("p.muted", {}, "Passkey yoki emailingizga keladigan kod bilan. Parol yo‘q.")), body);
  }

  // ---- sign up ------------------------------------------------------------------------------------
  function signUp() {
    const err = alertBox(), name = el("input", { name: "name", required: true, maxlength: 60, autocomplete: "organization", "aria-describedby": "name-hint" });
    const email = el("input", { type: "email", name: "email", maxlength: 120, autocomplete: "email", inputmode: "email", "aria-describedby": "email-hint" });
    const types = el("fieldset.typecards", {}, el("legend", {}, "Faoliyatingiz"), Object.keys(cfg.providerTypes).map((k, i) => el("label.typecard", {}, el("input", { type: "radio", name: "type", value: k, checked: i === 0, required: true }), icon(TYPE_ICON[k] ?? "people", 26), el("span", {}, cfg.providerTypes[k].uz))));
    const send = act(async () => {
      say(err, "");
      const h = await api("/api/hosts", { name: name.value, type: types.querySelector("input:checked").value, ...(email.value.trim() && { email: email.value.trim() }) });
      store.set("hostSeen", "1");
      if (email.value.trim()) store.set("hostEmail", email.value.trim());
      onCreated({ key: h.key, email: email.value.trim() || null, emailSent: h.email_sent });
      if (!location.hash) location.hash = "yangi";
      await start();
    }, (e) => { say(err, e.message); return e.message; });
    return el("form.stack", { style: "gap:18px", onsubmit: (e) => { e.preventDefault(); send({ currentTarget: e.submitter }); } },
      el("div.stack", { style: "gap:4px" }, el("h2", {}, "Kabinet oching"), el("p.muted", {}, "Bir daqiqa. Karta va parol kerak emas.")),
      el("label", {}, "Ismingiz yoki biznes nomi", name), el("span.small.muted", { id: "name-hint", style: "margin-top:-10px" }, "Mehmonlar shu nomni ko‘radi. Keyin o‘zgartirsa bo‘ladi."), types,
      cfg.mail && [el("label", {}, el("span", {}, "Email ", el("span.small.muted", {}, "(tavsiya etiladi)")), email), el("span.small.muted", { id: "email-hint", style: "margin-top:-10px" }, "Kirish kodi va yangi bronlar haqida xabar shu manzilga keladi.")],
      err, el("button.primary.wide", { type: "submit" }, "Kabinet ochish"),
      el("p.small.muted", {}, "Hali tayyor emasmisiz? ", el("a", { href: "/hamkor" }, "Niyat xati imzolang")));
  }

  const view = el("div.auth", {}, el("section.authintro", {}, art("auth-wall", "pottery"), el("div.stack", { style: "gap:16px" }, el("h1", {}, "Mahalliy madaniyatni daromadga aylantiring"),
    el("ul.authpoints", {}, POINTS.map((p) => el("li", {}, icon("check", 22), p))))), el("section.card.authcard", {}, tabs, panel));
  panel.id = "authpanel";
  panel.setAttribute("role", "tabpanel");
  show(tab);
  return view;
}

/** Right after sign-up: three steps that keep the account safe. Each can be done here and now. */
export function secureCard({ cfg, fresh, name, close }) {
  const link = `${location.origin}/mezbon#kirish=${fresh.key}`, state = { passkey: false, email: !fresh.email && !cfg.mail ? null : false, saved: false };
  const box = el("section.card.secure", { "aria-labelledby": "secure-title" });
  const mark = (k) => { state[k] = true; draw(); };
  function draw() {
    const steps = Object.entries(state).filter(([, v]) => v !== null), doneCount = steps.filter(([, v]) => v).length;
    const step = (k, title, text, action) => el("li.securestep" + (state[k] ? ".done" : ""), {}, el("span.dot", { "aria-hidden": "true" }, state[k] ? icon("check", 18) : ""), el("div.stack", { style: "gap:6px" }, el("b", {}, title, state[k] && el("span.vh", {}, " (bajarildi)")), !state[k] && el("p.small.muted", {}, text), !state[k] && action));
    const code = el("input.code", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, pattern: "[0-9]{6}", "aria-label": "Emaildagi kod" }), mail = el("input", { type: "email", autocomplete: "email", maxlength: 120, "aria-label": "Email", value: fresh.email ?? "" });
    const emailAction = fresh.emailSent
      ? el("form.compose", { onsubmit: act(async (e) => { e.preventDefault(); await api("/api/host/email/code", { code: code.value }); mark("email"); toast("Email tasdiqlandi"); }) }, code, el("button", { type: "submit" }, "Tasdiqlash"))
      : el("form.compose", { onsubmit: act(async (e) => { e.preventDefault(); await api("/api/host/email", { email: mail.value }); fresh.email = mail.value.trim(); fresh.emailSent = true; draw(); toast("Kod yuborildi"); }) }, mail, el("button", { type: "submit" }, "Kod yuborish"));
    const save = () => {
      const a = el("a", { href: URL.createObjectURL(new Blob([`SilkRoad Experience OS\r\n${name}\r\nZaxira kirish havolasi (hech kimga bermang):\r\n${link}\r\n`], { type: "text/plain" })), download: "silkroad-kirish.txt" });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); mark("saved");
    };
    box.replaceChildren(el("div.row.between", {}, el("div.stack", { style: "gap:2px" }, el("h2", { id: "secure-title" }, "Kabinetingizni himoyalang"), el("p.small.muted", {}, `${doneCount} / ${steps.length} bajarildi`)),
      el("button.ghost", { type: "button", onclick: async () => { if (state.saved || state.passkey || (await ask("Zaxira havolani saqlamadingiz. Passkey ham yo‘q bo‘lsa, kabinetga qaytib kira olmaysiz. Baribir yopasizmi?", "Yopish", "Qaytish"))) close(); } }, doneCount === steps.length ? "Tayyor" : "Keyinroq")),
      el("div.meter", { role: "progressbar", "aria-valuemin": 0, "aria-valuemax": steps.length, "aria-valuenow": doneCount, "aria-label": "Himoya" }, el("i", { style: `width:${(doneCount / steps.length) * 100}%` })),
      el("ol.securesteps", {},
        step("passkey", "Passkey yarating", "Keyingi safar barmoq izi, yuz yoki telefon PIN-kodi bilan bir soniyada kirasiz.", passkeys() ? el("button.primary", { type: "button", onclick: act(async () => { await passkeyAdd(); mark("passkey"); toast("Passkey qo‘shildi"); }) }, icon("key", 20), "Passkey yaratish") : el("p.small", {}, "Bu brauzer passkeyni qo‘llamaydi. HTTPS saytda yoki boshqa brauzerda yarating.")),
        state.email !== null && step("email", "Emailni tasdiqlang", fresh.emailSent ? `${fresh.email} manziliga 6 xonali kod yubordik.` : "Boshqa qurilmadan kirish va bron xabarlari uchun.", emailAction),
        step("saved", "Zaxira havolani saqlang", "Telefon yo‘qolsa, shu havola bilan qaytasiz. U faqat hozir ko‘rsatiladi, hech kimga bermang.", el("div.stack", { style: "gap:8px" }, el("code.secret", { dir: "ltr" }, link), el("div.row", {}, el("button", { type: "button", onclick: async () => { if (await copy(link)) { toast("Nusxalandi"); mark("saved"); } } }, "Nusxalash"), el("button", { type: "button", onclick: save }, "Faylga saqlash"))))));
  }
  draw();
  return box;
}
