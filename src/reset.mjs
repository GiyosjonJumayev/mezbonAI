import { rmSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db.mjs";

for (const f of ["mezbon.db", "mezbon.db-wal", "mezbon.db-shm"]) rmSync(path.join(DATA_DIR, f), { force: true });
console.log("Baza tozalandi. Keyingi `npm start` namunaviy ma'lumotlarni qayta yaratadi.");
