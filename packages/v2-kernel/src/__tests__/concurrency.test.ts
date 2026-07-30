import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { openKernelDb } from "../connection.js";
import { runMigrations } from "../migrator.js";
import { makeTempDatabase, type TempDatabase } from "./helpers.js";

function sqliteCode(error: unknown): string | undefined {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: undefined;
}

function insertMailbox(
	db: ReturnType<typeof openKernelDb>,
	messageUid: string,
): void {
	db.prepare(
		`INSERT INTO agents(agent_id,kind,generation,last_poll_at,state)
		 VALUES ('runner-1','lead',0,NULL,'offline')
		 ON CONFLICT(agent_id) DO NOTHING`,
	).run();
	db.prepare(
		`INSERT INTO mailbox
		 (message_uid, source_kind, source_id, payload, payload_digest, to_agent,
		  kind, retention_class, cutover_epoch, created_at)
		 VALUES (?, 'test', ?, '{}', 'digest', 'runner-1', 'instruction',
		  'business', 1, '2026-07-27T00:00:00.000Z')`,
	).run(messageUid, `source:${messageUid}`);
}

function insertTaskAndAttempt(
	db: ReturnType<typeof openKernelDb>,
	taskId: string,
	attemptId: string,
): void {
	db.prepare(
		`INSERT INTO tasks
		 (id, project_id, kind, state, lineage_root_id, created_at)
		 VALUES (?, 'flywheel', 'build', 'running', ?, '2026-07-27T00:00:00.000Z')`,
	).run(taskId, taskId);
	db.prepare(
		`INSERT INTO attempts(id, task_id, generation, desired_state)
		 VALUES (?, ?, 1, 'started')`,
	).run(attemptId, taskId);
}

describe("SQLite concurrency constraints", () => {
	let temp: TempDatabase | undefined;

	afterEach(() => {
		temp?.cleanup();
		temp = undefined;
	});

	it("rejects a second running processing attempt from another connection", () => {
		temp = makeTempDatabase();
		const first = openKernelDb({ path: temp.path });
		const second = openKernelDb({ path: temp.path });
		try {
			runMigrations(first);
			insertMailbox(first, "message-1");
			const insert = (
				db: ReturnType<typeof openKernelDb>,
				attemptUid: string,
				attemptNo: number,
			) =>
				db
					.prepare(
						`INSERT INTO processing_attempts
						 (attempt_uid, message_uid, attempt_no, instance_id, generation,
						  started_at, outcome)
						 VALUES (?, 'message-1', ?, 'instance-1', 1,
						  '2026-07-27T00:00:00.000Z', 'running')`,
					)
					.run(attemptUid, attemptNo);

			insert(first, "processing-1", 1);
			let rejected: unknown;
			try {
				insert(second, "processing-2", 2);
			} catch (error) {
				rejected = error;
			}
			expect(sqliteCode(rejected)).toBe("SQLITE_CONSTRAINT_UNIQUE");
			expect(
				first
					.prepare(
						"SELECT attempt_uid FROM processing_attempts WHERE outcome='running'",
					)
					.pluck()
					.all(),
			).toEqual(["processing-1"]);
		} finally {
			first.close();
			second.close();
		}
	});

	it("honors busy_timeout when another connection holds BEGIN IMMEDIATE", () => {
		temp = makeTempDatabase();
		const first = openKernelDb({ path: temp.path, busyTimeoutMs: 100 });
		const second = openKernelDb({ path: temp.path, busyTimeoutMs: 100 });
		try {
			runMigrations(first);
			first.exec("BEGIN IMMEDIATE");
			const startedAt = performance.now();
			let rejected: unknown;
			try {
				second.exec("BEGIN IMMEDIATE");
			} catch (error) {
				rejected = error;
			}
			const elapsedMs = performance.now() - startedAt;
			expect(sqliteCode(rejected)).toBe("SQLITE_BUSY");
			expect(elapsedMs).toBeGreaterThanOrEqual(75);
		} finally {
			if (first.inTransaction) {
				first.exec("ROLLBACK");
			}
			if (second.inTransaction) {
				second.exec("ROLLBACK");
			}
			first.close();
			second.close();
		}
	});

	it("rejects duplicate active attempt/session bindings and permits replacement after terminal", () => {
		temp = makeTempDatabase();
		const first = openKernelDb({ path: temp.path });
		const second = openKernelDb({ path: temp.path });
		try {
			runMigrations(first);
			insertTaskAndAttempt(first, "task-1", "attempt-1");
			insertTaskAndAttempt(first, "task-2", "attempt-2");
			const insertActivation = (
				db: ReturnType<typeof openKernelDb>,
				id: string,
				attemptId: string,
				sessionRef: string,
			) =>
				db
					.prepare(
						`INSERT INTO activations(id, attempt_id, session_ref, generation, state)
						 VALUES (?, ?, ?, 1, 'active')`,
					)
					.run(id, attemptId, sessionRef);

			insertActivation(first, "activation-1", "attempt-1", "session-1");
			expect(() =>
				insertActivation(second, "activation-2", "attempt-1", "session-2"),
			).toThrow();
			expect(() =>
				insertActivation(second, "activation-3", "attempt-2", "session-1"),
			).toThrow();

			first
				.prepare(
					"UPDATE activations SET state='terminal' WHERE id='activation-1'",
				)
				.run();
			insertActivation(second, "activation-4", "attempt-1", "session-1");
		} finally {
			first.close();
			second.close();
		}
	});
});
