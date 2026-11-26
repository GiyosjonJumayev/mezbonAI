// Public live streams (server-sent events). They carry only "something changed here"; the page then asks for what it may see.
import { fail } from "../lib/util.mjs";

const MAX_TOTAL = 2000, MAX_PER_VISITOR = 40;

export function createLive({ gather = 400, slow = 2000 } = {}) {
  const topics = new Map(), perIp = new Map();
  let total = 0, ids = new Set(), catalog = false, timer = null, numbers = null;

  function send(topic, ev) {
    const text = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of topics.get(topic) ?? []) {
      if (res.writableLength > 64e3) res.destroy(); // a reader that stopped reading
      else res.write(text);
    }
  }
  const flush = () => {
    timer = null;
    if (ids.size) send("all", { t: "slots", ids: [...ids].slice(0, 60) });
    if (catalog) send("all", { t: "catalog" });
    ids = new Set();
    catalog = false;
  };
  const soon = () => { timer ??= setTimeout(flush, gather).unref(); };

  return {
    open(res, topic, ip) {
      const mine = perIp.get(ip) ?? 0;
      if (total >= MAX_TOTAL || mine >= MAX_PER_VISITOR) throw fail(429, "Juda ko‘p ochiq oyna", "rate");
      total++;
      perIp.set(ip, mine + 1);
      const set = topics.get(topic) ?? new Set();
      topics.set(topic, set.add(res));
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      res.write('data: {"t":"hello"}\n\n');
      const ping = setInterval(() => res.write(": ping\n\n"), 25e3).unref();
      res.on("close", () => {
        clearInterval(ping);
        total--;
        const left = perIp.get(ip) - 1;
        left > 0 ? perIp.set(ip, left) : perIp.delete(ip);
        set.delete(res);
        if (!set.size) topics.delete(topic);
      });
    },
    /** Places of a listing changed. An unlisted one is told only to those who have it open. */
    slots(listing, listed) {
      send(`l:${listing}`, { t: "slots" });
      if (listed) { ids.add(listing); soon(); }
    },
    listing(listing, listed) {
      send(`l:${listing}`, { t: "listing" });
      if (listed) { catalog = true; soon(); }
    },
    booking: (bid) => send(`b:${bid}`, { t: "booking" }),
    /** Totals change often, so they are announced at most every two seconds. */
    numbers() { numbers ??= setTimeout(() => { numbers = null; send("all", { t: "numbers" }); }, slow).unref(); },
    count: () => total,
  };
}
