import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
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
			"voice_handoffs",
			"voice_health_demand_events",
			"voice_health_demand_source",
			"voice_health_projection",
			"voice_health_projection_cursor",
			"voice_intents",
			"voice_launch_attempts",
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
				"brief_keys_json",
				"live_context_mode",
				"live_context_fused_at",
				"live_context_fuse_reason",
				"context_ring_json",
				"context_ring_revision",
				"context_prompt_generation",
			]),
		);
		const outboundColumns = db
			.prepare("PRAGMA table_info(voice_outbound)")
			.all()
			.map((row) => (row as { name: string }).name);
		expect(outboundColumns).toEqual(
			expect.arrayContaining(["delivery_class", "source", "terminal_reason"]),
		);
		db.close();
	});

	it("adds default-off context columns while preserving legacy outbound as tell/discord", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "flywheel-voice-context-migration-"),
		);
		cleanup.push(root);
		const path = join(root, "teamlead.db");
		const original = await StateStore.create(path);
		const sessionId = "10000000-0000-4000-8000-000000000001";
		const now = "2026-09-08T20:00:00.000Z";
		original.reserveVoiceSession({
			sessionId,
			mode: "meeting",
			projectName: "flywheel",
			leadId: "lead-a",
			guildId: "100000000000000001",
			voiceBotUserId: "100000000000000005",
			voiceChannelId: "100000000000000002",
			requestedBy: "master",
			credentialTier: "master",
			createdAt: now,
		});
		original.updateVoiceProvisioning({
			sessionId,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			rootMessageId: "100000000000000011",
			updatedAt: now,
		});
		const claim = original.claimVoiceSession({
			sessionId,
			daemonBootId: "boot-a",
			now,
			leaseTtlMs: 60_000,
		})!;
		original.recordVoiceOutboundPage({
			sessionId,
			leaseToken: claim.leaseToken,
			channelId: "100000000000000003",
			cursor: "100000000000000012",
			messages: [
				{
					messageId: "100000000000000012",
					authorId: "100000000000000005",
					text: "legacy reply",
					observedAt: now,
				},
			],
			now,
		});
		original.close();

		const legacy = new Database(path);
		for (const column of [
			"brief_keys_json",
			"live_context_mode",
			"live_context_fused_at",
			"live_context_fuse_reason",
			"context_ring_json",
			"context_ring_revision",
			"context_prompt_generation",
		]) {
			legacy.exec(`ALTER TABLE voice_sessions DROP COLUMN ${column}`);
		}
		legacy.exec("ALTER TABLE voice_outbound DROP COLUMN delivery_class");
		legacy.exec("ALTER TABLE voice_outbound DROP COLUMN source");
		legacy.exec("ALTER TABLE voice_outbound DROP COLUMN terminal_reason");
		legacy.close();

		const reopened = await StateStore.create(path);
		expect(reopened.getVoiceSession(sessionId)).toMatchObject({
			briefKeys: [],
			liveContextMode: "disabled",
			liveContextFusedAt: null,
			liveContextFuseReason: null,
			contextRing: [],
			contextRingRevision: 0,
			contextPromptGeneration: null,
		});
		expect(
			reopened.listVoiceOutbound(sessionId, claim.leaseToken, now),
		).toMatchObject([
			{
				text: "legacy reply",
				deliveryClass: "tell",
				source: "discord",
				terminalReason: null,
			},
		]);
		reopened.close();
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
