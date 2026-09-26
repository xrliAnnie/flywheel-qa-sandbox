// FLY-901 QA — real-config E2E for the product/design executor dual-register fix.
//
// Loads the ACTUAL `.flywheel/config.yaml` on this branch through the real
// compiled `ConfigLoader` (dist, same code that ships), builds a real
// `AgentDispatcher` from it, and drives `dispatch()` exactly as Blueprint does
// for the product Lead (Honey Lemon, owningDept="product") and the
// engineering Lead (Tadashi, owningDept="engineering"). No mocks — this is the
// literal scenario from the issue: before the fix, a product-labeled issue
// dispatched by the product Lead fell through step-2a (home dept
// "engineering" !== owningDept "product") to the shipped-generic fallback.
//
// Run: node scripts/qa-fly-901-real-config-dispatch-e2e.mjs

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.env.FLY901_ROOT || process.cwd();
const CONFIG_PATH = join(ROOT, ".flywheel/config.yaml");

const { ConfigLoader } = await import(
	pathToFileURL(join(ROOT, "packages/config/dist/index.js")).href
);
const { AgentDispatcher } = await import(
	pathToFileURL(join(ROOT, "packages/edge-worker/dist/AgentDispatcher.js")).href
);

let failures = 0;
function check(label, cond, extra) {
	if (cond) {
		console.log(`  PASS: ${label}`);
	} else {
		failures++;
		console.log(
			`  FAIL: ${label}${extra ? ` — ${JSON.stringify(extra)}` : ""}`,
		);
	}
}

const loader = new ConfigLoader((p) => readFile(p, "utf-8"));
const config = await loader.load(CONFIG_PATH);

check(
	"config.yaml loaded + product-designer registered with departments [engineering, product]",
	JSON.stringify(config.agents?.["product-designer"]?.departments) ===
		JSON.stringify(["engineering", "product"]),
	config.agents?.["product-designer"],
);

const dispatcher = new AgentDispatcher(config.agents, undefined, ROOT);

// ── Scenario 1 (Honey Lemon / product Lead): Flywheel-Product issue, label "product" ──
// The original FLY-901 bug: a product-labeled issue dispatched by the product Lead
// fell to shipped-generic. Dual-register fixed that. FLY-1089 moved `product` from
// product-designer to the pm role, so it now hits `pm` — but the dual-register
// mechanism (step-2a reaching an engineering-home agent from owningDept=product) is
// exactly what this still proves.
const r1 = dispatcher.dispatch({
	issueLabels: ["product"],
	owningDept: "product",
});
check(
	"S1: product Lead (owningDept=product) + label 'product' -> hits pm (FLY-1089)",
	r1.agentName === "pm" && r1.matchMethod === "label",
	r1,
);
check("S1: department reported as 'product'", r1.department === "product", r1);

// ── Scenario 1b: remaining labels on product-designer (doc/design/ux) ──
// FLY-1059 moved `designer` OUT; FLY-1089 moved `product`/`pm` OUT to the pm role.
for (const label of ["ux", "design", "docs"]) {
	const r = dispatcher.dispatch({
		issueLabels: [label],
		owningDept: "product",
	});
	check(
		`S1b: product Lead + label '${label}' -> hits product-designer`,
		r.agentName === "product-designer",
		r,
	);
}

// ── Scenario 1b2 (FLY-1089): pm/product -> pm, prototype -> prototype, dual-registered ──
for (const role of ["pm", "prototype"]) {
	check(
		`S1b2: ${role} registered with departments [engineering, product]`,
		JSON.stringify(config.agents?.[role]?.departments) ===
			JSON.stringify(["engineering", "product"]),
		config.agents?.[role],
	);
}
for (const dept of ["product", "engineering"]) {
	for (const [label, expected] of [
		["pm", "pm"],
		["product", "pm"],
		["prototype", "prototype"],
	]) {
		const r = dispatcher.dispatch({ issueLabels: [label], owningDept: dept });
		check(
			`S1b2: ${dept} Lead + label '${label}' -> hits ${expected}`,
			r.agentName === expected && r.matchMethod === "label",
			r,
		);
	}
}
// 去黑话 (FLY-1089): `poc` is NOT an alias — unknown label falls to shipped-generic.
const rPoc = dispatcher.dispatch({
	issueLabels: ["poc"],
	owningDept: "product",
});
check(
	"S1b2: label 'poc' -> shipped-generic (not an alias for prototype)",
	rPoc.matchMethod === "shipped-generic",
	rPoc,
);

