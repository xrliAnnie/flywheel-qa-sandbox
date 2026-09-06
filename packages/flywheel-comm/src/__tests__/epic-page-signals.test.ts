import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

const CREATED_AFTER = "2026-09-05T00:00:00.000Z";
const CREATED_AT = "2026-09-05T01:00:00.000Z";

function runnerStopContent(
	executionId: string,
	reason:
		| "done"
		| "blocked"
		| "awaiting_approval"
		| "quota"
		| "context_full"
		| "error",
	detail = "safe",
): string {
	return (
		`RUNNER-STOPPED kind=runner_stopped reason=${reason} ` +
		`issue=FLY-2143 exec=${executionId} route=- detail=${detail}`
	);
}

describe("FLY-2143 Epic page CommDB signals", () => {
	let db: CommDB;
	let dbPath: string;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-epic-signals-"));
		dbPath = join(tmpDir, "comm.db");
		db = new CommDB(dbPath);
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function setCreatedAt(questionIds: string[], createdAt = CREATED_AT): void {
		const raw = new Database(dbPath);
		try {
			const update = raw.prepare(
				"UPDATE mailbox SET created_at = ? WHERE id = ?",
			);
			for (const id of questionIds) update.run(createdAt, id);
		} finally {
			raw.close();
		}
	}

	it("classifies runner stops, ordinary questions, and protected founder waits without leaking text", () => {
		const executionId = "exec-one";
		const stopId = db.insertQuestion(
			executionId,
			"lead",
			runnerStopContent(executionId, "blocked", "SENTINEL_SECRET"),
			{
				id: `rstop-${"a".repeat(32)}`,
				kind: "report",
			},
		);
		const questionId = db.insertQuestion(
			executionId,
			"lead",
			"SENTINEL_QUESTION",
		);
		const founderId = db.insertQuestion(
			executionId,
			"lead",
			"SENTINEL_FOUNDER",
			{ checkpoint: "founder_review" },
		);
		expect(db.markQuestionProtected(founderId, "event-founder")).toBe(true);
		setCreatedAt([stopId, questionId, founderId]);

		const result = db.listEpicPageSignals({
			executionIds: [executionId],
			createdAfter: CREATED_AFTER,
			limit: 20,
		});

		// Three kinds is the conservative per-execution output bound.
		expect(result.truncated).toBe(true);
		expect(result.signals).toHaveLength(3);
		expect(result.signals).toEqual(
			expect.arrayContaining([
				{
					kind: "runner_stopped",
					execution_id: executionId,
					since: CREATED_AT,
					reason: "blocked",
					question_id_present: true,
				},
				{
					kind: "question_pending",
					execution_id: executionId,
					since: CREATED_AT,
					question_id_present: true,
				},
				{
					kind: "waiting_founder",
					execution_id: executionId,
					since: CREATED_AT,
					question_id_present: true,
				},
			]),
		);
		expect(JSON.stringify(result)).not.toContain("SENTINEL");
		expect(Object.keys(result.signals[0] ?? {})).not.toContain("id");
		expect(Object.keys(result.signals[0] ?? {})).not.toContain("content");
		expect(Object.keys(result.signals[0] ?? {})).not.toContain("checkpoint");
	});

	it("drops completed stop reports and answered questions", () => {
		const executionId = "exec-two";
		const done = db.insertQuestion(
			executionId,
			"lead",
			runnerStopContent(executionId, "done"),
			{ id: `rstop-${"b".repeat(32)}`, kind: "report" },
		);
		const awaiting = db.insertQuestion(
			executionId,
			"lead",
			runnerStopContent(executionId, "awaiting_approval"),
			{ id: `rstop-${"c".repeat(32)}`, kind: "report" },
		);
		const answered = db.insertQuestion(executionId, "lead", "question");
		db.insertResponse(answered, "lead", "answer");
		setCreatedAt([done, awaiting, answered]);

		expect(
			db.listEpicPageSignals({
				executionIds: [executionId],
				createdAfter: CREATED_AFTER,
				limit: 20,
			}),
		).toEqual({ signals: [], truncated: false });
	});

	it("honors the created-at window, per-kind deduplication, and explicit limit", () => {
		const executionId = "exec-three";
		const old = db.insertQuestion(executionId, "lead", "old");
		const first = db.insertQuestion(executionId, "lead", "first");
		const duplicate = db.insertQuestion(executionId, "lead", "duplicate");
		const stop = db.insertQuestion(
			executionId,
			"lead",
			runnerStopContent(executionId, "error"),
			{ id: `rstop-${"d".repeat(32)}`, kind: "report" },
		);
		setCreatedAt([old], "2026-09-04T23:59:59.999Z");
		setCreatedAt([first], "2026-09-05T01:00:00.000Z");
		setCreatedAt([duplicate], "2026-09-05T02:00:00.000Z");
		setCreatedAt([stop], "2026-09-05T03:00:00.000Z");

		expect(
			db.listEpicPageSignals({
				executionIds: [executionId],
				createdAfter: CREATED_AFTER,
				limit: 1,
			}),
		).toEqual({
			signals: [
				{
					kind: "question_pending",
					execution_id: executionId,
					since: "2026-09-05T01:00:00.000Z",
					question_id_present: true,
				},
			],
			truncated: true,
		});
	});

	it("keeps the latest runner-stop reason while ordinary questions keep their earliest time", () => {
		const executionId = "exec-latest-stop";
		const firstQuestion = db.insertQuestion(executionId, "lead", "first");
		const laterQuestion = db.insertQuestion(executionId, "lead", "later");
		const firstStop = db.insertQuestion(
			executionId,
			"lead",
			runnerStopContent(executionId, "blocked"),
			{ id: `rstop-${"e".repeat(32)}`, kind: "report" },
		);
		const latestStop = db.insertQuestion(
			executionId,
			"lead",
			runnerStopContent(executionId, "quota"),
			{ id: `rstop-${"f".repeat(32)}`, kind: "report" },
		);
		setCreatedAt([firstQuestion, firstStop], "2026-09-05T01:00:00.000Z");
		setCreatedAt([laterQuestion, latestStop], "2026-09-05T02:00:00.000Z");

		const result = db.listEpicPageSignals({
			executionIds: [executionId],
			createdAfter: CREATED_AFTER,
			limit: 3,
		});
		expect(result.signals).toEqual(
			expect.arrayContaining([
				{
					kind: "question_pending",
					execution_id: executionId,
					since: "2026-09-05T01:00:00.000Z",
					question_id_present: true,
				},
				{
					kind: "runner_stopped",
					execution_id: executionId,
					since: "2026-09-05T02:00:00.000Z",
					reason: "quota",
					question_id_present: true,
				},
			]),
		);
	});

	it("rejects more than 500 executions and does not let duplicate raw rows starve later executions", () => {
		expect(() =>
			db.listEpicPageSignals({
				executionIds: Array.from(
					{ length: 501 },
					(_, index) => `exec-${index}`,
				),
				createdAfter: CREATED_AFTER,
				limit: 2_000,
			}),
		).toThrow(/500/);

		const noisy = "exec-noisy";
		const later = "exec-later";
		const ids = Array.from({ length: 501 }, (_, index) =>
			db.insertQuestion(noisy, "lead", `duplicate ${index}`),
		);
		const laterId = db.insertQuestion(later, "lead", "later valid question");
		setCreatedAt([...ids, laterId]);

		const result = db.listEpicPageSignals({
			executionIds: [noisy, later],
			createdAfter: CREATED_AFTER,
			limit: 6,
		});
		expect(result.signals.map((signal) => signal.execution_id)).toEqual([
			noisy,
			later,
		]);
		expect(result.truncated).toBe(false);
	});

	it("returns two deduplicated kinds for every execution at the 500-execution boundary", () => {
		const executionIds = Array.from(
			{ length: 500 },
			(_, index) => `exec-boundary-${index}`,
		);
		const ids: string[] = [];
		for (const [index, executionId] of executionIds.entries()) {
			ids.push(db.insertQuestion(executionId, "lead", "question"));
			ids.push(
				db.insertQuestion(
					executionId,
					"lead",
					runnerStopContent(executionId, "blocked"),
					{
						id: `rstop-${index.toString(16).padStart(32, "0")}`,
						kind: "report",
					},
				),
			);
		}
		setCreatedAt(ids);

		const result = db.listEpicPageSignals({
			executionIds,
			createdAfter: CREATED_AFTER,
			limit: 1_500,
		});
		expect(result.signals).toHaveLength(1_000);
		expect(result.truncated).toBe(false);
	});

	it("fails closed when a mailbox_v1 database is missing relay_state", () => {
		db.close();
		rmSync(dbPath, { force: true });
		rmSync(`${dbPath}-wal`, { force: true });
		rmSync(`${dbPath}-shm`, { force: true });
		const raw = new Database(dbPath);
		try {
			raw.exec(`
				CREATE TABLE mailbox_migration_meta (
					singleton INTEGER PRIMARY KEY,
					schema_generation TEXT NOT NULL
				);
				INSERT INTO mailbox_migration_meta VALUES (1, 'mailbox_v1');
				CREATE TABLE mailbox (
					seq INTEGER PRIMARY KEY,
					id TEXT NOT NULL,
					from_agent TEXT NOT NULL,
					type TEXT NOT NULL,
					content TEXT NOT NULL,
					ref_id TEXT,
					kind TEXT,
					checkpoint TEXT,
					created_at TEXT NOT NULL,
					superseded_at TEXT
				);
			`);
		} finally {
			raw.close();
		}

		const readonly = CommDB.openReadonly(dbPath);
		try {
			expect(() =>
				readonly.listEpicPageSignals({
					executionIds: ["exec-old"],
					createdAfter: CREATED_AFTER,
					limit: 3,
				}),
			).toThrow(/relay_state/);
		} finally {
			readonly.close();
		}
		// Prevent afterEach from closing the already-closed original handle.
		db = { close() {} } as CommDB;
	});
});
