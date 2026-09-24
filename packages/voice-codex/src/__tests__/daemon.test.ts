import { describe, expect, it, vi } from "vitest";
import {
	BridgeVoiceHttpError,
	VoiceLease,
	type VoiceSessionProjection,
} from "../bridge-client.js";
import { type ActiveVoiceSession, VoiceDaemon } from "../daemon.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const projection: VoiceSessionProjection = {
	sessionId: SESSION_ID,
	voiceBotUserId: "323456789012345678",
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
};

function lease(): VoiceLease {
	const value = new VoiceLease(() => 0);
	value.install(0, 15_000, 2_000);
	return value;
}

function active(
	overrides: Partial<ActiveVoiceSession> = {},
): ActiveVoiceSession {
	return {
		receiveHealth: vi.fn(() => undefined),
		start: vi.fn(async () => ({ founderPresent: true })),
		waitForFounder: vi.fn(async () => true),
		markLive: vi.fn(async () => {}),
		waitForEnd: vi.fn(
			() =>
				new Promise((resolve) =>
					setTimeout(
						() => resolve({ kind: "ended", reason: "voice-stop" }),
						20,
					),
				),
		),
		requestEnd: vi.fn(),
		speak: vi.fn(async () => "confirmed" as const),
		notify: vi.fn(),
		stop: vi.fn(async () => {}),
		...overrides,
	};
}

