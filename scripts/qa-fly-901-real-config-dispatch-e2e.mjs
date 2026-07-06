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
const r1 = dispatcher.dispatch({
	issueLabels: ["product"],
	owningDept: "product",
});
check(
	"S1: product Lead (owningDept=product) + label 'product' -> hits product-designer",
	r1.agentName === "product-designer" && r1.matchMethod === "label",
	r1,
);
check("S1: department reported as 'product'", r1.department === "product", r1);

// ── Scenario 1b: other labels in the real match.labels set (pm/ux/design/designer) ──
for (const label of ["pm", "ux", "design", "designer"]) {
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
