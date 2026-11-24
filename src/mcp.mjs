// MCP server (stdio). Lets Claude and other AI assistants search and hold a place. It never pays.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CATEGORIES, LANGS, REGIONS, REGION_NAMES, UI } from "./i18n.mjs";

const BASE = process.env.MEZBON_URL || "http://localhost:4321";

async function call(pathname, body) {
  let r;
  try { r = await fetch(BASE + pathname, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}); }
  catch { throw new Error(`SilkRoad server is not reachable at ${BASE}. Start it with: npm start`); }
  const v = await r.json();
  if (!r.ok) throw new Error((UI[`e_${v.code}`] ?? UI.e_other).en);
  return v;
}
const safe = (fn) => async (a) => {
  try { return { content: [{ type: "text", text: JSON.stringify(await fn(a)) }] }; }
  catch (e) { return { isError: true, content: [{ type: "text", text: e.message }] }; }
};

const server = new McpServer({ name: "silkroad-experience-os", version: "3.0.0" });

server.registerTool("search_experiences", {
  description: "Search craft workshops, cooking classes and village visits hosted by local people in Uzbekistan. Returns the price per person in UZS, capacity and rating. Pass date and guests to keep only listings with free places. Listings with sample=true are demo data; say so to the traveller.",
  inputSchema: {
    region: z.enum(Object.keys(REGIONS)).optional().describe(Object.keys(REGIONS).map((k) => `${k} = ${REGION_NAMES[k].en}`).join(", ")),
    category: z.enum(Object.keys(CATEGORIES)).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD"),
    guests: z.number().int().min(1).optional(),
    language: z.enum(LANGS).default("en"),
  },
  annotations: { readOnlyHint: true },
}, safe(async ({ region, category, date, guests, language }) => {
  const q = new URLSearchParams({ lang: language, source: "ai", ...(region && { region }), ...(category && { category }), ...(date && { date }), ...(guests && { guests }) });
  return (await call(`/api/listings?${q}`)).map((l) => ({
    listing_id: l.id, ...l.i18n[language], host: l.host, region: REGION_NAMES[l.region].en, price_uzs_per_person: l.price_uzs, duration_min: l.duration_min,
    capacity: l.capacity, rating: l.rating, reviews: l.reviews, sample: l.demo,
  }));
}));

server.registerTool("check_availability", {
  description: "List open dates and start times (Asia/Tashkent) with the number of free places for one listing.",
  inputSchema: { listing_id: z.string(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, default today"), days: z.number().int().min(1).max(60).default(14) },
  annotations: { readOnlyHint: true },
}, safe(({ listing_id, from, days }) => call(`/api/listings/${encodeURIComponent(listing_id)}/availability?${new URLSearchParams({ days, ...(from && { from }) })}`)));

server.registerTool("create_booking", {
  description: "Hold a place for 30 minutes and return a payment link. It does not pay: the traveller must open the link. Confirm date, time, number of guests and price with the traveller before calling.",
  inputSchema: {
    listing_id: z.string(), date: z.string().describe("YYYY-MM-DD"), time: z.string().describe("HH:MM, from check_availability"),
    guests: z.number().int().min(1), guest_name: z.string(), language: z.enum(LANGS).default("en"),
  },
}, safe(async ({ language, ...a }) => {
  const b = await call("/api/bookings", { ...a, lang: language, source: "ai" });
  return { status: b.status, date: b.date, time: b.time, guests: b.guests, total_uzs: b.total_uzs, held_until: b.expires_at, payment_link: `${BASE}/?b=${b.token}&lang=${language}` };
}));

await server.connect(new StdioServerTransport());
