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
		expect(names).toEqual(["voice_outbound", "voice_sessions"]);
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
			voiceChannelId: "room",
			requestedBy: "master",
			credentialTier: "master",
			createdAt,
		});
		original.close();
		const legacy = new Database(path);
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
