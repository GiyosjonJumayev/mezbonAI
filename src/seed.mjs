import { extractFacts, templateI18n } from "./ai/extract.mjs";

const HOSTS = [
  ["Gulnora opa", "Xivada gilam to'qish, 2 soat, 130 ming so'm, 6 kishi"],
  ["Anvar novvoy", "Samarqandda tandirda non yopamiz, 90 daqiqa, 100 ming so'm, 5 kishi"],
  ["Zulfiya opa", "Buxoroda uyimda palov damlashni o'rgataman, uch soat, ikki yuz ming so'm, 10 kishi"],
  ["Nodira opa", "Marg'ilonda atlas to'qiymiz, bir yarim soat, 120 ming so'm, 6 kishi"],
];
const HOTELS = [["registon", "Registon Plaza (namuna)", "samarqand"], ["ark", "Ark Boutique (namuna)", "buxoro"], ["vodiy", "Vodiy Guest House (namuna)", "fargona"]];
const SEARCHES = { surxondaryo: 14, qashqadaryo: 11, qoraqalpogiston: 9, namangan: 6, jizzax: 5, navoiy: 3, samarqand: 18, buxoro: 12, fargona: 8, xorazm: 10 };

/** Sample content for an empty database, marked as demo wherever it is stored and shown. Never runs in production. */
export function seed(db, core) {
  return db.tx(async () => {
    await db.one("SELECT pg_advisory_xact_lock(7411002)");
    if ((await db.one("SELECT COUNT(*) n FROM hosts")).n) return false;
    const covered = new Set();
    for (const [i, [name, text]] of HOSTS.entries()) {
      const h = await core.createHost(name, { demo: true }), f = extractFacts(text), t = new Date(Date.now() - (HOSTS.length - i) * 1000).toISOString();
      covered.add(f.region);
      await db.run(`INSERT INTO listings (id,host_id,status,category,region,place,price_uzs,duration_min,capacity,weekdays,times,transcript,i18n,engine,created_at,published_at)
        VALUES (?,?,'published',?,?,?,?,?,?,?,?,?,?,'demo',?,?)`, "l_" + h.id.slice(2), h.id, f.category, f.region, f.place, f.price_uzs, f.duration_min, f.capacity,
        JSON.stringify([1, 2, 3, 4, 5, 6, 7]), JSON.stringify(["10:00", "15:00"]), text, JSON.stringify(templateI18n(f, name)), t, t);
    }
    for (const h of HOTELS) await db.run("INSERT INTO hotels (code,name,region) VALUES (?,?,?)", ...h);
    for (const [r, n] of Object.entries(SEARCHES)) await db.run("INSERT INTO searches (region,results,lang,source,demo) SELECT ?, ?, 'en', 'seed', true FROM generate_series(1, ?::int)", r, covered.has(r) ? 1 : 0, n);
    return true;
  });
}
