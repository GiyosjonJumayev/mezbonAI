// Syntax-checks every JavaScript file. No dependencies, works on Windows and Linux.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

let failed = 0, n = 0;
for (const dir of ["src", "public", "test", "scripts"])
  for (const f of readdirSync(dir, { recursive: true }).filter((x) => /\.m?js$/.test(x))) {
    n++;
    try { execFileSync(process.execPath, ["--check", path.join(dir, f)], { stdio: "inherit" }); } catch { failed++; }
  }
console.log(failed ? `${failed} file(s) failed` : `${n} files parse`);
process.exit(failed ? 1 : 0);
