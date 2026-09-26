import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

/** FLY-2886 plan v12 §14.2: a session's background may degrade, once, for good. */
const cleanup: string[] = [];
afterEach(() => {
	for (const root of cleanup.splice(0))
		rmSync(root, { recursive: true, force: true });
});

const sessionId = "10000000-0000-4000-8000-000000000001";
const now = "2026-09-26T08:00:00.000Z";
async function claimed(path: string) {
	const store = await StateStore.create(path);
	store.reserveVoiceSession({
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
	store.updateVoiceProvisioning({
		sessionId,
		expectedStep: "reserved",
		nextStep: "done",
		nextState: "desired",
		rootMessageId: "100000000000000011",
		updatedAt: now,
	});
	const claim = store.claimVoiceSession({
		sessionId,
		daemonBootId: "boot-a",
		now,
		leaseTtlMs: 60_000,
	})!;
	return { store, leaseToken: claim.leaseToken };
}
function dbPath() {
	const root = mkdtempSync(join(tmpdir(), "flywheel-voice-degraded-"));
	cleanup.push(root);
	return join(root, "teamlead.db");
}

describe("voice background degraded state", () => {
	it("migrates an existing voice_sessions table to configured", async () => {
		const path = dbPath();
		const { store } = await claimed(path);
		store.close();
		const legacy = new Database(path);
		for (const column of [
			"background_state",
			"background_degraded_reason",
			"background_degraded_at",
		])
			legacy.exec(`ALTER TABLE voice_sessions DROP COLUMN ${column}`);
		legacy.close();
		const reopened = await StateStore.create(path);
		expect(reopened.getVoiceSession(sessionId)).toMatchObject({
			backgroundState: "configured",
			backgroundDegradedReason: null,
			backgroundDegradedAt: null,
		});
		reopened.close();
	});

	it("records degraded once under the live lease and keeps the first reason", async () => {
		const { store, leaseToken } = await claimed(dbPath());
		const later = "2026-09-26T08:00:10.000Z";
		expect(
			store.markVoiceBackgroundDegraded({
				sessionId,
				leaseToken: "stale-lease",
				reason: "model_isolation_unproven",
				now: later,
			}),
		).toBe("lease_conflict");
		expect(store.getVoiceSession(sessionId)?.backgroundState).toBe(
			"configured",
		);
		expect(
			store.markVoiceBackgroundDegraded({
				sessionId,
				leaseToken,
				reason: "not_a_reason" as never,
				now: later,
			}),
		).toBe("invalid");
		expect(
			store.markVoiceBackgroundDegraded({
				sessionId,
				leaseToken,
				reason: "model_isolation_unproven",
				now: later,
			}),
		).toBe("recorded");
		expect(
			store.markVoiceBackgroundDegraded({
				sessionId,
				leaseToken,
				reason: "admission_timeout",
				now: "2026-09-26T08:00:20.000Z",
			}),
		).toBe("replayed");
		expect(store.getVoiceSession(sessionId)).toMatchObject({
			backgroundState: "degraded",
			backgroundDegradedReason: "model_isolation_unproven",
			backgroundDegradedAt: later,
		});
		// A degraded session takes no background context.
		expect(
			store.recordVoiceBackgroundEvent({
				sessionId,
				leaseToken,
				key: "attention:gate:1",
				text: "FLY-1 等 founder 处理 gate 1",
				deliveryClass: "tell",
				tokenCount: 10,
				observedAt: later,
				now: later,
			}),
		).toBe("degraded");
		store.close();
	});
});
