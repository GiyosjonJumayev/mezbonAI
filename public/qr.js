import { api, el } from "/common.js";

import { themePicker } from "/pwa.js";

document.getElementById("prefs").append(themePicker({ theme: "Mavzu", auto: "Avtomatik", light: "Yorug‘", dark: "Qorong‘i" }));
const app = document.getElementById("app");
const local = ["localhost", "127.0.0.1"].includes(location.hostname);
try {
  const [hotels, cfg] = await Promise.all([api("/api/hotels"), api("/api/config")]);
  app.replaceChildren(el("div.wrap", {},
    el("div.row.between", {}, el("div.stack", {}, el("h1", {}, "Mehmonxona QR kodlari"), el("p.muted", {}, `Mehmon kodni skanerlaydi, bron qiladi, mehmonxona ${cfg.hotelFee}% oladi.`)), el("button.noprint", { onclick: () => print() }, "Chop etish")),
    local && el("div.note.warn.noprint", {}, "Telefondan skanerlash uchun serverni HOST=0.0.0.0 bilan ishga tushiring va bu sahifani konsoldagi “Telefon uchun” manzilidan oching."),
    hotels.length ? el("div.qrs", {}, hotels.map((h) => {
      const link = `${location.origin}/?h=${h.code}`;
      return el("div.card", {}, el("h2", {}, h.name), el("img.qr", { src: `/api/qr.svg?text=${encodeURIComponent(link)}`, alt: `${h.name} uchun QR kod` }), el("p.small", {}, "Book a local host · 预订当地体验 · Забронируйте мастер-класс"), el("a.small", { href: link }, link));
    })) : el("div.card.empty", {}, el("p", {}, "Hali mehmonxona qo‘shilmagan."))));
} catch (e) { app.replaceChildren(el("div.wrap", {}, el("div.note.bad", { role: "alert" }, e.message))); }
