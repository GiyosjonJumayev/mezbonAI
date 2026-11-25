// Generated artwork: one pattern language per craft, drawn from a seed so every listing keeps its own picture.
// It stands in until the provider uploads real photos.
const NS = "http://www.w3.org/2000/svg";
const W = 320, H = 240;

function maker(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return (n) => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return (h >>> 16) % n; };
}
const PALETTES = {
  pottery: [["#0f4c9c", "#f6f3ea", "#19a3a0", "#0a2f66"], ["#0b7f86", "#f6f3ea", "#1746a2", "#075055"], ["#173f8a", "#fdfaf1", "#e2a63a", "#0b2557"]],
  ikat: [["#7a1f4b", "#f4c453", "#f7efe2", "#1f7a6d"], ["#1c3f8f", "#f2b632", "#f7efe2", "#c2382f"], ["#b3372b", "#f7efe2", "#f0b23a", "#20304f"]],
  embroidery: [["#f7efdf", "#b3202c", "#1c3f6e", "#2f7a4d"], ["#1d2c4d", "#e0483e", "#f2c14e", "#6fb28a"], ["#f3e6d0", "#8c1d40", "#c9811a", "#24516e"]],
  cooking: [["#7b3a17", "#f2a53a", "#ffe0a3", "#c8511b"], ["#2d4a3a", "#f0b04a", "#fff0cf", "#d0602a"]],
  bread: [["#4a2716", "#d98e33", "#f3c476", "#a65a1c"], ["#1f3350", "#dd9638", "#f6cd86", "#a9611f"]],
  carpet: [["#7d1722", "#f0d9b5", "#1d2f4f", "#c4532f"], ["#1b2c4a", "#e9d3ae", "#8f2430", "#c9862d"]],
  wood: [["#5b3a21", "#e3bd8a", "#8a5a31", "#341f10"], ["#2f4a47", "#e6c795", "#6b4526", "#1d2f2d"]],
  metal: [["#263746", "#d9e2e8", "#8da2b2", "#e0a33b"], ["#3a2c22", "#ecd9b8", "#b88a4a", "#f1c15b"]],
  village: [["#f6b65f", "#e9774f", "#2f6d5a", "#173f4a"], ["#8fd0dd", "#f4e6b0", "#3b8a5a", "#1f4f5c"], ["#f4a7a0", "#b85c7c", "#3f5f7a", "#22384f"]],
  tour: [["#0f2f5c", "#1fa6a0", "#f3d9a6", "#f0a63c"], ["#e9b472", "#19807f", "#f7ead0", "#1746a2"]],
};

