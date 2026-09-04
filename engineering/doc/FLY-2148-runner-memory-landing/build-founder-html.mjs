#!/usr/bin/env node
// FLY-2148: assemble founder-design.html from founder-design.template.html by
// inlining the locally rendered Mermaid SVGs. The template is the single source
// of truth — edit the template, never the built file (rebuilding would silently
// revert direct edits). Fails loudly if any placeholder is left unfilled or an
// SVG is missing / lacks its stable id.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const templatePath = join(here, "founder-design.template.html");
const outPath = join(here, "founder-design.html");
const diagrams = {
	__SVG_D1__: ["d1-core-flow.svg", "FLY-2148-d1"],
	__SVG_D2__: ["d2-data-model.svg", "FLY-2148-d2"],
	__SVG_D3__: ["d3-closeout-sequence.svg", "FLY-2148-d3"],
	__SVG_D4__: ["d4-truncation-guard.svg", "FLY-2148-d4"],
};

let html = readFileSync(templatePath, "utf8");
for (const [placeholder, [file, svgId]] of Object.entries(diagrams)) {
	const svg = readFileSync(join(here, "diagrams", file), "utf8").replace(
		/^<\?xml[^>]*\?>\s*/,
		"",
	);
	if (!svg.includes(`id="${svgId}"`)) {
		throw new Error(`${file}: missing stable svg id ${svgId}`);
	}
	if (!svg.startsWith("<svg")) throw new Error(`${file}: not an <svg> root`);
	const count = html.split(placeholder).length - 1;
	if (count !== 1) {
		throw new Error(`${placeholder}: expected exactly 1 occurrence, got ${count}`);
	}
	html = html.replace(placeholder, svg);
}
const leftover = html.match(/__SVG_D\d+__|__REVIEW_META__/g);
if (leftover) throw new Error(`unfilled placeholders: ${leftover.join(", ")}`);
if (html.split("__CSP_NONCE__").length - 1 !== 1) {
	throw new Error("expected exactly one __CSP_NONCE__ script placeholder");
}
if (/Content-Security-Policy/i.test(html)) {
	throw new Error("template must not carry its own CSP meta");
}
if (/\son[a-z]+=["']/i.test(html)) throw new Error("inline event handler attribute found");
if (/<(script|link)[^>]+(src|href)=["']https?:/i.test(html)) {
	throw new Error("external script/style reference found");
}
writeFileSync(outPath, html);
console.log(`wrote ${outPath} (${Buffer.byteLength(html)} bytes)`);
