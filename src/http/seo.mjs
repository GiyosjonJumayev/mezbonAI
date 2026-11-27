// What search engines and link previews (Telegram, WhatsApp, Instagram) read before any script runs.
import { LANGS, UI } from "../lib/i18n.mjs";
import { inTheme, THEMES } from "../lib/themes.mjs";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** JSON inside a script element must not be able to close it. */
const ld = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function createSeo({ core, config }) {
  const base = config.publicUrl;
  const pick = (q) => (LANGS.includes(q.get("lang")) ? q.get("lang") : "en");

  /** Title, description, picture and structured data for one address, or null to leave the page as it is. */
  async function meta(q) {
    const lang = pick(q), lid = q.get("l"), hid = q.get("host");
    if (lid) {
      const l = await core.listing(lid).catch(() => null);
      if (!l) return null;
      const t = l.i18n[lang] ?? l.i18n.en, url = `${base}/?l=${l.id}`, image = l.photo ? `${base}/photos/${l.photo}` : `${base}/icon512.png`;
      return {
        lang, title: `${t.title} | SilkRoad`, description: cut(t.description, 200), image, url: `${url}&lang=${lang}`, type: "product", index: !l.demo,
        alternates: LANGS.map((g) => [g, `${url}&lang=${g}`]),
        data: { "@context": "https://schema.org", "@type": "Product", name: t.title, description: t.description, image: [image], url, brand: { "@type": "Brand", name: l.host },
          offers: { "@type": "Offer", price: l.price_uzs, priceCurrency: "UZS", availability: "https://schema.org/InStock", url },
          ...(l.reviews > 0 && { aggregateRating: { "@type": "AggregateRating", ratingValue: l.rating, reviewCount: l.reviews, bestRating: 5, worstRating: 1 } }) },
      };
    }
    if (hid) {
      const h = await core.provider(hid).catch(() => null);
      if (!h) return null;
      return { lang, title: `${h.name} | SilkRoad`, description: cut(`${h.listings.map((x) => (x.i18n[lang] ?? x.i18n.en).title).join(" · ")}`, 200), image: `${base}/icon512.png`, url: `${base}/?host=${h.id}&lang=${lang}`, type: "profile", index: !h.demo, alternates: LANGS.map((g) => [g, `${base}/?host=${h.id}&lang=${g}`]) };
    }
    const theme = q.get("theme");
    if (theme && Object.hasOwn(THEMES, theme) && [...q.keys()].every((k) => ["theme", "lang"].includes(k))) {
      const list = (await core.search({ log: false })).filter((l) => inTheme(THEMES[theme], l)), url = `${base}/?theme=${theme}`;
      return { lang, title: `${UI[`th_${theme}`][lang]} | SilkRoad`, description: UI[`thd_${theme}`][lang], image: `${base}/icon512.png`, url: `${url}&lang=${lang}`, type: "website", index: list.some((l) => !l.demo),
        alternates: LANGS.map((g) => [g, `${url}&lang=${g}`]),
        data: { "@context": "https://schema.org", "@type": "ItemList", name: UI[`th_${theme}`][lang], itemListElement: list.slice(0, 30).map((l, i) => ({ "@type": "ListItem", position: i + 1, url: `${base}/?l=${l.id}` })) } };
    }
    if ([...q.keys()].some((k) => k !== "lang")) return null; // bookings, trips and filters are not for search engines
    return { lang, title: `SilkRoad Experience OS: ${UI.headline[lang]}`, description: `${UI.heart[lang]} ${UI.sub[lang]}`, image: `${base}/icon512.png`, url: `${base}/?lang=${lang}`, type: "website", index: true,
      alternates: LANGS.map((g) => [g, `${base}/?lang=${g}`]),
      data: { "@context": "https://schema.org", "@type": "WebSite", name: "SilkRoad Experience OS", url: base } };
  }

  return {
    /** Writes the facts into the page. The visible page is still drawn by the script, so nothing else changes. */
    async page(html, q) {
      const m = await meta(q);
      const private_ = [...q.keys()].some((k) => ["b", "trip", "my", "leave", "embed", "saved", "plan"].includes(k));
      if (!m) return private_ ? html.replace("</head>", '<meta name="robots" content="noindex">\n</head>') : html;
      const tags = [
        `<meta property="og:type" content="${m.type}">`, `<meta property="og:site_name" content="SilkRoad Experience OS">`, `<meta property="og:title" content="${esc(m.title)}">`,
        `<meta property="og:description" content="${esc(m.description)}">`, `<meta property="og:image" content="${esc(m.image)}">`, `<meta property="og:url" content="${esc(m.url)}">`,
        `<meta name="twitter:card" content="summary_large_image">`, `<link rel="canonical" href="${esc(m.url)}">`,
        ...m.alternates.map(([g, u]) => `<link rel="alternate" hreflang="${g}" href="${esc(u)}">`),
        !m.index || config.demoSite ? '<meta name="robots" content="noindex">' : "",
        m.data ? `<script type="application/ld+json">${ld(m.data)}</script>` : "",
      ].filter(Boolean).join("\n");
      return html.replace(/<html lang="[a-z]+"/, `<html lang="${m.lang}"`).replace(/<title>[^<]*<\/title>/, `<title>${esc(m.title)}</title>`)
        .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(m.description)}">`)
        .replace(/<meta property="og:title"[^>]*><meta property="og:description"[^>]*>/, "").replace("</head>", `${tags}\n</head>`);
    },
    /** Every offer in every language. Samples are left out. */
    async sitemap() {
      const list = (await core.search({ log: false })).filter((l) => !l.demo), url = (u) => `<url><loc>${esc(u)}</loc></url>`;
      const pages = [`${base}/`, `${base}/impact`, ...LANGS.map((g) => `${base}/?lang=${g}`), ...Object.keys(THEMES).filter((th) => list.some((l) => inTheme(THEMES[th], l))).flatMap((th) => LANGS.map((g) => `${base}/?theme=${th}&lang=${g}`)), ...list.flatMap((l) => LANGS.map((g) => `${base}/?l=${l.id}&lang=${g}`)), ...[...new Set(list.map((l) => l.host_id))].map((h) => `${base}/?host=${h}`)];
      return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.slice(0, 50000).map(url).join("\n")}\n</urlset>\n`;
    },
    robots: () => (config.demoSite ? "User-agent: *\nDisallow: /\n" : `User-agent: *\nDisallow: /api/\nDisallow: /octo/\nDisallow: /mezbon\nDisallow: /admin\nDisallow: /stage\nAllow: /\nSitemap: ${base}/sitemap.xml\n`),
  };
}
