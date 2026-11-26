// Six-digit codes from an authenticator app (RFC 6238, SHA-1, 30 seconds).
import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "./util.mjs";

const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const newTotpSecret = () => [...randomBytes(20)].reduce((s, b) => s + b.toString(2).padStart(8, "0"), "").match(/.{5}/g).map((x) => ABC[parseInt(x, 2)]).join("");
export function base32(s) {
  const clean = String(s).toUpperCase().replace(/[\s=-]/g, "");
  if (!/^[A-Z2-7]{16,}$/.test(clean)) return null;
  const bits = [...clean].map((c) => ABC.indexOf(c).toString(2).padStart(5, "0")).join("");
  return Buffer.from(bits.match(/.{8}/g).map((x) => parseInt(x, 2)));
}
export function totp(key, step) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", key).update(b).digest(), o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}
/** Accepts the code of this half minute and its neighbours, each only once. */
export function totpChecker(secret) {
  const key = base32(secret);
  let last = 0;
  return function check(code, at = Date.now()) {
    const now = Math.floor(at / 30_000);
    for (const step of [now, now - 1, now + 1]) if (step > last && typeof code === "string" && safeEqual(code.replace(/\s/g, ""), totp(key, step))) { last = step; return true; }
    return false;
  };
}
