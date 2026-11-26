import os from "node:os";
import { runBot } from "./adapters/telegram.mjs";
import { aiEnabled } from "./ai/claude.mjs";
import { createApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { createDatabase } from "./db/database.mjs";
import { fillDemo } from "./demo.mjs";
import { seed } from "./seed.mjs";

const config = loadConfig();
if (config.problems.length) {
  console.error("Sozlamalarda muammo bor:\n- " + config.problems.join("\n- "));
  process.exit(1);
}
const db = createDatabase(config.databaseUrl, { ssl: config.dbSsl });
try {
  // With a separate owner account the running server itself cannot change the schema.
  if (config.migrateUrl !== config.databaseUrl) {
    const owner = createDatabase(config.migrateUrl, { max: 1, ssl: config.dbSsl });
    try { await owner.migrate({ grantTo: decodeURIComponent(new URL(config.databaseUrl).username) }); } finally { await owner.close(); }
  } else await db.migrate();
} catch (e) {
  console.error(`PostgreSQL: ${e.code ?? ""} ${e.message}\nBaza ishlayotganini tekshiring (mahalliy baza: npm run db:local).`);
  process.exit(1);
}

const app = await createApp({ db, config });
if (config.demoSite) await fillDemo(app);
else if (config.seed) await seed(db, app.core);
const stop = new AbortController();
app.server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `${config.port}-port band. Boshqa oynadagi serverni yoping yoki PORT ni o‘zgartiring.` : e.message);
  process.exit(1);
});
app.server.listen(config.port, config.host, () => {
  console.log(`SilkRoad Experience OS: ${config.publicUrl}   (AI: ${aiEnabled() ? "Claude" : "demo rejim"}, to‘lov: ${app.payments.methods().join(", ") || "o‘chiq"})`);
  if (config.host === "0.0.0.0" && !config.production) for (const i of Object.values(os.networkInterfaces()).flat()) if (i.family === "IPv4" && !i.internal) console.log(`Telefon uchun:  http://${i.address}:${config.port}`);
  if (!config.adminKey) console.log("Ma’muriyat sahifasi o‘chiq: ADMIN_KEY berilmagan");
});
app.startJobs();
if (config.telegramToken) runBot(app.core, config.telegramToken, { baseUrl: config.publicUrl, signal: stop.signal });

let closing = false;
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => {
  if (closing) return;
  closing = true;
  stop.abort();
  app.stopJobs();
  app.server.close(async () => { await db.close().catch(() => {}); process.exit(0); });
  app.server.closeIdleConnections();
  setTimeout(() => app.server.closeAllConnections(), 5000).unref(); // finish what is running, then stop
});
