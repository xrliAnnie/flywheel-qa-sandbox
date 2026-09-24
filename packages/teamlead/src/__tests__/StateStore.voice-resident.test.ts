import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const T0 = "2026-09-23T20:00:00.000Z";
let root: string;
let store: StateStore;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "flywheel-resident-voice-"));
	store = await StateStore.create(join(root, "teamlead.db"));
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true });
});

function input(overrides: Record<string, unknown> = {}) {
	return {
		projectName: "flywheel",
		leadId: "flywheel-eng-lead",
		requestId: "resident-request-1",
		inputDigest: "digest-1",
		ownerBootId: "voice-bridge-boot-1",
		sessionGeneration: 7,
		bindingProof: {
			version: 1 as const,
			projectName: "flywheel",
			guildId: "100000000000000001",
			voiceChannelId: "100000000000000002",
			ownerBootId: "voice-bridge-boot-1",
			sessionGeneration: 7,
			outputBotUserId: "100000000000000005",
			earsBotUserId: "100000000000000006",
			outputBotDropped: true,
			earsBotDropped: true,
			unknownDropped: true,
			allowedHumanPassed: true,
			observedAt: T0,
			expiresAt: "2026-09-23T20:01:00.000Z",
		},
		leaseTtlMs: 15_000,
		reservation: {
			sessionId: "10000000-0000-4000-8000-000000000101",
			mode: "rg" as const,
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
			guildId: "100000000000000001",
			voiceChannelId: "100000000000000002",
			voiceBotUserId: "100000000000000005",
			requestedBy: "master",
			credentialTier: "master" as const,
			createdAt: T0,
		},
		...overrides,
	};
}

