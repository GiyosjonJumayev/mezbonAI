// Provider accounts: access keys, sessions, one-time links and passkeys. Only hashes of secrets are stored.
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { randomInt, timingSafeEqual } from "node:crypto";
import { PROVIDER_TYPES } from "../lib/i18n.mjs";
import { cleanEmail, cleanPhone } from "./mail.mjs";
import { ago, bad, DAY, fail, id, known, secret, sha256, str } from "../lib/util.mjs";

const SESSION_DAYS = 30, CHALLENGE_MIN = 5, LINK_MIN = 15, MAX_PASSKEYS = 10;

/** Proof that server code, not a visitor, chose this provider (Telegram, background jobs). It can never arrive in a request. */
class HostRef {
  #id;
  constructor(hostId) { this.#id = hostId; }
  static read(v) { return v instanceof HostRef ? v.#id : null; }
}
export const asHost = (hostId) => new HostRef(hostId);

const CODE_MIN = 10, CODE_TRIES = 5;
const codeHash = (email, code) => sha256(`${String(email).toLowerCase()}|${code}`);
const codeFailed = () => fail(401, "Kod noto‘g‘ri yoki eskirgan", "code");

export function createAccounts({ db, audit, site }) {
  /** Spends a code: it must be the newest of its kind for that address, unexpired, and within its tries. */
  async function useCode(email, code, purpose, hostId = null) {
    const c = typeof email === "string" && /^\d{6}$/.test(String(code ?? "").trim()) ? await db.one("SELECT * FROM login_codes WHERE lower(email)=lower(?) AND purpose=? AND expires_at > now() AND (?::text IS NULL OR host_id=?) ORDER BY id DESC LIMIT 1", email.trim(), purpose, hostId, hostId) : null;
    if (!c) throw codeFailed();
    const r = await db.one("UPDATE login_codes SET attempts=attempts+1 WHERE id=? AND attempts < ? RETURNING attempts", c.id, CODE_TRIES);
    if (!r || !timingSafeEqual(codeHash(email.trim(), String(code).trim()), c.code_hash)) throw codeFailed();
    await db.run("DELETE FROM login_codes WHERE host_id=? AND purpose=?", c.host_id, purpose);
    return c.host_id;
  }
  const denied = () => fail(401, "Kirish havolasi noto‘g‘ri yoki eskirgan", "auth");
  const future = (ms) => new Date(Date.now() + ms).toISOString();

  async function authHost(credential) {
    const ref = HostRef.read(credential);
    if (ref) return (await db.one("SELECT * FROM hosts WHERE id=?", ref)) ?? (() => { throw denied(); })();
    if (typeof credential !== "string" || credential.length < 20 || credential.length > 100) throw denied();
    const h = sha256(credential);
    const host = credential.startsWith("s_")
      ? await db.one("SELECT h.* FROM sessions s JOIN hosts h ON h.id=s.host_id WHERE s.token_hash=? AND s.expires_at > now()", h)
      : await db.one("SELECT * FROM hosts WHERE key_hash=?", h);
    if (!host) throw denied();
    return host;
  }
  async function openSession(hostId, label = "") {
    const token = "s_" + secret();
    await db.run("INSERT INTO sessions (token_hash,host_id,label,expires_at) VALUES (?,?,?,?)", sha256(token), hostId, label.slice(0, 60), future(SESSION_DAYS * DAY));
    // Twenty devices are plenty; the oldest ones are signed out.
    await db.run("DELETE FROM sessions WHERE host_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE host_id=? ORDER BY created_at DESC LIMIT 20)", hostId, hostId);
    return { token, maxAge: SESSION_DAYS * 86400, host: await brief(hostId) };
  }
  const brief = (hostId) => db.one("SELECT id, name, type FROM hosts WHERE id=?", hostId);

  async function challenge(text, hostId = null) {
    const cid = id("c_");
    await db.run("DELETE FROM challenges WHERE expires_at < now()");
    await db.run("INSERT INTO challenges (id,challenge,host_id,expires_at) VALUES (?,?,?,?)", cid, text, hostId, future(CHALLENGE_MIN * 60e3));
    return cid;
  }
  /** Each challenge works once. */
  const spend = (cid) => db.one("DELETE FROM challenges WHERE id=? AND expires_at > now() RETURNING challenge, host_id", String(cid ?? "").slice(0, 64));
  const passkeyFailed = () => fail(401, "Passkey tasdiqlanmadi. Qayta urinib ko‘ring", "auth");

  return {
    authHost,
    async createHost(name, { telegramChat = null, demo = false, type = "artisan" } = {}) {
      if (!known(PROVIDER_TYPES, type)) throw bad("Faoliyat turi noto‘g‘ri");
      const h = { id: id("h_"), key: secret(), name: str(name, "Ism", 60) };
      await db.run("INSERT INTO hosts (id,key_hash,name,telegram_chat,demo,type) VALUES (?,?,?,?,?,?)", h.id, sha256(h.key), h.name, telegramChat, demo, type);
      return h; // the only time the key can be read
    },
    hostByTelegram: (chat) => db.one("SELECT * FROM hosts WHERE telegram_chat=?", String(chat)),

    async signIn(key, label) {
      if (typeof key !== "string" || key.startsWith("s_")) throw denied();
      const h = await authHost(key);
      return openSession(h.id, label);
    },
    openSession,
    async signOut(token) { if (typeof token === "string") await db.run("DELETE FROM sessions WHERE token_hash=?", sha256(token)); return { ok: true }; },
    /** Signs out every device and replaces the access key, for a lost phone or a leaked link. */
    async rotateKey(credential) {
      const h = await authHost(credential), key = secret();
      await db.tx(async () => {
        await db.run("UPDATE hosts SET key_hash=?, calendar_hash=NULL WHERE id=?", sha256(key), h.id);
        await db.run("DELETE FROM sessions WHERE host_id=?", h.id);
        await db.run("DELETE FROM challenges WHERE host_id=?", h.id); // links already on their way stop working too
        await audit(h.id, "key_rotated", h.id);
      });
      return { key };
    },
    /** A one-time sign-in link, e.g. sent by the Telegram bot. */
    async loginLink(credential) {
      const h = await authHost(credential), token = "l_" + secret();
      await db.run("INSERT INTO challenges (id,challenge,host_id,expires_at) VALUES (?,?,?,?)", sha256(token).toString("hex"), "link", h.id, future(LINK_MIN * 60e3));
      return token;
    },
    async useLink(token, label) {
      if (typeof token !== "string" || !token.startsWith("l_")) throw denied();
      const c = await spend(sha256(token).toString("hex"));
      if (c?.challenge !== "link") throw denied();
      return openSession(c.host_id, label);
    },
    /** A private address for Google, Apple or Outlook calendars. A new one replaces the old one. */
    async calendarLink(credential) {
      const h = await authHost(credential), token = secret();
      await db.run("UPDATE hosts SET calendar_hash=? WHERE id=?", sha256(token), h.id);
      await audit(h.id, "calendar_link", h.id);
      return token;
    },
    async hostByCalendar(token) {
      const h = typeof token === "string" ? await db.one("SELECT id, name FROM hosts WHERE calendar_hash=?", sha256(token)) : null;
      if (!h) throw denied();
      return h;
    },
    async setContact(credential, { phone }) {
      const h = await authHost(credential);
      await db.run("UPDATE hosts SET phone=? WHERE id=?", cleanPhone(phone), h.id);
      return { ok: true };
    },
    /** The provider's bank details, for the payout list. Empty removes them. */
    async setBank(credential, { account, mfo, holder } = {}) {
      const h = await authHost(credential), a = String(account ?? "").replace(/\s/g, ""), m = String(mfo ?? "").replace(/\s/g, "");
      if (!a && !m) { await db.run("UPDATE hosts SET bank_account=NULL, bank_mfo=NULL, bank_holder=NULL WHERE id=?", h.id); return { ok: true }; }
      if (!/^\d{20}$/.test(a)) throw fail(400, "Hisob raqami 20 ta raqam bo‘lsin");
      if (!/^\d{5}$/.test(m)) throw fail(400, "Bank kodi (MFO) 5 ta raqam bo‘lsin");
      await db.run("UPDATE hosts SET bank_account=?, bank_mfo=?, bank_holder=? WHERE id=?", a, m, String(holder ?? "").trim().slice(0, 80) || h.name, h.id);
      await audit("host", "bank_changed", h.id);
      return { ok: true };
    },
    /** An address counts only after its owner opened the link sent to it. An empty one removes it. */
    async askEmail(credential, value) {
      const h = await authHost(credential), email = cleanEmail(value);
      if (!email) { await db.run("UPDATE hosts SET email=NULL WHERE id=?", h.id); return {}; }
      const token = "e_" + secret();
      await db.run("INSERT INTO challenges (id,challenge,host_id,expires_at) VALUES (?,?,?,?)", sha256(token).toString("hex"), `email:${email}`, h.id, future(3600e3));
      return { email, token };
    },
    async confirmEmail(token) {
      const c = typeof token === "string" && token.startsWith("e_") ? await spend(sha256(token).toString("hex")) : null;
      if (!c?.challenge.startsWith("email:")) throw denied();
      const email = c.challenge.slice(6);
      try { await db.run("UPDATE hosts SET email=? WHERE id=?", email, c.host_id); } catch (e) { if (e.code === "23505") throw fail(409, "Bu email boshqa kabinetga ulangan"); throw e; }
      await audit(c.host_id, "email_confirmed", c.host_id);
      return { ok: true };
    },
    // ---- six-digit codes by e-mail -------------------------------------------------------------------
    /** A new code replaces older ones of the same kind. Returned once, to be e-mailed; only its hash is kept. */
    async emailCode(hostId, email, purpose = "login") {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      await db.run("DELETE FROM login_codes WHERE host_id=? AND purpose=?", hostId, purpose);
      await db.run("INSERT INTO login_codes (host_id,purpose,email,code_hash,expires_at) VALUES (?,?,?,?,?)", hostId, purpose, email, codeHash(email, code), future(CODE_MIN * 60e3));
      return code;
    },
    /** Signs in with the code from the e-mail. Five tries per code; every failure looks the same. */
    async signInWithCode(email, code, label) {
      const host = await useCode(email, code, "login");
      return openSession(host, label);
    },
    /** Confirms the provider's own address with the code sent to it. */
    async verifyEmailCode(credential, code) {
      const h = await authHost(credential), c = await db.one("SELECT email FROM login_codes WHERE host_id=? AND purpose='verify' ORDER BY id DESC LIMIT 1", h.id);
      if (!c) throw codeFailed();
      await useCode(c.email, code, "verify", h.id);
      try { await db.run("UPDATE hosts SET email=? WHERE id=?", c.email, h.id); } catch (e) { if (e.code === "23505") throw fail(409, "Bu email boshqa kabinetga ulangan"); throw e; }
      await audit(h.id, "email_confirmed", h.id);
      return { ok: true, email: c.email };
    },
    hostByEmail: (email) => db.one("SELECT id, email FROM hosts WHERE lower(email)=lower(?)", email),
    async account(credential) {
      const h = await authHost(credential);
      return {
        id: h.id, name: h.name, type: h.type, verified: Boolean(h.verified_at), suspended: Boolean(h.suspended_at), telegram: Boolean(h.telegram_chat), calendar: Boolean(h.calendar_hash), phone: h.phone, email: h.email, bank: h.bank_account ? { account: h.bank_account, mfo: h.bank_mfo, holder: h.bank_holder } : null,
        sessions: await db.all("SELECT label, created_at FROM sessions WHERE host_id=? AND expires_at > now() ORDER BY created_at DESC", h.id),
        passkeys: await db.all("SELECT id, created_at FROM passkeys WHERE host_id=? ORDER BY created_at", h.id),
      };
    },

    // ---- passkeys ------------------------------------------------------------------------------
    async passkeyRegisterOptions(credential) {
      const h = await authHost(credential);
      const have = await db.all("SELECT id, transports FROM passkeys WHERE host_id=?", h.id);
      if (have.length >= MAX_PASSKEYS) throw fail(409, `Ko‘pi bilan ${MAX_PASSKEYS} ta passkey`);
      const options = await generateRegistrationOptions({
        rpName: "SilkRoad Experience OS", rpID: site.rpId, userName: h.name, userDisplayName: h.name, userID: new TextEncoder().encode(h.id), attestationType: "none",
        excludeCredentials: have.map((c) => ({ id: c.id, transports: c.transports })), authenticatorSelection: { residentKey: "required", userVerification: "required" },
      });
      return { id: await challenge(options.challenge, h.id), options };
    },
    async passkeyRegister(credential, body) {
      const h = await authHost(credential), c = await spend(body?.id);
      if (!c || c.host_id !== h.id || c.challenge.startsWith("email:")) throw passkeyFailed();
      let v;
      try { v = await verifyRegistrationResponse({ response: body.response, expectedChallenge: c.challenge, expectedOrigin: site.origin, expectedRPID: site.rpId, requireUserVerification: true }); } catch { throw passkeyFailed(); }
      if (!v.verified) throw passkeyFailed();
      const k = v.registrationInfo.credential;
      const r = await db.run("INSERT INTO passkeys (id,host_id,public_key,counter,transports) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING", k.id, h.id, Buffer.from(k.publicKey), k.counter, JSON.stringify(k.transports ?? []));
      if (!r.changes) throw fail(409, "Bu passkey allaqachon qo‘shilgan");
      await audit(h.id, "passkey_added", h.id);
      return { ok: true };
    },
    async passkeyRemove(credential, pid) {
      const h = await authHost(credential);
      const r = await db.run("DELETE FROM passkeys WHERE id=? AND host_id=?", String(pid ?? ""), h.id);
      if (r.changes) await audit(h.id, "passkey_removed", h.id);
      return { ok: true };
    },
    async passkeyLoginOptions() {
      const options = await generateAuthenticationOptions({ rpID: site.rpId, userVerification: "required" });
      return { id: await challenge(options.challenge), options };
    },
    async passkeyLogin(body, label) {
      const c = await spend(body?.id);
      const k = c && c.challenge !== "link" && !c.host_id && (await db.one("SELECT * FROM passkeys WHERE id=?", String(body.response?.id ?? "").slice(0, 2000)));
      if (!k) throw passkeyFailed();
      let v;
      try {
        v = await verifyAuthenticationResponse({ response: body.response, expectedChallenge: c.challenge, expectedOrigin: site.origin, expectedRPID: site.rpId, requireUserVerification: true,
          credential: { id: k.id, publicKey: new Uint8Array(k.public_key), counter: k.counter, transports: k.transports } });
      } catch { throw passkeyFailed(); }
      if (!v.verified) throw passkeyFailed();
      await db.run("UPDATE passkeys SET counter=? WHERE id=?", v.authenticationInfo.newCounter, k.id);
      return openSession(k.host_id, label);
    },
    /** Housekeeping. */
    cleanAccounts: async () => { await db.run("DELETE FROM sessions WHERE expires_at < now()"); await db.run("DELETE FROM challenges WHERE expires_at < ?", ago(0)); },
  };
}
