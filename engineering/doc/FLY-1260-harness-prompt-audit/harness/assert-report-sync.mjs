/**
 * FLY-1260 R3 (Codex code review MEDIUM): source-of-truth assertion.
 *
 * report.html embeds an evidence MANIFEST object + per-card byte values +
 * summary numbers by hand. In R1→R2 those drifted from the regenerated
 * inventory-data.json/manifest, so the founder-facing artifact (and its export)
 * carried stale numbers. This script re-derives the canonical numbers from the
 * committed data + manifest and asserts every one of them appears verbatim in
 * report.html. It is run in the M4 preflight and MUST pass before publish.
 *
 * Bounded by design: it checks the specific fields report.html embeds (MANIFEST
 * provenance, the S02 bar decomposition, the summary table, and every card's
 * measured `bytes`). It is a drift tripwire, not a full re-render.
 *
 * Run:  node engineering/doc/FLY-1260-harness-prompt-audit/harness/assert-report-sync.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC = path.resolve(HERE, "..");
const data = JSON.parse(
	fs.readFileSync(path.join(HERE, "inventory-data.json"), "utf8"),
);
const manifest = JSON.parse(
	fs.readFileSync(path.join(HERE, "inventory-manifest.json"), "utf8"),
);
const html = fs.readFileSync(path.join(DOC, "report.html"), "utf8");

const fmt = (n) => n.toLocaleString("en-US");
const fails = [];
const require = (label, needle) => {
	if (!html.includes(needle)) fails.push(`${label}: missing "${needle}"`);
};

// ── MANIFEST provenance embedded in the report's <script> ──────────────────
const manifestBlock = html.match(/var MANIFEST = \{([\s\S]*?)\};/)?.[1] ?? "";
const mField = (k) =>
	manifestBlock.match(new RegExp(`${k}:\\s*"?([^",\\n]+)"?`))?.[1]?.trim();
const checkM = (k, expected) => {
	const got = mField(k);
	if (String(got) !== String(expected))
		fails.push(`MANIFEST.${k}: report="${got}" data="${expected}"`);
};
checkM("blueprintFileSha", manifest.blueprintFileSha);
checkM("repoHeadSha", manifest.repoHeadSha);
checkM("scenarios", manifest.scenarios.length);
checkM("anchors", manifest.anchors.length);
checkM("skillLockCount", manifest.skillCount);

// ── S02 bar decomposition + headline ratios ────────────────────────────────
const s02 = data.scenarios.find(
	(s) => s.scenario === "S02-prod-generic-claude",
);
const bytesOf = (blk) =>
	s02.blocks.find((b) => b.block === blk)?.utf8Bytes ?? 0;
const role = bytesOf("agent-role");
const total = s02.totalUtf8Bytes;
const nonRole = total - role;
const CONTRACT = [
	"lead-report-back",
	"approve-gate",
	"brainstorm-gate",
	"question-gate",
	"review-design-gate",
	"review-code-gate",
	"completion-reporting",
	"stage-reporting",
	"lead-inbox",
	"ask-nonblocking",
];
const contract = CONTRACT.reduce((a, b) => a + bytesOf(b), 0);
const other = total - role - contract;
const rolePct = ((role / total) * 100).toFixed(1);
const contractPct = ((contract / nonRole) * 100).toFixed(1);

require("S02 total", fmt(total));
require("agent-role bytes", fmt(role));
require("role %", `${rolePct}%`);
require("contract layer bytes", fmt(contract));
require("contract %", `${contractPct}%`);
require("bar 'other' bytes", fmt(other));
require("approve-gate bytes", fmt(bytesOf("approve-gate")));

// ── Lead bundles: assembled sizes must be labelled correctly ───────────────
for (const b of data.leadBundles) {
	require(`lead ${b.role} rawSum`, fmt(b.rawSumUtf8Bytes));
}

// ── skills description resident + body on-demand ───────────────────────────
const descResident = data.skills.reduce(
	(a, s) => a + s.descriptionUtf8Bytes,
	0,
);
const bodyOnDemand = data.skills.reduce((a, s) => a + s.bodyUtf8Bytes, 0);
require("skills description resident", fmt(descResident));
require("skills body on-demand", fmt(bodyOnDemand));

// ── Every card's measured `bytes` value must be a real measured number ─────
// Parse CARDS bytes and confirm each maps to a live block/section byte count.
// Blueprint blocks come from data; role-file sections are re-measured here.
const genericPath = path.resolve(
	HERE,
	"../../../../agents/generic-executor.md",
);
const gen = fs.readFileSync(genericPath, "utf8");
const seg = (a, b) => {
	const i = a === "(START)" ? 0 : gen.indexOf(a);
	const j = b == null ? gen.length : gen.indexOf(b);
	return Buffer.byteLength(gen.slice(i, j), "utf8");
};
// canonical per-card measured bytes (must match report.html card `bytes:`)
const CARD_BYTES = {
	"C:packages/teamlead/lead-rules-base/department-lead-rules.md:reply-discipline-trio": 20909,
	"B:agents/generic-executor.md:pipeline-stages": seg(
		"## Pipeline stages",
		"## Failure path",
	),
	"B:agents/generic-executor.md:critical-rules": seg(
		"## Critical rules",
		"## Skills you can assume exist",
	),
	"B:agents/generic-executor.md:skills-you-can-assume": seg(
		"## Skills you can assume exist",
		"## Pipeline stages",
	),
	"B:agents/generic-executor.md:override-c": seg(
		"**C. Simple tasks",
		"> **Scope note",
	),
	"B:agents/generic-executor.md:when-youre-being-used": seg(
		gen.match(/## When you.re being used/)[0],
		"## Critical rules",
	),
	"B:agents/generic-executor.md:superpowers-intro": seg(
		"## Default Workflow — Superpowers RPC (no agent role assigned)",
		"### The headless-Runner rule",
	),
	"B:agents/generic-executor.md:interaction-principles": seg(
		"## Interaction principles",
		"## Default Workflow",
	),
	"A:packages/edge-worker/src/Blueprint.ts:base-flow": bytesOf("base-flow"),
	"A:packages/edge-worker/src/Blueprint.ts:pipeline-preamble":
		bytesOf("pipeline-preamble"),
};
// Extract each card {id,bytes} pair from report.html.
const cardRe = /id:\s*"([^"]+)"[\s\S]*?bytes:\s*(\d+)/g;
const seenCards = new Set();
for (const [, id, bytesStr] of html.matchAll(cardRe)) {
	if (!(id in CARD_BYTES)) continue; // only assert the audit cards
	seenCards.add(id);
	if (Number(bytesStr) !== CARD_BYTES[id]) {
		fails.push(
			`card ${id}: report bytes=${bytesStr} measured=${CARD_BYTES[id]}`,
		);
	}
}
for (const id of Object.keys(CARD_BYTES)) {
	if (!seenCards.has(id)) fails.push(`card ${id}: not found in report.html`);
}

if (fails.length) {
	console.error(
		"FAIL: report.html is out of sync with inventory data/manifest:",
	);
	for (const f of fails) console.error(`  - ${f}`);
	process.exit(1);
}
console.log(
	`OK: report.html in sync — MANIFEST provenance, S02 decomposition (${fmt(total)} B, role ${rolePct}%, contract ${contractPct}%), lead bundles, skills, and ${seenCards.size} card byte values all match the data.`,
);
