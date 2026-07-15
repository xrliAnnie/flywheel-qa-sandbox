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

	it("exact TURN source replay is a no-op while a mismatched replay is poison", () => {
		const opts = {
			project: "flywheel",
			sourceEventId: "turn:spawn:exec-design",
		};
		db.grantTurn("FLY-1244", "exec-design", "design", 100, opts);
		db.grantTurn("FLY-1244", "exec-design", "design", 100, opts);
		expect(db.getTurn("FLY-1244")?.epoch).toBe(1);
		expect(db.listTurnSourceHistory("FLY-1244")).toHaveLength(1);

		expect(() =>
			db.grantTurn("FLY-1244", "exec-implement", "implement", 101, opts),
		).toThrow(/digest|mismatch|poison/i);
		expect(db.getTurn("FLY-1244")?.holder_exec_id).toBe("exec-design");
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
