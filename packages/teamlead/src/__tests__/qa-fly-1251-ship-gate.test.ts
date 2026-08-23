/**
 * QA (FLY-1251) — independent verification of the PR-1 ship-readiness gate.
 *
 * The implement phase's tests drive `reviewHoldReason` through a hand-written
 * fake store. These drive the REAL StateStore, because two of the ways this
 * change can fail in production are invisible to a fake:
 *
 *   1. `auto_qa_record.enrollment_source` is a NEW NOT NULL column. Every
 *      existing Bridge DB already has that table, so `CREATE TABLE IF NOT
 *      EXISTS` is a no-op there and only the ALTER migration adds the column.
 *      Every unit test starts from a fresh schema, so nothing exercises the
 *      upgrade an actual deploy performs.
 *   2. The E1 accident replay is only meaningful against the real row shapes
 *      the Bridge writes (real session, real codex record, real snapshot).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	founderApprovalHoldGuard,
	reviewHoldReason,
} from "../bridge/review-hold.js";
import { SHIP_RELEVANT_CLASSIFIER_VERSION } from "../bridge/ship-relevant-diff.js";
import { StateStore } from "../StateStore.js";
import { insertHistoricalAutoQaRecord } from "./helpers/historical-qa.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function dbFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "qa-fly-1251-"));
	dirs.push(dir);
	return join(dir, "teamlead.db");
}

/** The pre-FLY-1251 `auto_qa_record` shape, verbatim from git history —
 * i.e. what every deployed Bridge DB actually contains today. */
function seedLegacyDb(path: string): void {
	const raw = new BetterSqlite3(path);
	raw.exec(`
		CREATE TABLE auto_qa_record (
			parent_execution_id TEXT NOT NULL,
			target_pr_head_sha TEXT NOT NULL,
			issue_id TEXT NOT NULL,
			project_name TEXT NOT NULL,
			qa_execution_id TEXT,
			qa_issue_id TEXT,
			qa_issue_identifier TEXT,
			qa_issue_title TEXT,
			qa_issue_url TEXT,
			status TEXT NOT NULL,
			started_at TEXT NOT NULL,
			completed_at TEXT,
			notified_at TEXT,
			retest_wake_pending_at TEXT,
			PRIMARY KEY (parent_execution_id, target_pr_head_sha)
		);
		INSERT INTO auto_qa_record
			(parent_execution_id, target_pr_head_sha, issue_id, project_name, status, started_at)
		VALUES ('legacy-exec', '${HEAD}', 'FLY-0', 'flywheel', 'passed', '2026-07-01T00:00:00Z');
	`);
	raw.close();
}

/** Build the exact production row shape of the 2026-07-14 flag batch. */
async function accidentShapeStore() {
	const store = await StateStore.create(dbFile());
	store.upsertSession({
		execution_id: "exec-1251",
		issue_id: "issue-1",
		issue_identifier: "FLY-9999",
		project_name: "flywheel",
		status: "awaiting_review",
		session_role: "main",
		pr_number: 588,
	});
	// pr_head_sha is written by setReviewBinding, NOT upsertSession (that is how
	// the real Bridge binds a head to the approve_to_ship gate).
	store.setReviewBinding("exec-1251", {
		questionId: "q-1251",
		prHeadSha: HEAD,
	});
	// Codex code review APPROVED for this head — otherwise the predicate short-
	// circuits on codex_pending and the QA-evidence gate is never reached.
	store.recordCodexReviewApproved({
		executionId: "exec-1251",
		targetPrHeadSha: HEAD,
		issueId: "issue-1",
		projectName: "flywheel",
	});
	return store;
}

function codeBearingSnapshot(store: StateStore, shipRelevant: 0 | 1) {
	store.putShipRelevantDiffSnapshot({
		execution_id: "exec-1251",
		pr_head_sha: HEAD,
		repo: "xrliAnnie/flywheel",
		pr_number: 588,
		base_ref: "main",
		base_oid: BASE,
		classifier_version: SHIP_RELEVANT_CLASSIFIER_VERSION,
		ship_relevant: shipRelevant,
		file_count: 3,
	});
}

describe("QA FLY-1251 · legacy DB upgrade (the path every real deploy takes)", () => {
	it("adds enrollment_source to an existing auto_qa_record table", async () => {
		const path = dbFile();
		seedLegacyDb(path);
		const store = await StateStore.create(path);

		// The migration must run, and must backfill the pre-existing row rather
		// than fail the NOT NULL constraint.
		expect(store.getAutoQaRecord("legacy-exec", HEAD)).toMatchObject({
			status: "passed",
			enrollment_source: "auto",
		});
	});

	it("reads a historical manual record on an upgraded DB", async () => {
		const path = dbFile();
		seedLegacyDb(path);
		const store = await StateStore.create(path);

		(
			store as unknown as { db: { run(sql: string, params: unknown[]): void } }
		).db.run(
			`INSERT INTO auto_qa_record
			 (parent_execution_id, target_pr_head_sha, issue_id, project_name,
			  enrollment_source, status, started_at)
			 VALUES (?, ?, ?, ?, 'manual', 'running', datetime('now'))`,
			["exec-new", HEAD, "FLY-1", "flywheel"],
		);
		expect(store.getAutoQaRecord("exec-new", HEAD)?.enrollment_source).toBe(
			"manual",
		);
	});

	it("survives reopening an already-upgraded DB (migration is idempotent)", async () => {
		const path = dbFile();
		seedLegacyDb(path);
		(await StateStore.create(path)).close?.();
		const reopened = await StateStore.create(path);
		expect(
			reopened.getAutoQaRecord("legacy-exec", HEAD)?.enrollment_source,
		).toBe("auto");
	});
});

