import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeVoiceHttpError } from "../../../voice-codex/src/bridge-client.js";
import { VoiceDaemon } from "../../../voice-codex/src/daemon.js";
import { SessionStateStore } from "../../../voice-codex/src/session-state.js";
import { StateStore } from "../StateStore.js";

const T0 = "2026-09-08T20:00:00.000Z";
const cleanup: string[] = [];
let store: StateStore;

beforeEach(async () => {
	const root = mkdtempSync(join(tmpdir(), "flywheel-voice-store-"));
	cleanup.push(root);
	store = await StateStore.create(join(root, "teamlead.db"));
});

afterEach(() => {
	store.close();
	for (const root of cleanup.splice(0)) rmSync(root, { recursive: true });
});

function reservation(overrides: Record<string, unknown> = {}) {
	return {
		sessionId: "10000000-0000-4000-8000-000000000001",
		mode: "meeting" as const,
		projectName: "flywheel",
		leadId: "lead-a",
		guildId: "100000000000000001",
		voiceChannelId: "100000000000000002",
		meetingId: "20000000-0000-4000-8000-000000000001",
		evidenceDir: "/evidence/meeting-a",
		requestedBy: "ingest",
		credentialTier: "ingest" as const,
		createdAt: T0,
		...overrides,
	};
}

