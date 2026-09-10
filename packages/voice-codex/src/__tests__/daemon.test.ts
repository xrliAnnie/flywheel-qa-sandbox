import { describe, expect, it, vi } from "vitest";
import {
	BridgeVoiceHttpError,
	VoiceLease,
	type VoiceSessionProjection,
} from "../bridge-client.js";
import { type ActiveVoiceSession, VoiceDaemon } from "../daemon.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const projection: VoiceSessionProjection = {
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
		expect(await daemon.runOnce()).toBe("voice-stop");
		expect(calls.indexOf("store.save")).toBeLessThan(
			calls.indexOf("runtime.start"),
		);
		expect(calls).toContain("state.warming");
		expect(calls).toContain("state.live");
		expect(calls).toContain("state.ended");
		expect(runtime.speak).toHaveBeenCalledWith("你好");
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
		expect(await daemon.runOnce()).toBe("no_human");
		expect(bridge.setState).toHaveBeenLastCalledWith(
			SESSION_ID,
			"lease",
			expect.any(VoiceLease),
			"failed",
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
		expect(bridge.setState).toHaveBeenCalledWith(
			SESSION_ID,
			"stale",
			expect.any(VoiceLease),
			"failed",
			"daemon_restart",
			2,
		);
		expect(stateStore.remove).toHaveBeenCalledWith(SESSION_ID);
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
		expect(await daemon.runOnce()).toBe("lease_lost");
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
		expect(await daemon.runOnce()).toBe("voice-stop");
		expect(runtime.stop).toHaveBeenCalledWith({
			kind: "ended",
			reason: "voice-stop",
		});
	});

	it("renews the lease while a spoken reply waits for confirmation", async () => {
		const runtime = active({
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
		expect(await daemon.runOnce()).toBe("voice-stop");
		expect(bridge.renew).toHaveBeenCalled();
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

	it("fails and clears a claimed session when local session construction rejects it", async () => {
		const stateStore = {
			save: vi.fn(),
			list: vi.fn(() => []),
			remove: vi.fn(),
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
		expect(await daemon.runOnce()).toBe("voice_session_registry_drift");
		expect(bridge.setState).toHaveBeenCalledWith(
			SESSION_ID,
			"lease",
			expect.any(VoiceLease),
			"failed",
			"voice_session_registry_drift",
		);
		expect(stateStore.remove).toHaveBeenCalledWith(SESSION_ID);
	});

	it.each([
		[new Error("network"), false],
		[new BridgeVoiceHttpError(503, "unavailable"), false],
		[new BridgeVoiceHttpError(408, "timeout"), false],
		[new BridgeVoiceHttpError(429, "rate_limited"), false],
		[new BridgeVoiceHttpError(409, "voice_lease_conflict"), true],
		[new BridgeVoiceHttpError(404, "missing"), true],
		[new BridgeVoiceHttpError(403, "forbidden"), true],
	])(
		"recovery receipt %s removes saved authority only when final: %s",
		async (error, final) => {
			const saved = { sessionId: SESSION_ID, leaseToken: "lease", projection };
			const stateStore = {
				save: vi.fn(),
				list: vi.fn(() => [saved]),
				remove: vi.fn(),
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
			if (final) {
				await expect(daemon.recover()).resolves.toBeUndefined();
				expect(stateStore.remove).toHaveBeenCalledWith(SESSION_ID);
			} else {
				await expect(daemon.recover()).rejects.toThrow(error);
				expect(stateStore.remove).not.toHaveBeenCalled();
			}
		},
	);
});

function pending<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function lifetimeFixture() {
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
	const daemon = new VoiceDaemon({
		bridge,
		stateStore: { save: vi.fn(), list: vi.fn(() => []), remove: vi.fn() },
		bootId: "boot",
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
	});
	return { runtime, bridge, daemon, claimedLease, ended };
}

describe("VoiceDaemon session lifetime", () => {
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
			expect(await running).toBe("lease_lost");
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
			expect(await running).toBe("text-stop");
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
				expect(fixture.runtime.stop).toHaveBeenCalledWith(outcome);
				expect(await running).toBe(reason);
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
			expect(await running).toBe("voice-stop");
		} finally {
			vi.useRealTimers();
		}
	});
});