describe("VoiceDaemon", () => {
	it("persists authority before side effects and receipts each claimed reply", async () => {
		const calls: string[] = [];
		const runtime = active({
			start: vi.fn(async () => {
				calls.push("runtime.start");
				return { founderPresent: true };
			}),
		});
		const stateStore = {
			save: vi.fn(() => calls.push("store.save")),
			list: vi.fn(() => []),
			remove: vi.fn(),
			quarantine: vi.fn(),
		};
		const bridge = {
			desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
			claim: vi.fn(async () => ({
				lease: lease(),
				leaseToken: "lease",
				leaseExpiresAt: "later",
				projection,
			})),
			renew: vi.fn(async () => ({ state: "live", leaseExpiresAt: "later" })),
			renewRecovered: vi.fn(),
			setState: vi.fn(async (_id, _token, _lease, state) =>
				calls.push(`state.${state}`),
			),
			outbound: vi
				.fn()
				.mockResolvedValueOnce([{ seq: 1, messageId: "m1", text: "**你好**" }])
				.mockResolvedValue([]),
			claimOutbound: vi.fn(async () => "attempt"),
			receipt: vi.fn(async () => {}),
		};
		const daemon = new VoiceDaemon({
			bridge,
			stateStore,
			bootId: "22222222-2222-4222-8222-222222222222",
			createSession: () => runtime,
			recoverSession: vi.fn(),
			sleep: vi.fn(async () => {}),
			timing: {
				idlePollMs: 5_000,
				leaseRenewMs: 1,
				leaseMissMax: 2,
				presenceGraceMs: 120_000,
				speechChunkTokens: 600,
			},
		});
		expect(await daemon.runOnce()).toEqual({
			kind: "session_ended",
			sessionId: SESSION_ID,
			reason: "voice-stop",
		});
		expect(calls.indexOf("store.save")).toBeLessThan(
			calls.indexOf("runtime.start"),
		);
		expect(calls).toContain("state.warming");
		expect(calls).toContain("state.live");
		expect(calls).toContain("state.ended");
		expect(runtime.speak).toHaveBeenCalledWith(
			expect.objectContaining({ spokenText: "你好" }),
		);
		expect(bridge.receipt).toHaveBeenCalledWith(
			SESSION_ID,
			1,
			"lease",
			expect.any(VoiceLease),
			"attempt",
			"confirmed",
		);
		expect(stateStore.remove).toHaveBeenCalledWith(SESSION_ID);
	});

	it("fails without joining a founder-less room indefinitely", async () => {
		const runtime = active({
			start: vi.fn(async () => ({ founderPresent: false })),
			waitForFounder: vi.fn(async () => false),
		});
		const bridge = {
			desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
			claim: vi.fn(async () => ({
				lease: lease(),
				leaseToken: "lease",
				leaseExpiresAt: "later",
				projection,
			})),
			renew: vi.fn(),
			renewRecovered: vi.fn(),
			setState: vi.fn(async () => {}),
			outbound: vi.fn(async () => []),
			claimOutbound: vi.fn(),
			receipt: vi.fn(),
		};
		const daemon = new VoiceDaemon({
			bridge,
			stateStore: { save: vi.fn(), list: vi.fn(() => []), remove: vi.fn() },
			bootId: "22222222-2222-4222-8222-222222222222",
			createSession: () => runtime,
			recoverSession: vi.fn(),
			sleep: vi.fn(async () => {}),
			timing: {
				idlePollMs: 5_000,
				leaseRenewMs: 1,
				leaseMissMax: 2,
				presenceGraceMs: 10,
				speechChunkTokens: 600,
			},
		});
		// FLY-2701 review R1 / plan §7: nobody turning up is a normal ending, so
		// it is recorded as one. It used to be persisted as `failed/no_human` and
		// merely hidden from the alert projection, which made every unattended
		// meeting look like a voice fault in the durable record.
		expect(await daemon.runOnce()).toEqual({
			kind: "session_ended",
			sessionId: SESSION_ID,
			reason: "no_human",
		});
		expect(bridge.setState).toHaveBeenLastCalledWith(
			SESSION_ID,
			"lease",
			expect.any(VoiceLease),
			"ended",
			"no_human",
		);
		expect(runtime.stop).toHaveBeenCalled();
	});

	it("asks Bridge about a recovered lease before delivery and reports abandoned rows", async () => {
		const saved = { sessionId: SESSION_ID, leaseToken: "stale", projection };
		const bridge = {
			desired: vi.fn(),
			claim: vi.fn(),
			renew: vi.fn(),
			renewRecovered: vi.fn(async () => {
				throw new Error("conflict");
			}),
			setState: vi.fn(async () => {}),
			outbound: vi.fn(),
			claimOutbound: vi.fn(),
			receipt: vi.fn(),
		};
		const recoverSession = vi.fn(async (_saved, authority?: VoiceLease) => {
			expect(authority).toBeUndefined();
			return 2;
		});
		const stateStore = {
			save: vi.fn(),
			list: vi.fn(() => [saved]),
			remove: vi.fn(),
			quarantine: vi.fn(),
		};
		const daemon = new VoiceDaemon({
			bridge,
			stateStore,
			bootId: "22222222-2222-4222-8222-222222222222",
			createSession: vi.fn(),
			recoverSession,
			sleep: vi.fn(async () => {}),
			timing: {
				idlePollMs: 5_000,
				leaseRenewMs: 1,
				leaseMissMax: 2,
				presenceGraceMs: 10,
				speechChunkTokens: 600,
			},
		});
		await daemon.recover();
		expect(recoverSession).toHaveBeenCalledAfter(bridge.renewRecovered);
		expect(bridge.setState).not.toHaveBeenCalled();
		expect(stateStore.quarantine).toHaveBeenCalledWith(SESSION_ID);
	});

	it("continues to the next saved record and idle after a local recovery failure", async () => {
		const secondId = "33333333-3333-4333-8333-333333333333";
		const saved = [SESSION_ID, secondId].map((sessionId) => ({
			sessionId,
			leaseToken: "lease",
			projection: { ...projection, sessionId },
		}));
		const stateStore = {
			save: vi.fn(),
			list: () => saved,
			remove: vi.fn(),
			quarantine: vi.fn(),
		};
		const bridge = {
			desired: vi.fn(async () => null),
			claim: vi.fn(),
			renew: vi.fn(),
			renewRecovered: vi.fn(async () => ({
				state: "live",
				lease: lease(),
				leaseExpiresAt: "later",
			})),
			setState: vi.fn(async () => {}),
			outbound: vi.fn(),
			claimOutbound: vi.fn(),
			receipt: vi.fn(),
		};
		const recoverSession = vi
			.fn()
			.mockRejectedValueOnce(new Error("private diagnostic"))
			.mockResolvedValueOnce(1);
		const daemon = new VoiceDaemon({
			bridge,
			stateStore,
			bootId: "boot",
			createSession: vi.fn(),
			recoverSession,
			sleep: vi.fn(async () => {}),
			timing: {
				idlePollMs: 1,
				leaseRenewMs: 1,
				leaseMissMax: 2,
				presenceGraceMs: 1,
				speechChunkTokens: 600,
			},
		});
		await daemon.recover();
		expect(recoverSession).toHaveBeenCalledTimes(2);
		expect(stateStore.quarantine).toHaveBeenCalledWith(SESSION_ID);
		expect(stateStore.quarantine).toHaveBeenCalledWith(secondId);
		expect(bridge.setState).toHaveBeenCalledWith(
			SESSION_ID,
			"lease",
			expect.any(VoiceLease),
			"failed",
			"voice_recovery_failed",
			undefined,
		);
		expect(bridge.setState).toHaveBeenCalledWith(
			secondId,
			"lease",
			expect.any(VoiceLease),
			"failed",
			"daemon_restart",
			1,
		);
		expect(await daemon.runOnce()).toEqual({ kind: "idle_success" });
	});

	it("does not grant recovery authority for an ending session", async () => {
		const saved = { sessionId: SESSION_ID, leaseToken: "stale", projection };
		const recoveredLease = lease();
		const bridge = {
			desired: vi.fn(),
			claim: vi.fn(),
			renew: vi.fn(),
			renewRecovered: vi.fn(async () => ({
				state: "ending",
				leaseExpiresAt: "later",
				lease: recoveredLease,
			})),
			setState: vi.fn(async () => {}),
			outbound: vi.fn(),
			claimOutbound: vi.fn(),
			receipt: vi.fn(),
		};
		const recoverSession = vi.fn(async (_saved, authority?: VoiceLease) => {
			expect(authority).toBeUndefined();
			return 1;
		});
		const daemon = new VoiceDaemon({
			bridge,
			stateStore: {
				save: vi.fn(),
				list: vi.fn(() => [saved]),
				remove: vi.fn(),
				quarantine: vi.fn(),
			},
			bootId: "22222222-2222-4222-8222-222222222222",
			createSession: vi.fn(),
			recoverSession,
			sleep: vi.fn(async () => {}),
			timing: {
				idlePollMs: 5_000,
				leaseRenewMs: 1,
				leaseMissMax: 2,
				presenceGraceMs: 10,
				speechChunkTokens: 600,
			},
		});
		await daemon.recover();
		expect(recoveredLease.deadline).toBeGreaterThan(0);
		expect(recoverSession).toHaveBeenCalledWith(saved, undefined);
	});

	it("fences and stops after the configured consecutive renew misses", async () => {
		const runtime = active({ waitForEnd: vi.fn(() => new Promise(() => {})) });
		const claimedLease = lease();
		const bridge = {
			desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
			claim: vi.fn(async () => ({
				lease: claimedLease,
				leaseToken: "lease",
				leaseExpiresAt: "later",
				projection,
			})),
			renew: vi.fn(async () => {
				throw new Error("network");
			}),
			renewRecovered: vi.fn(),
			setState: vi.fn(async () => {}),
			outbound: vi.fn(async () => []),
			claimOutbound: vi.fn(),
			receipt: vi.fn(),
		};
		const daemon = new VoiceDaemon({
			bridge,
			stateStore: { save: vi.fn(), list: vi.fn(() => []), remove: vi.fn() },
			bootId: "22222222-2222-4222-8222-222222222222",
			createSession: () => runtime,
			recoverSession: vi.fn(),
			sleep: vi.fn(async () => {}),
			timing: {
				idlePollMs: 5_000,
				leaseRenewMs: 1,
				leaseMissMax: 2,
				presenceGraceMs: 10,
				speechChunkTokens: 600,
			},
		});
		expect(await daemon.runOnce()).toEqual({
			kind: "session_failed",
			sessionId: SESSION_ID,
			reason: "lease_lost",
		});
		expect(bridge.renew).toHaveBeenCalledTimes(2);
		expect(() => claimedLease.assert()).toThrow(/voice_lease_fenced/);
		expect(runtime.stop).toHaveBeenCalledWith({
			kind: "failed",
			reason: "lease_lost",
		});
	});

	it("keeps a live session through a transient outbound poll failure", async () => {
		const runtime = active();
		const bridge = {
			desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
			claim: vi.fn(async () => ({
				lease: lease(),
				leaseToken: "lease",
				leaseExpiresAt: "later",
				projection,
			})),
			renew: vi.fn(),
			renewRecovered: vi.fn(),
			setState: vi.fn(async () => {}),
			outbound: vi.fn(async () => {
				throw new Error("network");
			}),
			claimOutbound: vi.fn(),
			receipt: vi.fn(),
		};
		const daemon = new VoiceDaemon({
			bridge,
			stateStore: { save: vi.fn(), list: vi.fn(() => []), remove: vi.fn() },
			bootId: "22222222-2222-4222-8222-222222222222",
			createSession: () => runtime,
			recoverSession: vi.fn(),
			sleep: vi.fn(async () => {}),
			timing: {
				idlePollMs: 5_000,
				leaseRenewMs: 1,
				leaseMissMax: 2,
				presenceGraceMs: 10,
				speechChunkTokens: 600,
			},
		});
		expect(await daemon.runOnce()).toEqual({
			kind: "session_ended",
			sessionId: SESSION_ID,
			reason: "voice-stop",
		});
		expect(runtime.stop).toHaveBeenCalledWith({
			kind: "ended",
			reason: "voice-stop",
		});
	});

	it("renews the lease while a spoken reply waits for confirmation", async () => {
		const receiveHealth = {
			version: 1 as const,
			sequence: 2,
			state: "degraded" as const,
			reason: "dave_decrypt" as const,
			failures: 1,
			retries: 0,
			lastPcmAt: null,
		};
		const runtime = active({
			receiveHealth: vi.fn(() => receiveHealth),
			speak: vi.fn(
				() =>
					new Promise((resolve) => setTimeout(() => resolve("confirmed"), 10)),
			),
		});
		const bridge = {
			desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
			claim: vi.fn(async () => ({
				lease: lease(),
				leaseToken: "lease",
				leaseExpiresAt: "later",
				projection,
			})),
			renew: vi.fn(async () => ({ state: "live", leaseExpiresAt: "later" })),
			renewRecovered: vi.fn(),
			setState: vi.fn(async () => {}),
			outbound: vi
				.fn()
				.mockResolvedValueOnce([{ seq: 1, messageId: "m1", text: "hello" }])
				.mockResolvedValue([]),
			claimOutbound: vi.fn(async () => "attempt"),
			receipt: vi.fn(async () => {}),
		};
		const daemon = new VoiceDaemon({
			bridge,
			stateStore: { save: vi.fn(), list: vi.fn(() => []), remove: vi.fn() },
			bootId: "22222222-2222-4222-8222-222222222222",
			createSession: () => runtime,
			recoverSession: vi.fn(),
			sleep: vi.fn(() => new Promise((resolve) => setTimeout(resolve, 0))),
			timing: {
				idlePollMs: 5_000,
				leaseRenewMs: 1,
				leaseMissMax: 2,
				presenceGraceMs: 10,
				speechChunkTokens: 600,
			},
		});
		expect(await daemon.runOnce()).toEqual({
			kind: "session_ended",
			sessionId: SESSION_ID,
			reason: "voice-stop",
		});
		expect(bridge.renew).toHaveBeenCalledWith(
			SESSION_ID,
			"lease",
			expect.any(VoiceLease),
			receiveHealth,
		);
	});

	it("retries an ambiguous outbound receipt with the same attempt token", async () => {
		const runtime = active();
		const bridge = {
			desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
			claim: vi.fn(async () => ({
				lease: lease(),
				leaseToken: "lease",
				leaseExpiresAt: "later",
				projection,
			})),
			renew: vi.fn(),
			renewRecovered: vi.fn(),
			setState: vi.fn(async () => {}),
			outbound: vi
				.fn()
				.mockResolvedValueOnce([{ seq: 1, messageId: "m1", text: "hello" }])
				.mockResolvedValue([]),
			claimOutbound: vi.fn(async () => "attempt"),
			receipt: vi
				.fn()
				.mockRejectedValueOnce(new Error("timeout"))
				.mockResolvedValueOnce(undefined),
		};
		const daemon = new VoiceDaemon({
			bridge,
			stateStore: { save: vi.fn(), list: vi.fn(() => []), remove: vi.fn() },
			bootId: "22222222-2222-4222-8222-222222222222",
			createSession: () => runtime,
			recoverSession: vi.fn(),
			sleep: vi.fn(async () => {}),
			timing: {
				idlePollMs: 5_000,
				leaseRenewMs: 1,
				leaseMissMax: 2,
				presenceGraceMs: 10,
				speechChunkTokens: 600,
			},
		});
		await daemon.runOnce();
		expect(bridge.receipt).toHaveBeenCalledTimes(2);
		expect(bridge.receipt.mock.calls[0]).toEqual(bridge.receipt.mock.calls[1]);
	});

	it("does not start a session if shutdown arrives during identity verification", async () => {
		const runtime = active();
		const bridge = {
			desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
			claim: vi.fn(async () => ({
				lease: lease(),
				leaseToken: "lease",
				leaseExpiresAt: "later",
				projection,
			})),
			renew: vi.fn(),
			renewRecovered: vi.fn(),
			setState: vi.fn(async () => {}),
			outbound: vi.fn(),
			claimOutbound: vi.fn(),
			receipt: vi.fn(),
		};
		const daemon = new VoiceDaemon({
			bridge,
			stateStore: {
				save: vi.fn(),
				list: () => [],
				remove: vi.fn(),
				quarantine: vi.fn(),
			},
			bootId: "boot",
			createSession: async () => {
				daemon.shutdown();
				return runtime;
			},
			recoverSession: vi.fn(),
			sleep: vi.fn(async () => {}),
			timing: {
				idlePollMs: 1,
				leaseRenewMs: 1000,
				leaseMissMax: 2,
				presenceGraceMs: 1,
				speechChunkTokens: 600,
			},
		});
		expect(await daemon.runOnce()).toEqual({
			kind: "daemon_stopped",
			sessionId: SESSION_ID,
			reason: "daemon_shutdown",
		});
		expect(runtime.start).not.toHaveBeenCalled();
		expect(runtime.stop).toHaveBeenCalledOnce();
	});

	it.each([false, true])(
		"fails and clears a claimed session when construction rejects (async=%s)",
		async (asynchronous) => {
			const stateStore = {
				save: vi.fn(),
				list: vi.fn(() => []),
				remove: vi.fn(),
				quarantine: vi.fn(),
			};
			const bridge = {
				desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
				claim: vi.fn(async () => ({
					lease: lease(),
					leaseToken: "lease",
					leaseExpiresAt: "later",
					projection,
				})),
				renew: vi.fn(),
				renewRecovered: vi.fn(),
				setState: vi.fn(async () => {}),
				outbound: vi.fn(),
				claimOutbound: vi.fn(),
				receipt: vi.fn(),
			};
			const daemon = new VoiceDaemon({
				bridge,
				stateStore,
				bootId: "22222222-2222-4222-8222-222222222222",
				createSession: () => {
					if (asynchronous)
						return Promise.reject(new Error("voice_session_registry_drift"));
					throw new Error("voice_session_registry_drift");
				},
				recoverSession: vi.fn(),
				sleep: vi.fn(async () => {}),
				timing: {
					idlePollMs: 5_000,
					leaseRenewMs: 1,
					leaseMissMax: 2,
					presenceGraceMs: 10,
					speechChunkTokens: 600,
				},
			});
			expect(await daemon.runOnce()).toEqual({
				kind: "session_failed",
				sessionId: SESSION_ID,
				reason: "session_create_failed",
			});
			expect(bridge.setState).toHaveBeenCalledWith(
				SESSION_ID,
				"lease",
				expect.any(VoiceLease),
				"failed",
				"session_create_failed",
			);
			expect(stateStore.remove).toHaveBeenCalledWith(SESSION_ID);
		},
	);

	it.each([
		[new Error("network"), false],
		[new BridgeVoiceHttpError(503, "unavailable"), false],
		[new BridgeVoiceHttpError(408, "timeout"), false],
		[new BridgeVoiceHttpError(429, "rate_limited"), false],
		[new BridgeVoiceHttpError(409, "voice_lease_conflict"), true],
		[new BridgeVoiceHttpError(404, "missing"), true],
		[new BridgeVoiceHttpError(403, "forbidden"), true],
	])(
		"recovery receipt %s cannot prevent isolation or idle (formerly final=%s)",
		async (error) => {
			const saved = { sessionId: SESSION_ID, leaseToken: "lease", projection };
			const stateStore = {
				save: vi.fn(),
				list: vi.fn(() => [saved]),
				remove: vi.fn(),
				quarantine: vi.fn(),
			};
			const bridge = {
				desired: vi.fn(),
				claim: vi.fn(),
				renew: vi.fn(),
				renewRecovered: vi.fn(async () => ({
					state: "live",
					leaseExpiresAt: "later",
					lease: lease(),
				})),
				setState: vi.fn(async () => {
					throw error;
				}),
				outbound: vi.fn(),
				claimOutbound: vi.fn(),
				receipt: vi.fn(),
			};
			const daemon = new VoiceDaemon({
				bridge,
				stateStore,
				bootId: "22222222-2222-4222-8222-222222222222",
				createSession: vi.fn(),
				recoverSession: vi.fn(async () => 0),
				sleep: vi.fn(async () => {}),
				timing: {
					idlePollMs: 5_000,
					leaseRenewMs: 1,
					leaseMissMax: 2,
					presenceGraceMs: 10,
					speechChunkTokens: 600,
				},
			});
			await expect(daemon.recover()).resolves.toBeUndefined();
			expect(stateStore.quarantine).toHaveBeenCalledWith(SESSION_ID);
			expect(stateStore.remove).not.toHaveBeenCalled();
		},
	);

	it("exits after 120 seconds of continuously successful empty reads", async () => {
		let elapsed = 0;
		const daemonRef: { current?: VoiceDaemon } = {};
		const desired = vi.fn(async () => null);
		const sleep = vi.fn(async (ms: number) => {
			elapsed += ms;
			// Escape hatch keeps the pre-feature implementation from hanging the RED run.
			if (elapsed > 125_000) daemonRef.current?.shutdown();
		});
		const daemon = new VoiceDaemon({
			bridge: {
				desired,
				claim: vi.fn(),
				renew: vi.fn(),
				renewRecovered: vi.fn(),
				setState: vi.fn(),
				outbound: vi.fn(),
				claimOutbound: vi.fn(),
				receipt: vi.fn(),
			},
			stateStore: {
				save: vi.fn(),
				list: vi.fn(() => []),
				remove: vi.fn(),
				quarantine: vi.fn(),
			},
			bootId: "boot",
			createSession: vi.fn(),
			recoverSession: vi.fn(),
			sleep,
			monotonicNow: () => elapsed,
			timing: {
				idlePollMs: 5_000,
				idleExitMs: 120_000,
				leaseRenewMs: 4_000,
				leaseMissMax: 2,
				presenceGraceMs: 120_000,
				speechChunkTokens: 600,
			},
		});
		daemonRef.current = daemon;

		await daemon.run();

		expect(elapsed).toBe(120_000);
		expect(desired).toHaveBeenCalledTimes(26); // 25 polls plus the final race read
	});

	it("resets idle accounting after a desired read fails", async () => {
		let elapsed = 0;
		const daemonRef: { current?: VoiceDaemon } = {};
		let failed = false;
		const desired = vi.fn(async () => {
			if (!failed && elapsed === 115_000) {
				failed = true;
				throw new Error("bridge_unavailable");
			}
			return null;
		});
		const sleep = vi.fn(async (ms: number) => {
			elapsed += ms;
			if (elapsed > 240_000) daemonRef.current?.shutdown();
		});
		const daemon = new VoiceDaemon({
			bridge: {
				desired,
				claim: vi.fn(),
				renew: vi.fn(),
				renewRecovered: vi.fn(),
				setState: vi.fn(),
				outbound: vi.fn(),
				claimOutbound: vi.fn(),
				receipt: vi.fn(),
			},
			stateStore: {
				save: vi.fn(),
				list: vi.fn(() => []),
				remove: vi.fn(),
				quarantine: vi.fn(),
			},
			bootId: "boot",
			createSession: vi.fn(),
			recoverSession: vi.fn(),
			sleep,
			monotonicNow: () => elapsed,
			timing: {
				idlePollMs: 5_000,
				idleExitMs: 120_000,
				leaseRenewMs: 4_000,
				leaseMissMax: 2,
				presenceGraceMs: 120_000,
				speechChunkTokens: 600,
			},
		});
		daemonRef.current = daemon;

		await daemon.run();

		expect(failed).toBe(true);
		expect(elapsed).toBe(240_000);
	});

	it("claims a demand found by the final idle-exit read", async () => {
		let elapsed = 0;
		const daemonRef: { current?: VoiceDaemon } = {};
		let finalRaceDelivered = false;
		const runtime = active();
		const desired = vi.fn(async () => {
			if (elapsed === 120_000 && !finalRaceDelivered) {
				finalRaceDelivered = true;
				return { sessionId: SESSION_ID };
			}
			return null;
		});
		const sleep = vi.fn(async (ms: number) => {
			elapsed += ms;
			if (elapsed > 245_000) daemonRef.current?.shutdown();
		});
		const bridge = {
			desired,
			claim: vi.fn(async () => ({
				lease: lease(),
				leaseToken: "lease",
				leaseExpiresAt: "later",
				projection,
			})),
			renew: vi.fn(async () => ({ state: "live", leaseExpiresAt: "later" })),
			renewRecovered: vi.fn(),
			setState: vi.fn(async () => {}),
			outbound: vi.fn(async () => []),
			claimOutbound: vi.fn(),
			receipt: vi.fn(),
		};
		const daemon = new VoiceDaemon({
			bridge,
			stateStore: {
				save: vi.fn(),
				list: vi.fn(() => []),
				remove: vi.fn(),
				quarantine: vi.fn(),
			},
			bootId: "boot",
			createSession: () => runtime,
			recoverSession: vi.fn(),
			sleep,
			monotonicNow: () => elapsed,
			timing: {
				idlePollMs: 5_000,
				idleExitMs: 120_000,
				leaseRenewMs: 4_000,
				leaseMissMax: 2,
				presenceGraceMs: 120_000,
				speechChunkTokens: 600,
			},
		});
		daemonRef.current = daemon;

		await daemon.run();

		expect(finalRaceDelivered).toBe(true);
		expect(bridge.claim).toHaveBeenCalledOnce();
		expect(elapsed).toBe(240_000);
	});
});

