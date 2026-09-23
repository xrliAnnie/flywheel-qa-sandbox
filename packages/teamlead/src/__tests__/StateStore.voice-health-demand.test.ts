import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { voiceHealthDemandPayload } from "../bridge/voice-health-demand-recorder.js";
import { StateStore } from "../StateStore.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const T0 = "2026-09-18T08:00:00.000Z";

let root: string;
let path: string;
let store: StateStore;

function reserve(
	stateStore: StateStore,
	sessionId = SESSION_ID,
	meetingId = "meeting-a",
): void {
	stateStore.reserveVoiceSession({
		sessionId,
		mode: "meeting",
		projectName: "flywheel",
		leadId: "lead-a",
		guildId: "100000000000000001",
		voiceBotUserId: "100000000000000005",
		voiceChannelId: `room-${sessionId}`,
		meetingId,
		requestedBy: "master",
		credentialTier: "master",
		createdAt: T0,
	});
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "flywheel-voice-demand-"));
	path = join(root, "teamlead.db");
	store = await StateStore.create(path);
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true });
});

describe("StateStore voice-health demand projection", () => {
	it("installs one durable UUID source, AUTOINCREMENT events, and exactly three guarded triggers", async () => {
		const db = new Database(path, { readonly: true });
		const source = db
			.prepare(
				"SELECT source_id, trigger_digest FROM voice_health_demand_source",
			)
			.get() as { source_id: string; trigger_digest: string };
		const eventTable = db
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'voice_health_demand_events'",
			)
			.get() as { sql: string };
		const triggers = db
			.prepare(
				"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'voice_health_demand_sessions_%' ORDER BY name",
			)
			.all() as Array<{ name: string; sql: string }>;
		db.close();

		expect(source.source_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(source.trigger_digest).toMatch(/^[0-9a-f]{64}$/);
		expect(eventTable.sql).toContain("PRIMARY KEY AUTOINCREMENT");
		expect(triggers.map(({ name }) => name)).toEqual([
			"voice_health_demand_sessions_delete",
			"voice_health_demand_sessions_insert",
			"voice_health_demand_sessions_update",
		]);
		const update = triggers.find(({ name }) => name.endsWith("_update"))!.sql;
		expect(update).toMatch(
			/AFTER UPDATE OF state, reason, cancel_requested_at, ending_started_at, ended_at ON voice_sessions/,
		);
		for (const field of [
			"state",
			"reason",
			"cancel_requested_at",
			"ending_started_at",
			"ended_at",
		]) {
			expect(update).toContain(`OLD.${field} IS NOT NEW.${field}`);
		}

		const sourceId = store.getVoiceDemandSnapshot(0).demandSourceId;
		store.close();
		store = await StateStore.create(path);
		expect(store.getVoiceDemandSnapshot(0).demandSourceId).toBe(sourceId);
	});

	it("rotates the demand source and reinstalls triggers when the contract digest changes", async () => {
		const originalSource = store.getVoiceDemandSnapshot(0).demandSourceId;
		store.close();
		const db = new Database(path);
		const triggers = db
			.prepare(
				"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'voice_health_demand_sessions_%' ORDER BY name",
			)
			.all() as Array<{ name: string; sql: string }>;
		for (const trigger of triggers) {
			db.exec(`DROP TRIGGER ${trigger.name}`);
			db.exec(
				trigger.sql.replace(
					/\s+WHEN (?:NEW|OLD)\.reason IN \('no_human', 'daemon_shutdown'\) THEN NULL/,
					"",
				),
			);
		}
		db.prepare(
			"UPDATE voice_health_demand_source SET trigger_digest = ? WHERE singleton = 1",
		).run("bc7da93194749ebf189112778862d7f0515e839d3ae702ee1acfbacc4eaa8cf7");
		db.close();

		store = await StateStore.create(path);
		const rebased = store.getVoiceDemandSnapshot(0);
		expect(rebased.demandSourceId).not.toBe(originalSource);
		expect(rebased).toMatchObject({
			eventHighWater: 0,
			events: [],
			sourceStatus: "available",
		});
		const verified = new Database(path, { readonly: true });
		const source = verified
			.prepare(
				"SELECT trigger_digest FROM voice_health_demand_source WHERE singleton = 1",
			)
			.get() as { trigger_digest: string };
		const triggerCount = verified
			.prepare(
				"SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'voice_health_demand_sessions_%'",
			)
			.get() as { count: number };
		verified.close();
		expect(source.trigger_digest).toMatch(/^[0-9a-f]{64}$/);
		expect(source.trigger_digest).not.toBe(
			"bc7da93194749ebf189112778862d7f0515e839d3ae702ee1acfbacc4eaa8cf7",
		);
		expect(triggerCount.count).toBe(3);
	});

	it("captures direct SQL writers and rollback while unrelated writes change neither sequence nor digest", () => {
		reserve(store);
		const initial = store.getVoiceDemandSnapshot(0);
		expect(initial.events).toMatchObject([
			{
				eventSeq: 1,
				mutation: "insert",
				eventKind: "required",
				previousState: null,
				state: "provisioning",
			},
		]);
		const db = new Database(path);
		// Name the columns instead of copying positionally: a positional SELECT
		// silently breaks whenever either issue adds a column, which is exactly
		// how this line conflicted at the FLY-2655 merge.
		db.prepare(
			`INSERT INTO voice_sessions
			 (session_id, voice_channel_id, meeting_id, mode, project_name, lead_id,
			  guild_id, voice_bot_user_id, provisioning_step, state, reason,
			  requested_by, credential_tier, created_at, updated_at)
			 SELECT ?, ?, ?, mode, project_name, lead_id, guild_id, voice_bot_user_id,
			 provisioning_step, state, reason, requested_by, credential_tier,
			 created_at, updated_at
			 FROM voice_sessions WHERE session_id = ?`,
		).run(
			"10000000-0000-4000-8000-000000000002",
			"room-two",
			"meeting-b",
			SESSION_ID,
		);
		const inserted = store.getVoiceDemandSnapshot(initial.nextCursor);
		expect(inserted.events).toMatchObject([
			{ mutation: "insert", eventKind: "required", demandId: "meeting-b" },
		]);

		const beforeNoise = store.getVoiceDemandSnapshot(inserted.nextCursor);
		db.prepare(
			"UPDATE voice_sessions SET root_message_id = ? WHERE session_id = ?",
		).run("100000000000000099", SESSION_ID);
		db.prepare(
			"UPDATE voice_sessions SET cancel_requested_at = NULL WHERE session_id = ?",
		).run(SESSION_ID);
		const afterNoise = store.getVoiceDemandSnapshot(inserted.nextCursor);
		expect(afterNoise.eventHighWater).toBe(beforeNoise.eventHighWater);
		expect(afterNoise.digest).toBe(beforeNoise.digest);

		db.exec("BEGIN IMMEDIATE");
		db.prepare(
			"UPDATE voice_sessions SET state = 'failed', reason = 'lease_lost', ended_at = ? WHERE session_id = ?",
		).run("2026-09-18T08:01:00.000Z", SESSION_ID);
		db.exec("ROLLBACK");
		expect(store.getVoiceDemandSnapshot(inserted.nextCursor).events).toEqual(
			[],
		);

		db.prepare(
			"UPDATE voice_sessions SET cancel_requested_at = ? WHERE session_id = ?",
		).run("2026-09-18T08:02:00.000Z", SESSION_ID);
		db.prepare(
			"UPDATE voice_sessions SET state = 'ended', reason = NULL, ended_at = ?, updated_at = ? WHERE session_id = ?",
		).run("2026-09-18T08:03:00.000Z", "2026-09-18T08:03:00.000Z", SESSION_ID);
		db.prepare("DELETE FROM voice_sessions WHERE session_id = ?").run(
			"10000000-0000-4000-8000-000000000002",
		);
		const changed = store.getVoiceDemandSnapshot(inserted.nextCursor);
		expect(changed.events).toMatchObject([
			{ mutation: "update", eventKind: "required" },
			{ mutation: "update", eventKind: "normal_completed", state: "ended" },
			{ mutation: "delete", eventKind: "cancelled", demandId: "meeting-b" },
		]);
		db.close();
	});

	it("preserves a fleeting required to failed transition even when the current set is empty", () => {
		reserve(store);
		const db = new Database(path);
		db.prepare(
			"UPDATE voice_sessions SET state = 'failed', reason = 'lease_lost', ended_at = ?, updated_at = ? WHERE session_id = ?",
		).run("2026-09-18T08:01:00.000Z", "2026-09-18T08:01:00.000Z", SESSION_ID);
		db.close();

		const snapshot = store.getVoiceDemandSnapshot(0);
		expect(snapshot.state).toBe("none");
		expect(snapshot.demandIdentities).toEqual([]);
		expect(snapshot.events).toMatchObject([
			{ eventSeq: 1, eventKind: "required", state: "provisioning" },
			{
				eventSeq: 2,
				eventKind: "failed",
				previousState: "provisioning",
				state: "failed",
				reasonClass: "lease_lost",
			},
		]);
	});

	it.each(["no_human", "daemon_shutdown"])(
		"treats %s as a non-alerting terminal demand event",
		(reason) => {
			reserve(store);
			const db = new Database(path);
			db.prepare(
				"UPDATE voice_sessions SET state = 'failed', reason = ?, ended_at = ?, updated_at = ? WHERE session_id = ?",
			).run(
				reason,
				"2026-09-18T08:01:00.000Z",
				"2026-09-18T08:01:00.000Z",
				SESSION_ID,
			);
			db.close();

			const snapshot = store.getVoiceDemandSnapshot(0);
			expect(snapshot.events).toMatchObject([
				{ eventSeq: 1, eventKind: "required" },
				{
					eventSeq: 2,
					eventKind: "cancelled",
					state: "failed",
				},
			]);
			expect(snapshot.events[1]?.reasonClass).toBeUndefined();
			const helperPath = fileURLToPath(
				new URL("../../../../scripts/lib/voice-health.py", import.meta.url),
			);
			const runHelper = (command: string, payload: unknown) =>
				JSON.parse(
					execFileSync(
						"python3",
						[helperPath, "--state-root", join(root, "health"), command],
						{ input: JSON.stringify(payload), encoding: "utf8" },
					),
				);
			runHelper("record-demand", voiceHealthDemandPayload(snapshot, false));
			const exported = runHelper("export", { afterCursor: 0 });
			expect(exported.openEpisodes).toEqual([]);
			expect(exported.notifications).toEqual([]);
			expect(exported.currentProjection.failureCount).toBe(0);
		},
	);

	it("pages at 200 without exposing current authority until the final contiguous page", () => {
		reserve(store);
		const db = new Database(path);
		const update = db.prepare(
			"UPDATE voice_sessions SET reason = ?, updated_at = ? WHERE session_id = ?",
		);
		const write = db.transaction(() => {
			for (let i = 0; i < 201; i++) {
				update.run(
					i % 2 === 0 ? "diagnostic-a" : "diagnostic-b",
					`2026-09-18T08:${String(i % 60).padStart(2, "0")}:00.000Z`,
					SESSION_ID,
				);
			}
		});
		write();
		db.close();

		const first = store.getVoiceDemandSnapshot(0);
		expect(first.events).toHaveLength(200);
		expect(first.hasMore).toBe(true);
		expect(first.nextCursor).toBe(first.events.at(-1)!.eventSeq);
		expect(first.nextCursor).toBeLessThan(first.eventHighWater);
		expect(first).toMatchObject({
			state: "unknown",
			demandIdentities: [],
			gap: false,
		});

		const final = store.getVoiceDemandSnapshot(first.nextCursor);
		expect(final.events).toHaveLength(2);
		expect(final.hasMore).toBe(false);
		expect(final.nextCursor).toBe(final.eventHighWater);
		expect(final.state).toBe("required");
		expect(final.demandIdentities).toMatchObject([
			{ demandId: "meeting-a", attemptId: SESSION_ID, projectId: "flywheel" },
		]);
	});

	it("fails closed on a missing event range or tampered trigger", async () => {
		reserve(store);
		const originalSource = store.getVoiceDemandSnapshot(0).demandSourceId;
		const db = new Database(path);
		db.prepare(
			"UPDATE voice_sessions SET reason = 'diagnostic-a' WHERE session_id = ?",
		).run(SESSION_ID);
		db.prepare(
			"UPDATE voice_sessions SET reason = 'diagnostic-b' WHERE session_id = ?",
		).run(SESSION_ID);
		db.prepare(
			"DELETE FROM voice_health_demand_events WHERE event_seq = 2",
		).run();
		const gap = store.getVoiceDemandSnapshot(1);
		expect(gap).toMatchObject({
			state: "unknown",
			demandIdentities: [],
			gap: true,
			sourceStatus: "change_gap",
		});
		expect(gap.events).toEqual([]);

		db.exec("DROP TRIGGER voice_health_demand_sessions_update");
		db.prepare(
			"UPDATE voice_sessions SET state = 'failed', reason = 'lease_lost' WHERE session_id = ?",
		).run(SESSION_ID);
		db.exec(`
			CREATE TRIGGER voice_health_demand_sessions_update
			AFTER UPDATE OF state, reason, cancel_requested_at, ending_started_at, ended_at
			ON voice_sessions BEGIN SELECT 1; END
		`);
		db.close();
		store.close();
		store = await StateStore.create(path);
		const tampered = store.getVoiceDemandSnapshot(3);
		expect(tampered).toMatchObject({
			state: "unknown",
			demandIdentities: [],
			sourceStatus: "trigger_invalid",
		});
		expect(tampered.demandSourceId).toBe(originalSource);
	});

	it("baselines a legacy current set without replaying historical terminal sessions", async () => {
		reserve(store);
		const priorSourceId = store.getVoiceDemandSnapshot(0).demandSourceId;
		const db = new Database(path);
		db.exec(`
			DROP TRIGGER voice_health_demand_sessions_insert;
			DROP TRIGGER voice_health_demand_sessions_delete;
			DROP TRIGGER voice_health_demand_sessions_update;
			DROP TABLE voice_health_demand_events;
			DROP TABLE voice_health_demand_source;
		`);
		db.prepare(
			// Named columns, not positional: git happily merged two sides' column
			// additions here into an order the table does not actually have.
			`INSERT INTO voice_sessions
			 (session_id, voice_channel_id, meeting_id, mode, project_name, lead_id,
			  guild_id, voice_bot_user_id, provisioning_step, state, reason,
			  requested_by, credential_tier, created_at, updated_at, ended_at)
			 SELECT ?, ?, ?, mode, project_name, lead_id, guild_id, voice_bot_user_id,
			 provisioning_step, 'failed', 'lease_lost', requested_by, credential_tier,
			 created_at, updated_at, updated_at
			 FROM voice_sessions WHERE session_id = ?`,
		).run(
			"10000000-0000-4000-8000-000000000099",
			"room-old-failed",
			"meeting-old-failed",
			SESSION_ID,
		);
		db.close();
		store.close();
		store = await StateStore.create(path);

		const baseline = store.getVoiceDemandSnapshot(0);
		expect(baseline).toMatchObject({
			events: [],
			eventHighWater: 0,
			state: "required",
			sourceStatus: "available",
		});
		expect(baseline.demandIdentities).toHaveLength(1);
		expect(baseline.demandIdentities[0]?.demandId).toBe("meeting-a");
		expect(baseline.demandSourceId).not.toBe(priorSourceId);
	});
});
