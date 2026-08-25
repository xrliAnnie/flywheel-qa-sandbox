#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(evidenceDir, "../../../..");
const [inputName, svgName, pngName, receiptName] = process.argv.slice(2);

if (!inputName || !svgName || !pngName || !receiptName) {
	console.error(
		"usage: node render-diagram.mjs <input.html> <output.svg> <output.png> <receipt.json>",
	);
	process.exit(2);
}

function evidencePath(name) {
	const path = resolve(evidenceDir, name);
	if (path !== evidenceDir && !path.startsWith(`${evidenceDir}${sep}`)) {
		throw new Error(`evidence path escapes task folder: ${name}`);
	}
	return path;
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

const inputPath = evidencePath(inputName);
const svgPath = evidencePath(svgName);
const pngPath = evidencePath(pngName);
const receiptPath = evidencePath(receiptName);
if (!existsSync(inputPath)) throw new Error(`missing input: ${inputPath}`);
for (const path of [svgPath, pngPath, receiptPath]) {
	if (existsSync(path)) throw new Error(`refusing to overwrite: ${path}`);
}

const html = readFileSync(inputPath, "utf8");
const svgMatch = html.match(/<svg\b[\s\S]*?<\/svg>/i);
if (!svgMatch) throw new Error("input HTML has no inline SVG");
const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/i);
const style = styleMatch?.[1] ?? "";
let svg = svgMatch[0].replace(
	/<svg\b/,
	'<svg width="1080" height="1080"',
);
if (style) {
	const descEnd = svg.indexOf("</desc>");
	if (descEnd < 0) throw new Error("SVG is missing its required desc element");
	const insertion = descEnd + "</desc>".length;
	svg = `${svg.slice(0, insertion)}\n  <style><![CDATA[${style}]]></style>${svg.slice(insertion)}`;
}
writeFileSync(svgPath, `${svg}\n`);

const gitCommonDir = spawnSync(
	"git",
	["rev-parse", "--path-format=absolute", "--git-common-dir"],
	{ cwd: repoRoot, encoding: "utf8" },
).stdout.trim();
if (!gitCommonDir) throw new Error("cannot resolve shared git directory");
const primaryCheckout = dirname(gitCommonDir);
const sharpEntry = resolve(
	primaryCheckout,
	"node_modules/.pnpm/sharp@0.34.5/node_modules/sharp/lib/index.js",
);
if (!existsSync(sharpEntry)) {
	throw new Error(`repo-pinned sharp 0.34.5 is not installed at ${sharpEntry}`);
}
const { default: sharp } = await import(pathToFileURL(sharpEntry).href);
const renderInfo = await sharp(Buffer.from(svg), { density: 144 })
	.png()
	.toFile(pngPath);
const metadata = await sharp(pngPath).metadata();

const fontPattern =
	"PingFang SC,Hiragino Sans GB,Noto Sans CJK SC,Microsoft YaHei,sans-serif";
const fontCandidates = spawnSync(
	"fc-match",
	["-s", "-f", "%{family}|%{postscriptname}|%{file}\\n", fontPattern],
	{ encoding: "utf8" },
)
	.stdout.split(/\r?\n/)
	.filter(Boolean)
	.slice(0, 12);
const png = readFileSync(pngPath);
const physicalCjkCandidate = fontCandidates.find((candidate) =>
	/Hiragino Sans GB|PingFang|Noto Sans CJK|Microsoft YaHei/i.test(candidate),
);

const receipt = {
	tool: relative(repoRoot, fileURLToPath(import.meta.url)),
	renderer: {
		name: "sharp/librsvg",
		sharp: sharp.versions.sharp,
		vips: sharp.versions.vips,
		density: 144,
		degradation: {
			reason:
				"Runner process sandbox aborts Google Chrome headless (exit 134) and rejects qlmanage sandbox initialization (exit 255). The same Chrome 151 CDP procedure was independently verified during design review R3; this run uses the repo-pinned local SVG rasterizer instead of installing Playwright or a system package.",
			browserGeometryAvailable: false,
		},
	},
	input: {
		path: relative(repoRoot, inputPath),
		bytes: Buffer.byteLength(html),
		sha256: sha256(html),
	},
	extractedSvg: {
		path: relative(repoRoot, svgPath),
		bytes: Buffer.byteLength(svg),
		sha256: sha256(svg),
		viewBox: svg.match(/viewBox="([^"]+)"/)?.[1] ?? null,
		cjkTextNodes: [...svg.matchAll(/<text\b[^>]*>[\s\S]*?[\u3400-\u9fff][\s\S]*?<\/text>/gu)]
			.length,
	},
	output: {
		path: relative(repoRoot, pngPath),
		bytes: png.byteLength,
		sha256: sha256(png),
		width: metadata.width,
		height: metadata.height,
		channels: metadata.channels,
		space: metadata.space,
		renderInfo,
	},
	fontObservation: {
		declaredStack: fontPattern,
		fontconfigCandidates: fontCandidates,
		firstCjkCapableCandidate: physicalCjkCandidate ?? null,
		claimBoundary:
			"Fontconfig candidate order plus the produced raster is recorded; without CDP CSS.getPlatformFontsForNode in this runner sandbox, this receipt does not label the candidate as the browser's physical glyph face.",
	},
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

const failures = [];
if (metadata.width !== 2160 || metadata.height !== 2160) {
	failures.push(`PNG must be 2160x2160, got ${metadata.width}x${metadata.height}`);
}
if (receipt.extractedSvg.viewBox !== "0 0 1080 1080") {
	failures.push(`SVG viewBox drifted: ${receipt.extractedSvg.viewBox}`);
}
if (receipt.extractedSvg.cjkTextNodes === 0) failures.push("SVG has no CJK text nodes");
if (!physicalCjkCandidate) failures.push("fontconfig found no CJK-capable fallback candidate");
if (failures.length > 0) throw new Error(failures.join("; "));

console.log(
	`PASS render ${inputName}: ${metadata.width}x${metadata.height}, CJK candidate=${physicalCjkCandidate}`,
);