describe("QA FLY-1251 · E1 accident replay against the real StateStore", () => {
	it("holds the founder surface for a code PR with zero QA evidence", async () => {
		const store = await accidentShapeStore();
		codeBearingSnapshot(store, 1);
		const session = store.getSession("exec-1251");

		// The FLY-1251 predicate structurally never reads qa_required (it is not on
		// QaHeldSession and is referenced nowhere in reviewHoldReason). So the accident
		// bypass is closed by construction: with no passed QA record and a code diff,
		// a code PR holds regardless of any qa_required=0 exemption the old ship gate
		// would have honored.
		expect(store.getAutoQaRecord("exec-1251", HEAD)).toBeUndefined();
		expect(reviewHoldReason(store, session)).toBe("qa_evidence_missing");
		expect(founderApprovalHoldGuard(store, session)).toBe(true);
	});

	it("holds when the classification has not been computed yet (fail-closed)", async () => {
		const store = await accidentShapeStore();
		const session = store.getSession("exec-1251");
		expect(reviewHoldReason(store, session)).toBe("qa_evidence_missing");
	});

	it("releases ONLY on a server-classified docs-only diff", async () => {
		const store = await accidentShapeStore();
		codeBearingSnapshot(store, 0);
		expect(reviewHoldReason(store, store.getSession("exec-1251"))).toBeNull();
	});

	it("releases a code PR once real QA evidence passes for the same head", async () => {
		const store = await accidentShapeStore();
		codeBearingSnapshot(store, 1);
		insertHistoricalAutoQaRecord(store, {
			parentExecutionId: "exec-1251",
			targetPrHeadSha: HEAD,
			issueId: "issue-1",
			projectName: "flywheel",
			status: "running",
		});
		expect(reviewHoldReason(store, store.getSession("exec-1251"))).toBe(
			"qa_not_green",
		);

		(
			store as unknown as { db: { run(sql: string, params: unknown[]): void } }
		).db.run(
			"UPDATE auto_qa_record SET status = 'passed' WHERE parent_execution_id = ? AND target_pr_head_sha = ?",
			["exec-1251", HEAD],
		);
		expect(reviewHoldReason(store, store.getSession("exec-1251"))).toBeNull();
	});

	it("a docs-only exemption bound to a DIFFERENT head cannot release this head", async () => {
		const store = await accidentShapeStore();
		store.putShipRelevantDiffSnapshot({
			execution_id: "exec-1251",
			pr_head_sha: "c".repeat(40),
			repo: "xrliAnnie/flywheel",
			pr_number: 588,
			base_ref: "main",
			base_oid: BASE,
			classifier_version: SHIP_RELEVANT_CLASSIFIER_VERSION,
			ship_relevant: 0,
			file_count: 1,
		});
		expect(reviewHoldReason(store, store.getSession("exec-1251"))).toBe(
			"qa_evidence_missing",
		);
	});

	it("a docs-only exemption for a DIFFERENT PR number cannot release this session", async () => {
		const store = await accidentShapeStore();
		store.putShipRelevantDiffSnapshot({
			execution_id: "exec-1251",
			pr_head_sha: HEAD,
			repo: "xrliAnnie/flywheel",
			pr_number: 1,
			base_ref: "main",
			base_oid: BASE,
			classifier_version: SHIP_RELEVANT_CLASSIFIER_VERSION,
			ship_relevant: 0,
			file_count: 1,
		});
		expect(reviewHoldReason(store, store.getSession("exec-1251"))).toBe(
			"qa_evidence_missing",
		);
	});

	it("a docs-only exemption from a superseded classifier version cannot release", async () => {
		const store = await accidentShapeStore();
		store.putShipRelevantDiffSnapshot({
			execution_id: "exec-1251",
			pr_head_sha: HEAD,
			repo: "xrliAnnie/flywheel",
			pr_number: 588,
			base_ref: "main",
			base_oid: BASE,
			classifier_version: SHIP_RELEVANT_CLASSIFIER_VERSION + 1,
			ship_relevant: 0,
			file_count: 1,
		});
		expect(reviewHoldReason(store, store.getSession("exec-1251"))).toBe(
			"qa_evidence_missing",
		);
	});
});