function pending<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function lifetimeFixture(legacyOutboundPolling = true) {
	const ended = pending<import("../daemon.js").VoiceEnd>();
	const claimedLease = new VoiceLease(() => Date.now());
	claimedLease.install(Date.now(), 15_000, 2_000);
	const runtime = active({
		waitForEnd: vi.fn(() => ended.promise),
		requestEnd: vi.fn((outcome) => ended.resolve(outcome)),
	});
	const bridge = {
		desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
		claim: vi.fn(async () => ({
			lease: claimedLease,
			leaseToken: "lease",
			leaseExpiresAt: "later",
			projection,
		})),
		renew: vi.fn(async () => {
			claimedLease.install(Date.now(), 15_000, 2_000);
			return { state: "live", leaseExpiresAt: "later" };
		}),
		renewRecovered: vi.fn(),
		setState: vi.fn(async () => {}),
		outbound: vi.fn(
			async () => [] as { seq: number; messageId: string; text: string }[],
		),
		claimOutbound: vi.fn(async () => "attempt"),
		receipt: vi.fn(async () => {}),
	};
	const options = {
		bridge,
		stateStore: { save: vi.fn(), list: vi.fn(() => []), remove: vi.fn() },
		bootId: "boot",
		legacyOutboundPolling,
		createSession: () => runtime,
		recoverSession: vi.fn(),
		sleep: (ms, signal) =>
			new Promise((resolve) => {
				const timer = setTimeout(resolve, ms);
				signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						resolve();
					},
					{ once: true },
				);
			}),
		timing: {
			idlePollMs: 5_000,
			leaseRenewMs: 4_000,
			leaseMissMax: 2,
			presenceGraceMs: 120_000,
			speechChunkTokens: 600,
		},
	};
	const daemon = new VoiceDaemon(options);
	return { runtime, bridge, daemon, claimedLease, ended };
}

