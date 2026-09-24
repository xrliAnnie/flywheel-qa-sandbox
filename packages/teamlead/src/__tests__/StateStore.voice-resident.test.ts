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
});
