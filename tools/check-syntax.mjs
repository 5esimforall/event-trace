import {execFileSync} from "node:child_process";
import {readdirSync} from "node:fs";
import {fileURLToPath} from "node:url";

const root = new URL("../", import.meta.url);
const files = ["module/scripts/", "tools/"].flatMap(dir => readdirSync(new URL(dir, root))
  .filter(file => file.endsWith(".mjs"))
  .map(file => fileURLToPath(new URL(`${dir}${file}`, root))));
for (const file of files) execFileSync(process.execPath, ["--check", file], {stdio: "inherit"});
console.log(`Syntax OK: ${files.length} files`);
