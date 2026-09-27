/**
 * FLY-2373: the completion boundary over REAL temp CommDB + StateStore files.
 * Nothing here mocks either database: the lock, the synchronous StateStore
 * commit inside it, the savepoint settlement and the replay repair all run
 * against the production classes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { canonicalSubmissionDigest } from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../../workflow-run-snapshot.js";
import {
	type CompletionDrainProof,
	reconcileCompletionDrainSettlement,
	runSemanticCompletionDrain,
} from "../completion-drain.js";

const EXEC = "exec-1";
const SUBMISSION = { decision: { route: "needs_review" } };

function bindGeneralizedExecution(store: StateStore): string {
	const root = mkdtempSync(join(tmpdir(), "fly2373-snapshot-"));
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Execute.\n");
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: "test", revision: 1 },
		canonicalRoot: root,
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "execute",
					type: "generic",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "low",
					agent_file: "agents/generic.md",
				},
				{ id: "founder_gate", type: "gate" },
			],
			edges: [
				{
					id: "done",
					from: "execute",
					to: "founder_gate",
					condition: "node_done",
				},
			],
			loops: [],
			terminal_gate: { node: "founder_gate", predicate: "founder_approved" },
			ship_claims: ["founder_approved"],
		},
	});
	rmSync(root, { recursive: true, force: true });
	store.createWorkflowRun({
		runId: "run-1",
		issueId: "FLY-2373",
		projectName: "flywheel",
		snapshotJson: JSON.stringify(snapshot),
		claimsReadEnrolled: false,
	});
	const admission = store.admitGeneralizedWorkflowExecution({
		runId: "run-1",
		nodeId: "execute",
		executionId: EXEC,
		attempt: 1,
		now: "2026-07-15T00:00:00.000Z",
		expiresAt: "2026-07-15T00:05:00.000Z",
		absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
		env: {
			FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
			FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
			FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
			FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
		},
	});
	if (!admission.ok) throw new Error(`admission failed: ${admission.reason}`);
	store.upsertSession({
		execution_id: EXEC,
		issue_id: "FLY-2373",
		project_name: "flywheel",
		status: "running",
	});
	return admission.activationId;
}

describe("FLY-2373 semantic completion drain over real databases", () => {
	let dir: string;
	let commPath: string;
	let comm: CommDB;
	let store: StateStore;
	let activationId: string;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly2373-drain-"));
		commPath = join(dir, "comm.db");
		comm = new CommDB(commPath);
		comm.registerSession(
			EXEC,
			"flywheel:@1",
			"flywheel",
			"FLY-2373",
			"flywheel-eng-lead",
			"codex",
			true,
		);
		comm.grantTurn("FLY-2373", EXEC, "implement", 100);
		comm.markTurnStarted(EXEC, "turn-long");
		store = await StateStore.create(join(dir, "teamlead.db"));
		activationId = bindGeneralizedExecution(store);
	});

	afterEach(() => {
		comm.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function raw(): Database.Database {
		return (comm as unknown as { db: Database.Database }).db;
	}

	function drain(
		commit: (
			proof: CompletionDrainProof,
		) => ReturnType<StateStore["commitEnrolledCompletion"]> = (proof) =>
			commitWith(proof),
	) {
		return runSemanticCompletionDrain({
			commDbPath: commPath,
			store,
			executionId: EXEC,
			activationId,
			businessDigest: canonicalSubmissionDigest(SUBMISSION),
			commit,
			nowMs: () => 50_000,
		});
	}

	function commitWith(
		proof: CompletionDrainProof,
		sourceEventId = "complete-1",
	) {
		return store.commitEnrolledCompletion({
			nodeReuseEnabled: false,
			executionId: EXEC,
			route: "needs_review",
			sourceEventId,
			completionSubmission: SUBMISSION,
			drainProof: proof,
		});
	}

	function midTurnParkWake(id: string, content: string) {
		return comm.enqueueRunnerPhaseWake(
			EXEC,
			{ id, to: "runner", content },
			1_000,
			{ admissionState: "deferred_midturn", turnGeneration: 1 },
		).wake;
	}

	function ackEnvelope(readId: string) {
		const envelope = store.getDrainReadEnvelope(readId);
		if (!envelope) throw new Error("missing envelope");
		return comm.acknowledgeCompletionDrainRead({
			executionId: EXEC,
			activationId: envelope.activationId,
			readId,
			subjects: envelope.subjects,
			nowMs: 40_000,
		});
	}

	it("returns an unread body without ACKing anything, then commits in the same turn after the read", () => {
		const instruction = comm.insertInstruction(
			"flywheel-eng-lead",
			EXEC,
			"say the passphrase 7f3a",
		);
		const wake = midTurnParkWake("park-1", "[phase-wake park-1] resume");

		const first = drain();
		expect(first.kind).toBe("unread");
		if (first.kind !== "unread") throw new Error("expected unread");
		expect(first.response).toMatchObject({
			reason: "consume_pending_mail",
			protocolVersion: 2,
			mailbox: [instruction],
			phaseWakes: [wake.message_id],
		});
		const page = (first.response.page as { text: string }).text;
		expect(page).toContain("say the passphrase 7f3a");
		expect(page).toContain("[phase-wake park-1] resume");
		// A read-only 409: no ACK, no receipt, no wake or TURN movement.
		expect(
			raw().prepare("SELECT state FROM mailbox WHERE id = ?").get(instruction),
		).toEqual({ state: "QUEUED" });
		expect(comm.listContentConsumption(EXEC)).toEqual([]);
		expect(comm.listRunnerPhaseWakes(EXEC)[0]).toMatchObject({
			state: "pending",
			admission_state: "deferred_midturn",
		});
		expect(
			store.getWorkflowNodeCompletion("run-1", "execute", 1),
		).toBeUndefined();

		const ack = ackEnvelope(first.response.readId as string);
		expect(ack.rejected).toEqual([]);
		const second = drain();
		expect(second).toMatchObject({
			kind: "committed",
			completion: { ok: true, idempotentReplay: false },
			settled: 1,
		});
		expect(comm.getTurn("FLY-2373")?.active_turn_id).toBe("turn-long");
		expect(comm.listRunnerPhaseWakes(EXEC)[0]).toMatchObject({
			state: "finished",
			started_ack_scope: "drain_settled",
		});
		expect(
			store.getDrainReadEnvelope(first.response.readId as string)?.state,
		).toBe("consumed");
		expect(
			store.listCompletionDrainProofs({
				runId: "run-1",
				executionId: EXEC,
				activationId,
			}),
		).toEqual([
			expect.objectContaining({
				messageId: wake.message_id,
				reason: "content_consumed",
			}),
		]);
	});

	it("holds the CommDB write lock while StateStore commits, fencing producers at the boundary", () => {
		const contender = new Database(commPath, { timeout: 0 });
		let lockedDuringCommit = false;
		try {
			const result = drain((proof) => {
				try {
					contender.exec("BEGIN IMMEDIATE");
					contender.exec("ROLLBACK");
				} catch (error) {
					lockedDuringCommit = /SQLITE_BUSY|database is locked/.test(
						String(error),
					);
				}
				return commitWith(proof);
			});
			expect(result.kind).toBe("committed");
		} finally {
			contender.close();
		}
		expect(lockedDuringCommit).toBe(true);

		// Mail after the boundary is a new message: it stays queued and unproven.
		const later = comm.insertInstruction("flywheel-eng-lead", EXEC, "after");
		expect(
			raw().prepare("SELECT state FROM mailbox WHERE id = ?").get(later),
		).toEqual({ state: "QUEUED" });
		expect(comm.listContentConsumption(EXEC)).toEqual([]);
	});

	it("does not settle anything when StateStore refuses the completion", () => {
		const id = comm.insertInstruction("flywheel-eng-lead", EXEC, "x");
		comm.consumeRunnerInbox(EXEC, 10_000, "exec_cli");
		midTurnParkWake("park-1", "resume");
		const read = drain();
		if (read.kind !== "unread") throw new Error("expected unread");
		ackEnvelope(read.response.readId as string);
		const refused = drain(() => ({
			ok: false as const,
			reason: "stale_resubmission" as const,
		}));
		expect(refused).toMatchObject({
			kind: "committed",
			completion: { ok: false },
			settled: 0,
		});
		expect(comm.listRunnerPhaseWakes(EXEC)[0]?.state).toBe("pending");
		expect(comm.listRunnerWakeSettlements(EXEC)).toEqual([]);
		expect(id).toBeTruthy();
	});

	it("propagates a StateStore commit failure and leaves CommDB untouched", () => {
		midTurnParkWake("park-1", "resume");
		const read = drain();
		if (read.kind !== "unread") throw new Error("expected unread");
		ackEnvelope(read.response.readId as string);
		expect(() =>
			drain(() => {
				throw new Error("injected StateStore failure");
			}),
		).toThrow("injected StateStore failure");
		expect(comm.listRunnerPhaseWakes(EXEC)[0]?.state).toBe("pending");
		expect(comm.listRunnerWakeSettlements(EXEC)).toEqual([]);
	});

	it("keeps the completion when settlement fails, and a replay reconciles it exactly once", () => {
		midTurnParkWake("park-1", "resume");
		midTurnParkWake("park-2", "resume again");
		const read = drain();
		if (read.kind !== "unread") throw new Error("expected unread");
		ackEnvelope(read.response.readId as string);
		raw().exec(`
			CREATE TRIGGER reject_settlement_for_test
			BEFORE INSERT ON runner_wake_settlement
			WHEN NEW.wake_message_id = 'park-2'
			BEGIN SELECT RAISE(ABORT, 'injected settlement failure'); END
		`);
		const committed = drain();
		expect(committed).toMatchObject({
			kind: "committed",
			completion: { ok: true },
			settled: 0,
			settlementError: expect.stringContaining("injected settlement failure"),
		});
		// The savepoint rolled the half-written settlement back: park-1 was
		// already finished inside it, and is pending again.
		expect(comm.listRunnerPhaseWakes(EXEC).map((wake) => wake.state)).toEqual([
			"pending",
			"pending",
		]);
		expect(comm.listRunnerWakeSettlements(EXEC)).toEqual([]);
		raw().exec("DROP TRIGGER reject_settlement_for_test");

		const replay = commitWith(
			{
				protocolVersion: 2,
				proofDigest: "0".repeat(64),
				settledWakes: [],
				receiptIds: [],
			},
			"complete-replay",
		);
		expect(replay).toMatchObject({ ok: true, idempotentReplay: true });
		const reconcile = () =>
			reconcileCompletionDrainSettlement({
				commDbPath: commPath,
				store,
				runId: "run-1",
				executionId: EXEC,
				activationId,
				completionEventId: "wfc:replay",
				nowMs: 60_000,
			});
		expect(reconcile()).toBe(2);
		expect(reconcile()).toBe(0);
		expect(comm.listRunnerPhaseWakes(EXEC).map((wake) => wake.state)).toEqual([
			"finished",
			"finished",
		]);
	});

	it("answers a duplicate submission as a replay and never re-settles", () => {
		midTurnParkWake("park-1", "resume");
		const read = drain();
		if (read.kind !== "unread") throw new Error("expected unread");
		ackEnvelope(read.response.readId as string);
		expect(drain()).toMatchObject({ kind: "committed", settled: 1 });
		expect(drain()).toMatchObject({
			kind: "committed",
			completion: { ok: true, idempotentReplay: true },
			settled: 0,
		});
		expect(comm.listRunnerWakeSettlements(EXEC)).toHaveLength(1);

		// A wake that arrives after the boundary is new work, not covered by the
		// earlier proof.
		midTurnParkWake("park-late", "late copy");
		expect(
			comm.resolveCompletionObligations(EXEC, activationId).unread,
		).toEqual([expect.objectContaining({ body: "late copy" })]);
	});

	it("drains a Claude-shaped (non-phase) runner by mailbox only", () => {
		comm.registerSession(
			"exec-claude",
			"flywheel:@2",
			"flywheel",
			"FLY-2373",
			"flywheel-eng-lead",
			"claude-code",
		);
		comm.enqueueRunnerPhaseWake(
			"exec-claude",
			{ id: "legacy", to: "runner", content: "ignored for claude" },
			1_000,
			{ admissionState: "queued" },
		);
		expect(
			comm.resolveCompletionObligations("exec-claude", "activation:x").unread,
		).toEqual([]);
		comm.insertInstruction(
			"flywheel-eng-lead",
			"exec-claude",
			"claude reads me",
		);
		expect(
			comm
				.resolveCompletionObligations("exec-claude", "activation:x")
				.unread.map((obligation) => obligation.body),
		).toEqual(["claude reads me"]);
	});
});
