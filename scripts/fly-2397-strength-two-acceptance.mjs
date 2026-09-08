#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const requireFromTeamlead = createRequire(
	join(repoRoot, "packages", "teamlead", "package.json"),
);
const Database = requireFromTeamlead("better-sqlite3");
const { evaluateStrengthTwo } = await import(
	pathToFileURL(
		join(repoRoot, "packages", "teamlead", "dist", "strength-two", "judge.js"),
	).href
);

const BASE_ROW = {
	record_id: "11111111-1111-4111-8111-111111111111",
	recorded_at: "2026-09-07T00:00:00.000Z",
	ran_status: "satisfied",
	ran_reason: "ok",
	record_status: "satisfied",
	record_reason: "ok",
	verdict: "satisfied",
};

/** Versioned, caller-invariant rows: operators cannot replace the acceptance controls. */
export const STRENGTH_TWO_ACCEPTANCE_ROWS_V1 = {
	positive2: [
		{
			...BASE_ROW,
			record_id: "22222222-2222-4222-8222-222222222222",
			record_status: "unsatisfied",
			record_reason: "url_http_error",
			verdict: "unsatisfied",
		},
	],
	symmetric: [
		{
			...BASE_ROW,
			record_id: "33333333-3333-4333-8333-333333333333",
			ran_status: "unsatisfied",
			ran_reason: "site_head_mismatch",
			verdict: "unsatisfied",
		},
	],
	negative: [
		{
			...BASE_ROW,
			record_id: "44444444-4444-4444-8444-444444444444",
		},
	],
};

export const STRENGTH_TWO_ACCEPTANCE_ROWS_SHA256 = createHash("sha256")
	.update(JSON.stringify(STRENGTH_TWO_ACCEPTANCE_ROWS_V1))
	.digest("hex");

function invariant(condition, message) {
	if (!condition) throw new Error(message);
}

export function resolveCutoverForDecision(state) {
	if (state.cutover_at == null) {
		return { status: "unknown", reason: "cutover_not_recorded" };
	}
	if (!Number.isFinite(Date.parse(state.cutover_at))) {
		return { status: "unknown", reason: "cutover_invalid" };
	}
	return { status: "known", cutoverAt: state.cutover_at };
}

export function requireCutoverForDecision(state) {
	const resolution = resolveCutoverForDecision(state);
	if (resolution.status !== "known") {
		throw new Error(`unknown: ${resolution.reason}`);
	}
	return resolution.cutoverAt;
}

function persistFixedControlRows(rows) {
	const db = new Database(":memory:");
	try {
		db.exec(`
			CREATE TABLE strength_two_acceptance_control (
				control_group TEXT NOT NULL,
				record_id TEXT NOT NULL,
				recorded_at TEXT NOT NULL,
				ran_status TEXT NOT NULL,
				ran_reason TEXT NOT NULL,
				record_status TEXT NOT NULL,
				record_reason TEXT NOT NULL,
				verdict TEXT NOT NULL,
				PRIMARY KEY (control_group, record_id)
			)
		`);
		const insert = db.prepare(`
			INSERT INTO strength_two_acceptance_control
				(control_group, record_id, recorded_at, ran_status, ran_reason,
				 record_status, record_reason, verdict)
			VALUES
				(@control_group, @record_id, @recorded_at, @ran_status, @ran_reason,
				 @record_status, @record_reason, @verdict)
		`);
		const insertAll = db.transaction(() => {
			for (const [controlGroup, controlRows] of Object.entries(rows)) {
				for (const row of controlRows) {
					insert.run({ control_group: controlGroup, ...row });
				}
			}
		});
		insertAll();
		const select = db.prepare(`
			SELECT record_id, recorded_at, ran_status, ran_reason,
			       record_status, record_reason, verdict
			  FROM strength_two_acceptance_control
			 WHERE control_group = ?
			 ORDER BY recorded_at, record_id
		`);
		return Object.fromEntries(
			Object.keys(rows).map((controlGroup) => [
				controlGroup,
				select.all(controlGroup),
			]),
		);
	} finally {
		db.close();
	}
}

export function evaluateFixedStrengthTwoControls(
	rows = STRENGTH_TWO_ACCEPTANCE_ROWS_V1,
	evaluator = evaluateStrengthTwo,
) {
	const persistedRows = persistFixedControlRows(rows);
	const positive2 = evaluator(persistedRows.positive2);
	invariant(
		positive2.verdict === "unsatisfied" &&
			positive2.ran.satisfied === true &&
			positive2.record.satisfied === false &&
			positive2.record.reason === "url_http_error",
		"positive control 2 failed: an unreachable external record must leave ran satisfied and record unsatisfied",
	);
	const symmetric = evaluator(persistedRows.symmetric);
	invariant(
		symmetric.verdict === "unsatisfied" &&
			symmetric.ran.satisfied === false &&
			symmetric.record.satisfied === true &&
			symmetric.ran.reason === "site_head_mismatch",
		"symmetric control failed: a site mismatch must not erase a valid external record half",
	);
	const negative = evaluator(persistedRows.negative);
	invariant(
		negative.verdict === "satisfied" &&
			negative.ran.satisfied === true &&
			negative.record.satisfied === true,
		"negative control failed: both independently satisfied halves must satisfy strength two",
	);
	return { positive2, symmetric, negative };
}

function tableExists(db, name) {
	return Boolean(
		db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(name),
	);
}

