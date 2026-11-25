// A private PostgreSQL for development, using the PostgreSQL already installed on this computer.
// It has its own folder, port and random passwords, and never touches your other databases.
//   node scripts/localdb.mjs start | stop | reset
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function findBin() {
  const exe = process.platform === "win32" ? ".exe" : "";
  const dirs = [process.env.PG_BIN, ...(process.env.PATH ?? "").split(path.delimiter)];
  const base = process.platform === "win32" ? "C:/Program Files/PostgreSQL" : "/usr/lib/postgresql";
  if (existsSync(base)) for (const v of readdirSync(base).sort((a, b) => Number(b) - Number(a))) dirs.push(path.join(base, v, "bin"));
  const found = dirs.find((d) => d && existsSync(path.join(d, "initdb" + exe)) && existsSync(path.join(d, "pg_ctl" + exe)));
  if (!found) throw new Error("PostgreSQL topilmadi. https://www.postgresql.org/download/ dan o‘rnating yoki PG_BIN ni ko‘rsating");
  return (name) => path.join(found, name + exe);
}

/** Creates (once) and starts a cluster. `fast` is for throw-away test data only. Returns connection strings for the owner and the restricted app role. */
export async function startLocal({ dir = path.join(ROOT, "data", "pg"), port = 54330, name = "silkroad", fast = false } = {}) {
  const bin = findBin(), cluster = path.join(dir, "cluster"), secretFile = path.join(dir, "secrets.json");
  mkdirSync(dir, { recursive: true });
  let s = existsSync(secretFile) ? JSON.parse(readFileSync(secretFile, "utf8")) : null;
  if (!s || !existsSync(path.join(cluster, "PG_VERSION"))) {
    rmSync(cluster, { recursive: true, force: true });
    s = { owner: randomBytes(18).toString("hex"), app: randomBytes(18).toString("hex"), port };
    const pw = path.join(dir, "pw.tmp");
    writeFileSync(pw, s.owner, { mode: 0o600 });
    try { execFileSync(bin("initdb"), ["-D", cluster, "-U", "silkroad_owner", "-A", "scram-sha-256", "-E", "UTF8", "--locale=C", `--pwfile=${pw}`], { stdio: "pipe" }); } finally { rmSync(pw, { force: true }); }
    writeFileSync(path.join(cluster, "postgresql.auto.conf"), `listen_addresses = '127.0.0.1'\nport = ${port}\nmax_connections = 60\nlog_min_messages = fatal\nunix_socket_directories = ''\n${fast ? "fsync = off\nsynchronous_commit = off\nfull_page_writes = off\n" : ""}`);
    writeFileSync(secretFile, JSON.stringify(s), { mode: 0o600 });
  }
  const up = spawnSync(bin("pg_ctl"), ["-D", cluster, "status"], { stdio: "ignore" }).status === 0;
  if (!up) {
    const r = spawnSync(bin("pg_ctl"), ["-D", cluster, "-l", path.join(dir, "postgres.log"), "-w", "-t", "60", "start"], { stdio: "ignore" });
    if (r.status !== 0) throw new Error(`PostgreSQL ishga tushmadi. Jurnal: ${path.join(dir, "postgres.log")}`);
  }
  const url = (user, pass, d) => `postgres://${user}:${pass}@127.0.0.1:${s.port}/${d}`;
  const admin = new pg.Client({ connectionString: url("silkroad_owner", s.owner, "postgres") });
  await admin.connect();
  try {
    if (!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='silkroad_app'")).rowCount) await admin.query(`CREATE ROLE silkroad_app LOGIN PASSWORD '${s.app}'`);
    if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount) await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
  } finally { await admin.end(); }
  return { owner: url("silkroad_owner", s.owner, name), app: url("silkroad_app", s.app, name), bin, cluster, stop: () => spawnSync(bin("pg_ctl"), ["-D", cluster, "-m", "fast", "stop"], { stdio: "ignore" }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const what = process.argv[2] ?? "start", dir = path.join(ROOT, "data", "pg");
  if (what === "stop" || what === "reset") {
    try { spawnSync(findBin()("pg_ctl"), ["-D", path.join(dir, "cluster"), "-m", "fast", "stop"], { stdio: "ignore" }); } catch {}
    if (what === "reset") rmSync(dir, { recursive: true, force: true });
    console.log(what === "reset" ? "Mahalliy baza o‘chirildi" : "Mahalliy baza to‘xtatildi");
  } else {
    const c = await startLocal();
    const file = path.join(ROOT, ".env"), old = existsSync(file) ? readFileSync(file, "utf8") : "";
    const keep = old.split(/\r?\n/).filter((l) => !/^(DATABASE_URL|MIGRATE_URL)=/.test(l)).join("\n").trimEnd();
    writeFileSync(file, `${keep ? keep + "\n" : ""}DATABASE_URL=${c.app}\nMIGRATE_URL=${c.owner}\n`, { mode: 0o600 });
    console.log("PostgreSQL ishlayapti (127.0.0.1). Ulanish manzili .env fayliga yozildi.");
  }
}