/** Returns a full-bleed SVG picture. */
export function art(seed, category) {
  const rnd = maker(seed), f = () => rnd(1000) / 1000;
  const set = PALETTES[category] ?? PALETTES.pottery, [bg, a, b, c] = set[rnd(set.length)];
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("pattern");
  const add = (tag, at, to = svg) => { const n = document.createElementNS(NS, tag); for (const k in at) n.setAttribute(k, at[k]); to.append(n); return n; };
  const group = (x, y, s = 1, r = 0) => add("g", { transform: `translate(${x} ${y}) scale(${s}) rotate(${r})` });
  const petals = (g, n, r, len, w, fill, turn = 0) => { for (let i = 0; i < n; i++) add("path", { d: `M0 ${-r}C${w} ${-r - len * .35} ${w} ${-r - len * .75} 0 ${-r - len}C${-w} ${-r - len * .75} ${-w} ${-r - len * .35} 0 ${-r}Z`, transform: `rotate(${(360 / n) * (i + turn)})`, fill }, g); };
  const dots = (g, n, r, size, fill, turn = 0) => { for (let i = 0; i < n; i++) add("circle", { cy: -r, r: size, fill, transform: `rotate(${(360 / n) * (i + turn)})` }, g); };
  add("rect", { width: W, height: H, fill: bg });

  const draw = {
    pottery() {
      const dish = (x, y, s) => {
        const g = group(x, y, s, rnd(40)), n = 8 + 2 * rnd(4);
        add("circle", { r: 100, fill: b === "#f6f3ea" ? b : a }, g);
        add("circle", { r: 100, fill: a }, g);
        add("circle", { r: 94, fill: "none", stroke: bg, "stroke-width": 4 }, g);
        petals(g, n * 2, 66, 22, 6, b); add("circle", { r: 62, fill: "none", stroke: c, "stroke-width": 2 }, g);
        petals(g, n, 22, 38, 8 + rnd(5), bg); dots(g, n, 49, 3, b, .5);
        add("circle", { r: 19, fill: b }, g); petals(g, 6 + rnd(3), 2, 14, 4, a);
      };
      const lay = rnd(4);
      if (lay === 0) { dish(120 + rnd(40), 118 + rnd(20), 1.02); dish(282, 40 + rnd(40), .62); dish(20, 226, .55); dish(300, 220, .5); }
      else if (lay === 1) { dish(160, 120, 1.5); }
      else if (lay === 2) { for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) dish(52 + x * 108, 64 + y * 112, .5); }
      else { dish(64, 60, .74); dish(236, 168, .96); dish(250, 22, .4); dish(60, 214, .46); }
    },
    ikat() {
      const step = 5, period = 64 + rnd(3) * 16, colours = [a, b, c, a, b];
      for (let x = 0; x < W; x += step) {
        const tri = Math.abs(((x + 12) % period) - period / 2) / (period / 2);
        for (let y = -120; y < H + 120; y += 120) {
          colours.forEach((col, i) => {
            const half = (54 - i * 11) * (1 - tri * .92) + f() * 5;
            if (half > 1) add("rect", { x, y: y + 60 - half, width: step + .4, height: half * 2, fill: i === 4 ? bg : col, opacity: .96 });
          });
          add("rect", { x, y: y + 118 - f() * 9, width: step + .4, height: 5 + f() * 10, fill: b, opacity: .8 });
        }
      }
    },
    embroidery() {
      const flower = (x, y, s) => { const g = group(x, y, s, rnd(60)), n = 10 + rnd(5); petals(g, n, 22, 24, 8, c); petals(g, n, 16, 18, 7, a, .5); add("circle", { r: 24, fill: a }, g); add("circle", { r: 17, fill: b }, g); dots(g, n, 20.5, 2, bg); add("circle", { r: 9, fill: c }, g); add("circle", { r: 4, fill: bg }, g); };
      for (const [x, y, q] of [[0, 120, 1], [160, 0, -1], [320, 130, -1], [150, 240, 1]]) add("path", { d: `M160 120C${160 + q * 70} ${60} ${x - q * 40} ${y + 30} ${x} ${y}`, fill: "none", stroke: c, "stroke-width": 4, "stroke-linecap": "round" });
      for (let i = 0; i < 16; i++) { const g = group(rnd(W), rnd(H), .5 + f() * .4, rnd(360)); petals(g, 1, 0, 34, 9, c); }
      flower(158, 120, 1.7); flower(30 + rnd(20), 40, .95); flower(285, 48 + rnd(16), 1.05); flower(44, 206, 1); flower(270, 208, .92);
    },
    cooking() {
      const g = group(150 + rnd(30), 122, 1, 0);
      add("circle", { r: 118, fill: c }, g); add("circle", { r: 108, fill: "#f7efe0" }, g); add("circle", { r: 92, fill: b }, g);
      dots(g, 36, 100, 3, "#1746a2");
      for (let i = 0; i < 260; i++) { const r = Math.sqrt(f()) * 86, t = f() * 6.283; add("ellipse", { cx: r * Math.cos(t), cy: r * Math.sin(t), rx: 5, ry: 1.8, fill: i % 3 ? a : b, transform: `rotate(${rnd(180)} ${r * Math.cos(t)} ${r * Math.sin(t)})` }, g); }
      for (let i = 0; i < 46; i++) { const r = Math.sqrt(f()) * 78, t = f() * 6.283, x = r * Math.cos(t), y = r * Math.sin(t); add("rect", { x: x - 11, y: y - 2, width: 22, height: 4, rx: 2, fill: c, transform: `rotate(${rnd(180)} ${x} ${y})` }, g); }
      for (let i = 0; i < 5; i++) { const t = (i / 5) * 6.283 + f(), q = add("g", { transform: `translate(${Math.cos(t) * 44} ${Math.sin(t) * 44})` }, g); add("circle", { r: 11, fill: "#fff4e2" }, q); for (let k = 0; k < 6; k++) add("path", { d: "M0 0L0 -10", stroke: "#e4cfa8", "stroke-width": 1.5, transform: `rotate(${k * 60})` }, q); }
      for (let i = 0; i < 18; i++) { const t = f() * 6.283, r = f() * 70; add("circle", { cx: Math.cos(t) * r, cy: Math.sin(t) * r, r: 3.4, fill: "#5a2f17" }, g); }
    },
    bread() {
      const loaf = (x, y, s) => { const g = group(x, y, s, rnd(90)); add("circle", { r: 78, fill: "rgb(0 0 0 / .25)", cx: 5, cy: 7 }, g); add("circle", { r: 78, fill: a }, g); add("circle", { r: 62, fill: c, opacity: .55 }, g); add("circle", { r: 54, fill: b }, g); for (const [n, r] of [[8, 14], [14, 26], [20, 38], [26, 48]]) dots(g, n, r, 2.3, c, (r % 4) / 4); petals(g, 8, 4, 12, 4, c); for (let i = 0; i < 34; i++) { const t = f() * 6.283, r = 10 + f() * 60; add("ellipse", { cx: Math.cos(t) * r, cy: Math.sin(t) * r, rx: 2.6, ry: 1.4, fill: "#fff3d6" }, g); } };
      loaf(285, 205, .95); loaf(30, 210, 1); loaf(270, 48, .85); loaf(60, 56, .9); loaf(160, 122, 1.22);
    },
    carpet() {
      const gul = (x, y, s) => { const g = group(x, y, s); add("path", { d: "M-18 -44H18L44 -18V18L18 44H-18L-44 18V-18Z", fill: c }, g); add("path", { d: "M-14 -34H14L34 -14V14L14 34H-14L-34 14V-14Z", fill: a }, g); add("path", { d: "M0 -26L26 0 0 26 -26 0Z", fill: b }, g); add("path", { d: "M0 -15L15 0 0 15 -15 0Z", fill: c }, g); for (const t of [0, 90, 180, 270]) add("path", { d: "M0 -33l5 6h-10z", fill: bg, transform: `rotate(${t})` }, g); };
      for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) gul(40 + x * 80, 34 + y * 86, .78);
      for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) { const g = group(80 + x * 80, 77 + y * 86, .5); add("path", { d: "M0 -22L22 0 0 22 -22 0Z", fill: b }, g); add("path", { d: "M0 -11L11 0 0 11 -11 0Z", fill: a }, g); }
    },
    wood() {
      const R = 46;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) {
        const g = group(x * R * 2 - 24 + (y % 2) * R, y * R * 1.75 + 4, 1);
        for (const t of [0, 45]) add("rect", { x: -R * .62, y: -R * .62, width: R * 1.24, height: R * 1.24, fill: t ? b : "none", stroke: a, "stroke-width": 5, transform: `rotate(${t})`, opacity: t ? .9 : 1 }, g);
        petals(g, 8, 5, 20, 5, a); add("circle", { r: 6, fill: c }, g); add("circle", { r: R * .86, fill: "none", stroke: c, "stroke-width": 2 }, g);
      }
    },
    metal() {
      const g = group(160 + rnd(60) - 30, 120, 1);
      for (let r = 190; r > 10; r -= 15) { add("circle", { r, fill: "none", stroke: r % 2 ? a : b, "stroke-width": r % 45 ? .8 : 2.4, opacity: .7 }, g); const n = Math.max(6, Math.round(r / 7)); r % 30 ? petals(g, n, r - 13, 11, 3.4, r % 60 ? b : a) : dots(g, n, r - 8, 2, c); }
      add("circle", { r: 16, fill: c }, g); petals(g, 8, 4, 10, 3, bg);
    },
    village() {
      const sky = add("linearGradient", { id: `s${seed}`.replace(/\W/g, ""), x2: 0, y2: 1 }); add("stop", { offset: 0, "stop-color": a }, sky); add("stop", { offset: 1, "stop-color": b }, sky);
      add("rect", { width: W, height: H, fill: bg }); add("rect", { width: W, height: 150, fill: a, opacity: .55 });
      add("circle", { cx: 70 + rnd(180), cy: 74, r: 30, fill: "#fff6da" });
      const ridge = (base, amp, fill, n) => { let d = `M0 ${H}L0 ${base}`; for (let i = 0; i <= n; i++) d += `L${(W / n) * i} ${base - (i % 2 ? amp * (.5 + f() * .6) : f() * 12)}`; add("path", { d: d + `L${W} ${H}Z`, fill }); };
      ridge(146, 74, c, 5); ridge(160, 46, c, 8); svg.lastChild.setAttribute("opacity", .75); ridge(178, 20, "#3f7f4e", 7);
      for (let i = 0; i < 11; i++) add("ellipse", { cx: 12 + i * 30 + rnd(12), cy: 178, rx: 5, ry: 24 + rnd(14), fill: "#1f4d35" });
      for (let i = 0; i < 6; i++) add("path", { d: `M${-40 + i * 70} ${H}L${110 + i * 22} 186`, stroke: "#e6cf86", "stroke-width": 6, opacity: .5 });
    },
    tour() {
      add("circle", { cx: 160, cy: 104, r: 86, fill: c, opacity: .95 });
      const dome = (x, w, y, fill) => { add("rect", { x: x - w / 2, y, width: w, height: H - y, fill: b }); add("rect", { x: x - w * .38, y: y - 20, width: w * .76, height: 22, fill: a }); add("path", { d: `M${x - w * .44} ${y - 18}C${x - w * .56} ${y - 58} ${x - w * .16} ${y - 74} ${x} ${y - 92}C${x + w * .16} ${y - 74} ${x + w * .56} ${y - 58} ${x + w * .44} ${y - 18}Z`, fill }); for (let i = -3; i <= 3; i++) add("path", { d: `M${x + i * w * .12} ${y - 18}Q${x + i * w * .13} ${y - 62} ${x} ${y - 90}`, stroke: b, "stroke-width": 1.2, fill: "none", opacity: .7 }); };
      const tower = (x, t) => { add("path", { d: `M${x - 11} ${H}L${x - 7} ${t}H${x + 7}L${x + 11} ${H}Z`, fill: b }); add("rect", { x: x - 11, y: t - 8, width: 22, height: 10, fill: a }); for (let y = t + 14; y < H; y += 18) add("rect", { x: x - 9, y, width: 18, height: 5, fill: a }); };
      tower(36, 64); tower(284, 64); dome(92, 66, 150, a); dome(228, 66, 150, a); dome(160, 92, 132, a);
      add("rect", { x: 116, y: 124, width: 88, height: 116, fill: b, stroke: a, "stroke-width": 6 }); add("path", { d: "M132 240V168C132 150 152 142 160 134C168 142 188 150 188 168V240Z", fill: bg }); for (let i = 0; i < 7; i++) add("path", { d: `M${124 + i * 12} 131l5 5 -5 5 -5 -5z`, fill: c });
    },
  };
  (draw[category] ?? draw.pottery)();
  return svg;
}