function ledgerRows(db, runId, headSha) {
	if (!tableExists(db, "strength_two_evidence_record")) return [];
	return db
		.prepare(
			`SELECT record_id, recorded_at, ran_status, ran_reason,
			        record_status, record_reason, verdict
			   FROM strength_two_evidence_record
			  WHERE run_id = ? AND target_repo_identity = '__main__' AND head_sha = ?
			  ORDER BY recorded_at, record_id`,
		)
		.all(runId, headSha);
}

function readPreCutoverCohort(db, boundaryAt) {
	const shaGlob = "[0-9a-f]".repeat(40);
	const sharedWhere = `predicate = 'qa_passed'
		AND issued_at < :cutover
		AND json_extract(evidence, '$.summary') LIKE '%vercel.app%'`;
	const universe = db
		.prepare(
			`SELECT workflow_run_id, subject_kind, subject_digest
			   FROM workflow_claims
			  WHERE ${sharedWhere}
			  ORDER BY workflow_run_id, subject_digest`,
		)
		.all({ cutover: boundaryAt });
	const eligible = db
		.prepare(
			`SELECT workflow_run_id, subject_digest
			   FROM workflow_claims
			  WHERE ${sharedWhere}
			    AND subject_kind = 'git_head'
			    AND subject_digest GLOB :shaGlob
			  ORDER BY workflow_run_id, subject_digest`,
		)
		.all({ cutover: boundaryAt, shaGlob });
	return { universe, eligible, excluded: universe.length - eligible.length };
}

export function runStrengthTwoAcceptance({
	dbPath,
	shadowBoundaryAt,
	cutoverAt,
	evaluator = evaluateStrengthTwo,
	log = console.log,
}) {
	if (!dbPath) throw new Error("--db is required");
	if (Boolean(shadowBoundaryAt) === Boolean(cutoverAt)) {
		throw new Error(
			"exactly one of --shadow-boundary-at or --cutover-at is required",
		);
	}
	const boundaryAt = shadowBoundaryAt ?? cutoverAt;
	if (!boundaryAt || !Number.isFinite(Date.parse(boundaryAt))) {
		throw new Error("the selected boundary must be a valid ISO timestamp");
	}
	const cutoverState = {
		cutover_at: cutoverAt ?? null,
		shadow_boundary_at: shadowBoundaryAt ?? null,
	};
	const cutoverResolution = resolveCutoverForDecision(cutoverState);
	if (cutoverAt) requireCutoverForDecision(cutoverState);
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	db.pragma("query_only = ON");
	try {
		if (!tableExists(db, "workflow_claims")) {
			throw new Error("workflow_claims table is missing");
		}
		const cohort = readPreCutoverCohort(db, boundaryAt);
		invariant(
			cohort.eligible.length > 0,
			"eligible pre-cutover cohort is empty",
		);
		let noRowCount = 0;
		for (const candidate of cohort.eligible) {
			const rows = ledgerRows(
				db,
				candidate.workflow_run_id,
				candidate.subject_digest,
			);
			const verdict = evaluator(rows);
			invariant(
				verdict.verdict === "unsatisfied" &&
					verdict.basisRecordId === null &&
					verdict.ran.reason === "no_ledger_row" &&
					verdict.record.reason === "no_ledger_row",
				`positive control 1 failed for ${candidate.workflow_run_id}/${candidate.subject_digest}`,
			);
			noRowCount += 1;
			log(
				`cohort_candidate run=${candidate.workflow_run_id} repo=__main__ head=${candidate.subject_digest} verdict=unsatisfied ran=no_ledger_row record=no_ledger_row`,
			);
		}
		evaluateFixedStrengthTwoControls(
			STRENGTH_TWO_ACCEPTANCE_ROWS_V1,
			evaluator,
		);
		const summary =
			`cutover_at=${cutoverState.cutover_at ?? "null"} ` +
			`cutover_status=${cutoverResolution.status} ` +
			`${cutoverResolution.status === "unknown" ? `cutover_reason=${cutoverResolution.reason} ` : ""}` +
			`shadow_boundary_at=${cutoverState.shadow_boundary_at ?? "null"} ` +
			`cohort_total=${cohort.eligible.length} ` +
			`cohort_excluded=${cohort.excluded} positive_1=${noRowCount}/${cohort.eligible.length} ` +
			`positive_2=pass symmetric=pass negative=pass ` +
			`rows_sha256=${STRENGTH_TWO_ACCEPTANCE_ROWS_SHA256}`;
		log(summary);
		return {
			...cohort,
			positive1: noRowCount,
			rowsSha256: STRENGTH_TWO_ACCEPTANCE_ROWS_SHA256,
			summary,
		};
	} finally {
		db.close();
	}
}

function parseCliArgs(argv) {
	let dbPath;
	let shadowBoundaryAt;
	let cutoverAt;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--db") dbPath = argv[++index];
		else if (arg === "--shadow-boundary-at") {
			shadowBoundaryAt = argv[++index];
		} else if (arg === "--cutover-at") cutoverAt = argv[++index];
		else throw new Error(`unknown argument: ${arg}`);
	}
	return { dbPath, shadowBoundaryAt, cutoverAt };
}

const invokedPath = process.argv[1]
	? pathToFileURL(resolve(process.argv[1])).href
	: "";
if (invokedPath === import.meta.url) {
	try {
		runStrengthTwoAcceptance(parseCliArgs(process.argv.slice(2)));
	} catch (error) {
		console.error(
			`fly-2397 strength-two acceptance failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	}
}
