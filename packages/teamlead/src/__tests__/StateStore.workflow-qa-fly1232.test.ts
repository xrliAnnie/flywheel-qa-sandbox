import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createWorkflowShadowWriterFromEnv } from "../bridge/workflow-shadow-writer.js";
import { StateStore } from "../StateStore.js";
import {
	isWorkflowClaimsReadEnabled,
	isWorkflowClaimsWriteEnabled,
	isWorkflowLegacyForced,
} from "../workflow-claims.js";

/**
 * FLY-1232 QA acceptance probe — INDEPENDENT verification (three-stage QA
 * phase). These are NOT a copy of the implementer's unit assertions; they
 * exercise the substrate at a higher-assurance / integration angle to give the
 * QA verdict its own evidence:
 *
 *   A3+  the one-shot capability plaintext must be absent from the ENTIRE
 *        persisted DB file (not merely the token_hash column) — a leak into an
 *        evidence blob or event payload would still be a secret on disk.
 *   A2   append-only enforcement survives a raw reopen of the on-disk file.
 *   A6   gate resolution never regresses to a superseded PASS after a newer
 *        attempt FAILs.
 *   B6   applyWorkflowShadowBatch is atomic on a REAL file store: a batch whose
 *        later op is invalid persists NOTHING, and a subsequent valid batch
 *        replays cleanly (no torn run / node / event residue).
 *   A10/B1 the three rollout switches default OFF and the writer factory is
 *        undefined unless FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1 (byte-compat seam).
 */

const GIT_HEAD = "a".repeat(40);
const T0 = "2026-07-13T00:00:00.000Z";
const T_EXPIRE = "2026-07-13T01:00:00.000Z";
const T_DEADLINE = "2026-07-13T02:00:00.000Z";

function freshFileStore(label: string): {
	store: Promise<StateStore>;
	dbPath: string;
} {
	const dir = mkdtempSync(join(tmpdir(), `qa-fly1232-${label}-`));
	const dbPath = join(dir, "state.db");
	return { store: StateStore.create(dbPath), dbPath };
}

function seedRun(
	store: StateStore,
	runId = "run-qa",
	issueId = "FLY-1232",
): string {
	store.createWorkflowRun({
		runId,
		issueId,
		projectName: "flywheel",
		claimsReadEnrolled: false,
	});
	return runId;
}

describe("FLY-1232 QA · A3+ — the one-shot token never lands anywhere on disk", () => {
	it("no plaintext capability token appears in the persisted DB file; only its sha256 does", async () => {
		const { store: storeP, dbPath } = freshFileStore("token-leak");
		const store = await storeP;
		const runId = seedRun(store);

		const issued = store.issueWorkflowDecisionCapability({
			runId,
			nodeId: "qa",
			executionId: "qa-exec-1",
			attempt: 1,
			allowedPredicateFamily: "qa_verdict",
			expiresAt: T_EXPIRE,
			absoluteDeadlineAt: T_DEADLINE,
		});
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;
		const token = issued.token;
		const tokenHash = createHash("sha256").update(token).digest("hex");

		// Consume it into a real claim + run event (evidence, payloads all land).
		const submitted = store.submitWorkflowDecisionClaim({
			token,
			clientRequestId: "req-qa-1",
			predicate: "qa_passed",
			subjectKind: "git_head",
			subjectDigest: GIT_HEAD,
			issuerVendor: "claude",
			issuerModel: "opus",
			subjectProducerExecutionId: "impl-exec",
			subjectProducerVendor: "codex",
			claimExpiresAt: T_EXPIRE,
			evidence: { report: "qa-report.md", verdict: "pass" },
			now: T0,
		});
		expect(submitted.ok).toBe(true);
		store.close();

		// Scan the raw file bytes (+ any WAL sidecar) — the plaintext token, a
		// 32-byte random hex, must not appear; the sha256 hash must.
		const chunks: Buffer[] = [readFileSync(dbPath)];
		for (const suffix of ["-wal", "-shm"]) {
			if (existsSync(dbPath + suffix))
				chunks.push(readFileSync(dbPath + suffix));
		}
		const bytes = Buffer.concat(chunks).toString("latin1");
		expect(bytes.includes(token)).toBe(false);
		expect(bytes.includes(tokenHash)).toBe(true);
	});
});