describe("StateStore voice sessions", () => {
	it("restarts into the idle loop after Bridge sweeps a crashed daemon session", async () => {
		const { sessionId } = reservation();
		store.reserveVoiceSession(reservation());
		store.updateVoiceProvisioning({
			sessionId,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: T0,
		});
		const claim = store.claimVoiceSession({
			sessionId,
			daemonBootId: "crashed",
			now: T0,
			leaseTtlMs: 15_000,
		});
		expect(claim).not.toBeNull();
		const saved = new SessionStateStore(cleanup[0]);
		saved.save({
			sessionId,
			leaseToken: claim!.leaseToken,
			projection: {
				mode: "meeting",
				projectName: "flywheel",
				leadId: "lead-a",
				displayName: "Lead A",
				realtimeVoice: "marin",
				guildId: "guild",
				voiceChannelId: "voice",
				threadId: "thread",
				boundChannelIds: ["thread"],
				founderUserId: "founder",
				qaAllowUserIds: [],
			},
		});
		const now = "2026-09-08T20:00:30.000Z";
		expect(
			store.sweepVoiceSessions({
				now,
				clockSkewGraceMs: 5_000,
				endingTimeoutMs: 30_000,
			}),
		).toEqual([{ sessionId, reason: "lease_lost" }]);
		const unexpected = async () => {
			throw new Error("must not enter a voice room during recovery");
		};
		let idlePolls = 0;
		let terminalReceipts = 0;
		const daemon = new VoiceDaemon({
			bridge: {
				desired: async () => {
					idlePolls++;
					daemon.shutdown();
					return null;
				},
				claim: unexpected,
				renew: unexpected,
				outbound: unexpected,
				claimOutbound: unexpected,
				receipt: unexpected,
				renewRecovered: async (id, leaseToken) => {
					expect(
						store.renewVoiceSession({
							sessionId: id,
							leaseToken,
							now,
							leaseTtlMs: 15_000,
						}),
					).toBeNull();
					throw new BridgeVoiceHttpError(409, "voice_lease_conflict");
				},
				setState: async (
					id,
					leaseToken,
					_lease,
					state,
					reason,
					abandonedCount,
				) => {
					terminalReceipts++;
					expect(
						store.setVoiceSessionState({
							sessionId: id,
							leaseToken,
							state,
							reason,
							abandonedCount,
							now,
						}),
					).toBe(false);
					throw new BridgeVoiceHttpError(409, "voice_lease_conflict");
				},
			},
			stateStore: saved,
			bootId: "restarted",
			createSession: () => {
				throw new Error("must not start stale session");
			},
			recoverSession: async (_saved, authority) => {
				expect(authority).toBeUndefined();
				return 0;
			},
			sleep: async () => {},
			timing: {
				idlePollMs: 5_000,
				leaseRenewMs: 4_000,
				leaseMissMax: 2,
				presenceGraceMs: 10,
				speechChunkTokens: 600,
			},
		});
		await expect(daemon.run()).resolves.toBeUndefined();
		expect(idlePolls).toBe(1);
		expect(terminalReceipts).toBe(1);
		expect(saved.list()).toEqual([]);
		await daemon.recover();
		expect(terminalReceipts).toBe(1);
		expect(store.getVoiceSession(sessionId)?.state).toBe("failed");
	});

	it("persists the voice topic for crash-safe provisioning", () => {
		store.reserveVoiceSession(reservation({ topic: "Voice meeting" }));
		expect(store.getVoiceSession(reservation().sessionId)?.topic).toBe(
			"Voice meeting",
		);
	});

	it("reserves before side effects and converges only the same meeting intent", () => {
		expect(store.reserveVoiceSession(reservation()).status).toBe("inserted");
		expect(
			store.reserveVoiceSession(
				reservation({ sessionId: "10000000-0000-4000-8000-000000000002" }),
			),
		).toMatchObject({ status: "already_exists" });
		expect(
			store.reserveVoiceSession(
				reservation({
					sessionId: "10000000-0000-4000-8000-000000000003",
					leadId: "lead-b",
				}),
			),
		).toEqual({ status: "meeting_intent_conflict" });
		expect(
			store.reserveVoiceSession(
				reservation({
					sessionId: "10000000-0000-4000-8000-000000000004",
					meetingId: "20000000-0000-4000-8000-000000000004",
				}),
			),
		).toEqual({ status: "session_active" });
	});

	it("claims one desired session and fences expired or stale lease mutations", () => {
		store.reserveVoiceSession(reservation());
		expect(
			store.updateVoiceProvisioning({
				sessionId: reservation().sessionId,
				expectedStep: "reserved",
				nextStep: "done",
				nextState: "desired",
				updatedAt: T0,
			}),
		).toBe(true);
		const claim = store.claimVoiceSession({
			sessionId: reservation().sessionId,
			daemonBootId: "boot-a",
			now: T0,
			leaseTtlMs: 15_000,
		});
		expect(claim?.leaseToken).toMatch(/^[0-9a-f]{64}$/);
		expect(claim?.leaseExpiresAt).toBe("2026-09-08T20:00:15.000Z");
		expect(
			store.setVoiceSessionState({
				sessionId: reservation().sessionId,
				leaseToken: "wrong",
				state: "warming",
				now: "2026-09-08T20:00:01.000Z",
			}),
		).toBe(false);
		expect(
			store.setVoiceSessionState({
				sessionId: reservation().sessionId,
				leaseToken: claim!.leaseToken,
				state: "warming",
				now: "2026-09-08T20:00:01.000Z",
			}),
		).toBe(true);
		expect(
			store.renewVoiceSession({
				sessionId: reservation().sessionId,
				leaseToken: claim!.leaseToken,
				now: "2026-09-08T20:00:16.000Z",
				leaseTtlMs: 15_000,
			}),
		).toBeUndefined();
		expect(
			store.setVoiceSessionState({
				sessionId: reservation().sessionId,
				leaseToken: claim!.leaseToken,
				state: "failed",
				reason: "daemon_restart",
				now: "2026-09-08T20:00:16.000Z",
				abandonedCount: 2,
			}),
		).toBe(true);
		expect(store.getVoiceSession(reservation().sessionId)?.state).toBe(
			"failed",
		);
	});

	it("maps stop by lifecycle phase without letting stop directly cancel provisioning", () => {
		store.reserveVoiceSession(reservation());
		expect(
			store.stopVoiceSession(
				reservation().sessionId,
				"2026-09-08T20:00:01.000Z",
			),
		).toBe("cancel_requested");
		expect(store.getVoiceSession(reservation().sessionId)).toMatchObject({
			state: "provisioning",
			cancelRequestedAt: "2026-09-08T20:00:01.000Z",
		});
	});

	it("claims and receipts outbound rows exactly once, then settles them at terminal", () => {
		store.reserveVoiceSession(reservation());
		store.updateVoiceProvisioning({
			sessionId: reservation().sessionId,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: T0,
		});
		const claim = store.claimVoiceSession({
			sessionId: reservation().sessionId,
			daemonBootId: "boot-a",
			now: T0,
			leaseTtlMs: 15_000,
		})!;
		expect(
			store.recordVoiceOutboundPage({
				sessionId: reservation().sessionId,
				leaseToken: claim.leaseToken,
				channelId: "100000000000000003",
				cursor: "100000000000000010",
				messages: [
					{
						messageId: "100000000000000009",
						authorId: "100000000000000004",
						text: "reply",
						observedAt: "2026-09-08T20:00:01.000Z",
					},
				],
				now: "2026-09-08T20:00:01.000Z",
			}),
		).toBe(true);
		expect(
			store.listVoiceOutbound(reservation().sessionId, claim.leaseToken, T0),
		).toHaveLength(1);
		store.recordVoiceOutboundPage({
			sessionId: reservation().sessionId,
			leaseToken: claim.leaseToken,
			channelId: "100000000000000003",
			cursor: "100000000000000005",
			messages: [],
			now: "2026-09-08T20:00:01.500Z",
		});
		expect(
			store.getVoiceSession(reservation().sessionId)?.outboundCursor,
		).toEqual({ "100000000000000003": "100000000000000010" });
		const attempt = store.claimVoiceOutbound({
			sessionId: reservation().sessionId,
			seq: 1,
			leaseToken: claim.leaseToken,
			now: "2026-09-08T20:00:02.000Z",
		});
		expect(attempt).toMatch(/^[0-9a-f-]{36}$/);
		expect(
			store.finishVoiceOutbound({
				sessionId: reservation().sessionId,
				seq: 1,
				leaseToken: claim.leaseToken,
				attemptToken: "wrong",
				status: "confirmed",
				now: "2026-09-08T20:00:03.000Z",
			}),
		).toBe("conflict");
		expect(
			store.finishVoiceOutbound({
				sessionId: reservation().sessionId,
				seq: 1,
				leaseToken: claim.leaseToken,
				attemptToken: attempt!,
				status: "confirmed",
				now: "2026-09-08T20:00:03.000Z",
			}),
		).toBe("updated");
		expect(
			store.finishVoiceOutbound({
				sessionId: reservation().sessionId,
				seq: 1,
				leaseToken: claim.leaseToken,
				attemptToken: attempt!,
				status: "confirmed",
				now: "2026-09-08T20:00:04.000Z",
			}),
		).toBe("replayed");
	});

	it("expires only after lease plus skew grace and releases the room", () => {
		store.reserveVoiceSession(reservation());
		store.updateVoiceProvisioning({
			sessionId: reservation().sessionId,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: T0,
		});
		store.claimVoiceSession({
			sessionId: reservation().sessionId,
			daemonBootId: "boot-a",
			now: T0,
			leaseTtlMs: 15_000,
		});
		expect(
			store.sweepVoiceSessions({
				now: "2026-09-08T20:00:19.999Z",
				clockSkewGraceMs: 5_000,
				endingTimeoutMs: 30_000,
			}),
		).toEqual([]);
		expect(
			store.sweepVoiceSessions({
				now: "2026-09-08T20:00:20.001Z",
				clockSkewGraceMs: 5_000,
				endingTimeoutMs: 30_000,
			}),
		).toEqual([{ sessionId: reservation().sessionId, reason: "lease_lost" }]);
		expect(
			store.reserveVoiceSession(
				reservation({
					sessionId: "10000000-0000-4000-8000-000000000099",
					meetingId: "20000000-0000-4000-8000-000000000099",
					createdAt: "2026-09-08T20:00:21.000Z",
				}),
			).status,
		).toBe("inserted");
	});

	it("lists stale provisioning rows for reducer takeover", () => {
		store.reserveVoiceSession(reservation());
		expect(
			store
				.listRecoverableVoiceProvisioning("2026-09-08T20:02:00.001Z")
				.map(({ sessionId }) => sessionId),
		).toEqual([reservation().sessionId]);
	});
});

