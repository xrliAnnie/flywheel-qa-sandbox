import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	BridgeVoiceHttpError,
	BridgeVoiceRequestError,
	VoiceLease,
	type VoiceSessionProjection,
} from "../bridge-client.js";
import {
	type ActiveVoiceSession,
	VoiceDaemon,
	type VoiceDaemonOptions,
} from "../daemon.js";
import {
	type VoiceHealthCommandClient,
	VoiceHealthHelperClient,
	type VoiceHealthObservation,
	VoiceHealthReporter,
} from "../health.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const MEETING_ID = "22222222-2222-4222-8222-222222222222";
const projection: VoiceSessionProjection = {
	sessionId: SESSION_ID,
	voiceBotUserId: "323456789012345678",
	mode: "meeting",
	meetingId: MEETING_ID,
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
	const value = new VoiceLease(() => Date.now());
	value.install(Date.now(), 15_000, 2_000);
	return value;
}

function bridgeError(operation: "desired" | "claim" = "desired") {
	return new BridgeVoiceRequestError({
		operation,
		method: operation === "desired" ? "GET" : "POST",
		routeTemplate:
			operation === "desired"
				? "/api/voice/sessions/desired"
				: "/api/voice/sessions/:sessionId/claim",
		requestId: "33333333-3333-4333-8333-333333333333",
		elapsedMs: 2_001,
		phase: "headers",
		timeoutMs: 2_000,
		reasonClass: "bridge_timeout_headers",
		causeCode: "request_timeout",
	});
}

function baseOptions(
	overrides: Partial<VoiceDaemonOptions> = {},
): VoiceDaemonOptions {
	return {
		bridge: {
			desired: vi.fn(async () => null),
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
			quarantine: vi.fn(),
			remove: vi.fn(),
		},
		bootId: "44444444-4444-4444-8444-444444444444",
		createSession: vi.fn(),
		recoverSession: vi.fn(),
		sleep: vi.fn(async () => {}),
		timing: {
			idlePollMs: 5_000,
			leaseRenewMs: 4_000,
			leaseMissMax: 2,
			presenceGraceMs: 120_000,
			speechChunkTokens: 600,
		},
		...overrides,
	};
}

