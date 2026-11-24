import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.MEZBON_DATA ?? path.join(ROOT, "data");

const BOOKINGS = (name) => `
  CREATE TABLE ${name} (
    id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    date TEXT NOT NULL, time TEXT NOT NULL, guests INTEGER NOT NULL,
    guest_name TEXT NOT NULL, lang TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('web','hotel','ai')),
    hotel_code TEXT REFERENCES hotels(code),
    status TEXT NOT NULL CHECK (status IN ('pending','paid','confirmed','declined','cancelled')),
    total_uzs INTEGER NOT NULL, platform_uzs INTEGER NOT NULL,
    hotel_uzs INTEGER NOT NULL, host_uzs INTEGER NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT);`;

// Append only. PRAGMA user_version counts how many have run.
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS hosts (
     id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
     telegram_chat TEXT UNIQUE, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS listings (
     id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id),
     status TEXT NOT NULL CHECK (status IN ('draft','published','paused')),
     category TEXT NOT NULL, region TEXT, place TEXT,
     price_uzs INTEGER, duration_min INTEGER, capacity INTEGER,
     weekdays TEXT NOT NULL, times TEXT NOT NULL, cert_no TEXT,
     transcript TEXT NOT NULL, i18n TEXT NOT NULL, photo TEXT, engine TEXT NOT NULL,
     created_at TEXT NOT NULL, published_at TEXT);
   CREATE TABLE IF NOT EXISTS hotels (code TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL);
   ${BOOKINGS("IF NOT EXISTS bookings")}
   CREATE INDEX IF NOT EXISTS bookings_slot ON bookings(listing_id, date, time);
   CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY, booking_id TEXT NOT NULL REFERENCES bookings(id),
     sender TEXT NOT NULL CHECK (sender IN ('guest','host')),
     original TEXT NOT NULL, lang TEXT NOT NULL, translated TEXT NOT NULL,
     translated_lang TEXT NOT NULL, engine TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS searches (
     id INTEGER PRIMARY KEY, region TEXT, category TEXT, results INTEGER NOT NULL,
     lang TEXT, source TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);`,

  // v2: guest cancellation, reviews, hand-edited texts, closed dates
  `${BOOKINGS("bookings_v2")}
   INSERT INTO bookings_v2 SELECT id,token,listing_id,date,time,guests,guest_name,lang,channel,hotel_code,status,total_uzs,platform_uzs,hotel_uzs,host_uzs,created_at,expires_at FROM bookings;
   DROP TABLE bookings;
   ALTER TABLE bookings_v2 RENAME TO bookings;
   CREATE INDEX bookings_slot ON bookings(listing_id, date, time);
   ALTER TABLE listings ADD COLUMN edited TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE listings ADD COLUMN closed TEXT NOT NULL DEFAULT '[]';
   CREATE TABLE reviews (
     booking_id TEXT PRIMARY KEY REFERENCES bookings(id), listing_id TEXT NOT NULL REFERENCES listings(id),
     rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5), text TEXT, lang TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE INDEX reviews_listing ON reviews(listing_id);
   CREATE INDEX messages_booking ON messages(booking_id);
   CREATE INDEX listings_host ON listings(host_id);`,
];

export function openDb(file) {
  if (!file) {
    mkdirSync(path.join(DATA_DIR, "photos"), { recursive: true });
    file = path.join(DATA_DIR, "mezbon.db");
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
  // Table rebuilds need foreign keys off; the pragma has no effect inside a transaction.
  db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  try {
    const { user_version: from } = db.prepare("PRAGMA user_version").get();
    for (const sql of MIGRATIONS.slice(from)) db.exec(sql);
    if (from < MIGRATIONS.length) {
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length) throw new Error("Migration would break references");
      db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
