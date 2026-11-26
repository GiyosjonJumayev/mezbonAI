// Letters of intent. A letter counts as traction only after an administrator has called the person and confirmed it.
import { REGIONS } from "../lib/i18n.mjs";
import { ago, bad, DAY, fail, id, int, known, notFound, secret, sha256, str } from "../lib/util.mjs";
import { cleanEmail, cleanPhone } from "./mail.mjs";

export const KINDS = { host: "Hunarmand yoki oila", hotel: "Mehmonxona", guide: "Gid", operator: "Turoperator" };
export const COMMISSIONS = [0, 6, 12, 15, 18];
const som = (n) => `${String(n).replace(/\B(?=(\d{3})+$)/g, " ")} so‘m`;

/** The words a partner agrees to. Plain and short, and it says that it is not a contract. */
export function letterText(p) {
  const what = p.kind === "host" ? `“${p.offer}” xizmatimni${p.price_uzs ? ` bir kishiga ${som(p.price_uzs)}dan` : ""}${p.groups_week ? `, haftasiga ${p.groups_week} guruhgacha` : ""} taklif qilishga`
    : `quyidagicha hamkorlik qilishga: “${p.offer}”,`;
  return `Men, ${p.signed_name} (${p.name}, ${KINDS[p.kind]}, ${REGIONS[p.region]}), SilkRoad Experience OS platformasida ${what} niyatim borligini bildiraman. ${p.max_commission ? `Platforma komissiyasi ${p.max_commission}% gacha bo‘lishiga roziman.` : "Komissiya miqdorini keyin kelishamiz."} Bu niyat xati, shartnoma emas va meni majburlamaydi. Uni istalgan vaqtda qaytarib olishim mumkin. Ma’lumotlarim loyiha jamoasi men bilan bog‘lanishi va niyatlar sonini jami ko‘rsatishi uchun ishlatilishiga roziman.`;
}

export function createPartners({ db, audit }) {
  const own = async (token) => {
    const p = typeof token === "string" ? await db.one("SELECT * FROM partners WHERE token=?", token) : null;
    if (!p) throw notFound("Xat topilmadi");
    return p;
  };
  const view = (p) => ({ token: p.token, kind: p.kind, name: p.name, region: p.region, offer: p.offer, price_uzs: p.price_uzs, groups_week: p.groups_week, max_commission: p.max_commission, signed_name: p.signed_name, letter: p.letter, letter_hash: p.letter_hash, status: p.status, created_at: p.created_at });
  function clean(b) {
    if (!known(KINDS, b.kind)) throw bad("Hamkor turini tanlang");
    if (!known(REGIONS, b.region)) throw bad("Viloyatni tanlang");
    if (!COMMISSIONS.includes(b.max_commission)) throw bad("Komissiyani tanlang");
    const opt = (v, name, lo, hi) => (v == null || v === "" ? null : int(v, name, lo, hi));
    return { kind: b.kind, region: b.region, max_commission: b.max_commission, name: str(b.name, "Ism yoki tashkilot", 80), signed_name: str(b.signed_name, "To‘liq ism", 80), offer: str(b.offer, "Taklif", 300).replace(/[“”"]/g, "’"), price_uzs: opt(b.price_uzs, "Narx", 1000, 100_000_000), groups_week: opt(b.groups_week, "Guruhlar soni", 1, 100) };
  }
  return {
    /** Shows the letter before it is signed. Nothing is stored. */
    previewLetter: async (b) => ({ letter: letterText(clean(b)) }),
    async signLetter(b) {
      const p = clean(b), phone = cleanPhone(b.phone), email = cleanEmail(b.email);
      if (!phone) throw fail(400, "Telefon kerak: niyatni qo‘ng‘iroq qilib tasdiqlaymiz", "phone");
      const letter = letterText(p);
      if (b.agree !== true || b.letter !== letter) throw bad("Xat matnini o‘qib, rozilik bering");
      const t = { id: id("n_"), token: secret() };
      await db.tx(async () => {
        await db.one("SELECT pg_advisory_xact_lock(hashtextextended(?, 11))", phone);
        // One person signing many times is one signal of interest.
        if (await db.one("SELECT 1 x FROM partners WHERE phone=? AND status IN ('signed','verified','joined')", phone)) throw fail(409, "Bu telefon bilan xat allaqachon imzolangan", "state");
        await db.run("INSERT INTO partners (id,token,kind,name,phone,email,region,offer,price_uzs,groups_week,max_commission,signed_name,letter,letter_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          t.id, t.token, p.kind, p.name, phone, email, p.region, p.offer, p.price_uzs, p.groups_week, p.max_commission, p.signed_name, letter, sha256(letter).toString("hex"));
      });
      return view(await own(t.token));
    },
    letter: async (token) => view(await own(token)),
    async withdrawLetter(token) {
      const p = await own(token);
      const r = await db.run("UPDATE partners SET status='withdrawn', phone='', email=NULL, updated_at=now() WHERE id=? AND status<>'withdrawn'", p.id);
      if (r.changes) await audit("partner", "letter_withdrawn", p.id);
      return view(await own(token));
    },
    // ---- administrators ------------------------------------------------------------------------
    partners: () => db.all("SELECT id, kind, name, phone, email, region, offer, price_uzs, groups_week, max_commission, signed_name, letter_hash, status, note, created_at FROM partners ORDER BY (status='signed') DESC, created_at DESC LIMIT 500"),
    async setPartner(pid, { status, note }) {
      if (!["signed", "verified", "joined", "rejected"].includes(status)) throw bad("Holat noto‘g‘ri");
      const r = await db.run("UPDATE partners SET status=?, note=?, updated_at=now() WHERE id=? AND status<>'withdrawn'", status, note ? str(note, "Izoh", 200) : null, String(pid));
      if (!r.changes) throw notFound("Xat topilmadi yoki qaytarib olingan");
      await audit("admin", `letter_${status}`, String(pid));
      return { ok: true };
    },
    /** For investors: confirmed letters only, as totals. */
    async letterTotals() {
      const ok = "status IN ('verified','joined')";
      const t = await db.one(`SELECT COUNT(*) FILTER (WHERE status='signed') waiting, COUNT(*) FILTER (WHERE ${ok}) confirmed, COUNT(*) FILTER (WHERE status='joined') joined, COUNT(*) FILTER (WHERE ${ok} AND kind='host') hosts, COUNT(*) FILTER (WHERE ${ok} AND kind='hotel') hotels,
        COUNT(DISTINCT region) FILTER (WHERE ${ok}) regions, COALESCE(SUM(groups_week) FILTER (WHERE ${ok}),0) groups_week, percentile_cont(0.5) WITHIN GROUP (ORDER BY price_uzs) FILTER (WHERE ${ok}) price, COUNT(*) FILTER (WHERE ${ok} AND max_commission>=12) c12, COUNT(*) FILTER (WHERE ${ok} AND max_commission>=15) c15, COUNT(*) FILTER (WHERE ${ok} AND max_commission>=18) c18 FROM partners`);
      return { ...t, price: t.price == null ? null : Math.round(t.price) };
    },
    cleanPartners: () => db.run("DELETE FROM partners WHERE status IN ('withdrawn','rejected') AND updated_at < ?", ago(90 * DAY)),
  };
}
