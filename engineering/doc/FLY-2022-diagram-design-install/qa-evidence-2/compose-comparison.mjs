// Side-by-side for acceptance ④: the FLY-2004 approved hand-drawn B arm next to the
// diagram this QA generated from an unnamed natural Chinese request. Same subject, so
// the two are directly comparable; each tile is letterboxed, never cropped or stretched.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(dir, "../../../..");
const gitCommonDir = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
const sharpEntry = resolve(dirname(gitCommonDir), "node_modules/.pnpm/sharp@0.34.5/node_modules/sharp/lib/index.js");
const { default: sharp } = await import(pathToFileURL(sharpEntry).href);

const inputs = [
  [resolve(dir, "../evidence/reference-fly2004-arm-b.png"), "FLY-2004 认可锚点（手画 B 臂）"],
  [resolve(dir, "generated-natural.png"), "本轮 QA：不点名自然请求生成"],
];
const out = resolve(dir, "comparison-vs-fly2004.png");
if (existsSync(out)) throw new Error(`refusing to overwrite: ${out}`);

// Stacked at a COMMON WIDTH, each keeping its own aspect ratio. Equal-square tiles were
// rejected: they letterbox a 2.7:1 landscape against a 1:1 portrait and make the shorter
// image look small for reasons that have nothing to do with its quality.
const colWidth = 1500, gap = 40, margin = 48, header = 76;
const composites = [];
const receipts = [];
let y = margin;
for (const [p, label] of inputs) {
  const buf = readFileSync(p);
  receipts.push({ path: p, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length });
  const fitted = await sharp(buf).resize({ width: colWidth }).png().toBuffer();
  const meta = await sharp(fitted).metadata();
  const cap = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${colWidth}" height="${header}">` +
    `<text x="0" y="50" font-family="PingFang SC, Hiragino Sans GB, sans-serif" font-size="32" fill="#2d3142">${label}</text></svg>`
  );
  composites.push({ input: cap, left: margin, top: y });
  composites.push({ input: fitted, left: margin, top: y + header });
  y += header + meta.height + gap;
}
const width = margin * 2 + colWidth;
const height = y - gap + margin;
await sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
  .composite(composites).png().toFile(out);
const outBuf = readFileSync(out);
writeFileSync(resolve(dir, "comparison-receipt.json"), JSON.stringify({
  output: { path: out, sha256: createHash("sha256").update(outBuf).digest("hex"), bytes: outBuf.length, width, height },
  inputs: receipts, fit: "common width, native aspect ratio, no crop",
}, null, 2));
console.log("wrote", out);
