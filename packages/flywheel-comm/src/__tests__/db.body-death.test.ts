import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BodyDeathProjectionProof } from "../body-death-proof.js";
import { CommDB } from "../db.js";

describe("FLY-2919 committed physical death projection", () => {
	let root: string;
	let db: CommDB;
	let proof: BodyDeathProjectionProof;
	let nowMs: number;
	let verified: boolean;
	const raw = () => (db as unknown as { db: Database }).db;
	const project = () =>
		db.projectProvenBodyDeath(proof, {
			nowMs,
			verifyCommitted: () => verified,
		});
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly2919-comm-death-"));
		db = new CommDB(join(root, "comm.db"));
		nowMs = 1000;
		verified = true;
		db.registerSession("exec-1", "visible:@1", "fixture", "FLY-2919", "lead");
		db.upsertDeclaredState("exec-1", "parked", "awaiting_review", nowMs, null);
		const epoch = db.grantTurn("FLY-2919", "exec-1", "implement", nowMs);
		proof = {
			version: 1,
			obligationId: "body_death:exec-1:1",
			executionId: "exec-1",
			activationId: "activation-1",
			generation: 1,
			ownerToken: "owner-1",
			spawnEpoch: 1,
			bindingDigest: "b".repeat(64),
			lifecycleRevision: 0,
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			projectName: "fixture",
			issueId: "FLY-2919",
			evidenceId: "a".repeat(64),
			expectedIdentityRevision:
				db.getSessionCloseoutIdentity("exec-1").revision,
			observedTurnEpoch: epoch,
			observedAt: new Date(0).toISOString(),
			expiresAt: new Date(10000).toISOString(),
			committedAt: new Date(500).toISOString(),
			terminalLifecycleId: "terminal-1",
			terminalStatus: "failed",
			terminalReason: "process_tree_gone",
		};
	});
	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});
	it.each(["failed", "blocked", "completed", "timeout"] as const)(
		"mirrors %s, clears parked and revokes only the observed TURN while retaining identity",
		(status) => {
			proof.terminalStatus = status;
			expect(project()).toMatchObject({
				projected: true,
				idempotentReplay: false,
				result: { deletedSessionCount: 0, turnRevoked: true },
			});
			expect(db.getSession("exec-1")).toMatchObject({
				status,
				tmux_window: "visible:@1",
				ended_at: expect.any(String),
			});
			expect(db.getEffectiveDeclaredState("exec-1", nowMs)).toBeNull();
			expect(db.getTurn("FLY-2919")).toBeNull();
		},
	);
	it("settles each founder wake durably without claiming its content was consumed", () => {
		for (const id of ["founder-1", "founder-2"])
			db.enqueueRunnerPhaseWake(
				"exec-1",
				{
					id,
					to: "exec-1",
					content: `original ${id}`,
					metadata: { origin: "founder", questionId: id },
				},
				1,
			);
		expect(project()).toMatchObject({
			projected: true,
			result: { founderWakeIds: ["founder-1", "founder-2"] },
		});
		for (const wake of db.listRunnerPhaseWakes("exec-1")) {
			expect(wake).toMatchObject({
				state: "finished",
				started_ack_scope: "terminal",
				content: `original ${wake.message_id}`,
			});
			const alert = db.getReceiptAlertOutbox(wake.escalation_outbox_id!);
			expect(alert?.kind).toBe("wake_failed");
			expect(alert?.payload).toContain("body_gone_before_started");
			expect(alert?.payload).toContain("terminal-1");
		}
	});
	it("retains ordinary and rework wake source rows for their existing retirement protocol", () => {
		db.enqueueRunnerPhaseWake(
			"exec-1",
			{
				id: "rework-1",
				to: "exec-1",
				content: "unchanged rework",
				metadata: {
					purpose: "workflow_rework",
					reworkWake: { wakeId: "w1", activationId: "activation-1", epoch: 1 },
				},
			},
			1,
		);
		expect(project()).toMatchObject({
			projected: true,
			result: { pendingWakeIds: ["rework-1"], deletedSessionCount: 0 },
		});
		expect(db.listRunnerPhaseWakes("exec-1")).toMatchObject([
			{ message_id: "rework-1", state: "pending", content: "unchanged rework" },
		]);
	});
	it("retains review gates and fresh reports while settling the author's abandoned checkpoint", () => {
		const review = db.insertQuestion("exec-1", "lead", "review", {
			checkpoint: "review_code",
		});
		const report = db.insertQuestion("exec-1", "lead", "recent report");
		const gate = db.insertQuestion("exec-1", "lead", "gate", {
			checkpoint: "question",
		});
		expect(project()).toMatchObject({
			projected: true,
			result: { retiredQuestionCount: 1, retiredAskCount: 0 },
		});
		expect(db.isQuestionPending(review)).toBe(true);
		expect(db.isQuestionPending(report)).toBe(true);
		expect(db.isQuestionPending(gate)).toBe(false);
	});
	it("accepts a durably committed duty after the observation expires, including after reopen", () => {
		db.close();
		db = new CommDB(join(root, "comm.db"));
		nowMs = 60000;
		expect(project().projected).toBe(true);
		expect(db.getSession("exec-1")?.status).toBe("failed");
	});
	it("refuses an uncommitted or unreadable StateStore proof with zero effects", () => {
		verified = false;
		expect(project()).toEqual({
			projected: false,
			reason: "body_death_unverified",
		});
		expect(
			db.projectProvenBodyDeath(proof, {
				nowMs,
				verifyCommitted: () => {
					throw new Error("unreadable state");
				},
			}),
		).toEqual({ projected: false, reason: "body_death_unverified" });
		expect(db.getSession("exec-1")?.status).toBe("running");
		expect(db.getTurn("FLY-2919")?.holder_exec_id).toBe("exec-1");
	});
	it("refuses a body decision committed after its evidence expired", () => {
		nowMs = 60000;
		proof.committedAt = new Date(20000).toISOString();
		expect(project()).toEqual({
			projected: false,
			reason: "invalid_body_death_proof",
		});
		expect(db.getSession("exec-1")?.status).toBe("running");
	});
	it("does not reinterpret a land reservation string as a body death obligation", () => {
		proof.obligationId = "land:reservation";
		expect(project()).toEqual({
			projected: false,
			reason: "invalid_body_death_proof",
		});
	});
	it("rejects an identity epoch change before any TURN, gate, wake or session writes", () => {
		db.upsertDeclaredState("exec-1", "parked", "new demand", 2000, null);
		expect(project()).toEqual({
			projected: false,
			reason: "closeout_identity_changed",
		});
		expect(db.getSession("exec-1")?.status).toBe("running");
		expect(db.getTurn("FLY-2919")?.holder_exec_id).toBe("exec-1");
	});
	it("does not revoke a newer grant even when it names the same execution", () => {
		const epoch = db.grantTurn("FLY-2919", "exec-1", "implement", 2000);
		expect(epoch).toBeGreaterThan(proof.observedTurnEpoch!);
		expect(project()).toEqual({ projected: false, reason: "turn_changed" });
		expect(db.getSession("exec-1")?.status).toBe("running");
	});
	it("leaves the successor's TURN intact", () => {
		db.grantTurn("FLY-2919", "exec-2", "implement", 2000);
		expect(project()).toMatchObject({
			projected: true,
			result: { turnRevoked: false },
		});
		expect(db.getTurn("FLY-2919")?.holder_exec_id).toBe("exec-2");
	});
	it("replays the committed receipt without modifying a later session identity", () => {
		const first = project();
		expect(first.projected).toBe(true);
		db.registerSession(
			"exec-1",
			"new-window:@2",
			"fixture",
			"FLY-2919",
			"lead",
		);
		db.updateSessionStatus("exec-1", "running");
		const fresh = db.insertQuestion("exec-1", "lead", "new gate", {
			checkpoint: "question",
		});
		verified = false;
		nowMs = 60000;
		expect(project()).toEqual({ ...first, idempotentReplay: true });
		expect(db.getSession("exec-1")).toMatchObject({
			status: "running",
			tmux_window: "new-window:@2",
		});
		expect(db.isQuestionPending(fresh)).toBe(true);
		proof.evidenceId = "c".repeat(64);
		expect(project()).toEqual({
			projected: false,
			reason: "closeout_receipt_conflict",
		});
	});
	it("rolls back the TURN, wake alert and terminal projection if its receipt cannot commit", () => {
		db.enqueueRunnerPhaseWake(
			"exec-1",
			{
				id: "founder",
				to: "exec-1",
				content: "keep me",
				metadata: { origin: "founder" },
			},
			1,
		);
		raw().exec(
			"CREATE TRIGGER fail_projection BEFORE INSERT ON closeout_finalization_receipt BEGIN SELECT RAISE(ABORT,'injected projection failure'); END",
		);
		expect(() => project()).toThrow("injected projection failure");
		expect(db.getSession("exec-1")?.status).toBe("running");
		expect(db.getTurn("FLY-2919")?.holder_exec_id).toBe("exec-1");
		expect(db.listRunnerPhaseWakes("exec-1")[0]?.state).toBe("pending");
		raw().exec("DROP TRIGGER fail_projection");
		expect(project().projected).toBe(true);
	});
});
