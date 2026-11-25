// The live stage: traveller and provider side by side for a presentation. Exists only where payments are tests.
import { extractFacts, templateI18n } from "../ai/extract.mjs";
import { addDays, ago, DAY, id, today } from "../lib/util.mjs";

export function createStage({ db, accounts }) {
  const say = "Rishtonda kulolman. Loydan lagan yasashni o‘rgataman. Ikki soat, yuz ellik ming so‘m, sakkiz kishi.";
  return {
    /** A late hour, so that a visit can be booked and checked in on the day of the presentation.
     *  A provider of their own for each presentation, so two people presenting never disturb each other. Not shown in search. */
    async startStage(label) {
      const h = await accounts.createHost("Rustam usta", { demo: true }), f = extractFacts(say), lid = id("l_");
      await db.run("UPDATE hosts SET stage=true, verified_at=now(), phone='+998900000000' WHERE id=?", h.id);
      await db.run(`INSERT INTO listings (id,host_id,status,unlisted,category,region,place,price_uzs,duration_min,capacity,weekdays,times,transcript,i18n,engine,published_at,address,lat,lng) VALUES (?,?,'published',true,?,?,?,?,?,?,'[1,2,3,4,5,6,7]','["23:30"]',?,?,'demo',now(),'Namuna ko‘chasi 1, Rishton',40.3567,71.2834)`,
        lid, h.id, f.category, f.region, f.place, f.price_uzs, f.duration_min, f.capacity, say, JSON.stringify(templateI18n(f, "Rustam usta")));
      return { listing: lid, day: addDays(today(), 3), ...(await accounts.openSession(h.id, label)) };
    },
    /** Everything a presentation left behind, after a day. */
    cleanStage: () => db.tx(async () => {
      const hosts = (await db.all("SELECT id FROM hosts WHERE stage AND created_at < ?", ago(DAY))).map((h) => h.id);
      if (!hosts.length) return 0;
      const books = (await db.all("SELECT b.id FROM bookings b JOIN listings l ON l.id=b.listing_id WHERE l.host_id = ANY(?::text[])", hosts)).map((b) => b.id);
      // Payments of a presentation are always tests; the audit log keeps its entries.
      const pays = (await db.all("SELECT DISTINCT payment_id FROM payment_items WHERE booking_id = ANY(?::text[])", books)).map((p) => p.payment_id);
      await db.run("DELETE FROM refunds WHERE payment_id = ANY(?::text[])", pays);
      await db.run("DELETE FROM payment_items WHERE payment_id = ANY(?::text[])", pays);
      await db.run("DELETE FROM payments WHERE id = ANY(?::text[]) AND provider='test'", pays);
      await db.run("DELETE FROM push_subs WHERE (kind='guest' AND ref = ANY(?::text[])) OR (kind='host' AND ref = ANY(?::text[]))", books, hosts);
      await db.run("DELETE FROM reviews WHERE booking_id = ANY(?::text[])", books);
      await db.run("DELETE FROM bookings WHERE id = ANY(?::text[])", books);
      await db.run("DELETE FROM reports WHERE listing_id IN (SELECT id FROM listings WHERE host_id = ANY(?::text[]))", hosts);
      const inv = await db.all("SELECT payment_id FROM invoices WHERE host_id = ANY(?::text[])", hosts);
      await db.run("DELETE FROM invoices WHERE host_id = ANY(?::text[])", hosts);
      await db.run("DELETE FROM payments WHERE id = ANY(?::text[]) AND provider IN ('test','credit')", inv.map((i) => i.payment_id).filter(Boolean));
      await db.run("DELETE FROM payouts WHERE host_id = ANY(?::text[])", hosts);
      await db.run("DELETE FROM listings WHERE host_id = ANY(?::text[])", hosts);
      await db.run("DELETE FROM hosts WHERE id = ANY(?::text[])", hosts);
      return hosts.length;
    }),
  };
}
