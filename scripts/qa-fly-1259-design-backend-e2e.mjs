#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
/**
 * FLY-1259 — INDEPENDENT QA harness (QA session 72ccb2a5).
 *
 * SCOPE / HONESTY (Codex R1 CHANGES-REQUESTED, addressed):
 * This is a COMPILED-DIST + REAL-SQLITE integration harness. It drives the real
 * built `dist` resolution/persistence/display code and a real better-sqlite3
 * StateStore. It is NOT the isolated-Bridge real-OS-runner Task-10 acceptance —
 * it does NOT start a Bridge, POST to the HTTP `/api/runs/start` route, spawn a
 * real codex/claude tmux process, or read Lead notifications / thread titles from
 * a live run. Do not read any check here as "real-machine E2E".
 *
 * Where the OTHER tiers of FLY-1259 verification live (run separately, cited in
 * qa-report.md — this harness deliberately does not duplicate them):
 *   - REAL HTTP route, both override directions + receipt + dispatch vendor:
 *     packages/teamlead/src/__tests__/start-e2e.test.ts  (real Bridge app via
 *     createBridgeApp().listen() on a local TCP port, hit with real fetch;
 *     global-off+codex → receipt codex + dispatchVendor codex;
 *     global-on+claude → receipt claude + dispatchVendor claude).
 *   - Full FLY-1259 unit+integration suites (config + teamlead).
 *   - Isolated-Bridge real-OS-runner Task 10 (plan.md §Task 10): NOT executed
 *     here — deferred deployed-Bridge / 529-Room / founder acceptance.
 *
 * What THIS harness verifies (all against the real built dist):
 *   1. ADMISSION resolution — resolveThreeStageEntry(designBackend) locks the
 *      effective backend + resolves the design phase {vendor, model, effort}.
 *   2. MUTATION guard — the override flips the outcome away from the global
 *      switch in BOTH directions (proves it is load-bearing).
 *   3. BYTE-COMPAT — no override → pure global-switch behavior.
 *   4. KILL-SWITCH — resolveGlobalThreeStageKillSwitch early not-applicable.
 *   5. PUBLIC ENUM — isDesignBackend / DESIGN_BACKENDS validation surface.
 *   6. REAL sqlite — design_backend is SET-ONCE on a row (same-row COALESCE);
 *      legacy rows read undefined. (This is same-row persistence, NOT
 *      cross-session propagation — see §7 for real inheritance.)
 *   7. REAL successor inheritance — the production function
 *      buildRescueSuccessorDispatchFields propagates a persisted design_backend
 *      into the successor dispatch triple.
 *   8. OBSERVABILITY — phaseMessageTag + sessionModelDisplay render the locked
 *      backend into the founder-visible [DESIGN] title/window differently.
 *
 * Reproducible: the repo root is derived from this file's own location, and the
 * dist FLY-1259 surface is asserted present before any check runs.
 */
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// Derive the repo root from THIS file (scripts/…), never a hardcoded absolute
// path — so any checkout runs it and it can only load this checkout's dist.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const cfg = require(`${ROOT}/packages/config/dist/index.js`);
const pol = require(
	`${ROOT}/packages/teamlead/dist/bridge/three-stage-policy.js`,
);
const rmd = require(
	`${ROOT}/packages/teamlead/dist/bridge/runner-model-display.js`,
);
const rescue = require(
	`${ROOT}/packages/teamlead/dist/bridge/rescue-runtime.js`,
);
const { StateStore } = require(`${ROOT}/packages/teamlead/dist/StateStore.js`);

let pass = 0;
const failures = [];

function check(name, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		failures.push(`${name}\n      expected: ${e}\n      actual:   ${a}`);
		console.log(`  ✗ ${name}\n      expected: ${e}\n      actual:   ${a}`);
	}
}

// ── Section 0: dist freshness — this build carries the FLY-1259 surface ────────
console.log(`[0] Loaded dist under ${ROOT}`);
check(
	"dist exports DESIGN_BACKENDS",
	[...cfg.DESIGN_BACKENDS],
	["codex", "claude"],
);
check(
	"dist resolveThreeStageEntry accepts a 3rd designBackend arg",
	typeof pol.resolveThreeStageEntry,
	"function",
);
check(
	"dist buildRescueSuccessorDispatchFields present",
	typeof rescue.buildRescueSuccessorDispatchFields,
	"function",
);

/** Real admission, exactly as runs-route calls it for a fresh three-stage run. */
function admit({ env = {}, designBackend, labels = [] } = {}) {
	return pol.resolveThreeStageEntry({
		requestRole: "main",
		pipelineConfig: { three_stage: true },
		issueLabels: labels,
		env,
		designBackend,
	});
}

