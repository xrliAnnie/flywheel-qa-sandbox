import { getEncoding } from "/Users/xiaorongli/Dev/flywheel/node_modules/.pnpm/js-tiktoken@1.0.21/node_modules/js-tiktoken/dist/index.js";
import { readFileSync, existsSync } from "node:fs";
const enc = getEncoding("o200k_base"); const H = process.env.HOME;
const sets = {
  raya: [["identity", `${H}/Dev/raya-lead-workspace/.lead/raya/identity.md`], ["workspace-memory", `${H}/Dev/raya-lead-workspace/memory/MEMORY.md`], ["codex-memory-summary", `${H}/.codex-raya/memories/memory_summary.md`]],
  honeylemon: [["identity", `${H}/Dev/flywheel/.lead/flywheel-product-lead/identity.md`], ["user-memory", `${H}/.claude/agent-memory/flywheel-product-lead/MEMORY.md`]],
};
const out = {};
for (const [lead, files] of Object.entries(sets)) { out[lead] = {}; let tb = 0, tt = 0; for (const [k, p] of files) { if (!existsSync(p)) { out[lead][k] = "missing"; continue; } const s = readFileSync(p, "utf8"); const b = Buffer.byteLength(s), t = enc.encode(s).length; tb += b; tt += t; out[lead][k] = { bytes: b, o200k: t, codexEst: Math.ceil(b / 4) }; } out[lead].total = { bytes: tb, o200k: tt }; }
console.log(JSON.stringify(out, null, 1));
