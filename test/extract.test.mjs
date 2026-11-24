import test from "node:test";
import assert from "node:assert/strict";
import { extractFacts, readNumber, templateI18n } from "../src/extract.mjs";

test("Uzbek numbers", () => {
  for (const [s, v] of [["yuz ellik ming", 150000], ["ikki yuz ming", 200000], ["150 ming", 150000], ["150 000", 150000], ["150.000", 150000], ["bir million ikki yuz ming", 1200000], ["o'n besh", 15], ["ming", 1000]])
    assert.equal(readNumber(s.split(" ")).value, v, s);
  assert.equal(readNumber(["salom"]), null);
});

test("full sentence", () => {
  assert.deepEqual(extractFacts("Assalomu alaykum, men Rishtonda kulolman. Ikki soat, yuz ellik ming so‘m, sakkiz kishi."),
    { category: "pottery", region: "fargona", place: "Rishton", price_uzs: 150000, duration_min: 120, capacity: 8 });
});

test("apostrophe variants and half hours", () => {
  for (const a of ["'", "‘", "’", "ʻ", "`"]) assert.equal(extractFacts(`Marg${a}ilonda atlas, bir yarim soat, 120 ming so${a}m`).price_uzs, 120000);
  assert.equal(extractFacts("bir yarim soat").duration_min, 90);
});

test("unsaid facts stay null", () => {
  assert.deepEqual(extractFacts("Men somsa pishiraman"), { category: "cooking", region: null, place: null, price_uzs: null, duration_min: null, capacity: null });
});

test("clock time is not a duration", () => {
  assert.equal(extractFacts("Xivada gilam, soat 10 da boshlanadi, 6 kishi").duration_min, null);
});

test("a region-level place is written the way each language does; towns stay as they are", () => {
  const f = { category: "bread", duration_min: 60, capacity: 5 };
  assert.match(templateI18n({ ...f, place: "Samarqand", region: "samarqand" }, "A").zh.title, /撒马尔罕/);
  assert.match(templateI18n({ ...f, place: "Rishton", region: "fargona" }, "A").zh.title, /Rishton/);
});

test("guiding is a tour", () => {
  assert.equal(extractFacts("Samarqandda gidman, ekskursiya o'tkazaman").category, "tour");
});