it.each(["renew", "poller"])(
	"does not let %s extend the ending timeout",
	(activity) => {
		const sessionId = reservation().sessionId;
		store.reserveVoiceSession(reservation());
		store.updateVoiceProvisioning({
			sessionId,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: T0,
		});
		const claimed = store.claimVoiceSession({
			sessionId,
			daemonBootId: "boot",
			now: T0,
			leaseTtlMs: 60_000,
		})!;
		store.stopVoiceSession(sessionId, "2026-09-08T20:00:01.000Z");
		if (activity === "renew")
			store.renewVoiceSession({
				sessionId,
				leaseToken: claimed.leaseToken,
				now: "2026-09-08T20:00:30.000Z",
				leaseTtlMs: 60_000,
			});
		else
			store.recordVoiceOutboundPage({
				sessionId,
				leaseToken: claimed.leaseToken,
				channelId: "100000000000000003",
				cursor: "100000000000000010",
				messages: [],
				now: "2026-09-08T20:00:30.000Z",
			});
		expect(
			store.sweepVoiceSessions({
				now: "2026-09-08T20:00:31.001Z",
				clockSkewGraceMs: 5_000,
				endingTimeoutMs: 30_000,
			}),
		).toEqual([{ sessionId, reason: "ending_timeout" }]);
	},
);

