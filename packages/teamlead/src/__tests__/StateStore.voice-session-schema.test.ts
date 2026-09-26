import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { VoiceHandoffStore } from "../bridge/voice-handoff-store.js";
import { StateStore } from "../StateStore.js";

const cleanup: string[] = [];

afterEach(() => {
	for (const root of cleanup.splice(0)) rmSync(root, { recursive: true });
});

describe("StateStore voice session schema", () => {
	it("installs both retained voice tables and active uniqueness guards", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-voice-schema-"));
		cleanup.push(root);
		const path = join(root, "teamlead.db");
		const store = await StateStore.create(path);
		store.close();
		const db = new Database(path, { readonly: true });
		const names = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'voice_%' ORDER BY name",
			)
			.all()
			.map((row) => (row as { name: string }).name);
		expect(names).toEqual([
			"voice_agenda_dispositions",
			"voice_agenda_episodes",
			"voice_agenda_items",
			"voice_agenda_meta",
			"voice_agenda_state",
			"voice_agenda_turns",
			"voice_agenda_urgent",
			"voice_handoffs",
			"voice_headphone_ack",
			"voice_headphone_claim",
			"voice_headphone_delivery",
			"voice_headphone_inbox",
			"voice_headphone_source",
			"voice_health_demand_events",
			"voice_health_demand_source",
			"voice_health_projection",
			"voice_health_projection_cursor",
			"voice_intents",
			"voice_launch_attempts",
			"voice_lead_handoff_results",
			"voice_lead_handoffs",
			"voice_outbound",
			"voice_schedule_requests",
			"voice_schedules",
			"voice_sessions",
			"voice_utterances",
		]);
		const indexes = db
			.prepare(
				"SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='voice_sessions' AND sql IS NOT NULL ORDER BY name",
			)
			.all() as Array<{ name: string; sql: string }>;
		expect(indexes.map(({ name }) => name)).toEqual([
			"voice_sessions_active_meeting",
			"voice_sessions_active_room",
		]);
		expect(indexes.every(({ sql }) => sql.includes("state NOT IN"))).toBe(true);
		const columns = db
			.prepare("PRAGMA table_info(voice_sessions)")
			.all()
			.map((row) => (row as { name: string }).name);
		expect(columns).toEqual(
			expect.arrayContaining([
				"receive_health",
				"receive_health_observed_at",
				"receive_health_boot_id",
				"receive_card_digest",
				"session_generation",
			]),
		);
		db.close();
	});

	it("adds a nullable topic to an existing voice_sessions table", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-voice-topic-migration-"));
		cleanup.push(root);
		const path = join(root, "teamlead.db");
		const original = await StateStore.create(path);
		original.reserveVoiceSession({
			sessionId: "10000000-0000-4000-8000-000000000001",
			mode: "meeting",
			projectName: "flywheel",
			leadId: "lead-a",
			guildId: "100000000000000001",
			voiceBotUserId: "100000000000000005",
			voiceChannelId: "100000000000000002",
			requestedBy: "master",
			credentialTier: "master",
			createdAt: "2026-09-08T20:00:00.000Z",
		});
		original.close();
		const legacy = new Database(path);
		const columns = legacy.pragma("table_info(voice_sessions)") as Array<{
			name: string;
		}>;
		if (columns.some(({ name }) => name === "topic")) {
			legacy.exec("ALTER TABLE voice_sessions DROP COLUMN topic");
		}
		legacy.close();

		const reopened = await StateStore.create(path);
		expect(
			reopened.getVoiceSession("10000000-0000-4000-8000-000000000001"),
		).toMatchObject({ topic: null });
		reopened.close();
	});

	it("FLY-2863: keeps the Lead handoff tables apart from FLY-2799 voice_handoffs in either creation order", async () => {
		const columns = (db: Database.Database, table: string) =>
			(
				db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
					name: string;
				}>
			).map(({ name }) => name);
		const assertApart = (path: string) => {
			const db = new Database(path, { readonly: true });
			try {
				const engineB = columns(db, "voice_handoffs");
				expect(engineB).toEqual(
					expect.arrayContaining([
						"lead_id",
						"intent_kind",
						"transcript_receipt_id",
					]),
				);
				expect(engineB).not.toContain("target_lead_id");
				expect(engineB).not.toContain("request_kind");
				expect(columns(db, "voice_lead_handoffs")).toEqual(
					expect.arrayContaining([
						"target_lead_id",
						"request_kind",
						"agenda_json",
					]),
				);
				expect(
					db
						.prepare("PRAGMA foreign_key_list(voice_lead_handoff_results)")
						.all(),
				).toEqual([expect.objectContaining({ table: "voice_lead_handoffs" })]);
			} finally {
				db.close();
			}
		};

		// Production order: the Bridge store first, the Lead handoff store on first use.
		const first = mkdtempSync(join(tmpdir(), "flywheel-voice-schema-"));
		cleanup.push(first);
		const firstPath = join(first, "teamlead.db");
		const store = await StateStore.create(firstPath);
		expect(store.voiceHandoffs).toBeInstanceOf(VoiceHandoffStore);
		store.close();
		assertApart(firstPath);

		// Reverse order: a database the Lead handoff store touched first.
		const second = mkdtempSync(join(tmpdir(), "flywheel-voice-schema-"));
		cleanup.push(second);
		const secondPath = join(second, "teamlead.db");
		const bare = new Database(secondPath);
		new VoiceHandoffStore(bare).migrate();
		bare.close();
		const reopened = await StateStore.create(secondPath);
		expect(reopened.voiceHandoffs).toBeInstanceOf(VoiceHandoffStore);
		reopened.close();
		assertApart(secondPath);
	});

	it("upgrades the retained voice_handoffs intent guard", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "flywheel-voice-handoff-migration-"),
		);
		cleanup.push(root);
		const path = join(root, "teamlead.db");
		const original = await StateStore.create(path);
		original.close();

		const legacy = new Database(path);
		const row = legacy
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type='table' AND name='voice_handoffs'",
			)
			.get() as { sql: string };
		legacy.exec("DROP INDEX voice_handoffs_reconcile");
		legacy.exec("ALTER TABLE voice_handoffs RENAME TO voice_handoffs_current");
		legacy.exec(row.sql.replace(",'delegate_request'", ""));
		legacy.exec("DROP TABLE voice_handoffs_current");
		legacy.close();

		const reopened = await StateStore.create(path);
		reopened.close();
		const migrated = new Database(path, { readonly: true });
		const schema = migrated
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type='table' AND name='voice_handoffs'",
			)
			.get() as { sql: string };
		expect(schema.sql).toContain("'delegate_request'");
		expect(
			migrated
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='index' AND name='voice_handoffs_reconcile'",
				)
				.get(),
		).toBeTruthy();
		migrated.close();
	});
});

