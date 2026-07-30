import { afterEach, describe, expect, it } from "vitest";
import { openKernelDb } from "../connection.js";
import { MIGRATIONS } from "../migrations/index.js";
import { runMigrations } from "../migrator.js";
import {
	boundAgentParams,
	INSERT_BOUND_AGENT_SQL,
	makeTempDatabase,
	type TempDatabase,
} from "./helpers.js";

const NOW = "2026-07-30T00:00:00.000Z";
const SESSION = "v2dag:attempt-a:1:activation-a";

describe("0010 session recipient migration", () => {
	let temp: TempDatabase | undefined;

	afterEach(() => {
		temp?.cleanup();
		temp = undefined;
	});

	it("reroutes an in-flight runner mailbox and makes the activation its identity", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db, MIGRATIONS.slice(0, 9));
			db.prepare(INSERT_BOUND_AGENT_SQL).run(
				boundAgentParams({
					agentId: "runner-role",
					kind: "runner",
					instanceId: SESSION,
				}),
			);
			db.prepare(
				`INSERT INTO tasks
				 (id,project_id,kind,state,lineage_root_id,created_at)
				 VALUES ('task-a','project-a','opaque','running','task-a',@now)`,
			).run({ now: NOW });
			db.prepare(
				`INSERT INTO attempts(id,task_id,generation,desired_state)
				 VALUES ('attempt-a','task-a',1,'started')`,
			).run();
			db.prepare(
				`INSERT INTO activations(id,attempt_id,session_ref,generation,state)
				 VALUES ('activation-a','attempt-a',@session,1,'active')`,
			).run({ session: SESSION });
			db.prepare(
				`INSERT INTO mailbox
				 (message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
				  retention_class,cutover_epoch,state,retry_count,created_at)
				 VALUES ('message-a','dag_task_dispatch','activation-a','{}','digest-a',
				  'runner-role','task_assignment','business',1,'pending',0,@now)`,
			).run({ now: NOW });

			expect(runMigrations(db).applied).toEqual(["0010-session-recipients"]);
			expect(
				db
					.prepare(
						"SELECT session_ref,generation,session_binding FROM activations WHERE id='activation-a'",
					)
					.get(),
			).toMatchObject({
				session_ref: SESSION,
				generation: 1,
				session_binding: expect.any(String),
			});
			expect(
				db
					.prepare(
						"SELECT to_agent,state FROM mailbox WHERE message_uid='message-a'",
					)
					.get(),
			).toEqual({ to_agent: SESSION, state: "pending" });
			expect(
				db
					.prepare("SELECT state FROM agents WHERE agent_id='runner-role'")
					.pluck()
					.get(),
			).toBe("offline");
			expect(
				(
					db.pragma("foreign_key_list(mailbox)") as Array<{ table: string }>
				).some((key) => key.table === "agents"),
			).toBe(false);

			expect(() =>
				db
					.prepare(
						`INSERT INTO agents
						 (agent_id,kind,generation,instance_id,session_binding,last_poll_at,state)
						 VALUES ('new-runner','runner',0,NULL,NULL,NULL,'offline')`,
					)
					.run(),
			).toThrow(/lead identities only/i);
			expect(() =>
				db
					.prepare(
						`INSERT INTO mailbox
						 (message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
						  retention_class,cutover_epoch,state,retry_count,created_at)
						 VALUES ('unknown','test','unknown','{}','digest',@recipient,
						  'notice','notice',1,'pending',0,@now)`,
					)
					.run({ recipient: "v2dag:unknown:1:unknown", now: NOW }),
			).toThrow(/lead or an active session/i);
			db.prepare(
				"UPDATE activations SET state='terminal' WHERE id='activation-a'",
			).run();
			expect(() =>
				db
					.prepare(
						`INSERT INTO mailbox
						 (message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
						  retention_class,cutover_epoch,state,retry_count,created_at)
						 VALUES ('late','test','late','{}','digest',@recipient,
						  'notice','notice',1,'pending',0,@now)`,
					)
					.run({ recipient: SESSION, now: NOW }),
			).toThrow(/lead or an active session/i);
		} finally {
			db.close();
		}
	});

	it("rolls back when an active activation has no unique old runner binding", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db, MIGRATIONS.slice(0, 9));
			db.prepare(
				`INSERT INTO tasks
				 (id,project_id,kind,state,lineage_root_id,created_at)
				 VALUES ('task-a','project-a','opaque','running','task-a',@now)`,
			).run({ now: NOW });
			db.prepare(
				`INSERT INTO attempts(id,task_id,generation,desired_state)
				 VALUES ('attempt-a','task-a',1,'started')`,
			).run();
			db.prepare(
				`INSERT INTO activations(id,attempt_id,session_ref,generation,state)
				 VALUES ('activation-a','attempt-a',@session,1,'active')`,
			).run({ session: SESSION });

			expect(() => runMigrations(db)).toThrow();
			expect(
				db
					.prepare(
						"SELECT count(*) FROM schema_migrations WHERE id='0010-session-recipients'",
					)
					.pluck()
					.get(),
			).toBe(0);
			expect(
				db
					.pragma("table_info(activations)")
					.map((row) => (row as { name: string }).name),
			).not.toContain("session_binding");
		} finally {
			db.close();
		}
	});
});
