#!/usr/bin/env node
// FLY-2496: inline locally rendered Mermaid SVGs into the founder design HTML. No network.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const svg = (name) => readFileSync(join(here, "diagrams", name), "utf8").replace(/^\s*<\?xml[^>]*>\s*/, "");
let html = readFileSync(join(here, "founder-design.template.html"), "utf8");
for (const [ph, file] of [["__SVG_D1__", "d1-flow.svg"], ["__SVG_D2__", "d2-data.svg"], ["__SVG_D3__", "d3-boundary.svg"]]) {
  if (!html.includes(ph)) throw new Error(`placeholder missing: ${ph}`);
  html = html.replace(ph, () => svg(file));
}
if (/__SVG_D\d__/.test(html)) throw new Error("unreplaced svg placeholder");
if ((html.match(/__CSP_NONCE__/g) || []).length !== 1) throw new Error("nonce placeholder must appear exactly once");
if (/<script(?![^>]*nonce=)/.test(html)) throw new Error("un-nonced script");
if (/\son[a-z]+=/i.test(html.replace(/<svg[\s\S]*?<\/svg>/g, ""))) throw new Error("inline event handler attribute");
if (/(src|href)=["']https?:/i.test(html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/https:\/\/linear\.app[^"']*/g, ""))) throw new Error("external resource reference");
writeFileSync(join(here, "founder-design.html"), html);
console.log(`wrote founder-design.html ${Buffer.byteLength(html)} bytes`);
