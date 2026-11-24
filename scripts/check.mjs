// Syntax-checks every JavaScript file. No dependencies, works on Windows and Linux.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

let failed = 0;
for (const dir of ["src", "public", "test", "scripts"])
  for (const f of readdirSync(dir).filter((x) => /\.m?js$/.test(x))) {
    try { execFileSync(process.execPath, ["--check", path.join(dir, f)], { stdio: "inherit" }); } catch { failed++; }
  }
console.log(failed ? `${failed} file(s) failed` : "All files parse");
process.exit(failed ? 1 : 0);
