import {cp, mkdir, mkdtemp, readFile, rm} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {join} from "node:path";

const source = new URL("../module/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("module.json", source), "utf8"));
const dist = new URL("../dist/", import.meta.url);
const destination = new URL(`${manifest.id}-v${manifest.version}.zip`, dist);
await mkdir(dist, {recursive: true});

// Stage only the distributable module under the project. Foundry expects a
// top-level directory named after the module ID.
const staging = await mkdtemp(fileURLToPath(new URL(".package-", dist)));
try {
  await cp(source, join(staging, manifest.id), {recursive: true});
  const archive = join(staging, "release.zip");
  execFileSync("zip", ["-qr", archive, manifest.id, "-x", "*/.DS_Store", "*/.claude/*"], {cwd: staging});
  await cp(archive, destination);
} finally {
  await rm(staging, {recursive: true, force: true});
}
console.log(fileURLToPath(destination));