describe("FLY-1232 QA · A2 — append-only survives a raw reopen", () => {
	it("UPDATE/DELETE on all three ledger tables abort at the DB layer", async () => {
		const { store: storeP, dbPath } = freshFileStore("append-only");
		const store = await storeP;
		const runId = seedRun(store);
		const issued = store.issueWorkflowDecisionCapability({
			runId,
			nodeId: "qa",
			executionId: "qa-exec-1",
			attempt: 1,
			allowedPredicateFamily: "qa_verdict",
			expiresAt: T_EXPIRE,
			absoluteDeadlineAt: T_DEADLINE,
		});
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;
		const submitted = store.submitWorkflowDecisionClaim({
			token: issued.token,
			clientRequestId: "req-qa-1",
			predicate: "qa_passed",
			subjectKind: "git_head",
			subjectDigest: GIT_HEAD,
			issuerVendor: "claude",
			issuerModel: "opus",
			subjectProducerExecutionId: "impl-exec",
			subjectProducerVendor: "codex",
			claimExpiresAt: T_EXPIRE,
			now: T0,
		});
		expect(submitted.ok).toBe(true);
		if (!submitted.ok) return;
		// Seed a revocation row so its DELETE trigger has a row to fire on.
		store.revokeWorkflowClaim({
			claimId: submitted.claimId,
			reason: "qa",
			actor: "qa",
		});
		store.close();

		const raw = new Database(dbPath);
		try {
			for (const stmt of [
				"UPDATE workflow_claims SET predicate = 'qa_failed'",
				"DELETE FROM workflow_claims",
				"UPDATE workflow_run_event SET kind = 'tampered'",
				"DELETE FROM workflow_run_event",
				"UPDATE workflow_claim_revocation SET reason = 'x'",
				"DELETE FROM workflow_claim_revocation",
			]) {
				expect(() => raw.prepare(stmt).run(), stmt).toThrow(/append-only/);
			}
		} finally {
			raw.close();
		}
	});
});

describe("FLY-1232 QA · A6 — resolution never regresses to a superseded PASS", () => {
	it("a newer attempt FAIL makes the gate invalid even though attempt 1 PASSED", async () => {
		const store = await StateStore.create(":memory:");
		const runId = seedRun(store);

		// Attempt 1 → PASS (bound to the current git head).
		const c1 = store.issueWorkflowDecisionCapability({
			runId,
			nodeId: "qa",
			executionId: "qa-exec-1",
			attempt: 1,
			allowedPredicateFamily: "qa_verdict",
			expiresAt: T_EXPIRE,
			absoluteDeadlineAt: T_DEADLINE,
		});
		expect(c1.ok).toBe(true);
		if (!c1.ok) return;
		store.submitWorkflowDecisionClaim({
			token: c1.token,
			clientRequestId: "req-pass",
			predicate: "qa_passed",
			subjectKind: "git_head",
			subjectDigest: GIT_HEAD,
			issuerVendor: "claude",
			issuerModel: "opus",
			subjectProducerExecutionId: "impl-exec",
			subjectProducerVendor: "codex",
			claimExpiresAt: T_EXPIRE,
			now: T0,
		});
		// After attempt 1, the gate is open.
		expect(
			store.resolveWorkflowDecisionClaim({
				runId,
				nodeId: "qa",
				decisionKind: "qa_verdict",
				subjectKind: "git_head",
				subjectDigest: GIT_HEAD,
				now: T0,
			}).valid,
		).toBe(true);

		// Attempt 2 → FAIL on the SAME subject (a re-review of the same head).
		const c2 = store.issueWorkflowDecisionCapability({
			runId,
			nodeId: "qa",
			executionId: "qa-exec-2",
			attempt: 2,
			allowedPredicateFamily: "qa_verdict",
			expiresAt: T_EXPIRE,
			absoluteDeadlineAt: T_DEADLINE,
		});
		expect(c2.ok).toBe(true);
		if (!c2.ok) return;
		store.submitWorkflowDecisionClaim({
			token: c2.token,
			clientRequestId: "req-fail",
			predicate: "qa_failed",
			subjectKind: "git_head",
			subjectDigest: GIT_HEAD,
			issuerVendor: "claude",
			issuerModel: "opus",
			subjectProducerExecutionId: "impl-exec",
			subjectProducerVendor: "codex",
			claimExpiresAt: T_EXPIRE,
			now: T0,
		});

		// The gate must now be CLOSED — the highest attempt is a FAIL; the old
		// attempt-1 PASS must NOT be resurrected.
		const resolved = store.resolveWorkflowDecisionClaim({
			runId,
			nodeId: "qa",
			decisionKind: "qa_verdict",
			subjectKind: "git_head",
			subjectDigest: GIT_HEAD,
			now: T0,
		});
		expect(resolved.valid).toBe(false);
		if (!resolved.valid) expect(resolved.reason).toBe("not_pass");
		store.close();
	});
});