it.each(["root_requested", "ending"])(
	"adds frozen timestamps to legacy %s rows without rejuvenating them",
	async (phase) => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-voice-clock-migration-"));
		cleanup.push(root);
		const path = join(root, "teamlead.db");
		const original = await StateStore.create(path);
		const createdAt = "2026-09-08T20:00:00.000Z";
		original.reserveVoiceSession({
			sessionId: "session",
			mode: "meeting",
			projectName: "flywheel",
			leadId: "lead",
			guildId: "guild",
			voiceBotUserId: "100000000000000005",
			voiceChannelId: "room",
			requestedBy: "master",
			credentialTier: "master",
			createdAt,
		});
		original.close();
		const legacy = new Database(path);
		// Reconstruct the pre-FLY-2693 schema before removing legacy columns;
		// SQLite correctly refuses to orphan a trigger that references them.
		legacy.exec(`
			DROP TRIGGER voice_health_demand_sessions_insert;
			DROP TRIGGER voice_health_demand_sessions_delete;
			DROP TRIGGER voice_health_demand_sessions_update;
			DROP TABLE voice_health_demand_events;
			DROP TABLE voice_health_demand_source;
		`);
		legacy.exec("ALTER TABLE voice_sessions DROP COLUMN ending_started_at");
		legacy.exec("ALTER TABLE voice_sessions DROP COLUMN root_requested_at");
		legacy
			.prepare(
				"UPDATE voice_sessions SET state = ?, provisioning_step = ?, updated_at = ?",
			)
			.run(
				phase === "ending" ? "ending" : "provisioning",
				phase === "ending" ? "done" : phase,
				"2026-09-08T20:10:00.000Z",
			);
		legacy.close();
		const reopened = await StateStore.create(path);
		const row = reopened.getVoiceSession("session")!;
		expect(phase === "ending" ? row.endingStartedAt : row.rootRequestedAt).toBe(
			createdAt,
		);
		reopened.close();
	},
);