/** Small line icons, one per category plus interface glyphs. 24 px grid, drawn with currentColor. */
const ICONS = {
  pottery: "M6 7h12M8 7c-4 5-3 12 2 14h4c5-2 6-9 2-14M9 3h6v4H9z", ikat: "M12 3l6 9-6 9-6-9zM12 8l3 4-3 4-3-4z", embroidery: "M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 3v6M12 15v6M3 12h6M15 12h6M6 6l4 4M14 14l4 4M18 6l-4 4M10 14l-4 4",
  cooking: "M3 11h18a9 9 0 0 1-18 0zM8 7c0-2 2-2 2-4M14 7c0-2 2-2 2-4", bread: "M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M12 12h.01", carpet: "M4 5h16v14H4zM8 5v14M16 5v14M12 9l3 3-3 3-3-3z", wood: "M12 3l2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6z", metal: "M4 20l5-5M8 14l8-11 4 4-11 8zM6 18l-2 2",
  village: "M3 20l6-10 4 6 3-4 5 8zM17 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0", tour: "M5 21V11c0-5 7-6 7-9 0 3 7 4 7 9v10M9 21v-6a3 3 0 0 1 6 0v6M3 21h18",
  heart: "M12 20S4 15 4 9a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z", search: "M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0M16 16l5 5", calendar: "M4 6h16v15H4zM4 11h16M8 3v5M16 3v5", user: "M12 8m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M4 21c1-5 4-7 8-7s7 2 8 7", pin: "M12 21s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12zM12 9m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0", clock: "M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 7v5l3 2", people: "M9 8m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M2 20c1-4 3.500-6 7-6s6 2 7 6M16 5a3.500 3.500 0 0 1 0 6.500M18 14.500c2 .7 3.300 2.500 4 5.500",
  shield: "M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6zM8.500 12l2.500 2.500 4.500-5", route: "M6 19m-2.500 0a2.500 2.500 0 1 0 5 0a2.500 2.500 0 1 0-5 0M18 5m-2.500 0a2.500 2.500 0 1 0 5 0a2.500 2.500 0 1 0-5 0M8.500 19H15a3.500 3.500 0 0 0 0-7H9a3.500 3.500 0 0 1 0-7h6.500", flag: "M5 21V4M5 4h13l-3 4.500L18 13H5", key: "M8 15m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0M11.500 11.500L20 3M16 7l3 3", wallet: "M3 7h18v13H3zM3 7l13-4v4M16 13.500h.01",
  share: "M12 15V3M8 7l4-4 4 4M5 12v8h14v-8", ticket: "M3 8a2 2 0 0 0 0 4v5h18v-5a2 2 0 0 1 0-4V5H3zM14 5v3M14 11v3M14 16v1", chart: "M4 20V10M10 20V4M16 20v-7M22 20H2", spark: "M12 3l1.800 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800zM19 15l.8 2.200L22 18l-2.200.8L19 21l-.8-2.200L16 18l2.200-.8z", gear: "M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3", bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4", check: "M4 12l5 5L20 6", globe: "M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18", home: "M4 11l8-7 8 7v9h-5v-6H9v6H4z",
};
export function icon(name, size = 22) {
  const s = document.createElementNS(NS, "svg"), p = document.createElementNS(NS, "path");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) s.setAttribute(k, v);
  s.classList.add("icon");
  p.setAttribute("d", ICONS[name] ?? ICONS.pottery);
  s.append(p);
  return s;
}