describe("FLY-1232 QA · B6 — applyWorkflowShadowBatch is atomic on a real file store", () => {
	it("a MID-TRANSACTION failure (a valid op that throws inside the tx) rolls back an already-written earlier op — no torn writes", async () => {
		const { store: storeP, dbPath } = freshFileStore("atomic");
		const store = await storeP;

		// Seed an active run with one committed dispatch (baseline the failing
		// batch must not corrupt).
		store.applyWorkflowShadowBatch({
			projectName: "flywheel",
			issueId: "FLY-1232",
			newRunId: "run-atomic",
			ops: [{ op: "dispatch", node: "design", attempt: 1, executionId: "e1" }],
		});
		const baseEvents = store.listWorkflowRunEvents("run-atomic").length; // 1
		const baseSideEffects = store.listWorkflowSideEffects("run-atomic").length; // 1
		expect([baseEvents, baseSideEffects]).toEqual([1, 1]);

		// This batch PASSES validation (labels/attempts all well-formed) so it
		// enters the transaction: op #1 (dispatch implement) writes an event +
		// node projection + intent row; op #2 (a side_effect for an execution
		// that has NO dispatch row) throws "row not found" DEEP INSIDE the
		// transaction — after op #1 already wrote. A correct composite tx must
		// roll op #1 back.
		expect(() =>
			store.applyWorkflowShadowBatch({
				projectName: "flywheel",
				issueId: "FLY-1232",
				ops: [
					{ op: "dispatch", node: "implement", attempt: 1, executionId: "e2" },
					{
						op: "side_effect",
						node: "nonexistent",
						attempt: 9,
						executionId: "ghost",
						to: "launch_committed",
					},
				],
			}),
		).toThrow(/not found/i);

		// The failing batch left ZERO residue: the baseline is intact and the
		// mid-tx op #1 (implement) writes were fully rolled back.
		expect(store.listWorkflowRunEvents("run-atomic")).toHaveLength(baseEvents);
		expect(store.listWorkflowSideEffects("run-atomic")).toHaveLength(
			baseSideEffects,
		);
		expect(
			store.getWorkflowRunNode("run-atomic", "implement", 1),
		).toBeUndefined();
		store.close();

		// Reopen the on-disk file — the rollback is durable, not just in-memory.
		const raw = new Database(dbPath);
		try {
			const events = raw
				.prepare("SELECT COUNT(*) AS n FROM workflow_run_event")
				.get() as { n: number };
			const sideEffects = raw
				.prepare("SELECT COUNT(*) AS n FROM workflow_side_effect_ledger")
				.get() as { n: number };
			expect(events.n).toBe(baseEvents);
			expect(sideEffects.n).toBe(baseSideEffects);
		} finally {
			raw.close();
		}

		// B6 second clause, real-file end to end (Codex R6 MEDIUM): reopen the
		// SAME file through StateStore and replay a clean batch — the store that
		// just survived a mid-transaction rollback must accept the retried op.
		const reopened = await StateStore.create(dbPath);
		try {
			const retry = {
				projectName: "flywheel",
				issueId: "FLY-1232",
				ops: [
					{
						op: "dispatch" as const,
						node: "implement",
						attempt: 1,
						executionId: "e2",
					},
				],
			};
			const replayed = reopened.applyWorkflowShadowBatch(retry);
			expect(replayed.runId).toBe("run-atomic");
			expect(replayed.created).toBe(false); // run survived the rollback
			expect(replayed.events).toHaveLength(1);
			expect(replayed.events[0]?.deduped).toBe(false);
			// Identity: the retried dispatch lands under the SAME run with a
			// writer-allocated ordinal, and the uid matches the run:… formula.
			const ordinal = replayed.dispatchOrdinals[0];
			expect(ordinal).toBeGreaterThanOrEqual(1);
			expect(replayed.events[0]?.eventUid).toBe(
				`run:run-atomic:dispatch:implement:1:${ordinal}`,
			);
			expect(
				reopened.getWorkflowRunNode("run-atomic", "implement", 1),
			).toBeDefined();
			expect(reopened.listWorkflowRunEvents("run-atomic")).toHaveLength(
				baseEvents + 1,
			);
			expect(reopened.listWorkflowSideEffects("run-atomic")).toHaveLength(
				baseSideEffects + 1,
			);
			// And the replay of that same batch dedupes instead of double-writing.
			const dedup = reopened.applyWorkflowShadowBatch(retry);
			expect(dedup.events.every((e) => e.deduped)).toBe(true);
			expect(reopened.listWorkflowSideEffects("run-atomic")).toHaveLength(
				baseSideEffects + 1,
			);
		} finally {
			reopened.close();
		}
	});

	it("a fail-closed op with no active run persists nothing, and a clean batch replays idempotently", async () => {
		// Pre-validation / fail-closed guard: no active run + no newRunId → throw,
		// nothing created (distinct from the mid-tx rollback above).
		const store = await StateStore.create(":memory:");
		expect(() =>
			store.applyWorkflowShadowBatch({
				projectName: "flywheel",
				issueId: "FLY-1232",
				ops: [{ op: "dispatch", node: "design", attempt: 1, executionId: "x" }],
			}),
		).toThrow(/no active shadow run/i);
		expect(store.getActiveWorkflowRun("flywheel", "FLY-1232")).toBeUndefined();

		const good = {
			projectName: "flywheel",
			issueId: "FLY-1232",
			newRunId: "run-good",
			ops: [
				{
					op: "dispatch" as const,
					node: "design",
					attempt: 1,
					executionId: "e1",
				},
			],
		};
		const first = store.applyWorkflowShadowBatch(good);
		expect(first.created).toBe(true);
		expect(first.dispatchOrdinals).toEqual([1]);
		// Replay: same run, same event uid → deduped, no second ledger row.
		const replay = store.applyWorkflowShadowBatch({
			...good,
			newRunId: undefined,
		});
		expect(replay.created).toBe(false);
		expect(replay.events.every((e) => e.deduped)).toBe(true);
		expect(store.listWorkflowSideEffects("run-good")).toHaveLength(1);
		store.close();
	});
});

describe("FLY-1232 QA · A10/B1 — rollout switches default OFF (byte-compat seam)", () => {
	it("the three flags are independent and OFF unless explicitly '1'", async () => {
		expect(isWorkflowClaimsWriteEnabled({})).toBe(false);
		expect(isWorkflowClaimsReadEnabled({})).toBe(false);
		expect(isWorkflowLegacyForced({})).toBe(false);
		// Only the literal "1" enables — "true"/"0"/"yes" do not.
		expect(
			isWorkflowClaimsWriteEnabled({ FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "true" }),
		).toBe(false);
		expect(
			isWorkflowClaimsWriteEnabled({ FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1" }),
		).toBe(true);
	});

	it("the shadow-writer factory is undefined unless the WRITE flag is '1'", async () => {
		const store = await StateStore.create(":memory:");
		expect(createWorkflowShadowWriterFromEnv({}, store)).toBeUndefined();
		expect(
			createWorkflowShadowWriterFromEnv(
				{ FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1" },
				store,
			),
		).toBeDefined();
		store.close();
	});
});
