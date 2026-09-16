import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionJournal } from "../journal.js";
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
				sessionId: "11111111-1111-4111-8111-111111111111",
				voiceBotUserId: "323456789012345678",
				mode: "meeting",
				projectName: "raya",
				leadId: "raya",
				displayName: "Raya",
				realtimeVoice: "marin",
				guildId: "123456789012345678",
				voiceChannelId: "223456789012345678",
				threadId: "423456789012345678",
				boundChannelIds: ["423456789012345678"],
				founderUserId: "523456789012345678",
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

	it.each([
		"not-json",
		"null",
		JSON.stringify({ sessionId: "wrong", leaseToken: "lease", projection: {} }),
	])(
		"quarantines malformed authority without losing its evidence: %s",
		(raw) => {
			const root = mkdtempSync(join(tmpdir(), "flywheel-voice-state-"));
			roots.push(root);
			const id = "11111111-1111-4111-8111-111111111111";
			const directory = join(root, "sessions", id);
			mkdirSync(directory, { recursive: true });
			const store = new SessionStateStore(root);
			writeFileSync(store.path(id), raw, { mode: 0o600 });
			const journal = new SessionJournal(join(directory, "journal.jsonl"));
			journal.append({
				kind: "captured",
				transcriptId: "one",
				safeText: "retain me",
			});
			expect(store.list()).toEqual([]);
			expect(store.list()).toEqual([]);
			expect(journal.pending()).toEqual([]);
			const quarantined = readdirSync(directory).find((name) =>
				name.startsWith("session.quarantined-"),
			);
			expect(quarantined).toBeTruthy();
			expect(readFileSync(join(directory, quarantined!), "utf8")).toBe(raw);
			expect(journal.records()[0]?.safeText).toBe("retain me");
		},
	);
	it("refuses a new save without a valid pinned projection", () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-voice-state-"));
		roots.push(root);
		const store = new SessionStateStore(root);
		expect(() =>
			store.save({
				sessionId: "11111111-1111-4111-8111-111111111111",
				leaseToken: "lease",
				projection: {} as never,
			}),
		).toThrow("voice_projection_invalid");
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