// ── Scenario 1c (FLY-1059): the new visual `designer` role, dual-registered ──
check(
	"S1c: designer registered with departments [engineering, product]",
	JSON.stringify(config.agents?.designer?.departments) ===
		JSON.stringify(["engineering", "product"]),
	config.agents?.designer,
);
for (const dept of ["product", "engineering"]) {
	for (const label of ["designer", "mockup"]) {
		const r = dispatcher.dispatch({ issueLabels: [label], owningDept: dept });
		check(
			`S1c: ${dept} Lead + label '${label}' -> hits the new designer role`,
			r.agentName === "designer" && r.matchMethod === "label",
			r,
		);
	}
}
// UI/frontend production labels stay with engineer (the mockup-first Design PHASE
// is a separate Blueprint mechanism, not this whole-issue route).
const rUi = dispatcher.dispatch({
	issueLabels: ["ui"],
	owningDept: "engineering",
});
check(
	"S1c: label 'ui' -> still hits engineer (not designer)",
	rUi.agentName === "engineer",
	rUi,
);

// ── Scenario 1d (FLY-1059): real-config label overlap = zero (first-match safety) ──
{
	const named = Object.entries(config.agents ?? {}).map(([name, cfg]) => ({
		name,
		labels: new Set((cfg.match?.labels ?? []).map((l) => l.toLowerCase())),
	}));
	let overlapFound = false;
	for (let i = 0; i < named.length; i++) {
		for (let j = i + 1; j < named.length; j++) {
			const a = named[i];
			const b = named[j];
			const inter = [...a.labels].filter((l) => b.labels.has(l));
			if (inter.length > 0) {
				overlapFound = true;
				check(
					`S1d: label overlap between '${a.name}' and '${b.name}'`,
					false,
					inter,
				);
			}
		}
	}
	check(
		"S1d: zero label overlap across all agents (case-insensitive)",
		!overlapFound,
	);
}

// ── Scenario 2 (Tadashi / engineering Lead): zero regression on doc/design routing ──
const r2 = dispatcher.dispatch({
	issueLabels: ["doc"],
	owningDept: "engineering",
});
check(
	"S2: engineering Lead + label 'doc' -> still hits product-designer, department=engineering",
	r2.agentName === "product-designer" && r2.department === "engineering",
	r2,
);

const r2b = dispatcher.dispatch({
	issueLabels: ["code", "feat"],
	owningDept: "engineering",
});
check(
	"S2b: engineering Lead + code label -> still hits 'engineer' (untouched)",
	r2b.agentName === "engineer",
	r2b,
);

// ── Scenario 3: no cross-dept leak for a dept NOT in product-designer.departments ──
const r3 = dispatcher.dispatch({ issueLabels: ["product"], owningDept: "ops" });
check(
	"S3: ops Lead (unlisted dept) + label 'product' -> falls to shipped-generic (no leak)",
	r3.matchMethod === "shipped-generic",
	r3,
);

// ── Scenario 4: qa executor (dept-owned, no `departments` field) untouched ──
const r4 = dispatcher.dispatch({
	issueLabels: ["qa"],
	owningDept: "engineering",
});
check(
	"S4: engineering Lead + 'qa' label -> still hits qa executor (byte-compat, no departments field)",
	r4.agentName === "qa",
	r4,
);

console.log("");
if (failures === 0) {
	console.log(
		"RESULT: ALL PASS (real .flywheel/config.yaml, real compiled dispatcher)",
	);
	process.exit(0);
} else {
	console.log(`RESULT: ${failures} FAILURE(S)`);
	process.exit(1);
}
