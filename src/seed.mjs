import { extractFacts, templateI18n } from "./extract.mjs";

const HOSTS = [
  ["Gulnora opa", "Xivada gilam to'qish, 2 soat, 130 ming so'm, 6 kishi"],
  ["Anvar novvoy", "Samarqandda tandirda non yopamiz, 90 daqiqa, 100 ming so'm, 5 kishi"],
  ["Zulfiya opa", "Buxoroda uyimda palov damlashni o'rgataman, uch soat, ikki yuz ming so'm, 10 kishi"],
  ["Nodira opa", "Marg'ilonda atlas to'qiymiz, bir yarim soat, 120 ming so'm, 6 kishi"],
];
const HOTELS = [["registon", "Registon Plaza (namuna)", "samarqand"], ["ark", "Ark Boutique (namuna)", "buxoro"], ["vodiy", "Vodiy Guest House (namuna)", "fargona"]];
const SEARCHES = { surxondaryo: 14, qashqadaryo: 11, qoraqalpogiston: 9, namangan: 6, jizzax: 5, navoiy: 3, samarqand: 18, buxoro: 12, fargona: 8, xorazm: 10 };

/** Sample content, marked as demo wherever it is stored and shown. */
export function seed(db, core) {
  if (db.prepare("SELECT COUNT(*) n FROM hosts").get().n) return;
  const covered = new Set();
  HOSTS.forEach(([name, text], i) => {
    const h = core.createHost(name, { demo: 1 });
    const f = extractFacts(text);
    covered.add(f.region);
    const t = new Date(Date.now() - (HOSTS.length - i) * 1000).toISOString();
    db.prepare(`INSERT INTO listings (id,host_id,status,category,region,place,price_uzs,duration_min,capacity,weekdays,times,transcript,i18n,engine,created_at,published_at)
      VALUES (?,?,'published',?,?,?,?,?,?,?,?,?,?,'demo',?,?)`).run("l_" + h.id.slice(2), h.id, f.category, f.region, f.place, f.price_uzs, f.duration_min, f.capacity,
      JSON.stringify([1, 2, 3, 4, 5, 6, 7]), JSON.stringify(["10:00", "15:00"]), text, JSON.stringify(templateI18n(f, name)), t, t);
  });
  for (const h of HOTELS) db.prepare("INSERT INTO hotels VALUES (?,?,?)").run(...h);
  for (const [r, n] of Object.entries(SEARCHES)) for (let i = 0; i < n; i++)
    db.prepare("INSERT INTO searches (region,results,lang,source,demo,created_at) VALUES (?,?,'en','seed',1,?)").run(r, covered.has(r) ? 1 : 0, new Date().toISOString());
}
