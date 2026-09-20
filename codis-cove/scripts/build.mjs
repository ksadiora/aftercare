import { mkdir, copyFile, readFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
await mkdir("dist/vendor", { recursive: true });
for (const file of ["three.module.js", "three.core.js"])
  await copyFile(`node_modules/three/build/${file}`, `dist/vendor/${file}`);
await copyFile("node_modules/three/LICENSE", "dist/vendor/THREE-LICENSE.txt");
for (const file of ["app.js", "world.js", "game.js", "services.js", "codi.js", "tutorials.js"])
  execFileSync(process.execPath, ["--check", `dist/${file}`]);
for (const file of [
  "config.mjs",
  "services.mjs",
  "server.mjs",
  "serve.mjs",
  "gemini.mjs",
])
  execFileSync(process.execPath, ["--check", `scripts/${file}`]);
const html = await readFile("dist/index.html", "utf8");
for (const [, path] of html.matchAll(/(?:src|href)="\.\/([^"#]+)"/g))
  await access(`dist/${path}`);
console.log("Codi’s Cove is ready. Static site: dist/");