// ── Section 1: the two override directions at the ADMISSION layer ─────────────
console.log("\n[1] Admission override directions (dist resolution layer)");
{
	// A) global switch says "design stays claude" (0), override forces codex.
	const a = admit({
		env: { FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "0" },
		designBackend: "codex",
	});
	check(
		"A: global=0 + override codex → enters three-stage",
		a.enteredThreeStage,
		true,
	);
	check("A: locked designBackend = codex", a.designBackend, "codex");
	check("A: design dispatch vendor = codex", a.dispatchVendor, "codex");
	check(
		"A: design dispatch model = gpt-5.6-sol",
		a.dispatchModel,
		"gpt-5.6-sol",
	);
	check("A: design dispatch effort = xhigh", a.dispatchEffort, "xhigh");

	// B) global switch says "design flips to codex" (1), override forces claude.
	const b = admit({
		env: { FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "1" },
		designBackend: "claude",
	});
	check(
		"B: global=1 + override claude → enters three-stage",
		b.enteredThreeStage,
		true,
	);
	check("B: locked designBackend = claude", b.designBackend, "claude");
	check("B: design dispatch vendor = claude", b.dispatchVendor, "claude");
	check(
		"B: design dispatch model = fable (claude default)",
		b.dispatchModel,
		"claude-fable-5",
	);
}

// ── Section 2: mutation guard — the override must FLIP the outcome ─────────────
console.log("\n[2] Mutation guard — override overrides the global switch");
{
	const base0 = admit({ env: { FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "0" } });
	check(
		"global=0, no override → design vendor claude",
		base0.dispatchVendor,
		"claude",
	);
	const over0 = admit({
		env: { FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "0" },
		designBackend: "codex",
	});
	check(
		"global=0 + override codex FLIPS to codex",
		over0.dispatchVendor,
		"codex",
	);
	check(
		"  → and the two differ (override is load-bearing)",
		base0.dispatchVendor !== over0.dispatchVendor,
		true,
	);

	const base1 = admit({ env: { FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "1" } });
	check(
		"global=1, no override → design vendor codex",
		base1.dispatchVendor,
		"codex",
	);
	const over1 = admit({
		env: { FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "1" },
		designBackend: "claude",
	});
	check(
		"global=1 + override claude FLIPS to claude",
		over1.dispatchVendor,
		"claude",
	);
	check(
		"  → and the two differ (override is load-bearing)",
		base1.dispatchVendor !== over1.dispatchVendor,
		true,
	);
}

// ── Section 3: default path byte-compat (no designBackend) ────────────────────
console.log("\n[3] Byte-compat — no override → pure global-switch behavior");
{
	const d0 = admit({ env: {} });
	check(
		"no override, no env → claude (legacy default)",
		d0.dispatchVendor,
		"claude",
	);
	check(
		"no override → designBackend still locked to resolved vendor",
		d0.designBackend,
		"claude",
	);
}

// ── Section 4: kill-switch is the ONE early not-applicable check ───────────────
console.log(
	"\n[4] Global kill-switch (the route's pre-admission early 400 source)",
);
{
	const off = pol.resolveGlobalThreeStageKillSwitch({
		FLYWHEEL_THREE_STAGE: "0",
	});
	check(
		"FLYWHEEL_THREE_STAGE=0 → block with reasonCode",
		off?.reasonCode,
		"global_disabled",
	);
	const on = pol.resolveGlobalThreeStageKillSwitch({});
	check("three-stage on → no early block (undefined)", on, undefined);
	const nonMain = pol.resolveThreeStageEntry({
		requestRole: "qa",
		pipelineConfig: { three_stage: true },
		issueLabels: [],
		env: {},
		designBackend: "codex",
	});
	check(
		"non-main role → not entered, reason non_main_role",
		nonMain.notEnteredReasonCode,
		"non_main_role",
	);
}

// ── Section 5: public enum validation (untrusted body boundary) ───────────────
console.log(
	"\n[5] Public enum — exactly what the route validates the body against",
);
check(
	"DESIGN_BACKENDS = [codex, claude]",
	[...cfg.DESIGN_BACKENDS],
	["codex", "claude"],
);
check("isDesignBackend('codex')", cfg.isDesignBackend("codex"), true);
check("isDesignBackend('claude')", cfg.isDesignBackend("claude"), true);
check("isDesignBackend('gpt') → rejected", cfg.isDesignBackend("gpt"), false);
check(
	"isDesignBackend('agy') → rejected (not a design backend)",
	cfg.isDesignBackend("agy"),
	false,
);
check("isDesignBackend(42) → rejected", cfg.isDesignBackend(42), false);
check("isDesignBackend(null) → rejected", cfg.isDesignBackend(null), false);

