import { afterEach, describe, expect, it } from "vitest";
import { openKernelDb } from "../connection.js";
import { MIGRATIONS } from "../migrations/index.js";
import { runMigrations } from "../migrator.js";
import { makeTempDatabase, type TempDatabase } from "./helpers.js";

const MAILBOX_INDEXES = [
	"mailbox_pending_age",
	"mailbox_pending_immediate",
	"mailbox_pending_immediate_f",
	"mailbox_pending_immediate_nf",
	"mailbox_pending_scheduled",
	"mailbox_pending_scheduled_f",
	"mailbox_pending_scheduled_nf",
];

function migrateThroughBatchOne(db: ReturnType<typeof openKernelDb>): void {
	runMigrations(db, MIGRATIONS.slice(0, 4));
}

function seedRegistry(
	db: ReturnType<typeof openKernelDb>,
	agentId: string,
	kind: "lead" | "runner",
	generation: number,
): void {
	const identity =
		kind === "lead"
			? { kind, leadId: agentId, instanceId: "instance-1", generation }
			: {
					kind,
					agentId,
					instanceId: "instance-1",
					activationId: "activation-1",
					generation,
				};
	db.prepare(
		`INSERT INTO meta(key,value,updated_at)
		 VALUES (@key,@value,'2026-07-28T00:00:00.000Z')`,
	).run({
		key: `consumer_registry:${agentId}`,
		value: JSON.stringify(identity),
	});
}

function seedMailbox(
	db: ReturnType<typeof openKernelDb>,
	args: { agentId: string; uid: string; state?: string },
): void {
	db.prepare(
		`INSERT INTO mailbox
		 (seq,message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
		  retention_class,cutover_epoch,state,retry_count,next_retry_at,created_at)
		 VALUES (41,@uid,'lead',@sourceId,'{}','digest',@agentId,'instruction',
		  'business',1,@state,0,NULL,'2026-07-28T00:00:00.000Z')`,
	).run({
		uid: args.uid,
		sourceId: `source-${args.uid}`,
		agentId: args.agentId,
		state: args.state ?? "pending",
	});
}

describe("agents/config mailbox cutover migration", () => {
	let temp: TempDatabase | undefined;

	afterEach(() => {
		temp?.cleanup();
		temp = undefined;
	});

	it("creates agents/config, the mailbox FK, and every named mailbox index from zero", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);
			const tables = db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.pluck()
				.all() as string[];
			const indexes = db
				.prepare(
					`SELECT name FROM sqlite_master
					 WHERE type='index' AND tbl_name='mailbox'
					   AND name NOT LIKE 'sqlite_autoindex%'
					 ORDER BY name`,
				)
				.pluck()
				.all() as string[];
			const foreignKeys = db.pragma("foreign_key_list(mailbox)") as Array<{
				table: string;
				from: string;
				to: string;
			}>;

			expect(tables).toContain("agents");
			expect(tables).toContain("config");
			expect(indexes).toEqual(MAILBOX_INDEXES);
			expect(foreignKeys).toContainEqual(
				expect.objectContaining({
					table: "agents",
					from: "to_agent",
					to: "agent_id",
				}),
			);
			expect(db.pragma("foreign_key_check")).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("materializes legacy registry rows and preserves mailbox/attempt identity across rebuild", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			migrateThroughBatchOne(db);
			seedRegistry(db, "lead-a", "lead", 7);
			seedMailbox(db, { agentId: "lead-a", uid: "message-1" });
			db.prepare(
				`INSERT INTO processing_attempts
				 (attempt_uid,message_uid,attempt_no,instance_id,generation,activation_id,started_at,outcome)
				 VALUES ('message-1#1','message-1',1,'instance-1',7,NULL,
				  '2026-07-28T00:00:00.000Z','running')`,
			).run();

			expect(runMigrations(db)).toEqual({
				applied: [MIGRATIONS.at(-1)?.id],
			});
			expect(
				db
					.prepare(
						"SELECT agent_id,kind,generation,last_poll_at,state FROM agents",
					)
					.get(),
			).toEqual({
				agent_id: "lead-a",
				kind: "lead",
				generation: 7,
				last_poll_at: null,
				state: "online",
			});
			expect(
				db.prepare("SELECT seq,message_uid,state FROM mailbox").get(),
			).toEqual({ seq: 41, message_uid: "message-1", state: "pending" });
			expect(
				db
					.prepare(
						"SELECT attempt_uid,message_uid,outcome FROM processing_attempts",
					)
					.get(),
			).toEqual({
				attempt_uid: "message-1#1",
				message_uid: "message-1",
				outcome: "running",
			});
			expect(
				db
					.prepare("SELECT seq FROM sqlite_sequence WHERE name='mailbox'")
					.pluck()
					.get(),
			).toBe(41);
			expect(
				db
					.prepare(
						`SELECT name FROM sqlite_master
						 WHERE type='index' AND tbl_name='mailbox'
						   AND name NOT LIKE 'sqlite_autoindex%'
						 ORDER BY name`,
					)
					.pluck()
					.all(),
			).toEqual(MAILBOX_INDEXES);
			expect(
				db
					.prepare(
						"SELECT count(*) FROM meta WHERE key LIKE 'consumer_registry:%'",
					)
					.pluck()
					.get(),
			).toBe(0);
			expect(db.pragma("foreign_key_check")).toEqual([]);
		} finally {
			db.close();
		}
	});

	it.each([
		["orphan recipient", "pending", false],
		["legacy tombstone", "tombstoned", true],
	])("rolls back the entire cutover for %s", (_name, state, withRegistry) => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			migrateThroughBatchOne(db);
			if (withRegistry) {
				seedRegistry(db, "lead-a", "lead", 1);
			}
			seedMailbox(db, { agentId: "lead-a", uid: "message-1", state });

			expect(() => runMigrations(db)).toThrow();
			expect(
				db
					.prepare("SELECT count(*) FROM schema_migrations WHERE id=@id")
					.pluck()
					.get({ id: MIGRATIONS.at(-1)?.id }),
			).toBe(0);
			expect(
				db
					.prepare(
						"SELECT count(*) FROM sqlite_master WHERE type='table' AND name='agents'",
					)
					.pluck()
					.get(),
			).toBe(0);
			expect(
				db
					.prepare("SELECT state FROM mailbox WHERE message_uid='message-1'")
					.pluck()
					.get(),
			).toBe(state);
			expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
		} finally {
			db.close();
		}
	});

	it("forbids agent deletion, identity mutation, and generation rollback without blocking heartbeat/offline updates", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);
			db.prepare(
				`INSERT INTO agents(agent_id,kind,generation,last_poll_at,state)
				 VALUES ('lead-a','lead',2,NULL,'online')`,
			).run();

			expect(() =>
				db.prepare("DELETE FROM agents WHERE agent_id='lead-a'").run(),
			).toThrow();
			expect(() =>
				db
					.prepare(
						"UPDATE agents SET agent_id='lead-b' WHERE agent_id='lead-a'",
					)
					.run(),
			).toThrow();
			expect(() =>
				db
					.prepare("UPDATE agents SET kind='runner' WHERE agent_id='lead-a'")
					.run(),
			).toThrow();
			expect(() =>
				db
					.prepare("UPDATE agents SET generation=1 WHERE agent_id='lead-a'")
					.run(),
			).toThrow();
			expect(
				db
					.prepare(
						`UPDATE agents
						 SET last_poll_at='2026-07-28T00:00:05.000Z',state='offline'
						 WHERE agent_id='lead-a' AND generation=2`,
					)
					.run().changes,
			).toBe(1);
		} finally {
			db.close();
		}
	});
});