describe("StateStore resident voice carrier", () => {
	it("atomically creates a claimed lease without daemon provisioning or launch admission", () => {
		const first = store.reserveAndClaimResidentVoiceSession(input());
		expect(first).toMatchObject({
			status: "inserted",
			session: {
				carrierKind: "resident",
				ownerBootId: "voice-bridge-boot-1",
				sessionGeneration: 7,
				state: "claimed",
				provisioningStep: "done",
				rootMessageId: null,
				threadId: null,
				residentBindingProof: expect.objectContaining({
					outputBotDropped: true,
					earsBotDropped: true,
				}),
			},
		});
		expect(first).toHaveProperty("leaseToken");
		expect(store.getDesiredVoiceSession()).toBeUndefined();
		expect(
			store.listRecoverableVoiceProvisioning("2099-01-01T00:00:00Z"),
		).toEqual([]);
		expect(
			store.claimVoiceSession({
				sessionId: input().reservation.sessionId,
				daemonBootId: "daemon-boot",
				now: T0,
				leaseTtlMs: 15_000,
			}),
		).toBeUndefined();
		expect(
			store.admitVoiceLaunchAttempt({
				sessionId: input().reservation.sessionId,
				attemptId: "attempt-1",
				now: T0,
			}),
		).toEqual({ status: "ineligible" });
		expect(store.getVoiceDemandSnapshot(0)).toMatchObject({
			state: "none",
			demandIdentities: [],
			events: [],
		});
	});

	it("replays one request, rejects a conflicting digest, and preserves room uniqueness", () => {
		const first = store.reserveAndClaimResidentVoiceSession(input());
		const replay = store.reserveAndClaimResidentVoiceSession(
			input({
				reservation: {
					...input().reservation,
					sessionId: "10000000-0000-4000-8000-000000000102",
				},
			}),
		);
		expect(replay).toMatchObject({
			status: "replayed",
			leaseToken: first.leaseToken,
			session: { sessionId: input().reservation.sessionId },
		});
		expect(
			store.reserveAndClaimResidentVoiceSession(
				input({ inputDigest: "changed" }),
			),
		).toEqual({ status: "intent_conflict" });
		expect(
			store.reserveAndClaimResidentVoiceSession(
				input({
					requestId: "resident-request-2",
					inputDigest: "digest-2",
					reservation: {
						...input().reservation,
						sessionId: "10000000-0000-4000-8000-000000000103",
					},
				}),
			),
		).toEqual({ status: "session_active" });
	});

	it("requires the resident owner and generation for renew and state changes", () => {
		const claimed = store.reserveAndClaimResidentVoiceSession(input());
		if (!("leaseToken" in claimed)) throw new Error("resident claim missing");
		const common = {
			sessionId: input().reservation.sessionId,
			leaseToken: claimed.leaseToken,
			now: "2026-09-23T20:00:01.000Z",
			leaseTtlMs: 15_000,
		};
		const refreshedProof = {
			...input().bindingProof,
			observedAt: common.now,
			expiresAt: "2026-09-23T20:02:00.000Z",
		};
		expect(
			store.renewVoiceSession({
				...common,
				ownerBootId: "wrong-boot",
				sessionGeneration: 7,
			}),
		).toBeUndefined();
		expect(
			store.renewVoiceSession({
				...common,
				ownerBootId: "voice-bridge-boot-1",
				sessionGeneration: 6,
			}),
		).toBeUndefined();
		expect(
			store.renewVoiceSession({
				...common,
				ownerBootId: "voice-bridge-boot-1",
				sessionGeneration: 7,
				bindingProof: refreshedProof,
			}),
		).toMatchObject({
			state: "claimed",
		});
		expect(
			store.getVoiceSession(common.sessionId)?.residentBindingProof,
		).toEqual(refreshedProof);
		expect(
			store.setVoiceSessionState({
				sessionId: common.sessionId,
				leaseToken: common.leaseToken,
				ownerBootId: "wrong-boot",
				sessionGeneration: 7,
				state: "warming",
				now: common.now,
			}),
		).toBe(false);
		expect(
			store.setVoiceSessionState({
				sessionId: common.sessionId,
				leaseToken: common.leaseToken,
				ownerBootId: "voice-bridge-boot-1",
				sessionGeneration: 7,
				state: "warming",
				now: common.now,
			}),
		).toBe(true);
	});

	it("releases a normally ended resident room for an immediate replacement claim", () => {
		const first = store.reserveAndClaimResidentVoiceSession(input());
		if (!("leaseToken" in first)) throw new Error("resident claim missing");
		const sessionId = input().reservation.sessionId;
		const owner = {
			sessionId,
			leaseToken: first.leaseToken,
			ownerBootId: "voice-bridge-boot-1",
			sessionGeneration: 7,
		};
		expect(
			store.setVoiceSessionState({
				...owner,
				state: "warming",
				now: T0,
			}),
		).toBe(true);
		expect(
			store.setVoiceSessionState({
				...owner,
				state: "live",
				now: "2026-09-23T20:00:01.000Z",
			}),
		).toBe(true);
		expect(
			store.setVoiceSessionState({
				...owner,
				state: "ended",
				reason: "voice-stop",
				now: "2026-09-23T20:00:02.000Z",
			}),
		).toBe(true);
		expect(store.getVoiceSession(sessionId)).toMatchObject({
			state: "ended",
			reason: "voice-stop",
		});

		const replacement = store.reserveAndClaimResidentVoiceSession(
			input({
				requestId: "resident-request-2",
				inputDigest: "digest-2",
				ownerBootId: "voice-bridge-boot-2",
				sessionGeneration: 8,
				bindingProof: {
					...input().bindingProof,
					ownerBootId: "voice-bridge-boot-2",
					sessionGeneration: 8,
					observedAt: "2026-09-23T20:00:02.000Z",
					expiresAt: "2026-09-23T20:01:02.000Z",
				},
				reservation: {
					...input().reservation,
					sessionId: "10000000-0000-4000-8000-000000000102",
					createdAt: "2026-09-23T20:00:02.000Z",
				},
			}),
		);
		expect(replacement).toMatchObject({
			status: "inserted",
			session: {
				sessionId: "10000000-0000-4000-8000-000000000102",
				state: "claimed",
			},
		});
	});

	it("expires an abandoned resident lease before admitting a new room owner", () => {
		const first = store.reserveAndClaimResidentVoiceSession(input());
		expect(first).toHaveProperty("leaseToken");
		const takeoverAt = "2026-09-23T20:00:15.000Z";
		const takeover = store.reserveAndClaimResidentVoiceSession(
			input({
				requestId: "resident-request-2",
				inputDigest: "digest-2",
				ownerBootId: "voice-bridge-boot-2",
				sessionGeneration: 8,
				bindingProof: {
					...input().bindingProof,
					ownerBootId: "voice-bridge-boot-2",
					sessionGeneration: 8,
					observedAt: takeoverAt,
					expiresAt: "2026-09-23T20:01:15.000Z",
				},
				reservation: {
					...input().reservation,
					sessionId: "10000000-0000-4000-8000-000000000102",
					createdAt: takeoverAt,
				},
			}),
		);

		expect(takeover).toMatchObject({
			status: "inserted",
			session: {
				sessionId: "10000000-0000-4000-8000-000000000102",
				ownerBootId: "voice-bridge-boot-2",
				state: "claimed",
			},
		});
		expect(store.getVoiceSession(input().reservation.sessionId)).toMatchObject({
			state: "failed",
			reason: "resident_lease_expired",
			endedAt: takeoverAt,
		});
	});

	it("keeps a renewed resident lease exclusive until its extended expiry", () => {
		const first = store.reserveAndClaimResidentVoiceSession(input());
		if (!("leaseToken" in first)) throw new Error("resident claim missing");
		const renewedAt = "2026-09-23T20:00:10.000Z";
		expect(
			store.renewVoiceSession({
				sessionId: input().reservation.sessionId,
				leaseToken: first.leaseToken,
				now: renewedAt,
				leaseTtlMs: 15_000,
				ownerBootId: "voice-bridge-boot-1",
				sessionGeneration: 7,
				bindingProof: {
					...input().bindingProof,
					observedAt: renewedAt,
					expiresAt: "2026-09-23T20:01:10.000Z",
				},
			}),
		).toMatchObject({ leaseExpiresAt: "2026-09-23T20:00:25.000Z" });
		const replacement = {
			requestId: "resident-request-2",
			inputDigest: "digest-2",
			ownerBootId: "voice-bridge-boot-2",
			sessionGeneration: 8,
			bindingProof: {
				...input().bindingProof,
				ownerBootId: "voice-bridge-boot-2",
				sessionGeneration: 8,
				observedAt: "2026-09-23T20:00:16.000Z",
				expiresAt: "2026-09-23T20:01:16.000Z",
			},
			reservation: {
				...input().reservation,
				sessionId: "10000000-0000-4000-8000-000000000102",
				createdAt: "2026-09-23T20:00:16.000Z",
			},
		};
		expect(
			store.reserveAndClaimResidentVoiceSession(input(replacement)),
		).toEqual({
			status: "session_active",
		});
		expect(store.getVoiceSession(input().reservation.sessionId)).toMatchObject({
			state: "claimed",
			leaseExpiresAt: "2026-09-23T20:00:25.000Z",
		});

		const afterExpiry = store.reserveAndClaimResidentVoiceSession(
			input({
				...replacement,
				bindingProof: {
					...replacement.bindingProof,
					observedAt: "2026-09-23T20:00:25.000Z",
					expiresAt: "2026-09-23T20:01:25.000Z",
				},
				reservation: {
					...replacement.reservation,
					createdAt: "2026-09-23T20:00:25.000Z",
				},
			}),
		);
		expect(afterExpiry).toMatchObject({ status: "inserted" });
	});
});