it("preserves a cancelled receipt without advancing state or accepting a stale owner", () => {
	const sessionId = reservation().sessionId;
	store.reserveVoiceSession(reservation());
	store.claimVoiceProvisioner(sessionId, "owner", T0, T0);
	store.updateVoiceProvisioning({
		sessionId,
		expectedStep: "reserved",
		nextStep: "root_requested",
		provisioningNonce: "nonce",
		updatedAt: T0,
		provisionerEpoch: "owner",
	});
	store.stopVoiceSession(sessionId, T0);
	expect(
		store.updateVoiceProvisioning({
			sessionId,
			expectedStep: "root_requested",
			nextStep: "thread_requested",
			rootMessageId: "stale-receipt",
			updatedAt: T0,
			provisionerEpoch: "stale",
		}),
	).toBe(false);
	expect(store.getVoiceSession(sessionId)?.rootMessageId).toBeNull();
	expect(
		store.updateVoiceProvisioning({
			sessionId,
			expectedStep: "root_requested",
			nextStep: "thread_requested",
			rootMessageId: "actual-receipt",
			updatedAt: T0,
			provisionerEpoch: "owner",
		}),
	).toBe(false);
	expect(store.getVoiceSession(sessionId)).toMatchObject({
		state: "provisioning",
		provisioningStep: "root_requested",
		rootMessageId: "actual-receipt",
	});
});

it.each([
	{ reason: "she-left", elapsedMs: 2_000, accepted: true },
	{ reason: "voice-stop", elapsedMs: 2_000, accepted: true },
	{ reason: "text-stop", elapsedMs: 2_000, accepted: false },
	{ reason: "unknown", elapsedMs: 2_000, accepted: false },
	{ reason: "voice-stop", elapsedMs: 15_000, accepted: false },
])(
	"maps live local end $reason at $elapsedMs ms with active-lease validation",
	({ reason, elapsedMs, accepted }) => {
		const sessionId = reservation().sessionId;
		store.reserveVoiceSession(reservation());
		store.updateVoiceProvisioning({
			sessionId,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: T0,
		});
		const claim = store.claimVoiceSession({
			sessionId,
			daemonBootId: "boot",
			now: T0,
			leaseTtlMs: 15_000,
		})!;
		store.setVoiceSessionState({
			sessionId,
			leaseToken: claim.leaseToken,
			state: "warming",
			now: T0,
		});
		store.setVoiceSessionState({
			sessionId,
			leaseToken: claim.leaseToken,
			state: "live",
			now: T0,
		});
		const now = new Date(Date.parse(T0) + elapsedMs).toISOString();
		expect(
			store.setVoiceSessionState({
				sessionId,
				leaseToken: claim.leaseToken,
				state: "ended",
				reason,
				now,
			}),
		).toBe(accepted);
		expect(store.getVoiceSession(sessionId)).toMatchObject(
			accepted
				? { state: "ended", reason, endedAt: now }
				: { state: "live", endedAt: null },
		);
	},
);

it.each(["leaseToken mismatch", "leaseExpiresAt null"])(
	"rejects renew with %s without returning a success receipt",
	(guard) => {
		const { sessionId } = reservation();
		store.reserveVoiceSession(reservation());
		store.updateVoiceProvisioning({
			sessionId,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: T0,
		});
		const claim = store.claimVoiceSession({
			sessionId,
			daemonBootId: "boot",
			now: T0,
			leaseTtlMs: 15_000,
		})!;
		expect(claim.leaseToken).toBeTruthy();
		if (guard === "leaseExpiresAt null") {
			const db = new Database(store.getDbPath());
			try {
				db.prepare(
					"UPDATE voice_sessions SET lease_expires_at = NULL WHERE session_id = ?",
				).run(sessionId);
			} finally {
				db.close();
			}
		}
		const before = store.getVoiceSession(sessionId);
		expect(before?.state).toBe("claimed");
		expect(before?.leaseExpiresAt).toBe(
			guard === "leaseExpiresAt null" ? null : claim.leaseExpiresAt,
		);
		const receipt = store.renewVoiceSession({
			sessionId,
			leaseToken:
				guard === "leaseToken mismatch" ? "wrong-token" : claim.leaseToken,
			now: "2026-09-08T20:00:01.000Z",
			leaseTtlMs: 15_000,
		});
		expect(receipt).toBeUndefined();
		expect(store.getVoiceSession(sessionId)).toEqual(before);
	},
);