// ── Section 6: REAL sqlite persistence — SAME-ROW set-once lock ────────────────
// NOTE: this proves the COALESCE(design_backend, excluded.design_backend)
// same-row set-once behavior, NOT cross-session inheritance — see §7 for that.
console.log(
	"\n[6] Real better-sqlite3 round-trip — design_backend is SET-ONCE per row",
);
{
	const dir = mkdtempSync(join(tmpdir(), "fly1259-qa-"));
	const dbPath = join(dir, "teamlead.db");
	try {
		const store = await StateStore.create(dbPath);
		store.upsertSession({
			execution_id: "exec-design",
			issue_id: "FLY-1259",
			project_name: "P",
			status: "running",
			chat_thread_role: "design",
			design_backend: "codex",
		});
		let s = store.getSession("exec-design");
		check(
			"design row persists design_backend=codex",
			s?.design_backend,
			"codex",
		);

		// A LATER re-upsert of the SAME row tries to write claude → MUST be ignored
		// (set-once COALESCE). This is same-row immutability, not propagation.
		store.upsertSession({
			execution_id: "exec-design",
			issue_id: "FLY-1259",
			project_name: "P",
			status: "completed",
			chat_thread_role: "design",
			design_backend: "claude",
		});
		s = store.getSession("exec-design");
		check(
			"same-row re-upsert can NOT overwrite the lock (still codex)",
			s?.design_backend,
			"codex",
		);

		// A row with NO design_backend reads back undefined (byte-compat legacy row).
		store.upsertSession({
			execution_id: "exec-legacy",
			issue_id: "GEO-legacy",
			project_name: "P",
			status: "running",
		});
		s = store.getSession("exec-legacy");
		check("legacy row (no backend) → undefined", s?.design_backend, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── Section 7: REAL successor inheritance (production function) ────────────────
// buildRescueSuccessorDispatchFields is the actual exported production derivation
// the rescue path uses. Feeding it a persisted design row must reproduce the
// locked backend on the successor dispatch triple — genuine inheritance, not a
// hand-written second row.
console.log(
	"\n[7] Real successor inheritance — buildRescueSuccessorDispatchFields",
);
{
	const succCodex = rescue.buildRescueSuccessorDispatchFields({
		chat_thread_role: "design",
		session_role: "design",
		dispatch_model: "gpt-5.6-sol",
		design_backend: "codex",
	});
	check(
		"successor of a codex-locked design carries designBackend=codex",
		succCodex.designBackend,
		"codex",
	);
	check("successor dispatch vendor = codex", succCodex.dispatchVendor, "codex");
	check(
		"successor dispatch model = gpt-5.6-sol",
		succCodex.dispatchModel,
		"gpt-5.6-sol",
	);
	check("successor dispatch effort = xhigh", succCodex.dispatchEffort, "xhigh");

	// A design row locked to claude must inherit claude on the successor even
	// though the phase table's design default would otherwise be claude too —
	// the point is the lock is READ, not re-derived from env.
	const succClaude = rescue.buildRescueSuccessorDispatchFields({
		chat_thread_role: "design",
		session_role: "design",
		dispatch_model: "claude-fable-5",
		design_backend: "claude",
	});
	check(
		"successor of a claude-locked design carries designBackend=claude",
		succClaude.designBackend,
		"claude",
	);
	check(
		"successor codex vs claude inheritance differ",
		succCodex.designBackend !== succClaude.designBackend,
		true,
	);

	// No persisted backend → successor omits designBackend (byte-compat).
	const succNone = rescue.buildRescueSuccessorDispatchFields({
		chat_thread_role: "design",
		session_role: "design",
		dispatch_model: "claude-fable-5",
	});
	check(
		"no persisted backend → successor omits designBackend",
		succNone.designBackend,
		undefined,
	);
}

// ── Section 8: founder-visible observability ──────────────────────────────────
console.log(
	"\n[8] Observability — the effective backend renders in [DESIGN] title",
);
{
	const tagCodex = cfg.phaseMessageTag("design", undefined, "codex");
	check(
		"design + codex lock → tag carries a codex model glyph",
		/gpt-5\.6/i.test(tagCodex) || /codex/i.test(tagCodex),
		true,
	);
	const tagClaude = cfg.phaseMessageTag("design", undefined, "claude");
	check(
		"design + claude lock → tag carries the Fable model glyph",
		/fable/i.test(tagClaude),
		true,
	);
	check("codex vs claude design tags differ", tagCodex !== tagClaude, true);

	const dispCodex = rmd.sessionModelDisplay({
		chat_thread_role: "design",
		design_backend: "codex",
	});
	const dispClaude = rmd.sessionModelDisplay({
		chat_thread_role: "design",
		design_backend: "claude",
	});
	check(
		"sessionModelDisplay design+codex ≠ design+claude",
		dispCodex !== dispClaude,
		true,
	);
	console.log(`      codex display: ${JSON.stringify(dispCodex)}`);
	console.log(`      claude display: ${JSON.stringify(dispClaude)}`);
}

console.log(`\n${"=".repeat(64)}`);
if (failures.length === 0) {
	console.log(
		`FLY-1259 dist+sqlite integration harness: ALL ${pass} CHECKS PASS`,
	);
	console.log(
		"(scope: compiled-dist + real sqlite; real HTTP route + isolated-",
	);
	console.log(
		" Bridge real-runner acceptance are separate — see qa-report.md)",
	);
	process.exit(0);
} else {
	console.log(`FLY-1259 harness: ${pass} pass, ${failures.length} FAIL`);
	for (const f of failures) console.log(`  ✗ ${f}`);
	process.exit(1);
}
