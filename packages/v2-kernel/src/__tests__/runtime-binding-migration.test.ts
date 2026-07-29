import { afterEach, describe, expect, it } from "vitest";
import { openKernelDb } from "../connection.js";
import { MIGRATIONS } from "../migrations/index.js";
import { runMigrations } from "../migrator.js";
import { makeTempDatabase, type TempDatabase } from "./helpers.js";

const NOW = "2026-07-28T00:00:00.000Z";

function binding(sessionId: string, pid = 4242): string {
	return JSON.stringify({
		v: 1,
		host_epoch: "host-epoch-1",
		session_id: sessionId,
		pid,
		pid_start: `pid-start-${pid}`,
	});
}

describe("0009 runtime binding and proposal receipt migration", () => {
	let temp: TempDatabase | undefined;

	afterEach(() => {
		temp?.cleanup();
		temp = undefined;
	});

	it("installs the exact binding and receipt columns on a fresh database", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);
			const agentColumns = db
				.pragma("table_info(agents)")
				.map((row) => (row as { name: string }).name);
			const attemptColumns = db
				.pragma("table_info(processing_attempts)")
				.map((row) => (row as { name: string }).name);

			expect(MIGRATIONS.at(-1)?.id).toBe(
				"0009-runtime-binding-proposal-receipts",
			);
			expect(agentColumns).toEqual(
				expect.arrayContaining(["instance_id", "session_binding"]),
			);
			expect(attemptColumns).toContain("proposal_digest");
		} finally {
			db.close();
		}
	});

	it("enforces provision, registration, and generation-scoped binding transitions", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);
			db.prepare(
				`INSERT INTO agents
				 (agent_id,kind,generation,instance_id,session_binding,last_poll_at,state)
				 VALUES ('lead-provisioned','lead',0,NULL,NULL,NULL,'offline')`,
			).run();

			expect(() =>
				db
					.prepare(
						`INSERT INTO agents
						 (agent_id,kind,generation,instance_id,session_binding,last_poll_at,state)
						 VALUES ('bad-provision','lead',0,'instance-a',@binding,NULL,'offline')`,
					)
					.run({ binding: binding("session-a") }),
			).toThrow(/binding invariant/i);
			expect(() =>
				db
					.prepare(
						`INSERT INTO agents
						 (agent_id,kind,generation,instance_id,session_binding,last_poll_at,state)
						 VALUES ('bad-registration','lead',1,NULL,NULL,NULL,'online')`,
					)
					.run(),
			).toThrow(/binding invariant/i);

			db.prepare(
				`INSERT INTO agents
				 (agent_id,kind,generation,instance_id,session_binding,last_poll_at,state)
				 VALUES ('lead-a','lead',1,'instance-a',@binding,NULL,'online')`,
			).run({ binding: binding("session-a") });
			expect(
				db
					.prepare(
						"UPDATE agents SET last_poll_at=@now WHERE agent_id='lead-a'",
					)
					.run({ now: NOW }).changes,
			).toBe(1);
			expect(() =>
				db
					.prepare(
						"UPDATE agents SET session_binding=@binding WHERE agent_id='lead-a'",
					)
					.run({ binding: binding("session-b") }),
			).toThrow(/binding transition/i);
			expect(() =>
				db
					.prepare(
						`UPDATE agents
						 SET generation=2,instance_id='instance-a',session_binding=@binding
						 WHERE agent_id='lead-a'`,
					)
					.run({ binding: binding("session-a") }),
			).toThrow(/binding transition/i);
			expect(
				db
					.prepare(
						`UPDATE agents
						 SET generation=2,instance_id='instance-b',session_binding=@binding
						 WHERE agent_id='lead-a'`,
					)
					.run({ binding: binding("session-b", 4343) }).changes,
			).toBe(1);
		} finally {
			db.close();
		}
	});

	it("requires an immutable canonical digest only for successful settlement", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);
			db.prepare(
				`INSERT INTO agents
				 (agent_id,kind,generation,instance_id,session_binding,last_poll_at,state)
				 VALUES ('lead-a','lead',1,'instance-a',@binding,NULL,'online')`,
			).run({ binding: binding("session-a") });
			db.prepare(
				`INSERT INTO mailbox
				 (message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
				  retention_class,cutover_epoch,state,retry_count,created_at)
				 VALUES ('message-a','test','source-a','{}','payload-digest','lead-a',
				  'instruction','business',1,'pending',0,@now)`,
			).run({ now: NOW });

			expect(() =>
				db
					.prepare(
						`INSERT INTO processing_attempts
						 (attempt_uid,message_uid,attempt_no,instance_id,generation,
						  activation_id,started_at,outcome,proposal_digest)
						 VALUES ('bad-running','message-a',1,'instance-a',1,NULL,@now,
						  'running','digest-a')`,
					)
					.run({ now: NOW }),
			).toThrow(/must start running without receipt/i);

			db.prepare(
				`INSERT INTO processing_attempts
				 (attempt_uid,message_uid,attempt_no,instance_id,generation,
				  activation_id,started_at,outcome,proposal_digest)
				 VALUES ('attempt-a','message-a',1,'instance-a',1,NULL,@now,
				  'running',NULL)`,
			).run({ now: NOW });
			expect(() =>
				db
					.prepare(
						`UPDATE processing_attempts
						 SET outcome='succeeded',settled_at=@now
						 WHERE attempt_uid='attempt-a'`,
					)
					.run({ now: NOW }),
			).toThrow(/receipt immutability/i);
			expect(
				db
					.prepare(
						`UPDATE processing_attempts
						 SET outcome='succeeded',settled_at=@now,proposal_digest='digest-a'
						 WHERE attempt_uid='attempt-a'`,
					)
					.run({ now: NOW }).changes,
			).toBe(1);
			expect(() =>
				db
					.prepare(
						`UPDATE processing_attempts
						 SET proposal_digest='digest-b'
						 WHERE attempt_uid='attempt-a'`,
					)
					.run(),
			).toThrow(/receipt immutability/i);
		} finally {
			db.close();
		}
	});

	it("rejects upgrading a populated 0008 database", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db, MIGRATIONS.slice(0, 8));
			db.prepare(
				`INSERT INTO agents(agent_id,kind,generation,last_poll_at,state)
				 VALUES ('lead-a','lead',1,NULL,'online')`,
			).run();

			expect(() => runMigrations(db)).toThrow();
			expect(
				db
					.prepare(
						`SELECT count(*) FROM schema_migrations
						 WHERE id='0009-runtime-binding-proposal-receipts'`,
					)
					.pluck()
					.get(),
			).toBe(0);
			expect(
				db
					.pragma("table_info(agents)")
					.map((row) => (row as { name: string }).name),
			).not.toContain("session_binding");
		} finally {
			db.close();
		}
	});
});
