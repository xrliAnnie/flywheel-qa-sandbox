import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const now = "2026-09-16T01:00:00.000Z";
const reservation = {
	sessionId: "identity-session",
	mode: "meeting" as const,
	projectName: "flywheel",
	leadId: "lead",
	guildId: "1485787271192907816",
	voiceChannelId: "1485787273193853170",
	voiceBotUserId: "100000000000000005",
	requestedBy: "master",
	credentialTier: "master" as const,
	createdAt: now,
};
let root: string;
let path: string;
let store: StateStore;
beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "voice-identity-"));
	path = join(root, "fixture.db");
	store = await StateStore.create(path);
});
afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

it("pins bot identity through a database restart", async () => {
	store.reserveVoiceSession(reservation);
	store.close();
	store = await StateStore.create(path);
	expect(store.getVoiceSession(reservation.sessionId)).toMatchObject({
		voiceBotUserId: reservation.voiceBotUserId,
	});
});

it.each([undefined, null, "", "bot", 123])(
	"rejects an unpinned new reservation: %s",
	(voiceBotUserId) => {
		expect(() =>
			store.reserveVoiceSession({ ...reservation, voiceBotUserId } as never),
		).toThrow(/voice_bot_identity_required/);
		expect(store.listVoiceSessions(["provisioning"])).toEqual([]);
	},
);

it("does not reuse a meeting intent with a different pinned identity", () => {
	store.reserveVoiceSession({ ...reservation, meetingId: "meeting" });
	expect(
		store.reserveVoiceSession({
			...reservation,
			meetingId: "meeting",
			voiceBotUserId: "100000000000000006",
		}),
	).toEqual({ status: "meeting_intent_conflict" });
	expect(store.getVoiceSession(reservation.sessionId)?.voiceBotUserId).toBe(
		reservation.voiceBotUserId,
	);
});

it.each(["ended", "live"])(
	"migrates legacy %s without inventing identity, idempotently",
	async (state) => {
		store.reserveVoiceSession(reservation);
		store.close();
		const db = new Database(path);
		db.prepare("UPDATE voice_sessions SET state = ?").run(state);
		const columns = db.pragma("table_info(voice_sessions)") as Array<{
			name: string;
		}>;
		if (columns.some(({ name }) => name === "voice_bot_user_id"))
			db.exec("ALTER TABLE voice_sessions DROP COLUMN voice_bot_user_id");
		db.close();
		for (let round = 0; round < 2; round++) {
			store = await StateStore.create(path);
			expect(store.getVoiceSession(reservation.sessionId)).toMatchObject({
				voiceBotUserId: null,
				state,
			});
			if (round === 0) store.close();
		}
	},
);

it("fails active identity atomically, settling queued and in-flight output without rewriting evidence", () => {
	store.reserveVoiceSession(reservation);
	store.updateVoiceProvisioning({
		sessionId: reservation.sessionId,
		expectedStep: "reserved",
		nextStep: "done",
		nextState: "desired",
		updatedAt: now,
	});
	const claimed = store.claimVoiceSession({
		sessionId: reservation.sessionId,
		daemonBootId: "boot",
		now,
		leaseTtlMs: 15000,
	})!;
	store.recordVoiceOutboundPage({
		sessionId: reservation.sessionId,
		leaseToken: claimed.leaseToken,
		channelId: "channel",
		cursor: "2",
		now,
		messages: [
			{
				messageId: "1",
				authorId: reservation.voiceBotUserId,
				text: "first",
				observedAt: now,
			},
			{
				messageId: "2",
				authorId: reservation.voiceBotUserId,
				text: "second",
				observedAt: now,
			},
		],
	});
	const [first] = store.listVoiceOutbound(
		reservation.sessionId,
		claimed.leaseToken,
		now,
	);
	store.claimVoiceOutbound({
		sessionId: reservation.sessionId,
		seq: first.seq,
		leaseToken: claimed.leaseToken,
		now,
	});
	expect(
		store.failVoiceSessionAdmission(
			reservation.sessionId,
			"voice_session_registry_drift",
			now,
		),
	).toBe(true);
	expect(store.getVoiceSession(reservation.sessionId)).toMatchObject({
		state: "failed",
		reason: "voice_session_registry_drift",
		voiceBotUserId: reservation.voiceBotUserId,
		leaseToken: claimed.leaseToken,
	});
	const db = new Database(path, { readonly: true });
	expect(
		db.prepare("SELECT text, phase FROM voice_outbound ORDER BY seq").all(),
	).toEqual([
		{ text: "first", phase: "ambiguous" },
		{ text: "second", phase: "dropped" },
	]);
	db.close();
	expect(
		store.failVoiceSessionAdmission(
			reservation.sessionId,
			"identity_binding_missing",
			now,
		),
	).toBe(false);
	expect(store.getVoiceSession(reservation.sessionId)?.reason).toBe(
		"voice_session_registry_drift",
	);
	expect(
		store.renewVoiceSession({
			sessionId: reservation.sessionId,
			leaseToken: claimed.leaseToken,
			now,
			leaseTtlMs: 15000,
		}),
	).toBeUndefined();
});
