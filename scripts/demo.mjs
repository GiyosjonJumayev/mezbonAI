// A complete, throw-away demonstration for a pitch: its own database, a month of sample activity, test payments only.
// Every provider in it is marked as a sample. Your real database is not touched.
//   npm run demo            fresh data on http://localhost:4322
//   PORT=5000 npm run demo
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { createApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { createDatabase } from "../src/db/database.mjs";
import { fillDemo } from "../src/demo.mjs";
import { startLocal } from "./localdb.mjs";

const port = Number(process.env.PORT) || 4322, name = "silkroad_demo", adminKey = `demo-${randomBytes(12).toString("hex")}`;
const local = await startLocal();
const c = new pg.Client({ connectionString: local.owner.replace(/[^/]+$/, "postgres") });
await c.connect();
await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
await c.query(`CREATE DATABASE ${name}`);
await c.end();
const at = (u) => u.replace(/[^/]+$/, name), owner = createDatabase(at(local.owner), { max: 1 });
await owner.migrate({ grantTo: "silkroad_app" });
await owner.close();

const db = createDatabase(at(local.app));
const config = { ...loadConfig({ DATABASE_URL: at(local.app), PORT: String(port), ADMIN_KEY: adminKey, ADMIN_TOTP: process.env.DEMO_TOTP, PUBLIC_URL: `http://localhost:${port}` }), dataDir: mkdtempSync(path.join(os.tmpdir(), "silkroad-demo-")) };
// E-mails of the demo are printed here instead of being sent.
config.mail ??= { url: "smtp://demo", from: "SilkRoad <demo@localhost>" };
const mailer = { sendMail: async (m) => { if (app?.server.listening) console.log(`[email] ${m.to}: ${m.subject}
${m.text}
`); } };
const app = await createApp({ db, config, telegram: null, pushSend: async () => {}, mailer });
const out = { ...(await fillDemo(app)), adminKey };
await new Promise((r) => setTimeout(r, 1500)); // let the last notifications be written
await db.run("DELETE FROM emails"); // only what happens during the demo is worth showing
if (process.env.DEMO_OUT) writeFileSync(process.env.DEMO_OUT, JSON.stringify(out));
app.server.listen(port, process.env.HOST || "127.0.0.1", () => console.log(`
Namoyish tayyor (barcha ma'lumot namuna, pul yechilmaydi):
  Sayohatchi   http://localhost:${port}/
  Reja         http://localhost:${port}/?plan=1
  Kabinet      http://localhost:${port}/mezbon#kirish=${out.key}
  Ma'muriyat   http://localhost:${port}/admin   kalit: ${adminKey}
  Talab        http://localhost:${port}/panel
  Sahna        http://localhost:${port}/stage
To'xtatish: Ctrl+C`));
app.startJobs();
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { app.stopJobs(); app.server.closeAllConnections(); app.server.close(() => db.close().then(() => process.exit(0))); });
