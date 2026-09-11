import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("StateStore attention Discord config", () => {
	const stores: StateStore[] = [];
	const directories: string[] = [];
	afterEach(() => {
		for (const store of stores.splice(0)) store.close();
		for (const directory of directories.splice(0))
			rmSync(directory, { recursive: true, force: true });
	});

	it("persists one normalized configuration with its source clock", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		expect(store.readDiscordConfig()).toBeNull();
		store.syncDiscordConfig(
			" 18446744073709551615 ",
			"2026-09-09T10:00:00.000Z",
		);
		expect(store.readDiscordConfig()).toEqual({
			singleton_key: "discord",
			guild_id: "18446744073709551615",
			state: "configured",
			source: "DISCORD_GUILD_ID",
			source_updated_at: "2026-09-09T10:00:00.000Z",
		});
	});

	it.each([undefined, null, "", "  "])(
		"clears a previous guild for missing input %j",
		async (input) => {
			const store = await StateStore.create(":memory:");
			stores.push(store);
			store.syncDiscordConfig("123", "2026-09-09T10:00:00.000Z");
			store.syncDiscordConfig(input, "2026-09-09T11:00:00.000Z");
			expect(store.readDiscordConfig()).toMatchObject({
				guild_id: null,
				state: "missing",
				source_updated_at: "2026-09-09T11:00:00.000Z",
			});
		},
	);

	it.each([
		"0",
		"01",
		"-1",
		"+1",
		"1.2",
		"1e3",
		"18446744073709551616",
		"123456789012345678901",
		"@me",
		"1'; DROP TABLE sessions;--",
		123,
		{},
	])("clears a previous guild for invalid input %j", async (input) => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.syncDiscordConfig("123", "2026-09-09T10:00:00.000Z");
		store.syncDiscordConfig(input, "2026-09-09T11:00:00.000Z");
		expect(store.readDiscordConfig()).toMatchObject({
			guild_id: null,
			state: "invalid",
			source_updated_at: "2026-09-09T11:00:00.000Z",
		});
	});

	it("retains the source clock on identical value/state and changes it on recovery", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		for (const [first, repeat] of [
			["123", " 123 "],
			[null, ""],
			["bad", "worse"],
		]) {
			store.syncDiscordConfig(first, "2026-09-09T10:00:00.000Z");
			store.syncDiscordConfig(repeat, "2026-09-09T11:00:00.000Z");
			expect(store.readDiscordConfig()?.source_updated_at).toBe(
				"2026-09-09T10:00:00.000Z",
			);
		}
		store.syncDiscordConfig("1", "2026-09-09T12:00:00.000Z");
		expect(store.readDiscordConfig()).toMatchObject({
			guild_id: "1",
			state: "configured",
			source_updated_at: "2026-09-09T12:00:00.000Z",
		});
	});

	it("adds only a table, survives reopen and repeated migration, and enforces singleton constraints", async () => {
		const directory = mkdtempSync(join(tmpdir(), "fly2483-discord-"));
		directories.push(directory);
		const path = join(directory, "state.db");
		const legacy = new BetterSqlite3(path);
		legacy.exec(
			"CREATE TABLE legacy_marker(value TEXT); INSERT INTO legacy_marker VALUES ('retained')",
		);
		legacy.close();
		const first = await StateStore.create(path);
		first.syncDiscordConfig("123", "2026-09-09T10:00:00.000Z");
		first.close();
		const reopened = await StateStore.create(path);
		stores.push(reopened);
		const secondWriter = await StateStore.create(path);
		stores.push(secondWriter);
		secondWriter.syncDiscordConfig("123", "2026-09-09T11:00:00.000Z");
		expect(reopened.readDiscordConfig()?.source_updated_at).toBe(
			"2026-09-09T10:00:00.000Z",
		);
		reopened.migrate();
		expect(reopened.readDiscordConfig()?.guild_id).toBe("123");
		const peer = new BetterSqlite3(path);
		try {
			peer.exec(
				"CREATE TRIGGER reject_discord_update BEFORE UPDATE ON discord_config BEGIN SELECT RAISE(ABORT, 'write rejected'); END;",
			);
			expect(() => reopened.syncDiscordConfig("456")).toThrow("write rejected");
			expect(secondWriter.readDiscordConfig()?.guild_id).toBe("123");
			peer.exec("DROP TRIGGER reject_discord_update");
			expect(peer.prepare("SELECT value FROM legacy_marker").get()).toEqual({
				value: "retained",
			});
			expect(
				peer.prepare("SELECT count(*) AS n FROM discord_config").get(),
			).toEqual({ n: 1 });
			for (const [key, guild, state, source] of [
				["other", "123", "configured", "DISCORD_GUILD_ID"],
				["discord", null, "configured", "DISCORD_GUILD_ID"],
				["discord", "123", "missing", "DISCORD_GUILD_ID"],
				["discord", null, "invalid", "other"],
			]) {
				expect(() =>
					peer
						.prepare(
							"INSERT OR REPLACE INTO discord_config VALUES (?, ?, ?, ?, ?)",
						)
						.run(key, guild, state, source, "now"),
				).toThrow();
			}
		} finally {
			peer.close();
		}
	});
});
