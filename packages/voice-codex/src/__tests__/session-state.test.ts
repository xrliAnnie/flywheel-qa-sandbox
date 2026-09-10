import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStateStore } from "../session-state.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("SessionStateStore", () => {
	it("persists only the recovery authority needed after a daemon restart", () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-voice-state-"));
		roots.push(root);
		const store = new SessionStateStore(root);
		store.save({
			sessionId: "11111111-1111-4111-8111-111111111111",
			leaseToken: "lease-a",
			projection: {
				mode: "meeting",
				projectName: "raya",
				leadId: "raya",
				displayName: "Raya",
				realtimeVoice: "marin",
				guildId: "guild",
				voiceChannelId: "voice",
				threadId: "thread",
				boundChannelIds: ["thread"],
				founderUserId: "founder",
				qaAllowUserIds: [],
			},
		});
		expect(store.list()).toHaveLength(1);
		expect(store.list()[0]?.leaseToken).toBe("lease-a");
		expect(
			statSync(store.path("11111111-1111-4111-8111-111111111111")).mode & 0o777,
		).toBe(0o600);
		store.remove("11111111-1111-4111-8111-111111111111");
		expect(store.list()).toEqual([]);
	});

	it("atomically records the current daemon boot id in a private file", () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-voice-state-"));
		roots.push(root);
		const store = new SessionStateStore(root);
		store.saveBoot("22222222-2222-4222-8222-222222222222");
		const path = join(root, "daemon.json");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			bootId: "22222222-2222-4222-8222-222222222222",
		});
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});
});