describe("VoiceDaemon session lifetime", () => {
	it("does not poll legacy outbound replies when Engine A owns Lead delivery", async () => {
		vi.useFakeTimers();
		try {
			const fixture = lifetimeFixture(false);
			const running = fixture.daemon.runOnce();
			await vi.advanceTimersByTimeAsync(0);
			expect(fixture.runtime.markLive).toHaveBeenCalledOnce();
			expect(fixture.bridge.outbound).not.toHaveBeenCalled();
			fixture.ended.resolve({ kind: "ended", reason: "voice-stop" });
			await vi.advanceTimersByTimeAsync(0);
			await expect(running).resolves.toMatchObject({
				kind: "session_ended",
				reason: "voice-stop",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("receipts a claimed reply as dropped when speech projection is empty", async () => {
		const fixture = lifetimeFixture();
		fixture.bridge.outbound
			.mockResolvedValueOnce([{ seq: 1, messageId: "1", text: "🙂" }])
			.mockResolvedValue([]);
		const running = fixture.daemon.runOnce();
		await vi.waitFor(() =>
			expect(fixture.bridge.receipt).toHaveBeenCalledWith(
				SESSION_ID,
				1,
				"lease",
				expect.any(VoiceLease),
				"attempt",
				"dropped",
			),
		);
		expect(fixture.runtime.speak).not.toHaveBeenCalled();
		expect(fixture.runtime.notify).toHaveBeenCalledWith(
			"📻 没有可朗读内容，请看文字",
		);
		fixture.ended.resolve({ kind: "ended", reason: "voice-stop" });
		expect(await running).toEqual({
			kind: "session_ended",
			sessionId: SESSION_ID,
			reason: "voice-stop",
		});
	});

	it("classifies an explicit daemon shutdown separately from session failure", async () => {
		vi.useFakeTimers();
		try {
			const fixture = lifetimeFixture();
			const running = fixture.daemon.runOnce();
			await vi.advanceTimersByTimeAsync(0);
			fixture.daemon.shutdown();
			expect(await running).toEqual({
				kind: "daemon_stopped",
				sessionId: SESSION_ID,
				reason: "daemon_shutdown",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("kills a warming session at the hard deadline even when renewal never settles", async () => {
		vi.useFakeTimers();
		try {
			const fixture = lifetimeFixture();
			vi.mocked(fixture.runtime.start).mockReturnValue(new Promise(() => {}));
			fixture.bridge.renew.mockReturnValue(new Promise(() => {}));
			const running = fixture.daemon.runOnce();
			await vi.advanceTimersByTimeAsync(13_000);
			expect(fixture.runtime.stop).toHaveBeenCalledWith({
				kind: "failed",
				reason: "lease_lost",
			});
			expect(await running).toEqual({
				kind: "session_failed",
				sessionId: SESSION_ID,
				reason: "lease_lost",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("consumes text stop during warming without waiting for founder", async () => {
		vi.useFakeTimers();
		try {
			const fixture = lifetimeFixture();
			vi.mocked(fixture.runtime.start).mockResolvedValue({
				founderPresent: false,
			});
			vi.mocked(fixture.runtime.waitForFounder).mockReturnValue(
				new Promise(() => {}),
			);
			fixture.bridge.renew.mockResolvedValue({
				state: "ending",
				leaseExpiresAt: "later",
			});
			const running = fixture.daemon.runOnce();
			await vi.advanceTimersByTimeAsync(4_000);
			expect(fixture.runtime.stop).toHaveBeenCalledWith({
				kind: "ended",
				reason: "text-stop",
			});
			expect(await running).toEqual({
				kind: "session_ended",
				sessionId: SESSION_ID,
				reason: "text-stop",
			});
			expect(fixture.runtime.markLive).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(["she-left", "voice-stop", "codex_process_exit"])(
		"interrupts outbound on %s and never claims the next reply",
		async (reason) => {
			vi.useFakeTimers();
			try {
				const fixture = lifetimeFixture();
				fixture.bridge.outbound.mockResolvedValue([
					{ seq: 1, messageId: "1", text: "hello" },
					{ seq: 2, messageId: "2", text: "later" },
				]);
				const speech = pending<"confirmed">();
				vi.mocked(fixture.runtime.speak).mockReturnValue(speech.promise);
				const running = fixture.daemon.runOnce();
				await vi.advanceTimersByTimeAsync(0);
				expect(fixture.runtime.speak).toHaveBeenCalledTimes(1);
				const outcome =
					reason === "codex_process_exit"
						? { kind: "failed" as const, reason }
						: {
								kind: "ended" as const,
								reason: reason as "she-left" | "voice-stop",
							};
				fixture.ended.resolve(outcome);
				await vi.advanceTimersByTimeAsync(0);
				expect(fixture.runtime.stop).toHaveBeenCalledWith(
					reason === "codex_process_exit"
						? { kind: "failed", reason: "session_runtime_failed" }
						: outcome,
				);
				expect(await running).toEqual({
					kind:
						reason === "codex_process_exit"
							? "session_failed"
							: "session_ended",
					sessionId: SESSION_ID,
					reason:
						reason === "codex_process_exit" ? "session_runtime_failed" : reason,
				});
				speech.resolve("confirmed");
				await vi.advanceTimersByTimeAsync(8_000);
				expect(fixture.bridge.claimOutbound).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("renews while warming and waiting for founder presence", async () => {
		vi.useFakeTimers();
		try {
			const fixture = lifetimeFixture();
			const starting = pending<{ founderPresent: boolean }>();
			const founder = pending<boolean>();
			vi.mocked(fixture.runtime.start).mockReturnValue(starting.promise);
			vi.mocked(fixture.runtime.waitForFounder).mockReturnValue(
				founder.promise,
			);
			const running = fixture.daemon.runOnce();
			await vi.advanceTimersByTimeAsync(8_000);
			expect(fixture.bridge.renew).toHaveBeenCalledTimes(2);
			starting.resolve({ founderPresent: false });
			await vi.advanceTimersByTimeAsync(8_000);
			expect(fixture.bridge.renew).toHaveBeenCalledTimes(4);
			founder.resolve(true);
			await vi.advanceTimersByTimeAsync(0);
			fixture.ended.resolve({ kind: "ended", reason: "voice-stop" });
			expect(await running).toEqual({
				kind: "session_ended",
				sessionId: SESSION_ID,
				reason: "voice-stop",
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("VoiceDaemon prewarmed meeting (FLY-2701)", () => {
	function prewarmedProjection() {
		return {
			...projection,
			notBeforeLiveAt: "2026-09-22T09:00:00.000Z",
			presenceDeadlineAt: "2026-09-22T09:10:00.000Z",
			scheduleRevision: 1,
		};
	}

	it("reports ready, waits for the meeting time, and re-reads her presence", async () => {
		const order: string[] = [];
		let elapsedMs = 0;
		const runtime = active();
		const session = {
			...runtime,
			start: async () => {
				order.push("start");
				return { founderPresent: true };
			},
			// She was here when the room came up and left again during the wait.
			isFounderPresent: () => false,
			waitForFounderPresence: async () => {
				order.push("presence_recheck");
				return true;
			},
			waitForFounder: async () => {
				order.push("stale_presence");
				return true;
			},
			markLive: async () => {
				order.push("live");
			},
		};
		const bridge = {
			desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
			claim: vi.fn(async () => ({
				lease: lease(),
				leaseToken: "lease",
				leaseExpiresAt: "later",
				projection: prewarmedProjection(),
			})),
			renew: vi.fn(async () => ({ state: "live", leaseExpiresAt: "later" })),
			renewRecovered: vi.fn(),
			ready: vi.fn(async () => {
				order.push("ready");
			}),
			setState: vi.fn(async (_id, _t, _l, state) => {
				order.push(`state:${state}`);
			}),
			outbound: vi.fn(async () => []),
			claimOutbound: vi.fn(),
			receipt: vi.fn(),
		};
		const daemon = new VoiceDaemon({
			bridge,
			stateStore: {
				save: vi.fn(),
				list: vi.fn(() => []),
				remove: vi.fn(),
				quarantine: vi.fn(),
			},
			bootId: "boot",
			createSession: () => session,
			recoverSession: vi.fn(),
			sleep: vi.fn(async (ms: number) => {
				order.push("wait_until_T");
				elapsedMs += ms;
			}),
			now: () => new Date(Date.parse("2026-09-22T08:58:00.000Z") + elapsedMs),
			timing: {
				idlePollMs: 5_000,
				leaseRenewMs: 4_000,
				leaseMissMax: 2,
				presenceGraceMs: 600_000,
				speechChunkTokens: 600,
			},
		});

		const result = daemon.runOnce();
		await vi.waitFor(() => expect(order).toContain("live"));
		session.requestEnd({ kind: "ended", reason: "she-left" });
		await result;

		expect(bridge.ready).toHaveBeenCalledWith(
			SESSION_ID,
			"lease",
			expect.anything(),
			1,
		);
		expect(order.slice(0, 6)).toEqual([
			"state:warming",
			"start",
			"ready",
			"wait_until_T",
			"presence_recheck",
			"state:live",
		]);
		expect(order).not.toContain("stale_presence");
	});
});

describe("VoiceDaemon meeting floor (FLY-2701)", () => {
	it("does not fall through when a sleep returns before the meeting time", async () => {
		const sleeps: number[] = [];
		let elapsed = 0;
		const runtime = active();
		const session = {
			...runtime,
			start: async () => ({ founderPresent: true }),
			isFounderPresent: () => true,
			waitForFounderPresence: async () => true,
		};
		const bridge = {
			desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
			claim: vi.fn(async () => ({
				lease: lease(),
				leaseToken: "lease",
				leaseExpiresAt: "later",
				projection: {
					...projection,
					notBeforeLiveAt: "2026-09-22T09:00:00.000Z",
					scheduleRevision: 1,
				},
			})),
			renew: vi.fn(async () => ({ state: "live", leaseExpiresAt: "later" })),
			renewRecovered: vi.fn(),
			ready: vi.fn(async () => {}),
			setState: vi.fn(async () => {}),
			outbound: vi.fn(async () => []),
			claimOutbound: vi.fn(),
			receipt: vi.fn(),
		};
		const daemon = new VoiceDaemon({
			bridge,
			stateStore: {
				save: vi.fn(),
				list: vi.fn(() => []),
				remove: vi.fn(),
				quarantine: vi.fn(),
			},
			bootId: "boot",
			createSession: () => session,
			recoverSession: vi.fn(),
			// A short sleep: the first one only covers half the wait.
			sleep: vi.fn(async (ms: number) => {
				sleeps.push(ms);
				elapsed += Math.min(ms, 60_000);
			}),
			now: () => new Date(Date.parse("2026-09-22T08:58:00.000Z") + elapsed),
			timing: {
				idlePollMs: 5_000,
				leaseRenewMs: 4_000,
				leaseMissMax: 2,
				presenceGraceMs: 600_000,
				speechChunkTokens: 600,
			},
		});

		const result = daemon.runOnce();
		await vi.waitFor(() =>
			expect(bridge.setState).toHaveBeenCalledWith(
				SESSION_ID,
				"lease",
				expect.anything(),
				"live",
			),
		);
		session.requestEnd({ kind: "ended", reason: "she-left" });
		await result;

		// 120s of floor covered by two 60s sleeps, never one fall-through.
		expect(sleeps.slice(0, 2)).toEqual([120_000, 60_000]);
	});
});
