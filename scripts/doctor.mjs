// Checks a real installation before launch, from the outside where possible. It never moves money and sends no e-mail.
//   npm run doctor
import { createHash } from "node:crypto";
import tls from "node:tls";
import nodemailer from "nodemailer";
import { loadConfig } from "../src/config.mjs";
import { createDatabase } from "../src/db/database.mjs";

const config = loadConfig();
let bad = 0, skipped = 0;
const ok = (t) => console.log(`  ✓ ${t}`), no = (t) => { bad++; console.log(`  ✗ ${t}`); }, skip = (t) => { skipped++; console.log(`  – ${t}`); };
const check = async (label, fn) => { try { const r = await fn(); r === true ? ok(label) : no(`${label}: ${r}`); } catch (e) { no(`${label}: ${e.cause?.code ?? e.code ?? e.message}`); } };
const get = (path, init) => fetch(config.publicUrl + path, { redirect: "error", signal: AbortSignal.timeout(15_000), ...init });

console.log("Sozlamalar");
config.problems.length ? config.problems.forEach(no) : ok("ziddiyat yo‘q");
config.production ? ok("ishlab chiqarish rejimi") : skip("NODE_ENV=production emas");
config.adminKey ? ok("ADMIN_KEY bor") : skip("ADMIN_KEY yo‘q: /admin yopiq");
config.adminTotp ? ok("ikki bosqichli ma’muriyat kirishi") : skip("ADMIN_TOTP yo‘q: npm run admin:totp");

console.log("Baza");
if (config.databaseUrl) {
  const db = createDatabase(config.databaseUrl, { max: 2, ssl: config.dbSsl });
  await check("ulanish", () => db.ping());
  await check("migratsiyalar", async () => (await db.one("SELECT COUNT(*) n FROM schema_migrations")).n > 0 || "bajarilmagan, serverni bir marta ishga tushiring");
  await check("server hisobi jadvallarni o‘zgartira olmaydi", async () => { try { await db.tx(async () => { await db.run("CREATE TABLE doctor_probe (a int)"); throw new Error("probe"); }); } catch (e) { return e.code === "42501" || "cheklanmagan hisob ishlatilmoqda (DATABASE_URL va MIGRATE_URL alohida bo‘lsin)"; } });
  await check("jurnalni o‘zgartirib bo‘lmaydi", async () => { try { await db.tx(async () => { await db.run("DELETE FROM audit_log"); throw new Error("probe"); }); } catch (e) { return e.code === "42501" || /append only/.test(e.message) || "himoyasiz"; } });
  await db.close().catch(() => {});
}

console.log(`Sayt: ${config.publicUrl}`);
let up = false;
await check("javob beradi", async () => { const r = await get("/healthz"); up = r.ok; return r.ok || `HTTP ${r.status}`; });
if (up) {
  await check("xavfsizlik sarlavhalari", async () => { const h = (await get("/")).headers; return (/default-src 'self'/.test(h.get("content-security-policy") ?? "") && (!config.https || h.has("strict-transport-security"))) || "yetishmayapti"; });
  await check("boshqa saytdan so‘rov rad etiladi", async () => (await get("/api/hosts", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" })).status === 403 || "qabul qilindi");
  if (config.https) await check("HTTPS sertifikati", () => new Promise((done, fail) => { const u = new URL(config.publicUrl), s = tls.connect(Number(u.port) || 443, u.hostname, { servername: u.hostname }, () => { const days = Math.round((new Date(s.getPeerCertificate().valid_to) - Date.now()) / 864e5); s.end(); done(days > 7 || `${days} kun qoldi`); }); s.on("error", fail); }));
}

console.log("To‘lovlar");
if (!config.octo && !config.payme && !config.click) skip("ulanmagan. Qadamlar: docs/LAUNCH.md");
const rpc = async (auth, body) => (await (await get("/pay/payme", { method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body: JSON.stringify(body) })).json()).error?.code;
if (config.payme && up) {
  const basic = (k) => "Basic " + Buffer.from(`${config.payme.login}:${k}`).toString("base64"), ask = { id: 1, method: "CheckPerformTransaction", params: { amount: 100, account: { order_id: "doctor" } } };
  await check("Payme: noto‘g‘ri kalit rad etiladi", async () => { const c = await rpc(basic("wrong"), ask); return c === -32504 || `javob ${c}`; });
  config.payme.ips ? skip("Payme: PAYME_CHECK_IP yoqilgan, kalitni faqat Payme tekshira oladi") : await check("Payme: kalit va protokol", async () => { const c = await rpc(basic(config.payme.key), ask); return c === -31050 || `javob ${c}`; });
}
if (config.click && up) {
  const c = config.click, call = async (secret) => {
    const q = { click_trans_id: "1", service_id: c.serviceId, click_paydoc_id: "1", merchant_trans_id: "doctor", amount: "1000", action: "0", error: "0", error_note: "", sign_time: "2026-01-01 00:00:00" };
    q.sign_string = createHash("md5").update(`1${c.serviceId}${secret}doctor10000${q.sign_time}`).digest("hex");
    return (await (await get("/pay/click", { method: "POST", body: new URLSearchParams(q) })).json()).error;
  };
  await check("Click: noto‘g‘ri imzo rad etiladi", async () => { const r = await call("wrong"); return r === -1 || `javob ${r}`; });
  await check("Click: kalit va protokol", async () => { const r = await call(c.secret); return r === -5 || `javob ${r}`; });
}
if (config.octo) await check("Octo: xizmat javob beradi (kalitni Octo tekshiradi)", async () => {
  const r = await (await fetch("https://secure.octo.uz/prepare_payment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ octo_shop_id: config.octo.shopId, octo_secret: config.octo.secret, shop_transaction_id: "doctor-no-such-payment" }), signal: AbortSignal.timeout(15_000) })).json();
  console.log(`    Octo javobi: ${r.error} ${String(r.errMessage ?? r.errorMessage ?? "").slice(0, 120)}. “Topilmadi” bo‘lsa kalit to‘g‘ri, “avtorizatsiya” bo‘lsa noto‘g‘ri.`);
  return true;
});
config.fiscal || (!config.octo && !config.payme) || skip("fiskal ma’lumot yo‘q: shartnomangiz talab qilsa, FISCAL_* ni kiriting");
if (config.testPayments) (config.octo || config.payme || config.click ? no : skip)("sinov to‘lovi yoqilgan");

console.log("Xabarlar");
if (config.mail) await check("pochta serveri kirishga ruxsat berdi", () => nodemailer.createTransport(config.mail.url, { connectionTimeout: 15_000 }).verify()); else skip("SMTP_URL yo‘q: email va bronni topish o‘chiq");
if (config.telegramToken) await check("Telegram bot", async () => { const r = await (await fetch(`https://api.telegram.org/bot${config.telegramToken}/getMe`, { signal: AbortSignal.timeout(15_000) })).json(); return r.ok || r.description; }); else skip("Telegram bot ulanmagan");
process.env.ANTHROPIC_API_KEY ? skip("Claude kaliti bor, lekin bu tekshiruv pullik so‘rov yubormaydi") : skip("Claude kaliti yo‘q: demo rejim");

console.log(`\n${bad ? `${bad} ta muammo` : "Muammo topilmadi"}${skipped ? `, ${skipped} ta band sozlanmagan yoki o‘tkazib yuborildi` : ""}`);
process.exitCode = bad ? 1 : 0; // open connections close by themselves
