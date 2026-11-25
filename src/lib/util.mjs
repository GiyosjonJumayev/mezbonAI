// Small shared tools: errors, validation, time in Tashkent, secrets.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { LANGS } from "./i18n.mjs";

/** `message` is Uzbek for providers; `code` lets the traveller site and AI assistants show their own wording. */
export class AppError extends Error {
  constructor(status, message, code = "input") { super(message); this.status = status; this.code = code; }
}
export const fail = (status, message, code) => new AppError(status, message, code);
export const bad = (m) => new AppError(400, m);
export const notFound = (m) => new AppError(404, m, "notfound");

export const str = (v, name, max) => {
  if (typeof v !== "string" || !v.trim()) throw bad(`${name} kerak`);
  const s = v.trim().replace(/\u0000/g, "");
  if (s.length > max) throw bad(`${name} juda uzun (${max} belgigacha)`);
  return s;
};
export const int = (v, name, min, max) => {
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`${name}: ${min}–${max} oralig‘ida butun son bo‘lsin`);
  return v;
};
export const lang = (v) => (LANGS.includes(v) ? v : "en");
export const known = (map, v) => (typeof v === "string" && Object.hasOwn(map, v) ? v : null);

// ---- time. Tashkent is UTC+5 with no daylight saving. -------------------------------------------
export const DAY = 864e5;
export const tashkentNow = (d = new Date()) => new Date(d.getTime() + 5 * 3600e3).toISOString();
export const today = () => tashkentNow().slice(0, 10);
export const tashkentDate = (iso) => tashkentNow(new Date(iso)).slice(0, 10);
export const startsAt = (date, time) => new Date(`${date}T${time}:00+05:00`);
export const isoWeekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
export const addDays = (date, n) => new Date(+new Date(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export function isDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === s;
}
export const ago = (ms) => new Date(Date.now() - ms).toISOString();

// ---- secrets ------------------------------------------------------------------------------------
export const id = (prefix) => prefix + randomBytes(8).toString("hex");
export const secret = () => randomBytes(24).toString("base64url");
export const sha256 = (s) => createHash("sha256").update(String(s)).digest();
export const safeEqual = (a, b) => { const x = sha256(a), y = sha256(b); return timingSafeEqual(x, y); };