describe("VoiceDaemon health observations", () => {
	it("returns idle promptly and keeps idle sleeping in run", async () => {
		const sleep = vi.fn(async () => {});
		const daemon = new VoiceDaemon(baseOptions({ sleep }));

		await expect(daemon.runOnce()).resolves.toEqual({ kind: "idle_success" });
		expect(sleep).not.toHaveBeenCalled();
	});

	it("uses 5/10/20/30 second failure backoff, resets on success, and emits only closed diagnostics", async () => {
		const outcomes: Array<Error | null> = [
			bridgeError(),
			bridgeError(),
			bridgeError(),
			null,
			bridgeError(),
			bridgeError(),
			bridgeError(),
			bridgeError(),
		];
		const observations: VoiceHealthObservation[] = [];
		const health = { observe: vi.fn((value) => observations.push(value)) };
		let daemon!: VoiceDaemon;
		const desired = vi.fn(async () => {
			const outcome = outcomes.shift();
			if (outcome) throw outcome;
			return null;
		});
		const delays: number[] = [];
		const sleep = vi.fn(async (ms: number) => {
			delays.push(ms);
			if (outcomes.length === 0) daemon.shutdown();
		});
		daemon = new VoiceDaemon(
			baseOptions({
				bridge: { ...baseOptions().bridge, desired },
				health,
				sleep,
			}),
		);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			await daemon.run();
		} finally {
			log.mockRestore();
		}

		expect(delays).toEqual([
			5_000, 10_000, 20_000, 5_000, 5_000, 10_000, 20_000, 30_000,
		]);
		expect(observations.filter(({ kind }) => kind === "poll_failed")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "poll_failed",
					operation: "desired",
					reasonClass: "bridge_timeout_headers",
					durationMs: 2_001,
				}),
			]),
		);
		expect(observations.map(({ kind }) => kind)).toContain("idle_success");
		expect(observations.at(-1)?.kind).toBe("daemon_stopped");
		expect(JSON.stringify(observations)).not.toContain("/api/voice");
	});

	it("maps an arbitrary poll error to unknown_failure without logging its message", async () => {
		const raw = "secret-token /api/voice/sessions/private-session";
		const health = { observe: vi.fn() };
		let daemon!: VoiceDaemon;
		daemon = new VoiceDaemon(
			baseOptions({
				bridge: {
					...baseOptions().bridge,
					desired: vi.fn(async () => {
						throw new Error(raw);
					}),
				},
				health,
				sleep: vi.fn(async () => daemon.shutdown()),
			}),
		);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			await daemon.run();
			expect(health.observe).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "poll_failed",
					reasonClass: "unknown_failure",
					operation: "desired",
				}),
			);
			expect(log.mock.calls.flat().join(" ")).not.toContain(raw);
		} finally {
			log.mockRestore();
		}
	});

	it("preserves a legacy HTTP diagnostic for desired polling without exposing its raw reason", async () => {
		const raw = "upstream-secret-reason";
		const error = new BridgeVoiceHttpError(503, raw, {
			operation: "desired",
			method: "GET",
			routeTemplate: "/api/voice/sessions/desired",
			requestId: "88888888-8888-4888-8888-888888888888",
			elapsedMs: 17,
			phase: "body",
			status: 503,
			timeoutMs: 2_000,
			reasonClass: "bridge_http_error",
			causeCode: "http_5xx",
		});
		const health = { observe: vi.fn() };
		let daemon!: VoiceDaemon;
		daemon = new VoiceDaemon(
			baseOptions({
				bridge: {
					...baseOptions().bridge,
					desired: vi.fn(async () => {
						throw error;
					}),
				},
				health,
				sleep: vi.fn(async () => daemon.shutdown()),
			}),
		);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			await daemon.run();
			expect(health.observe).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "poll_failed",
					reasonClass: "bridge_http_error",
					operation: "desired",
					durationMs: 17,
				}),
			);
			expect(log.mock.calls.flat().join(" ")).not.toContain(raw);
		} finally {
			log.mockRestore();
		}
	});

	it("sanitizes arbitrary session errors, uses meeting demand identity, and never lets health failure block cleanup", async () => {
		const raw = "secret-token /api/voice/sessions/private-session";
		const setState = vi.fn(async () => {});
		const remove = vi.fn();
		const health = {
			observe: vi.fn(() => {
				throw new Error("health backend unavailable");
			}),
		};
		const daemon = new VoiceDaemon(
			baseOptions({
				bridge: {
					...baseOptions().bridge,
					desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
					claim: vi.fn(async () => ({
						lease: lease(),
						leaseToken: "lease",
						leaseExpiresAt: "later",
						projection,
					})),
					setState,
				},
				stateStore: {
					save: vi.fn(),
					list: vi.fn(() => []),
					quarantine: vi.fn(),
					remove,
				},
				createSession: vi.fn(() => {
					throw new Error(raw);
				}),
				health,
			}),
		);

		await expect(daemon.runOnce()).resolves.toEqual({
			kind: "session_failed",
			sessionId: SESSION_ID,
			reason: "session_create_failed",
		});
		expect(setState).toHaveBeenCalledWith(
			SESSION_ID,
			"lease",
			expect.any(VoiceLease),
			"failed",
			"session_create_failed",
		);
		expect(remove).toHaveBeenCalledWith(SESSION_ID);
		expect(health.observe).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "session_failed",
				demandId: MEETING_ID,
				attemptId: SESSION_ID,
				reasonClass: "session_create_failed",
				operation: "session_create",
			}),
		);
		expect(JSON.stringify(health.observe.mock.calls)).not.toContain(raw);
	});

	it("records a create failure before a rejected terminal receipt and retains recovery state", async () => {
		const raw = "terminal secret-token /private/session/path";
		const order: string[] = [];
		const health = {
			observe: vi.fn((observation: VoiceHealthObservation) => {
				if (observation.kind === "session_failed") order.push("health");
			}),
		};
		const remove = vi.fn();
		const setState = vi.fn(async () => {
			order.push("terminal");
			throw new Error(raw);
		});
		const daemon = new VoiceDaemon(
			baseOptions({
				bridge: {
					...baseOptions().bridge,
					desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
					claim: vi.fn(async () => ({
						lease: lease(),
						leaseToken: "lease",
						leaseExpiresAt: "later",
						projection,
					})),
					setState,
				},
				stateStore: {
					save: vi.fn(),
					list: vi.fn(() => []),
					quarantine: vi.fn(),
					remove,
				},
				createSession: vi.fn(() => {
					throw new Error("create raw secret");
				}),
				health,
			}),
		);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			await expect(daemon.runOnce()).resolves.toEqual({
				kind: "session_failed",
				sessionId: SESSION_ID,
				reason: "session_create_failed",
			});
			expect(order).toEqual(["health", "terminal"]);
			expect(health.observe).toHaveBeenCalledTimes(1);
			expect(remove).not.toHaveBeenCalled();
			expect(log.mock.calls.flat().join(" ")).not.toContain(raw);
		} finally {
			log.mockRestore();
		}
	});

	it("records the original runtime failure before a rejected terminal receipt and retains recovery state", async () => {
		const raw = "runtime terminal secret-token /private/session/path";
		const order: string[] = [];
		const health = {
			observe: vi.fn((observation: VoiceHealthObservation) => {
				if (observation.kind === "session_failed") order.push("health");
			}),
		};
		const runtime: ActiveVoiceSession = {
			start: vi.fn(async () => {
				throw new Error("runtime primary raw secret");
			}),
			waitForFounder: vi.fn(async () => true),
			receiveHealth: vi.fn(() => undefined),
			markLive: vi.fn(async () => {}),
			waitForEnd: vi.fn(() => new Promise(() => {})),
			requestEnd: vi.fn(),
			speak: vi.fn(async () => "confirmed"),
			stop: vi.fn(async () => {}),
		};
		const remove = vi.fn();
		const setState = vi.fn(async (_id, _token, _lease, state: string) => {
			if (state === "failed") {
				order.push("terminal");
				throw new Error(raw);
			}
		});
		const daemon = new VoiceDaemon(
			baseOptions({
				bridge: {
					...baseOptions().bridge,
					desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
					claim: vi.fn(async () => ({
						lease: lease(),
						leaseToken: "lease",
						leaseExpiresAt: "later",
						projection,
					})),
					setState,
				},
				stateStore: {
					save: vi.fn(),
					list: vi.fn(() => []),
					quarantine: vi.fn(),
					remove,
				},
				createSession: () => runtime,
				health,
			}),
		);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			await expect(daemon.runOnce()).resolves.toEqual({
				kind: "session_failed",
				sessionId: SESSION_ID,
				reason: "Error:runtime primary raw secret",
			});
			expect(order).toEqual(["health", "terminal"]);
			expect(health.observe).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "session_failed",
					reasonClass: "session_runtime_failed",
					operation: "session_runtime",
				}),
			);
			expect(remove).not.toHaveBeenCalled();
			const logged = log.mock.calls.flat().join(" ");
			expect(logged).toContain("Error:runtime primary raw secret");
			expect(logged).not.toContain(raw);
		} finally {
			log.mockRestore();
		}
	});

	it("preserves closed Bridge request classification for a session failure", async () => {
		const runtime: ActiveVoiceSession = {
			start: vi.fn(async () => ({ founderPresent: true })),
			waitForFounder: vi.fn(async () => true),
			receiveHealth: vi.fn(() => undefined),
			markLive: vi.fn(async () => {}),
			waitForEnd: vi.fn(() => new Promise(() => {})),
			requestEnd: vi.fn(),
			speak: vi.fn(async () => "confirmed"),
			stop: vi.fn(async () => {}),
		};
		const requestError = new BridgeVoiceRequestError({
			operation: "state",
			method: "POST",
			routeTemplate: "/api/voice/sessions/:sessionId/state",
			requestId: "77777777-7777-4777-8777-777777777777",
			elapsedMs: 41,
			phase: "headers",
			status: 401,
			timeoutMs: 2_000,
			reasonClass: "bridge_auth_rejected",
			causeCode: "http_401",
		});
		const setState = vi
			.fn()
			.mockRejectedValueOnce(requestError)
			.mockResolvedValueOnce(undefined);
		const health = { observe: vi.fn() };
		const daemon = new VoiceDaemon(
			baseOptions({
				bridge: {
					...baseOptions().bridge,
					desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
					claim: vi.fn(async () => ({
						lease: lease(),
						leaseToken: "lease",
						leaseExpiresAt: "later",
						projection,
					})),
					setState,
				},
				createSession: () => runtime,
				health,
			}),
		);

		await expect(daemon.runOnce()).resolves.toEqual({
			kind: "session_failed",
			sessionId: SESSION_ID,
			reason: "bridge_auth_rejected",
		});
		expect(health.observe).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "session_failed",
				reasonClass: "bridge_auth_rejected",
				operation: "state",
			}),
		);
	});

	it("preserves a legacy HTTP diagnostic for a session failure while keeping 409 fenced", async () => {
		const runtime: ActiveVoiceSession = {
			start: vi.fn(async () => ({ founderPresent: true })),
			waitForFounder: vi.fn(async () => true),
			receiveHealth: vi.fn(() => undefined),
			markLive: vi.fn(async () => {}),
			waitForEnd: vi.fn(() => new Promise(() => {})),
			requestEnd: vi.fn(),
			speak: vi.fn(async () => "confirmed"),
			stop: vi.fn(async () => {}),
		};
		const raw = "forbidden raw upstream reason";
		const requestError = new BridgeVoiceHttpError(403, raw, {
			operation: "state",
			method: "POST",
			routeTemplate: "/api/voice/sessions/:sessionId/state",
			requestId: "99999999-9999-4999-8999-999999999999",
			elapsedMs: 23,
			phase: "body",
			status: 403,
			timeoutMs: 2_000,
			reasonClass: "bridge_auth_rejected",
			causeCode: "http_403",
		});
		const setState = vi
			.fn()
			.mockRejectedValueOnce(requestError)
			.mockResolvedValueOnce(undefined);
		const health = { observe: vi.fn() };
		const daemon = new VoiceDaemon(
			baseOptions({
				bridge: {
					...baseOptions().bridge,
					desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
					claim: vi.fn(async () => ({
						lease: lease(),
						leaseToken: "lease",
						leaseExpiresAt: "later",
						projection,
					})),
					setState,
				},
				createSession: () => runtime,
				health,
			}),
		);

		await expect(daemon.runOnce()).resolves.toEqual({
			kind: "session_failed",
			sessionId: SESSION_ID,
			reason: "bridge_auth_rejected",
		});
		expect(health.observe).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "session_failed",
				reasonClass: "bridge_auth_rejected",
				operation: "state",
			}),
		);
		expect(JSON.stringify(health.observe.mock.calls)).not.toContain(raw);

		const fencedHealth = { observe: vi.fn() };
		const fenced = new VoiceDaemon(
			baseOptions({
				bridge: {
					...baseOptions().bridge,
					desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
					claim: vi.fn(async () => ({
						lease: lease(),
						leaseToken: "lease",
						leaseExpiresAt: "later",
						projection,
					})),
					setState: vi
						.fn()
						.mockRejectedValueOnce(
							new BridgeVoiceHttpError(409, "raw-conflict", {
								...requestError.diagnostic!,
								status: 409,
								reasonClass: "bridge_http_error",
								causeCode: "http_4xx",
							}),
						)
						.mockResolvedValueOnce(undefined),
				},
				createSession: () => runtime,
				health: fencedHealth,
			}),
		);
		await expect(fenced.runOnce()).resolves.toMatchObject({
			kind: "session_failed",
			reason: "lease_lost",
		});
		expect(fencedHealth.observe).toHaveBeenCalledWith(
			expect.objectContaining({
				reasonClass: "lease_lost",
				operation: "state",
			}),
		);
	});

	it("samples successful lease renewals as nonblocking progress", async () => {
		vi.useFakeTimers();
		try {
			let finish!: (value: { kind: "ended"; reason: "voice-stop" }) => void;
			const ended = new Promise<{ kind: "ended"; reason: "voice-stop" }>(
				(resolve) => {
					finish = resolve;
				},
			);
			const runtime: ActiveVoiceSession = {
				start: vi.fn(async () => ({ founderPresent: true })),
				waitForFounder: vi.fn(async () => true),
				receiveHealth: vi.fn(() => undefined),
				markLive: vi.fn(async () => {}),
				waitForEnd: vi.fn(() => ended),
				requestEnd: vi.fn(),
				speak: vi.fn(async () => "confirmed"),
				stop: vi.fn(async () => {}),
			};
			const claimedLease = lease();
			const renew = vi.fn(async () => {
				claimedLease.install(Date.now(), 15_000, 2_000);
				return { state: "live", leaseExpiresAt: "later" };
			});
			const health = {
				observe: vi.fn((observation: VoiceHealthObservation) => {
					if (observation.kind === "progress")
						throw new Error("health helper unavailable with secret-token");
				}),
			};
			const daemon = new VoiceDaemon(
				baseOptions({
					bridge: {
						...baseOptions().bridge,
						desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
						claim: vi.fn(async () => ({
							lease: claimedLease,
							leaseToken: "lease",
							leaseExpiresAt: "later",
							projection,
						})),
						renew,
						setState: vi.fn(async () => {}),
						outbound: vi.fn(async () => []),
					},
					createSession: () => runtime,
					health,
					timing: { ...baseOptions().timing, leaseMissMax: 1 },
				}),
			);
			const log = vi
				.spyOn(console, "error")
				.mockImplementation(() => undefined);
			const running = daemon.runOnce();
			await vi.advanceTimersByTimeAsync(20_000);
			expect(renew).toHaveBeenCalledTimes(5);
			expect(
				health.observe.mock.calls.filter(
					([value]) => (value as VoiceHealthObservation).kind === "progress",
				),
			).toHaveLength(5);
			finish({ kind: "ended", reason: "voice-stop" });
			await expect(running).resolves.toMatchObject({ kind: "session_ended" });
			expect(log.mock.calls.flat().join(" ")).not.toContain("secret-token");
			log.mockRestore();
		} finally {
			vi.useRealTimers();
		}
	});

	it("emits recovery and normal end only from an actual live-then-renew proof", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-18T10:00:00.000Z"));
		try {
			let finish!: (value: { kind: "ended"; reason: "voice-stop" }) => void;
			let finishLive!: () => void;
			const ended = new Promise<{ kind: "ended"; reason: "voice-stop" }>(
				(resolve) => {
					finish = resolve;
				},
			);
			const markedLive = new Promise<void>((resolve) => {
				finishLive = resolve;
			});
			const runtime: ActiveVoiceSession = {
				start: vi.fn(async () => ({ founderPresent: true })),
				waitForFounder: vi.fn(async () => true),
				receiveHealth: vi.fn(() => undefined),
				markLive: vi.fn(() => markedLive),
				waitForEnd: vi.fn(() => ended),
				requestEnd: vi.fn(),
				speak: vi.fn(async () => "confirmed"),
				stop: vi.fn(async () => {}),
			};
			const claimedLease = lease();
			const renew = vi.fn(async () => {
				claimedLease.install(Date.now(), 15_000, 2_000);
				return { state: "live", leaseExpiresAt: "later" };
			});
			const health = { observe: vi.fn() };
			const daemon = new VoiceDaemon(
				baseOptions({
					bridge: {
						...baseOptions().bridge,
						desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
						claim: vi.fn(async () => ({
							lease: claimedLease,
							leaseToken: "lease",
							leaseExpiresAt: "later",
							projection,
						})),
						renew,
						setState: vi.fn(async () => {}),
						outbound: vi.fn(async () => []),
					},
					createSession: () => runtime,
					health,
				}),
			);
			const running = daemon.runOnce();
			await vi.advanceTimersByTimeAsync(8_000);
			expect(
				health.observe.mock.calls.some(
					([value]) =>
						(value as VoiceHealthObservation).kind === "session_recovered",
				),
			).toBe(false);
			finishLive();
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(4_000);
			const recovered = health.observe.mock.calls
				.map(([value]) => value as VoiceHealthObservation)
				.filter(({ kind }) => kind === "session_recovered");
			expect(recovered).toHaveLength(1);
			expect(recovered[0]).toMatchObject({
				demandId: MEETING_ID,
				successorAttemptId: SESSION_ID,
			});
			if (recovered[0]?.kind !== "session_recovered")
				throw new Error("missing recovery proof");
			expect(Date.parse(recovered[0].renewAt)).toBeGreaterThan(
				Date.parse(recovered[0].liveAt),
			);
			finish({ kind: "ended", reason: "voice-stop" });
			await vi.advanceTimersByTimeAsync(0);
			await expect(running).resolves.toMatchObject({ kind: "session_ended" });
			expect(health.observe).toHaveBeenCalledWith({
				kind: "session_ended",
				observedAt: expect.any(String),
				demandId: MEETING_ID,
				successorAttemptId: SESSION_ID,
				liveAt: recovered[0].liveAt,
				renewAt: recovered[0].renewAt,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("treats RequestError 409 as fenced and preserves renew or outbound operation", async () => {
		vi.useFakeTimers();
		try {
			for (const operation of ["renew", "outbound"] as const) {
				const runtime: ActiveVoiceSession = {
					start: vi.fn(async () => ({ founderPresent: true })),
					waitForFounder: vi.fn(async () => true),
					receiveHealth: vi.fn(() => undefined),
					markLive: vi.fn(async () => {}),
					waitForEnd: vi.fn(() => new Promise(() => {})),
					requestEnd: vi.fn(),
					speak: vi.fn(async () => "confirmed"),
					stop: vi.fn(async () => {}),
				};
				const requestError = new BridgeVoiceRequestError({
					operation,
					method: "GET",
					routeTemplate: `/api/voice/sessions/:sessionId/${operation}`,
					requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					elapsedMs: 5,
					phase: "body",
					status: 409,
					timeoutMs: 2_000,
					reasonClass: "bridge_http_error",
					causeCode: "http_4xx",
				});
				const health = { observe: vi.fn() };
				const claimOutbound = vi.fn();
				const claimedLease = lease();
				const daemon = new VoiceDaemon(
					baseOptions({
						bridge: {
							...baseOptions().bridge,
							desired: vi.fn(async () => ({ sessionId: SESSION_ID })),
							claim: vi.fn(async () => ({
								lease: claimedLease,
								leaseToken: "lease",
								leaseExpiresAt: "later",
								projection,
							})),
							setState: vi.fn(async () => {}),
							renew:
								operation === "renew"
									? vi.fn(async () => {
											throw requestError;
										})
									: vi.fn(),
							outbound:
								operation === "outbound"
									? vi.fn(async () => {
											throw requestError;
										})
									: vi.fn(async () => []),
							claimOutbound,
						},
						createSession: () => runtime,
						health,
					}),
				);
				const running = daemon.runOnce();
				if (operation === "renew") await vi.advanceTimersByTimeAsync(4_000);
				await expect(running).resolves.toMatchObject({
					kind: "session_failed",
					reason: "lease_lost",
				});
				expect(health.observe).toHaveBeenCalledWith(
					expect.objectContaining({
						reasonClass: "lease_lost",
						operation,
					}),
				);
				expect(claimOutbound).not.toHaveBeenCalled();
				expect(runtime.speak).not.toHaveBeenCalled();
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("opens on the third required-demand poll failure, closes on idle success, and opens a fresh later episode", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "voice-health-daemon-"));
		try {
			const helper = new VoiceHealthHelperClient({
				helperPath: resolve(process.cwd(), "../../scripts/lib/voice-health.py"),
				stateRoot,
			});
			const resultReceipts: Array<{
				payload: Record<string, unknown>;
				receipt: Record<string, unknown>;
			}> = [];
			const client: VoiceHealthCommandClient = {
				invoke: async (command, payload) => {
					const receipt = await helper.invoke(command, payload);
					if (command === "record-result")
						resultReceipts.push({
							payload: structuredClone(payload),
							receipt: structuredClone(receipt),
						});
					return receipt;
				},
			};
			let wallMs = Date.parse("2026-09-18T10:00:02.000Z");
			const reporter = new VoiceHealthReporter({
				client,
				bootId: "55555555-5555-4555-8555-555555555555",
				stateRoot,
				now: () => new Date(wallMs),
				monotonicNow: () => wallMs,
			});
			await reporter.registerBoot();
			const identities = [{ demandId: MEETING_ID }];
			await helper.invoke("record-demand", {
				demandSourceId: "66666666-6666-4666-8666-666666666666",
				revision: 1,
				digest: createHash("sha256")
					.update(JSON.stringify(identities))
					.digest("hex"),
				state: "required",
				observedAt: "2026-09-18T10:00:01.000Z",
				identities,
			});

			const outcomes: Array<Error | null> = [
				bridgeError(),
				bridgeError(),
				bridgeError(),
				null,
				bridgeError(),
				bridgeError(),
				bridgeError(),
			];
			let daemon!: VoiceDaemon;
			const desired = vi.fn(async () => {
				const outcome = outcomes.shift();
				if (outcome) throw outcome;
				return null;
			});
			const delays: number[] = [];
			daemon = new VoiceDaemon(
				baseOptions({
					bridge: { ...baseOptions().bridge, desired },
					health: reporter,
					now: () => new Date(wallMs),
					monotonicNow: () => wallMs,
					sleep: vi.fn(async (ms: number) => {
						delays.push(ms);
						wallMs += ms;
						if (outcomes.length === 0) daemon.shutdown();
					}),
				}),
			);
			const log = vi
				.spyOn(console, "error")
				.mockImplementation(() => undefined);
			try {
				await daemon.run();
			} finally {
				log.mockRestore();
			}
			reporter.stop();
			await reporter.whenSettled();

			const failures = resultReceipts.filter(
				({ payload }) => payload.resultKind === "poll_failed",
			);
			expect(
				failures.map(({ receipt }) => Object.hasOwn(receipt, "episode")),
			).toEqual([false, false, true, false, false, true]);
			const idle = resultReceipts.find(
				({ payload }) => payload.resultKind === "idle_success",
			);
			expect(idle?.receipt).toHaveProperty("closedEpisodeId");
			expect(delays).toEqual([
				5_000, 10_000, 20_000, 5_000, 5_000, 10_000, 20_000,
			]);

			const exported = await helper.invoke("export", {});
			expect(exported.openEpisodes).toEqual([
				expect.objectContaining({ scope: "poll_dependency" }),
			]);
			expect(exported.notifications).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ state: "cancelled_recovered" }),
					expect.objectContaining({ state: "pending" }),
				]),
			);
		} finally {
			await rm(stateRoot, { recursive: true, force: true });
		}
	});
});
