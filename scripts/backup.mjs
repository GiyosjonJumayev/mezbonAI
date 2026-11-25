// Backs up the database and photos, keeps the newest copies, and can prove that a backup really restores.
//   npm run backup                 makes backups/<date>.dump and copies new photos
//   npm run backup -- --verify     also restores it into a throw-away database and compares row counts
// Restore for real:  pg_restore --clean --if-exists --no-owner -d "$MIGRATE_URL" backups/<date>.dump
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadConfig, ROOT } from "../src/config.mjs";
import { findBin } from "./localdb.mjs";

const config = loadConfig(), url = config.migrateUrl, KEEP = Number(process.env.BACKUP_KEEP) || 14;
if (!url) { console.error("MIGRATE_URL yoki DATABASE_URL kerak"); process.exit(1); }
const bin = findBin(), dir = process.env.BACKUP_DIR || path.join(ROOT, "backups"), file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.dump`);
mkdirSync(dir, { recursive: true });

/** The password travels in the environment, so it never appears in the process list. */
function connect(u) {
  const x = new URL(u), env = { ...process.env, PGPASSWORD: decodeURIComponent(x.password) };
  x.password = "";
  return { arg: x.href, env };
}
const main = connect(url);
try { execFileSync(bin("pg_dump"), ["--format=custom", "--no-owner", "--no-privileges", `--file=${file}`, "--dbname", main.arg], { env: main.env, stdio: ["ignore", "inherit", "inherit"] }); } catch {
  rmSync(file, { force: true }); // half a backup is worse than none
  console.error("Zaxira olinmadi");
  process.exit(1);
}
const photos = path.join(config.dataDir, "photos");
if (existsSync(photos)) cpSync(photos, path.join(dir, "photos"), { recursive: true, force: false, errorOnExist: false });
const old = readdirSync(dir).filter((f) => f.endsWith(".dump")).sort().reverse().slice(KEEP);
for (const f of old) rmSync(path.join(dir, f));
console.log(`Zaxira: ${path.relative(ROOT, file)}${old.length ? ` (${old.length} eski nusxa o‘chirildi)` : ""}`);

if (process.argv.includes("--verify")) {
  const name = `verify_${randomBytes(5).toString("hex")}`, u = new URL(url);
  u.pathname = `/${name}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const copy = new pg.Client({ connectionString: u.href });
  try {
    const t = connect(u.href);
    execFileSync(bin("pg_restore"), ["--no-owner", "--exit-on-error", "--dbname", t.arg, file], { env: t.env, stdio: ["ignore", "inherit", "inherit"] });
    await copy.connect();
    const tables = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows.map((r) => r.tablename);
    const count = async (c, x) => (await c.query(`SELECT COUNT(*)::int n FROM ${c.escapeIdentifier(x)}`)).rows[0].n;
    let bad = 0;
    for (const x of tables) { const [a, b] = [await count(admin, x), await count(copy, x)]; if (a !== b) { bad++; console.error(`${x}: ${a} / ${b}`); } }
    console.log(bad ? `${bad} jadval mos kelmadi (server ishlab turgan bo‘lsa, bu yangi yozuvlar bo‘lishi mumkin)` : `Tiklash tekshirildi: ${tables.length} jadval mos`);
    process.exitCode = bad ? 1 : 0;
  } finally {
    await copy.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}
