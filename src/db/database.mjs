// PostgreSQL access. Every value is a bound parameter; there is no string-built SQL from user input anywhere.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

// BIGINT and NUMERIC sums fit a JS number here (whole so'm, far below 2^53). Dates stay plain text; instants become ISO text.
const num = (v) => {
  const n = Number(v);
  if (Number.isInteger(n) && !Number.isSafeInteger(n)) throw new RangeError("number too large");
  return n;
};
const PARSERS = { 20: num, 1700: num, 1082: (v) => v, 1114: (v) => v, 1184: (v) => new Date(v).toISOString() };
const types = { getTypeParser: (oid, format) => (format !== "binary" && PARSERS[oid]) || pg.types.getTypeParser(oid, format) };

const cache = new Map();
/** Turns `?` placeholders into $1, $2 … leaving quoted strings alone. */
export function placeholders(sql) {
  let out = cache.get(sql);
  if (!out) {
    let n = 0;
    out = sql.replace(/'(?:[^']|'')*'|\?/g, (m) => (m === "?" ? `$${++n}` : m));
    if (cache.size < 2000) cache.set(sql, out);
  }
  return out;
}

export function createDatabase(url, { max = 10, ssl, idle = 30_000 } = {}) {
  const pool = new pg.Pool({ connectionString: url, max, types, ssl, connectionTimeoutMillis: 10_000, idleTimeoutMillis: idle, statement_timeout: 15_000, idle_in_transaction_session_timeout: 20_000, application_name: "silkroad" });
  pool.on("error", (e) => console.error("[db] idle connection:", e.code ?? e.message));
  const current = new AsyncLocalStorage(); // the open transaction, if any

  const query = (sql, params) => (current.getStore()?.client ?? pool).query(placeholders(sql), params);
  const flush = (list) => { for (const fn of list) Promise.resolve().then(fn).catch((e) => console.error("[after commit]", e.message)); };

  const db = {
    all: async (sql, ...p) => (await query(sql, p)).rows,
    one: async (sql, ...p) => (await query(sql, p)).rows[0],
    run: async (sql, ...p) => ({ changes: (await query(sql, p)).rowCount }),
    /** Runs fn in one transaction. A call inside another transaction joins it.
     *  fn may run again after a deadlock, so it must only touch the database; use afterCommit for anything else. */
    async tx(fn) {
      if (current.getStore()) return fn();
      for (let attempt = 1; ; attempt++) {
        const client = await pool.connect(), store = { client, after: [] };
        let broken = null;
        try {
          await client.query("BEGIN");
          const v = await current.run(store, fn);
          await client.query("COMMIT");
          current.exit(() => flush(store.after));
          return v;
        } catch (e) {
          try { await client.query("ROLLBACK"); } catch (x) { broken = x; }
          // Two transactions waited for each other: PostgreSQL cancelled this one, so it is safe to run again.
          if (!["40P01", "40001"].includes(e.code) || attempt >= 4) throw e;
        } finally { client.release(broken ?? undefined); }
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 30));
      }
    },
    /** Side effects such as notifications wait until the data is really saved. */
    afterCommit(fn) { const s = current.getStore(); s ? s.after.push(fn) : flush([fn]); },
    /** `grantTo` is the restricted account the server runs as: rows only, no schema changes, audit log append only. */
    async migrate({ grantTo } = {}) {
      const client = await pool.connect();
      try {
        await client.query("SELECT pg_advisory_lock(7411001)");
        await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now())");
        const done = new Map((await client.query("SELECT name, checksum FROM schema_migrations")).rows.map((r) => [r.name, r.checksum]));
        for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
          const sql = readFileSync(path.join(MIGRATIONS, name), "utf8").replace(/\r\n/g, "\n"), sum = createHash("sha256").update(sql).digest("hex");
          if (done.has(name)) {
            if (done.get(name) !== sum) throw new Error(`Migration ${name} was edited after it ran. Add a new file instead`);
            continue;
          }
          await client.query("BEGIN");
          try {
            await client.query(sql);
            await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [name, sum]);
            await client.query("COMMIT");
          } catch (e) { await client.query("ROLLBACK"); throw e; }
        }
        if (grantTo) {
          const role = client.escapeIdentifier(grantTo);
          await client.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${role};
            GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role};
            REVOKE UPDATE, DELETE ON audit_log FROM ${role}; REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM ${role};`);
        }
      } finally {
        await client.query("SELECT pg_advisory_unlock(7411001)").catch(() => {});
        client.release();
      }
    },
    ping: async () => { await pool.query("SELECT 1"); return true; },
    close: () => pool.end(),
  };
  return db;
}
