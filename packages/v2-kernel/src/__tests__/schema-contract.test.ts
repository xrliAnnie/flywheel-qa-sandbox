import { afterEach, describe, expect, it } from "vitest";
import { openKernelDb } from "../connection.js";
import { runMigrations } from "../migrator.js";
import { makeTempDatabase, type TempDatabase } from "./helpers.js";

function insertTask(
	db: ReturnType<typeof openKernelDb>,
	id: string,
	state = "ready",
): void {
	db.prepare(
		`INSERT INTO tasks
			(id, project_id, kind, state, lineage_root_id, created_at)
		 VALUES (?, 'flywheel', 'build', ?, ?, '2026-07-27T00:00:00.000Z')`,
	).run(id, state, id);
}

describe("schema constraints and trigger bypass protection", () => {
	let temp: TempDatabase | undefined;

	afterEach(() => {
		temp?.cleanup();
		temp = undefined;
	});

	it("installs the complete named trigger set", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);
			expect(
				db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name",
					)
					.pluck()
					.all(),
			).toEqual([
				"actions_current_actor_insert",
				"actions_current_actor_outcome",
				"actions_immutable_fields",
				"actions_lineage_insert",
				"actions_no_delete",
				"actions_supersedes_insert",
				"actions_terminal_once",
				"agents_agent_id_immutable",
				"agents_generation_no_rollback",
				"agents_kind_immutable",
				"agents_no_delete",
				"command_dependencies_immutable",
				"command_dependencies_no_cycle",
				"events_append_only",
				"obligations_hierarchy_immutable",
				"obligations_inherit_root",
				"obligations_parent_depth",
				"obligations_tombstone_attempt_terminal",
				"obligations_tombstone_task_terminal",
				"tasks_no_self_rework_ins",
				"tasks_no_self_rework_upd",
			]);
		} finally {
			db.close();
		}
	});

	it("rejects task self-rework on insert and update", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);
			expect(() =>
				db
					.prepare(
						`INSERT INTO tasks
						 (id, project_id, kind, state, rework_of, lineage_root_id, created_at)
						 VALUES ('self', 'flywheel', 'build', 'ready', 'self', 'self', 'now')`,
					)
					.run(),
			).toThrow();
			insertTask(db, "task-1");
			expect(() =>
				db
					.prepare("UPDATE tasks SET rework_of='task-1' WHERE id='task-1'")
					.run(),
			).toThrow();
		} finally {
			db.close();
		}
	});

	it("keeps events and actions immutable while preserving command dependency fences", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);
			db.prepare(
				`INSERT INTO agents(agent_id, kind, generation, state)
				 VALUES ('lead-a', 'lead', 1, 'online')`,
			).run();
			db.prepare(
				`INSERT INTO events(event_uid, kind, cutover_epoch, created_at)
				 VALUES ('event-1', 'test', 1, 'now')`,
			).run();
			expect(() =>
				db
					.prepare("UPDATE events SET kind='changed' WHERE event_uid='event-1'")
					.run(),
			).toThrow();

			const insertCommand = db.prepare(
				`INSERT INTO commands(id, kind, cutover_epoch, created_at)
				 VALUES (?, 'notify', 1, 'now')`,
			);
			insertCommand.run("command-1");
			insertCommand.run("command-2");
			insertCommand.run("command-3");
			const insertEdge = db.prepare(
				`INSERT INTO command_dependencies
				 (command_id, depends_on_command_id, kind)
				 VALUES (?, ?, 'notify_before')`,
			);
			insertEdge.run("command-1", "command-2");
			insertEdge.run("command-2", "command-3");
			expect(() => insertEdge.run("command-3", "command-1")).toThrow();
			expect(() =>
				db
					.prepare(
						`UPDATE command_dependencies SET depends_on_command_id='command-1'
						 WHERE command_id='command-1'`,
					)
					.run(),
			).toThrow();

			db.prepare(
				`INSERT INTO actions
				 (id, actor_kind, actor_agent_id, actor_instance_id, actor_generation,
				  kind, payload, payload_digest, logical_key, effect_key,
				  cutover_epoch, created_at)
				 VALUES ('action-1', 'lead', 'lead-a', 'session-a', 1,
				  'custom_tool', '{}', 'payload-digest', 'logical-1', 'effect-1',
				  1, 'now')`,
			).run();
			expect(() =>
				db.prepare("UPDATE actions SET payload='{\"changed\":true}'").run(),
			).toThrow();
			expect(() =>
				db.prepare("DELETE FROM actions WHERE id='action-1'").run(),
			).toThrow(/not deletable/i);
		} finally {
			db.close();
		}
	});

	it("enforces attempt terminal-reason coupling and the mailbox enum", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);
			for (const id of ["task-1", "task-2", "task-3", "task-4"]) {
				insertTask(db, id);
			}
			const insertAttempt = db.prepare(
				`INSERT INTO attempts
				 (id, task_id, generation, desired_state, terminal_reason)
				 VALUES (?, ?, 1, ?, ?)`,
			);
			insertAttempt.run("valid-active", "task-1", "started", null);
			insertAttempt.run("valid-terminal", "task-2", "terminal", "completed");
			expect(() =>
				insertAttempt.run("active-with-reason", "task-3", "started", "failed"),
			).toThrow();
			expect(() =>
				insertAttempt.run("terminal-no-reason", "task-4", "terminal", null),
			).toThrow();

			expect(() =>
				db
					.prepare(
						`INSERT INTO mailbox
						 (message_uid, source_kind, source_id, payload, payload_digest,
						  to_agent, kind, retention_class, cutover_epoch, created_at)
						 VALUES ('bad-retention', 'test', '1', '{}', 'x', 'agent', 'test',
						  'forever', 1, 'now')`,
					)
					.run(),
			).toThrow();
		} finally {
			db.close();
		}
	});

	it("declares textual primary keys NOT NULL and rejects null writes", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);
			const textPrimaryKeys = db
				.prepare(
					`SELECT m.name AS table_name, p.name AS column_name, p."notnull" AS not_null
					 FROM sqlite_master m
					 JOIN pragma_table_info(m.name) p
					 WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%'
					   AND p.pk > 0 AND upper(p.type)='TEXT'
					 ORDER BY m.name, p.pk`,
				)
				.all() as {
				table_name: string;
				column_name: string;
				not_null: number;
			}[];
			expect(textPrimaryKeys.length).toBeGreaterThan(0);
			expect(textPrimaryKeys.every((column) => column.not_null === 1)).toBe(
				true,
			);

			insertTask(db, "task-pk");
			db.prepare(
				`INSERT INTO attempts(id, task_id, generation, desired_state)
				 VALUES ('attempt-pk', 'task-pk', 1, 'planned')`,
			).run();
			db.prepare(
				`INSERT INTO agents(agent_id,kind,generation,last_poll_at,state)
				 VALUES ('agent','runner',0,NULL,'offline')`,
			).run();
			db.prepare(
				`INSERT INTO mailbox
				 (message_uid, source_kind, source_id, payload, payload_digest,
				  to_agent, kind, retention_class, cutover_epoch, created_at)
				 VALUES ('message-pk', 'test', 'pk', '{}', 'digest', 'agent', 'test',
				  'business', 1, 'now')`,
			).run();
			db.prepare(
				`INSERT INTO agents(agent_id, kind, generation, state)
				 VALUES ('lead-pk', 'lead', 1, 'online')`,
			).run();

			const nullInsertSql = [
				`INSERT INTO tasks
				 (id, project_id, kind, state, lineage_root_id, created_at)
				 VALUES (NULL, 'flywheel', 'build', 'ready', 'task-pk', 'now')`,
				`INSERT INTO thread_bindings(lineage_root_id, thread_id, state)
				 VALUES (NULL, 'thread-null', 'active')`,
				`INSERT INTO meta(key, value, updated_at)
				 VALUES (NULL, 'value', 'now')`,
				`INSERT INTO processing_attempts
				 (attempt_uid, message_uid, attempt_no, instance_id, generation,
				  started_at)
				 VALUES (NULL, 'message-pk', 1, 'instance-null', 1, 'now')`,
				`INSERT INTO activations
				 (id, attempt_id, session_ref, generation, state)
				 VALUES (NULL, 'attempt-pk', 'session-null', 1, 'active')`,
				`INSERT INTO actions
				 (id, actor_kind, actor_agent_id, actor_instance_id, actor_generation,
				  kind, payload, payload_digest, logical_key, effect_key,
				  cutover_epoch, created_at)
				 VALUES (NULL, 'lead', 'lead-pk', 'session-pk', 1, 'custom_tool',
				  '{}', 'payload-digest', 'logical-pk', 'effect-pk', 1, 'now')`,
			];
			for (const sql of nullInsertSql) {
				expect(() => db.prepare(sql).run()).toThrow(/NOT NULL/);
			}

			db.prepare(
				`INSERT INTO thread_bindings(lineage_root_id, thread_id, state)
				 VALUES ('task-pk', 'thread-pk', 'active')`,
			).run();
			db.prepare(
				`INSERT INTO meta(key, value, updated_at)
				 VALUES ('meta-pk', 'value', 'now')`,
			).run();
			db.prepare(
				`INSERT INTO processing_attempts
				 (attempt_uid, message_uid, attempt_no, instance_id, generation,
				  started_at)
				 VALUES ('processing-pk', 'message-pk', 1, 'instance-pk', 1, 'now')`,
			).run();
			db.prepare(
				`INSERT INTO activations
				 (id, attempt_id, session_ref, generation, state)
				 VALUES ('activation-pk', 'attempt-pk', 'session-pk', 1, 'active')`,
			).run();
			db.prepare(
				`INSERT INTO actions
				 (id, actor_kind, actor_agent_id, actor_instance_id, actor_generation,
				  kind, payload, payload_digest, logical_key, effect_key,
				  cutover_epoch, created_at)
				 VALUES ('action-pk', 'lead', 'lead-pk', 'session-pk', 1,
				  'custom_tool', '{}', 'payload-digest', 'logical-pk', 'effect-pk',
				  1, 'now')`,
			).run();

			const nullUpdateSql = [
				"UPDATE tasks SET id=NULL WHERE id='task-pk'",
				"UPDATE thread_bindings SET lineage_root_id=NULL WHERE lineage_root_id='task-pk'",
				"UPDATE meta SET key=NULL WHERE key='meta-pk'",
				"UPDATE processing_attempts SET attempt_uid=NULL WHERE attempt_uid='processing-pk'",
				"UPDATE activations SET id=NULL WHERE id='activation-pk'",
			];
			for (const sql of nullUpdateSql) {
				expect(() => db.prepare(sql).run()).toThrow(/NOT NULL/);
			}
			expect(() =>
				db.prepare("UPDATE actions SET id=NULL WHERE id='action-pk'").run(),
			).toThrow();
		} finally {
			db.close();
		}
	});

	it("rejects malformed retry evidence through raw SQL", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);
			db.prepare(
				`INSERT INTO agents(agent_id, kind, generation, state)
				 VALUES ('lead-a', 'lead', 1, 'online')`,
			).run();
			const insertRoot = db.prepare(
				`INSERT INTO actions
				 (id, actor_kind, actor_agent_id, actor_instance_id, actor_generation,
				  kind, payload, payload_digest, logical_key, effect_key,
				  cutover_epoch, state, result, created_at, completed_at)
				 VALUES (?, 'lead', 'lead-a', 'session-a', 1, 'custom_tool',
				  '{}', 'payload-digest', ?, ?, 1, 'failed', '{}', 'now', 'now')`,
			);
			const insertSuccessor = db.prepare(
				`INSERT INTO actions
				 (id, actor_kind, actor_agent_id, actor_instance_id, actor_generation,
				  kind, payload, payload_digest, logical_key, effect_key,
				  supersedes_action_id, retry_basis, cutover_epoch, created_at)
				 VALUES (?, 'lead', 'lead-a', 'session-a', 1, 'custom_tool',
				  '{}', 'payload-digest', ?, ?, ?, ?, 1, 'now')`,
			);
			const invalid = [
				null,
				JSON.stringify({ evidence_ref: "gh://runs/1" }),
				JSON.stringify({ reason: "verified absent" }),
				JSON.stringify({ evidence_ref: "gh://runs/1", reason: null }),
				JSON.stringify({ evidence_ref: null, reason: "verified absent" }),
				JSON.stringify({ evidence_ref: 1, reason: 2 }),
				JSON.stringify({ evidence_ref: "gh://runs/1", reason: " retry " }),
				"{",
			];
			for (const [index, retryBasis] of invalid.entries()) {
				const rootId = `root-${index}`;
				const logicalKey = `logical-${index}`;
				insertRoot.run(rootId, logicalKey, `root-effect-${index}`);
				expect(() =>
					insertSuccessor.run(
						`successor-${index}`,
						logicalKey,
						`successor-effect-${index}`,
						rootId,
						retryBasis,
					),
				).toThrow();
			}

			insertRoot.run("root-valid", "logical-valid", "root-effect-valid");
			insertSuccessor.run(
				"successor-valid",
				"logical-valid",
				"successor-effect-valid",
				"root-valid",
				JSON.stringify({
					evidence_ref: "gh://runs/2",
					reason: "provider confirmed no request was accepted",
				}),
			);
		} finally {
			db.close();
		}
	});

	it("rejects duplicate thread lineage bindings", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);
			insertTask(db, "task-1");
			db.prepare(
				`INSERT INTO thread_bindings(lineage_root_id, thread_id, state)
				 VALUES ('task-1', 'thread-1', 'active')`,
			).run();
			expect(() =>
				db
					.prepare(
						`INSERT INTO thread_bindings(lineage_root_id, thread_id, state)
						 VALUES ('task-1', 'thread-2', 'archived')`,
					)
					.run(),
			).toThrow();
		} finally {
			db.close();
		}
	});
});
