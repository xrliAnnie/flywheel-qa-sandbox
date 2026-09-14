// Inline locally rendered mmdc SVGs into founder-design.html (zero runtime mermaid).
// usage: node diagrams/build-founder-html.mjs "<review meta text>"
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir, "..");
const meta = process.argv[2] ?? "";
let html = readFileSync(join(root, "founder-design.template.html"), "utf8");
const map = { d1: "d1-core-flow.svg", d2: "d2-data-model.svg", d3: "d3-decision.svg" };
for (const [key, file] of Object.entries(map)) {
  let svg = readFileSync(join(dir, file), "utf8").replace(/^<\?xml[^>]*>\s*/, "");
  if (!svg.includes(`id="FLY-2390-${key}"`)) throw new Error(`${file} lacks unique svg id`);
  const marker = `<!--DIAGRAM:${key}-->`;
  if (!html.includes(marker)) throw new Error(`template lacks ${marker}`);
  html = html.replace(marker, svg);
}
if (meta) html = html.replace("__REVIEW_META__", meta);
if (html.includes("<!--DIAGRAM:") || html.includes("__REVIEW_META__")) throw new Error("placeholder left");
if ((html.match(/__CSP_NONCE__/g) ?? []).length !== 1) throw new Error("nonce placeholder count != 1");
writeFileSync(join(root, "founder-design.html"), html);
console.log(`wrote founder-design.html ${Buffer.byteLength(html)} bytes`);
