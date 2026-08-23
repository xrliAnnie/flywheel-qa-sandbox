import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { canonicalSubmissionDigest } from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

describe("CommDB workflow source events", () => {
	let dir: string;
	let path: string;
	let db: CommDB;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1244-source-"));
		path = join(dir, "comm.db");
		db = new CommDB(path);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("commits a stable TURN source event and history row with the epoch update", () => {
		db.grantTurn("FLY-1244", "exec-design", "design", 1_700_000_000_000, {
			project: "flywheel",
			sourceEventId: "turn:spawn:exec-design",
		});

		expect(db.getTurn("FLY-1244")?.epoch).toBe(1);
		expect(db.listWorkflowSourceEvents()).toEqual([
			expect.objectContaining({
				project: "flywheel",
				source_event_id: "turn:spawn:exec-design",
				kind: "turn_grant",
				schema_version: 1,
			}),
		]);
		expect(db.listTurnSourceHistory("FLY-1244")).toEqual([
			expect.objectContaining({
				from_role: null,
				to_role: "design",
				epoch: 1,
				target_run_id: null,
				source_event_id: "turn:spawn:exec-design",
			}),
		]);
	});

	it("freezes an engine-owned target run into the source event and TURN history", () => {
		db.grantTurn("FLY-1307", "engine-design", "design", 1_700_000_000_000, {
			project: "flywheel",
			sourceEventId: "turn:engine:design",
			targetRunId: "run-engine-1",
		});

		const source = db.listWorkflowSourceEvents()[0]!;
		expect(JSON.parse(source.payload)).toMatchObject({
			issue_id: "FLY-1307",
			new_holder: "engine-design",
			target_run_id: "run-engine-1",
		});
		expect(db.listTurnSourceHistory("FLY-1307")[0]?.target_run_id).toBe(
			"run-engine-1",
		);
	});

	it("exact TURN source replay is a no-op while a mismatched replay is poison", () => {
		const opts = {
			project: "flywheel",
			sourceEventId: "turn:spawn:exec-design",
		};
		expect(db.grantTurn("FLY-1244", "exec-design", "design", 100, opts)).toBe(
			1,
		);
		expect(db.grantTurn("FLY-1244", "exec-design", "design", 100, opts)).toBe(
			1,
		);
		expect(db.getTurn("FLY-1244")?.epoch).toBe(1);
		expect(db.listTurnSourceHistory("FLY-1244")).toHaveLength(1);

		expect(() =>
			db.grantTurn("FLY-1244", "exec-implement", "implement", 101, opts),
		).toThrow(/digest|mismatch|poison/i);
		expect(db.getTurn("FLY-1244")?.holder_exec_id).toBe("exec-design");
	});

	it("freezes activation context on source replay without incrementing epoch", () => {
		const source = {
			project: "flywheel",
			sourceEventId: "rework:req-1:activation-2",
			targetRunId: "run-1",
			activation: {
				activationId: "activation-2",
				runId: "run-1",
				nodeId: "implement",
				attempt: 2,
				outputCredential: "output-2",
				submissionCredential: "submission-2",
				context: { summary: "QA found a regression" },
			},
		};
		expect(
			db.grantTurn("FLY-1423", "exec-implement", "implement", 100, source),
		).toBe(1);
		expect(
			db.grantTurn("FLY-1423", "exec-implement", "implement", 101, {
				...source,
				activation: {
					...source.activation,
					outputCredential: "rotated-output-must-not-win",
					submissionCredential: "rotated-submission-must-not-win",
				},
			}),
		).toBe(1);
		expect(db.getTurn("FLY-1423")?.epoch).toBe(1);
		expect(db.getRunnerWorkflowActivation("exec-implement", 1)).toMatchObject({
			activation_id: "activation-2",
			context_json: JSON.stringify({ summary: "QA found a regression" }),
			output_credential: "output-2",
			submission_credential: "submission-2",
		});

		expect(() =>
			db.grantTurn("FLY-1423", "exec-implement", "implement", 102, {
				...source,
				activation: {
					...source.activation,
					context: { summary: "different" },
				},
			}),
		).toThrow(/mismatch|poison/i);
	});

	it("pages immutable source rows by a monotonic rowid cursor", () => {
		db.grantTurn("FLY-1244", "exec-design", "design", 100, {
			project: "flywheel",
			sourceEventId: "turn:1",
		});
		db.grantTurn("FLY-1244", "exec-implement", "implement", 101, {
			project: "flywheel",
			sourceEventId: "turn:2",
		});
		const first = db.listWorkflowSourceEventsAfter(0, 1);
		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({ row_id: 1, source_event_id: "turn:1" });
		expect(db.listWorkflowSourceEventsAfter(first[0]!.row_id, 10)).toEqual([
			expect.objectContaining({ row_id: 2, source_event_id: "turn:2" }),
		]);
	});

	it("appends an idempotent land departure cutoff in the founder-event rowid domain", () => {
		db.grantTurn("FLY-1833", "exec-land", "land", 100, {
			project: "flywheel",
			sourceEventId: "turn:before-cutoff",
		});
		const input = {
			project: "flywheel",
			carryoverReceiptId: "carryover-receipt-1",
			operationId: "land-operation-2",
			ordinal: 1,
			runId: "run-1833",
			approvedHead: "a".repeat(40),
			operationGeneration: 0,
			at: "2026-08-17T20:00:00.000Z",
		};

		const first = db.appendLandDepartureCutoff(input);
		const replay = db.appendLandDepartureCutoff(input);
		expect(first).toMatchObject({
			rowId: 2,
			idempotentReplay: false,
			sourceEventId: expect.stringMatching(/^land-departure-cutoff:/),
		});
		expect(replay).toEqual({ ...first, idempotentReplay: true });
		expect(db.listWorkflowSourceEventsAfter(1, 10)).toEqual([
			expect.objectContaining({
				row_id: 2,
				kind: "land_departure_cutoff",
				source_event_id: first.sourceEventId,
				payload_digest: canonicalSubmissionDigest({
					schema_version: 1,
					run_id: input.runId,
					carryover_receipt_id: input.carryoverReceiptId,
					operation_id: input.operationId,
					ordinal: input.ordinal,
					approved_head: input.approvedHead,
					operation_generation: input.operationGeneration,
				}),
			}),
		]);
		expect(() =>
			db.appendLandDepartureCutoff({
				...input,
				approvedHead: "b".repeat(40),
			}),
		).toThrow(/conflict|mismatch|poison/i);
	});

	it("conditionally writes a trusted founder response and its frozen source atomically", () => {
		const questionId = db.insertQuestion("exec-1", "lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const payload = {
			schema_version: 1,
			run_id: "run-1",
			issue_id: "FLY-1244",
			question_id: questionId,
			response: { approved: true },
			actor: "bridge",
			approved_head: "a".repeat(40),
			classification: "dashboard_founder_action",
			authority_id: questionId,
		};
		const written = db.insertFounderApprovalResponseWithSource({
			project: "flywheel",
			sourceEventId: `founder-approval:${questionId}`,
			questionId,
			fromAgent: "bridge",
			content: '{"approved":true}',
			expectedOwner: "exec-1",
			payload,
		});

		expect(written).toBe(true);
		expect(db.getResponse(questionId)?.from_agent).toBe("bridge");
		expect(db.listWorkflowSourceEvents()).toEqual([
			expect.objectContaining({
				source_event_id: `founder-approval:${questionId}`,
				kind: "founder_approval",
				payload_digest: canonicalSubmissionDigest(payload),
			}),
		]);
	});

	it("rejects bridge-founder-consent as a fresh atomic source writer", () => {
		const questionId = db.insertQuestion("exec-1", "lead", "ship?", {
			checkpoint: "approve_to_ship",
		});

		expect(() =>
			db.insertFounderApprovalResponseWithSource({
				project: "flywheel",
				sourceEventId: `founder-approval:${questionId}`,
				questionId,
				fromAgent: "bridge-founder-consent",
				content: '{"approved":true}',
				expectedOwner: "exec-1",
				payload: {
					schema_version: 1,
					response: { approved: true },
					classification: "founder_consent_enforce",
				},
			}),
		).toThrow(/historical-only/i);
		expect(db.getResponse(questionId)).toBeUndefined();
		expect(db.listWorkflowSourceEvents()).toEqual([]);
	});

	it("keeps a historical bridge-founder-consent row idempotently readable", () => {
		const questionId = db.insertQuestion("exec-1", "lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const raw = (
			db as unknown as {
				db: {
					prepare: (sql: string) => {
						run: (...args: unknown[]) => unknown;
					};
				};
			}
		).db;
		const responseId = `historical-response:${questionId}`;
		const deliveryId = `historical-delivery:${questionId}`;
		raw
			.prepare(
				"INSERT INTO mailbox_identity (id, delivery_id, insert_projection_hash) VALUES (?, ?, ?)",
			)
			.run(responseId, deliveryId, "historical-test-fixture");
		raw
			.prepare(
				`INSERT INTO mailbox
				 (id, delivery_id, from_agent, to_agent, recipient_kind, type, content,
				  ref_id, created_at, expires_at, relay_state)
				 VALUES (?, ?, 'bridge-founder-consent', 'exec-1', 'runner', 'response',
				         '{"approved":true}', ?, '2026-08-22T00:00:00.000Z',
				         '2026-08-25T00:00:00.000Z', 'terminal_disposed')`,
			)
			.run(responseId, deliveryId, questionId);
		raw
			.prepare(
				"UPDATE mailbox SET relay_state = 'terminal_disposed' WHERE id = ?",
			)
			.run(questionId);
		const existing = db.getResponse(questionId);

		expect(
			db.trustedFounderGateResponse({
				questionId,
				fromAgent: "bridge-founder-consent",
				content: '{"approved":true}',
				expectedOwner: "exec-1",
				msgId: "historical-message",
				now: "2026-08-22T00:00:00.000Z",
			}),
		).toEqual({ responseId: existing?.id });
		expect(db.getResponse(questionId)).toEqual(existing);
		expect(db.listWorkflowSourceEvents()).toEqual([]);
	});

	it("rejects bridge-founder-consent on the fresh trusted-message writer", () => {
		const questionId = db.insertQuestion("exec-1", "lead", "ship?", {
			checkpoint: "approve_to_ship",
		});

		expect(() =>
			db.trustedFounderGateResponse({
				questionId,
				fromAgent: "bridge-founder-consent",
				content: '{"approved":true}',
				expectedOwner: "exec-1",
				msgId: "new-message",
				now: "2026-08-22T00:00:00.000Z",
			}),
		).toThrow(/historical-only/i);
		expect(db.getResponse(questionId)).toBeUndefined();
	});

	it("writes founder feedback as a distinct immutable source event", () => {
		const questionId = db.insertQuestion("exec-1", "lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const payload = {
			schema_version: 1,
			run_id: "run-1",
			issue_id: "FLY-1375",
			question_id: questionId,
			response: { approved: false, feedback: "fix the changelog" },
			actor: "bridge",
			approved_head: "a".repeat(40),
			classification: "dashboard_founder_action",
			authority_id: questionId,
		};
		expect(
			db.insertFounderApprovalResponseWithSource({
				project: "flywheel",
				sourceEventId: `founder-feedback:${questionId}`,
				questionId,
				fromAgent: "bridge",
				content: "fix the changelog",
				expectedOwner: "exec-1",
				payload,
			}),
		).toBe(true);
		expect(db.listWorkflowSourceEvents()).toEqual([
			expect.objectContaining({
				source_event_id: `founder-feedback:${questionId}`,
				kind: "founder_feedback",
				payload_digest: canonicalSubmissionDigest(payload),
			}),
		]);
	});

	it("source and TURN history tables reject UPDATE and DELETE", () => {
		db.grantTurn("FLY-1244", "exec-design", "design", 100, {
			project: "flywheel",
			sourceEventId: "turn:1",
		});
		db.close();
		const raw = new Database(path);
		expect(() =>
			raw.prepare("UPDATE workflow_source_event SET kind='x'").run(),
		).toThrow(/append-only|immutable/i);
		expect(() => raw.prepare("DELETE FROM turn_source_history").run()).toThrow(
			/append-only|immutable/i,
		);
		raw.close();
		db = new CommDB(path);
	});
});
