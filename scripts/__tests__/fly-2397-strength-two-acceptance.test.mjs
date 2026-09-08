import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const script = join(root, "scripts", "fly-2397-strength-two-acceptance.mjs");
const acceptanceState = join(
	root,
	"engineering",
	"doc",
	"FLY-2397-strength-two-evidence-ledger",
	"acceptance-state.json",
);
const requireFromTeamlead = createRequire(
	join(root, "packages", "teamlead", "package.json"),
);
const Database = requireFromTeamlead("better-sqlite3");
const SHADOW_BOUNDARY_AT = "2026-09-07T00:00:00.000Z";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);

function fixture({ eligible = true } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "fly2397-acceptance-"));
	const dbPath = join(dir, "teamlead.db");
	const db = new Database(dbPath);
	db.exec(`
		CREATE TABLE workflow_claims (
			workflow_run_id TEXT NOT NULL,
			predicate TEXT NOT NULL,
			subject_kind TEXT NOT NULL,
			subject_digest TEXT NOT NULL,
			issued_at TEXT NOT NULL,
			evidence TEXT NOT NULL
		);
		CREATE TABLE strength_two_evidence_record (
			run_id TEXT NOT NULL,
			target_repo_identity TEXT NOT NULL,
			head_sha TEXT NOT NULL,
			record_id TEXT NOT NULL,
			recorded_at TEXT NOT NULL,
			ran_status TEXT NOT NULL,
			ran_reason TEXT NOT NULL,
			record_status TEXT NOT NULL,
			record_reason TEXT NOT NULL,
			verdict TEXT NOT NULL
		);
	`);
	if (eligible) {
		const insert = db.prepare(
			"INSERT INTO workflow_claims VALUES (?, 'qa_passed', ?, ?, ?, ?)",
		);
		insert.run(
			"run-a",
			"git_head",
			HEAD_A,
			"2026-09-06T10:00:00.000Z",
			'{"summary":"proof https://fw-reports-a.vercel.app/r/a/"}',
		);
		insert.run(
			"run-b",
			"git_head",
			HEAD_B,
			"2026-09-06T11:00:00.000Z",
			'{"summary":"proof https://fw-reports-b.vercel.app/r/b/"}',
		);
		insert.run(
			"run-c",
			"git_head",
			HEAD_C,
			"2026-09-06T11:30:00.000Z",
			'{"summary":"proof https://fw-reports-c.vercel.app/r/c/"}',
		);
		insert.run(
			"run-snapshot",
			"snapshot_digest",
			"d".repeat(64),
			"2026-09-06T12:00:00.000Z",
			'{"summary":"proof https://fw-reports-d.vercel.app/r/d/"}',
		);
	} else {
		db.prepare(
			"INSERT INTO workflow_claims VALUES (?, 'qa_passed', ?, ?, ?, ?)",
		).run(
			"run-only-snapshot",
			"snapshot_digest",
			"d".repeat(64),
			"2026-09-06T12:00:00.000Z",
			'{"summary":"proof https://fw-reports-d.vercel.app/r/d/"}',
		);
	}
	db.close();
	return { dir, dbPath };
}

function ensureTeamleadBuild() {
	if (ensureTeamleadBuild.done) return;
	execFileSync("pnpm", ["--filter", "flywheel-teamlead", "build"], {
		cwd: root,
		stdio: "pipe",
	});
	ensureTeamleadBuild.done = true;
}

ensureTeamleadBuild.done = false;

test("fixed pre-cutover cohort proves no-row fail-closed and prints exclusions", () => {
	ensureTeamleadBuild();
	const { dir, dbPath } = fixture();
	try {
		const result = spawnSync(
			process.execPath,
			[script, "--db", dbPath, "--shadow-boundary-at", SHADOW_BOUNDARY_AT],
			{ cwd: root, encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /cutover_at=null/);
		assert.match(result.stdout, /cutover_status=unknown/);
		assert.match(result.stdout, /cutover_reason=cutover_not_recorded/);
		assert.match(result.stdout, /shadow_boundary_at=2026-09-07T00:00:00.000Z/);
		assert.match(result.stdout, /cohort_total=3/);
		assert.match(result.stdout, /cohort_excluded=1/);
		assert.match(result.stdout, /positive_1=3\/3/);
		assert.match(result.stdout, /positive_2=pass/);
		assert.match(result.stdout, /symmetric=pass/);
		assert.match(result.stdout, /negative=pass/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("empty eligible cohort fails closed", () => {
	ensureTeamleadBuild();
	const { dir, dbPath } = fixture({ eligible: false });
	try {
		const result = spawnSync(
			process.execPath,
			[script, "--db", dbPath, "--shadow-boundary-at", SHADOW_BOUNDARY_AT],
			{ cwd: root, encoding: "utf8" },
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /eligible pre-cutover cohort is empty/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the positive-2 assertion fails if its external record half is changed to ok", async () => {
	ensureTeamleadBuild();
	const module = await import(`${pathToFileURL(script).href}?t=${Date.now()}`);
	const mutated = structuredClone(module.STRENGTH_TWO_ACCEPTANCE_ROWS_V1);
	mutated.positive2[0].record_status = "satisfied";
	mutated.positive2[0].record_reason = "ok";
	mutated.positive2[0].verdict = "satisfied";
	assert.throws(
		() => module.evaluateFixedStrengthTwoControls(mutated),
		/positive control 2 failed/,
	);
});

test("fixed controls are read back from an in-memory ledger before evaluation", async () => {
	ensureTeamleadBuild();
	const module = await import(`${pathToFileURL(script).href}?db=${Date.now()}`);
	const judge = await import(
		pathToFileURL(
			join(root, "packages", "teamlead", "dist", "strength-two", "judge.js"),
		).href
	);
	const rows = structuredClone(module.STRENGTH_TWO_ACCEPTANCE_ROWS_V1);
	rows.positive2[0].callerOnly = "must not bypass the ledger";
	module.evaluateFixedStrengthTwoControls(rows, (persistedRows) => {
		assert.equal(Object.hasOwn(persistedRows[0], "callerOnly"), false);
		return judge.evaluateStrengthTwo(persistedRows);
	});
});

test("a shadow boundary can never satisfy a cutover-dependent consumer", async () => {
	ensureTeamleadBuild();
	const module = await import(
		`${pathToFileURL(script).href}?cutover=${Date.now()}`
	);
	const state = {
		cutover_at: null,
		shadow_boundary_at: SHADOW_BOUNDARY_AT,
	};
	assert.deepEqual(module.resolveCutoverForDecision(state), {
		status: "unknown",
		reason: "cutover_not_recorded",
	});
	assert.throws(
		() => module.requireCutoverForDecision(state),
		/unknown: cutover_not_recorded/,
	);
});

test("durable acceptance state keeps the real cutover unset and shadow provenance separate", async () => {
	ensureTeamleadBuild();
	const module = await import(
		`${pathToFileURL(script).href}?state=${Date.now()}`
	);
	const state = JSON.parse(readFileSync(acceptanceState, "utf8"));
	assert.equal(state.cutover_at, null);
	assert.equal(state.shadow_boundary_at, "2026-09-07T04:11:15.000Z");
	assert.equal(state.shadow_provenance.source, "live_db_consistent_copy");
	assert.equal(state.shadow_provenance.cohort_result, "305/305_no_ledger_row");
	assert.deepEqual(module.resolveCutoverForDecision(state), {
		status: "unknown",
		reason: "cutover_not_recorded",
	});
});
