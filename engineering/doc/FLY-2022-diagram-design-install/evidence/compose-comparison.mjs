#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(evidenceDir, "../../../..");
const inputs = [
	["reference-fly2004-arm-b.png", "FLY-2004 认可锚点"],
	["explicit-generated.png", "权威显式调用"],
	["natural-generated.png", "不点名自然触发"],
];
const outputPath = resolve(evidenceDir, "comparison.png");
const receiptPath = resolve(evidenceDir, "comparison-receipt.json");
for (const path of [outputPath, receiptPath]) {
	if (existsSync(path)) throw new Error(`refusing to overwrite: ${path}`);
}

const gitCommonDir = spawnSync(
	"git",
	["rev-parse", "--path-format=absolute", "--git-common-dir"],
	{ cwd: repoRoot, encoding: "utf8" },
).stdout.trim();
const sharpEntry = resolve(
	dirname(gitCommonDir),
	"node_modules/.pnpm/sharp@0.34.5/node_modules/sharp/lib/index.js",
);
const { default: sharp } = await import(pathToFileURL(sharpEntry).href);

const tile = 680;
const gap = 24;
const margin = 40;
const header = 96;
const width = margin * 2 + tile * 3 + gap * 2;
const height = margin * 2 + header + tile;
const composites = [];
const inputReceipts = [];
for (const [index, [name, label]] of inputs.entries()) {
	const path = resolve(evidenceDir, name);
	const bytes = readFileSync(path);
	const image = await sharp(bytes)
		.resize(tile, tile, { fit: "contain", background: "#f5f5f5" })
		.png()
		.toBuffer();
	composites.push({ input: image, left: margin + index * (tile + gap), top: margin + header });
	inputReceipts.push({
		path: relative(repoRoot, path),
		label,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	});
}
const labels = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#f5f5f5"/>
  <text x="${margin}" y="42" fill="#eb6c36" font-size="12" font-weight="600" letter-spacing="2" font-family="Hiragino Sans GB, sans-serif">FLY-2022 · SAME SUBJECT · SIDE BY SIDE</text>
  ${inputs.map(([, label], index) => `<text x="${margin + index * (tile + gap)}" y="82" fill="#2d3142" font-size="20" font-weight="600" font-family="Hiragino Sans GB, sans-serif">${label}</text>`).join("\n  ")}
</svg>`;
composites.unshift({ input: Buffer.from(labels), left: 0, top: 0 });

await sharp({ create: { width, height, channels: 4, background: "#f5f5f5" } })
	.composite(composites)
	.png()
	.toFile(outputPath);
const output = readFileSync(outputPath);
writeFileSync(
	receiptPath,
	`${JSON.stringify(
		{
			tool: relative(repoRoot, fileURLToPath(import.meta.url)),
			renderer: `sharp ${sharp.versions.sharp} / libvips ${sharp.versions.vips}`,
			inputs: inputReceipts,
			output: {
				path: relative(repoRoot, outputPath),
				width,
				height,
				bytes: output.byteLength,
				sha256: createHash("sha256").update(output).digest("hex"),
			},
		},
		null,
		2,
	)}\n`,
);
console.log(`PASS comparison: ${width}x${height}`);
