// Runs the tests on a real PostgreSQL. Each test gets its own copy of a freshly migrated database,
// and uses it through the same restricted account as production.
//   TEST_DATABASE_URL  an account that may create databases and roles (used in CI); otherwise a private local cluster is started
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDatabase } from "../src/db/database.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let admin = process.env.TEST_DATABASE_URL;
if (!admin) {
  const { startLocal } = await import("./localdb.mjs");
  admin = (await startLocal({ dir: path.join(ROOT, "data", "pgtest"), port: 54331, name: "silkroad_test", fast: true })).owner;
}
const run = "t" + randomBytes(4).toString("hex"), role = `${run}_app`, pass = randomBytes(12).toString("hex");
const at = (db, app) => { const u = new URL(admin); u.pathname = `/${db}`; if (app) { u.username = role; u.password = pass; } return u.href; };
const c = new pg.Client({ connectionString: at("postgres") });
await c.connect();
await c.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pass}'`);
await c.query(`CREATE DATABASE ${run}`);
const owner = createDatabase(at(run), { max: 1 });
await owner.migrate({ grantTo: role });
await owner.close();
console.log((await c.query("SELECT split_part(version(), ' on ', 1) v")).rows[0].v);

const files = process.argv.slice(2);
if (!files.length) files.push(...readdirSync(path.join(ROOT, "test")).filter((f) => f.endsWith(".test.mjs")).map((f) => `test/${f}`));
const env = { ...process.env, TEST_ADMIN_URL: at("postgres"), TEST_TEMPLATE: run, TEST_APP_URL: at("postgres", true), MEZBON_OFFLINE: "1" };
const child = spawn(process.execPath, ["--test", "--test-concurrency=4", ...files], { cwd: ROOT, stdio: "inherit", env });
child.on("exit", async (code) => {
  for (const { datname } of (await c.query("SELECT datname FROM pg_database WHERE datname LIKE $1", [`${run}%`])).rows) await c.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
  await c.query(`DROP ROLE ${role}`);
  await c.end();
  process.exit(code ?? 1);
});
