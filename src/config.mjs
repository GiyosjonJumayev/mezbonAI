// One place that reads the environment. The server refuses to start with an unsafe combination.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { base32 } from "./lib/totp.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env = process.env) {
  const problems = [], production = env.NODE_ENV === "production";
  const publicUrl = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT || 4321}`).replace(/\/+$/, "");
  let site;
  try { site = new URL(publicUrl); } catch { problems.push("PUBLIC_URL noto‘g‘ri"); site = new URL("http://localhost"); }
  const https = site.protocol === "https:";

  const pair = (a, b) => { if (Boolean(env[a]) !== Boolean(env[b])) problems.push(`${a} va ${b} birga berilishi kerak`); return env[a] && env[b]; };
  const octo = pair("OCTO_SHOP_ID", "OCTO_SECRET") ? { shopId: Number(env.OCTO_SHOP_ID), secret: env.OCTO_SECRET, test: env.OCTO_TEST === "1" } : null;
  const payme = pair("PAYME_MERCHANT_ID", "PAYME_KEY") ? {
    merchant: env.PAYME_MERCHANT_ID, key: env.PAYME_KEY, login: env.PAYME_LOGIN || "Paycom", test: env.PAYME_TEST === "1",
    checkout: (env.PAYME_CHECKOUT_URL || (env.PAYME_TEST === "1" ? "https://test.paycom.uz" : "https://checkout.paycom.uz")).replace(/\/+$/, ""),
    ips: env.PAYME_CHECK_IP === "1" ? Array.from({ length: 15 }, (_, i) => `185.234.113.${i + 1}`) : null,
  } : null;
  const clickKeys = ["CLICK_SERVICE_ID", "CLICK_MERCHANT_ID", "CLICK_MERCHANT_USER_ID", "CLICK_SECRET"], clickSet = clickKeys.filter((k) => env[k]).length;
  if (clickSet && clickSet < clickKeys.length) problems.push(`${clickKeys.join(", ")} birga berilishi kerak`);
  const click = clickSet === clickKeys.length ? { serviceId: env.CLICK_SERVICE_ID, merchantId: env.CLICK_MERCHANT_ID, userId: env.CLICK_MERCHANT_USER_ID, secret: env.CLICK_SECRET } : null;
  if (click && !/^\d+$/.test(click.serviceId)) problems.push("CLICK_SERVICE_ID butun son bo‘lishi kerak");
  if (octo && !Number.isInteger(octo.shopId)) problems.push("OCTO_SHOP_ID butun son bo‘lishi kerak");
  if ((octo || payme || click) && !https) problems.push("Haqiqiy to‘lov uchun PUBLIC_URL https:// bilan boshlanishi kerak");
  const fiscalKeys = ["FISCAL_INN", "FISCAL_SPIC", "FISCAL_PACKAGE"], fiscalSet = fiscalKeys.filter((k) => env[k]).length;
  if (fiscalSet && fiscalSet < 3) problems.push(`${fiscalKeys.join(", ")} birga berilishi kerak`);
  const fiscal = fiscalSet === 3 ? { inn: env.FISCAL_INN, spic: env.FISCAL_SPIC, pack: env.FISCAL_PACKAGE, vat: Number(env.FISCAL_VAT) || 0 } : null;

  if (Boolean(env.SMTP_URL) !== Boolean(env.MAIL_FROM)) problems.push("SMTP_URL va MAIL_FROM birga berilishi kerak");
  if (env.SMTP_URL && !/^smtps?:\/\//.test(env.SMTP_URL)) problems.push("SMTP_URL smtp:// yoki smtps:// bilan boshlanishi kerak");
  const mail = env.SMTP_URL && env.MAIL_FROM ? { url: env.SMTP_URL, from: env.MAIL_FROM } : null;
  const adminTotp = env.ADMIN_TOTP || null;
  if (adminTotp && !base32(adminTotp)) problems.push("ADMIN_TOTP noto‘g‘ri. Yaratish: npm run admin:totp");
  const adminKey = env.ADMIN_KEY || null;
  if (adminKey && adminKey.length < 24) problems.push("ADMIN_KEY kamida 24 belgi bo‘lsin");
  if (!env.DATABASE_URL) problems.push("DATABASE_URL yo‘q. Mahalliy baza uchun: npm run db:local");
  // Test payments must never be reachable on a real deployment by accident.
  // A public demonstration: sample data, test payments, clearly marked. Never together with real money.
  const demoSite = env.DEMO_SITE === "1";
  if (demoSite && (octo || payme || click)) problems.push("DEMO_SITE va haqiqiy to‘lov birga ishlamaydi");
  const testPayments = env.ALLOW_TEST_PAYMENTS === "1" || demoSite || (!production && !octo && !payme && !click);
  if (production) {
    if (!https) problems.push("Ishlab chiqarishda PUBLIC_URL https:// bo‘lishi shart");
    if (!adminKey) problems.push("Ishlab chiqarishda ADMIN_KEY shart");
  }
  return {
    production, publicUrl, https, origin: site.origin, rpId: site.hostname, problems,
    databaseUrl: env.DATABASE_URL, migrateUrl: env.MIGRATE_URL || env.DATABASE_URL, dbSsl: env.DATABASE_SSL === "1" ? { rejectUnauthorized: true } : undefined,
    port: Number(env.PORT) || 4321, host: env.HOST || "127.0.0.1", trustProxy: env.TRUST_PROXY === "1",
    dataDir: env.MEZBON_DATA || path.join(ROOT, "data"), seed: demoSite || (env.SEED !== "0" && !production), demoSite, stage: demoSite || (!production && testPayments), usdRate: Number(env.USD_RATE) || null,
    octo, payme, click, fiscal, testPayments, adminKey, adminTotp, mail,
    telegramToken: env.TELEGRAM_BOT_TOKEN || null, pushContact: env.PUSH_CONTACT || (https ? publicUrl : "mailto:noreply@example.com"),
    retentionDays: Math.max(30, Number(env.RETENTION_DAYS) || 365),
  };
}
