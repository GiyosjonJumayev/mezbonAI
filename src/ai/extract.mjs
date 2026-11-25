// Rule-based Uzbek extraction. Used when no AI key is set or the AI call fails.
import { CATEGORIES, DESC, LANGS, REGIONS, REGION_NAMES } from "../lib/i18n.mjs";

export const norm = (s) => s.toLowerCase().replace(/[‘’ʻʼ`´]/g, "'").replace(/\s+/g, " ").trim();

const UNITS = { bir: 1, ikki: 2, uch: 3, "to'rt": 4, besh: 5, olti: 6, yetti: 7, sakkiz: 8, "to'qqiz": 9 };
const TENS = { "o'n": 10, yigirma: 20, "o'ttiz": 30, qirq: 40, ellik: 50, oltmish: 60, yetmish: 70, sakson: 80, "to'qson": 90 };

/** Parses an Uzbek number at the start of a token list: ["yuz","ellik","ming"] → {value:150000, used:3} */
export function readNumber(tokens) {
  let total = 0, cur = 0, used = 0, seen = false;
  for (const t of tokens) {
    if (/^\d+([.,]\d{3})*$/.test(t)) {
      const n = Number(t.replace(/[.,]/g, ""));
      // "150 000": a three-digit group continues the number before it
      cur = seen && cur > 0 && /^\d{3}$/.test(t) ? cur * 1000 + n : cur + n;
      seen = true;
    } else if (Object.hasOwn(UNITS, t)) { cur += UNITS[t]; seen = true; }
    else if (Object.hasOwn(TENS, t)) { cur += TENS[t]; seen = true; }
    else if (t === "yuz") { cur = (cur || 1) * 100; seen = true; }
    else if (t === "ming") { total += (cur || 1) * 1000; cur = 0; seen = true; }
    else if (t === "million" || t === "mln") { total += (cur || 1) * 1e6; cur = 0; seen = true; }
    else break;
    used++;
  }
  return seen ? { value: total + cur, used } : null;
}

/** Finds the first "<number> <unit>", allowing "bir yarim soat". */
function findQuantity(tokens, unitRe) {
  for (let i = 0; i < tokens.length; i++) {
    const n = readNumber(tokens.slice(i));
    if (!n) continue;
    let j = i + n.used, value = n.value;
    if (tokens[j] === "yarim") { value += 0.5; j++; }
    if (unitRe.test(tokens[j] ?? "")) return value;
    i = j - 1;
  }
  return null;
}

const CAT_WORDS = [
  ["tour", /ekskursiya|(^| )gid(man|lik|\b)|sayr qildir/],
  ["bread", /(^| )non(voy| yop|ni| pish|\b)|tandir/],
  ["pottery", /kulol|sopol|(^| )lagan|(^| )loy(dan|\b)/],
  ["ikat", /(^| )atlas|adras|ipak/],
  ["embroidery", /kashta|zardo'z|so'zana/],
  ["carpet", /gilam/],
  ["wood", /yog'och|o'ymakor|naqqosh/],
  ["metal", /pichoq|kandakor|misgar|temirchi/],
  ["cooking", /oshpaz|(^| )osh( damla|ni\b)|palov|somsa|taom|pazanda/],
  ["village", /qishloq|(^| )bog'|yaylov|(^| )sigir/],
];

// Towns come before their region so "Rishton, Farg'ona" keeps the town.
const PLACES = [
  ["Rishton", "fargona", /rishton/], ["Marg‘ilon", "fargona", /marg'ilon/], ["Qo‘qon", "fargona", /qo'qon/],
  ["Chust", "namangan", /(^| )chust/], ["G‘ijduvon", "buxoro", /g'ijduvon/],
  ["Urgut", "samarqand", /urgut/], ["Konigil", "samarqand", /konigil/],
  ["Xiva", "xorazm", /(^| )xiva/], ["Urganch", "xorazm", /urganch/],
  ["Shahrisabz", "qashqadaryo", /shahrisabz/], ["Boysun", "surxondaryo", /boysun/], ["Termiz", "surxondaryo", /termiz/],
  ["Nurota", "navoiy", /nurota/], ["Zomin", "jizzax", /zomin/], ["Guliston", "sirdaryo", /guliston/],
  ["Nukus", "qoraqalpogiston", /nukus/], ["Mo‘ynoq", "qoraqalpogiston", /mo'ynoq/],
  ["Parkent", "toshkent", /parkent/], ["Chimyon", "toshkent", /chimyon/],
  ["Farg‘ona", "fargona", /farg'ona/], ["Namangan", "namangan", /namangan/], ["Andijon", "andijon", /andijon/],
  ["Buxoro", "buxoro", /buxoro/], ["Samarqand", "samarqand", /samarqand/], ["Xorazm", "xorazm", /xorazm/],
  ["Qarshi", "qashqadaryo", /(^| )qarshi(da|lik)/], ["Qashqadaryo", "qashqadaryo", /qashqadaryo/], ["Surxondaryo", "surxondaryo", /surxondaryo/],
  ["Navoiy", "navoiy", /navoiy/], ["Jizzax", "jizzax", /jizzax/], ["Sirdaryo", "sirdaryo", /sirdaryo/],
  ["Qoraqalpog‘iston", "qoraqalpogiston", /qoraqalpog'iston/], ["Toshkent", "toshkent", /toshkent/],
];

export function extractFacts(transcript) {
  const s = norm(transcript);
  const tokens = s.replace(/[.,!?;:](?=\s|$)/g, "").split(" ");
  const place = PLACES.find(([, , re]) => re.test(s));
  const price = findQuantity(tokens, /^so'm/);
  const hours = findQuantity(tokens, /^soat(lik|ga)?$/); // "soat 10 da" is a clock time and never matches
  const mins = findQuantity(tokens, /^(daqiqa|minut)/);
  const capacity = findQuantity(tokens, /^(kishi|odam|mehmon|nafar)/);
  const hoursOk = hours != null && hours <= 12;
  return {
    category: CAT_WORDS.find(([, re]) => re.test(s))?.[0] ?? "village",
    region: place?.[1] ?? null,
    place: place?.[0] ?? null,
    price_uzs: price >= 1000 ? Math.round(price) : null,
    duration_min: hoursOk ? Math.round(hours * 60 + (mins ?? 0)) : mins != null ? Math.round(mins) : null,
    capacity: capacity >= 1 && capacity <= 100 ? Math.round(capacity) : null,
  };
}

export function templateI18n(facts, host) {
  // A place that is just the region's own name is shown the way each language writes it.
  const town = facts.place && facts.place !== REGIONS[facts.region] ? facts.place : null;
  return Object.fromEntries(LANGS.map((l) => {
    const place = town ?? (facts.region ? REGION_NAMES[facts.region][l] : "O‘zbekiston");
    return [l, { title: `${CATEGORIES[facts.category][l]} · ${place}`, description: DESC[l]({ host, place, dur: facts.duration_min ?? "?", cap: facts.capacity ?? "?" }) }];
  }));
}

/** Questions the host must still answer before publishing. */
export function missing(l) {
  const q = [];
  if (!l.region) q.push({ field: "region", text: "Qaysi viloyatdasiz?" });
  if (!l.price_uzs) q.push({ field: "price_uzs", text: "Bir kishi uchun narx qancha?" });
  if (!l.duration_min) q.push({ field: "duration_min", text: "Mashg‘ulot qancha davom etadi?" });
  if (!l.capacity) q.push({ field: "capacity", text: "Bir vaqtda necha mehmon qabul qilasiz?" });
  if (l.category === "tour" && !l.cert_no) q.push({ field: "cert_no", text: "Ekskursiya uchun gid sertifikati raqami kerak." });
  return q;
}
