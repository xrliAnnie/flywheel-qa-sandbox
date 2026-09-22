import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { VoiceSessionRuntime } from "../voice-session-runtime.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const T0 = "2026-09-08T20:00:00.000Z";
let store: StateStore;
let root: string;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "flywheel-voice-runtime-"));
	store = await StateStore.create(join(root, "teamlead.db"));
	store.reserveVoiceSession({
		sessionId: SESSION_ID,
		mode: "meeting",
		projectName: "flywheel",
		leadId: "lead-a",
		guildId: "100000000000000001",
		voiceBotUserId: "100000000000000005",
		voiceChannelId: "100000000000000002",
		requestedBy: "master",
		credentialTier: "master",
		createdAt: T0,
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	store.close();
	rmSync(root, { recursive: true });
});

describe("VoiceSessionRuntime", () => {
	it("scans desired sessions in a wake lane independent of provisioning", async () => {
		store.updateVoiceProvisioning({
			sessionId: SESSION_ID,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: T0,
		});
		const requestWake = vi.fn();
		const runtime = new VoiceSessionRuntime({
			store,
			timing: {
				leaseTtlMs: 15_000,
				leaseRenewMs: 4_000,
				leaseHttpTimeoutMs: 2_000,
				clockSkewGraceMs: 5_000,
				provisioningStaleMs: 120_000,
				endingTimeoutMs: 30_000,
				pollIntervalMs: 3_000,
			},
			now: () => T0,
			provision: vi.fn(() => new Promise(() => {})),
			poll: vi.fn(),
			requestWake,
		});

		await runtime.wakeTick();

		expect(requestWake).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: SESSION_ID, state: "desired" }),
		);
	});

	it("projects one coalesced demand page on the existing tick cadence and retries failures", async () => {
		const recordDemand = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error("health_store_unavailable"))
			.mockResolvedValue(undefined);
		const runtime = new VoiceSessionRuntime({
			store,
			timing: {
				leaseTtlMs: 15_000,
				leaseRenewMs: 4_000,
				leaseHttpTimeoutMs: 2_000,
				clockSkewGraceMs: 5_000,
				provisioningStaleMs: 120_000,
				endingTimeoutMs: 30_000,
				pollIntervalMs: 3_000,
			},
			now: () => "2026-09-18T08:00:00.000Z",
			provision: vi.fn(),
			poll: vi.fn(),
			recordDemand,
		});

		await expect(runtime.tick()).resolves.toBeUndefined();
		await runtime.tick();
		await runtime.tick();
		expect(recordDemand).toHaveBeenCalledTimes(2);
		expect(recordDemand.mock.calls[0]?.[0]).toMatchObject({
			afterCursor: 0,
			nextCursor: 1,
			hasMore: false,
			state: "required",
		});
		expect(recordDemand.mock.calls[1]?.[0]).toEqual(
			recordDemand.mock.calls[0]?.[0],
		);
	});

	it("refreshes an unchanged authoritative demand at most every twenty seconds", async () => {
		let elapsedMs = 0;
		const recordDemand = vi.fn(async () => {});
		const runtime = new VoiceSessionRuntime({
			store,
			timing: {
				leaseTtlMs: 15_000,
				leaseRenewMs: 4_000,
				leaseHttpTimeoutMs: 2_000,
				clockSkewGraceMs: 5_000,
				provisioningStaleMs: 120_000,
				endingTimeoutMs: 30_000,
				pollIntervalMs: 3_000,
			},
			now: () => new Date(Date.parse(T0) + elapsedMs).toISOString(),
			provision: vi.fn(),
			poll: vi.fn(),
			recordDemand,
		});

		await runtime.tick();
		elapsedMs = 19_999;
		await runtime.tick();
		expect(recordDemand).toHaveBeenCalledTimes(1);
		elapsedMs = 20_000;
		await runtime.tick();
		expect(recordDemand).toHaveBeenCalledTimes(2);
		expect(recordDemand.mock.calls[1]?.[0]).toMatchObject({
			events: [],
			hasMore: false,
		});
		// FLY-2693 review R5 (stale-gate-uses-frozen-data-clock): observedAt is
		// the Bridge observation clock, not a frozen row/source timestamp, so an
		// unchanged demand keeps advancing the fixed page's 90s stale gate.
		expect(recordDemand.mock.calls[0]?.[0]).toMatchObject({ observedAt: T0 });
		expect(recordDemand.mock.calls[1]?.[0]).toMatchObject({
			observedAt: new Date(Date.parse(T0) + 20_000).toISOString(),
		});
	});

	// FLY-2693 review R5: a dropped demand trigger must reach the helper as a
	// fail-closed snapshot (rendered unknown), not be swallowed so the page keeps
	// saying dormant; and the cursor must not advance past unread authority.
	it("projects a fail-closed demand snapshot instead of dropping it", async () => {
		let elapsedMs = 0;
		const recordDemand = vi.fn(async () => {});
		const runtime = new VoiceSessionRuntime({
			store,
			timing: {
				leaseTtlMs: 15_000,
				leaseRenewMs: 4_000,
				leaseHttpTimeoutMs: 2_000,
				clockSkewGraceMs: 5_000,
				provisioningStaleMs: 120_000,
				endingTimeoutMs: 30_000,
				pollIntervalMs: 3_000,
			},
			now: () => new Date(Date.parse(T0) + elapsedMs).toISOString(),
			provision: vi.fn(),
			poll: vi.fn(),
			recordDemand,
		});
		await runtime.tick();
		expect(recordDemand).toHaveBeenCalledTimes(1);
		expect(recordDemand.mock.calls[0]?.[0]).toMatchObject({
			sourceStatus: "available",
			state: "required",
			nextCursor: 1,
		});

		store.db.run("DROP TRIGGER voice_health_demand_sessions_update");
		elapsedMs = 20_000;
		await runtime.tick();
		expect(recordDemand).toHaveBeenCalledTimes(2);
		expect(recordDemand.mock.calls[1]?.[0]).toMatchObject({
			sourceStatus: "trigger_invalid",
			state: "unknown",
			observedAt: new Date(Date.parse(T0) + 20_000).toISOString(),
		});

		// Unread authority is not consumed: the next projection reads from the
		// same cursor rather than skipping past the invalid window.
		elapsedMs = 40_000;
		await runtime.tick();
		expect(recordDemand).toHaveBeenCalledTimes(3);
		expect(recordDemand.mock.calls[2]?.[0]).toMatchObject({
			sourceStatus: "trigger_invalid",
			afterCursor: recordDemand.mock.calls[1]?.[0].afterCursor,
		});
	});

	it("hands stale provisioning back to the reducer", async () => {
		const provision = vi.fn(async () => {});
		const runtime = new VoiceSessionRuntime({
			store,
			timing: {
				leaseTtlMs: 15_000,
				leaseRenewMs: 4_000,
				leaseHttpTimeoutMs: 2_000,
				clockSkewGraceMs: 5_000,
				provisioningStaleMs: 120_000,
				endingTimeoutMs: 30_000,
				pollIntervalMs: 3_000,
			},
			now: () => "2026-09-08T20:02:00.001Z",
			provision,
			poll: vi.fn(),
		});
		await runtime.tick();
		expect(provision).toHaveBeenCalledWith(SESSION_ID, expect.any(AbortSignal));
	});

	it("polls only sessions whose lease is still active", async () => {
		store.updateVoiceProvisioning({
			sessionId: SESSION_ID,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: T0,
		});
		store.claimVoiceSession({
			sessionId: SESSION_ID,
			daemonBootId: "boot-a",
			now: T0,
			leaseTtlMs: 15_000,
		});
		const poll = vi.fn(async () => {});
		const runtime = new VoiceSessionRuntime({
			store,
			timing: {
				leaseTtlMs: 15_000,
				leaseRenewMs: 4_000,
				leaseHttpTimeoutMs: 2_000,
				clockSkewGraceMs: 5_000,
				provisioningStaleMs: 120_000,
				endingTimeoutMs: 30_000,
				pollIntervalMs: 3_000,
			},
			now: () => "2026-09-08T20:00:01.000Z",
			provision: vi.fn(),
			poll,
		});
		await runtime.tick();
		expect(poll).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: SESSION_ID, state: "claimed" }),
		);
	});

	it("reports a poll failure without terminalizing the session", async () => {
		store.updateVoiceProvisioning({
			sessionId: SESSION_ID,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: T0,
		});
		store.claimVoiceSession({
			sessionId: SESSION_ID,
			daemonBootId: "boot-a",
			now: T0,
			leaseTtlMs: 15_000,
		});
		const reportPollFailure = vi.fn(async () => {});
		const runtime = new VoiceSessionRuntime({
			store,
			timing: {
				leaseTtlMs: 15_000,
				leaseRenewMs: 4_000,
				leaseHttpTimeoutMs: 2_000,
				clockSkewGraceMs: 5_000,
				provisioningStaleMs: 120_000,
				endingTimeoutMs: 30_000,
				pollIntervalMs: 3_000,
			},
			now: () => "2026-09-08T20:00:01.000Z",
			provision: vi.fn(),
			poll: vi.fn(async () => {
				throw new Error("discord_down");
			}),
			reportPollFailure,
		});
		await expect(runtime.tick()).resolves.toBeUndefined();
		expect(reportPollFailure).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: SESSION_ID }),
			"discord_down",
		);
		expect(store.getVoiceSession(SESSION_ID)?.state).toBe("claimed");
	});
});

const timing = {
	leaseTtlMs: 15_000,
	leaseRenewMs: 4_000,
	leaseHttpTimeoutMs: 2_000,
	clockSkewGraceMs: 5_000,
	provisioningStaleMs: 120_000,
	endingTimeoutMs: 30_000,
	pollIntervalMs: 3_000,
};
const SECOND_ID = "10000000-0000-4000-8000-000000000002";
function reserveSecond() {
	store.reserveVoiceSession({
		sessionId: SECOND_ID,
		mode: "meeting",
		projectName: "flywheel",
		leadId: "lead-b",
		guildId: "100000000000000001",
		voiceBotUserId: "100000000000000005",
		voiceChannelId: "100000000000000003",
		requestedBy: "master",
		credentialTier: "master",
		createdAt: T0,
	});
}

describe("runtime provisioning isolation", () => {
	it("continues later candidates and the next tick after a provision throws", async () => {
		reserveSecond();
		const provision = vi.fn(async (id: string) => {
			if (id === SESSION_ID) throw new Error("registry_drift");
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const runtime = new VoiceSessionRuntime({
			store,
			timing,
			now: () => "2026-09-08T20:02:01.000Z",
			provision,
			poll: vi.fn(),
		});
		await expect(runtime.tick()).resolves.toBeUndefined();
		await expect(runtime.tick()).resolves.toBeUndefined();
		expect(provision.mock.calls.map(([id]) => id)).toEqual([
			SESSION_ID,
			SECOND_ID,
			SESSION_ID,
			SECOND_ID,
		]);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("registry_drift"),
		);
	});
});

it("aborts a stuck provision by deadline and resumes polling and future ticks", async () => {
	reserveSecond();
	store.updateVoiceProvisioning({
		sessionId: SECOND_ID,
		expectedStep: "reserved",
		nextStep: "done",
		nextState: "desired",
		updatedAt: T0,
	});
	store.claimVoiceSession({
		sessionId: SECOND_ID,
		daemonBootId: "boot",
		now: T0,
		leaseTtlMs: 600_000,
	});
	vi.useFakeTimers();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	let signal: AbortSignal | undefined;
	let rejectLate!: (reason: Error) => void;
	const provision = vi.fn((_id: string, attemptSignal?: AbortSignal) => {
		signal = attemptSignal;
		return new Promise<void>((_resolve, reject) => {
			rejectLate = reject;
		});
	});
	const poll = vi.fn(async () => {});
	const runtime = new VoiceSessionRuntime({
		store,
		timing,
		now: () => "2026-09-08T20:02:01.000Z",
		provision,
		poll,
	});
	let finished = false;
	const tick = runtime.tick().then(() => {
		finished = true;
	});
	await runtime.tick(); // overlapping entry is ignored
	expect(provision).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(29_999);
	expect(finished).toBe(false);
	await vi.advanceTimersByTimeAsync(1);
	expect(finished).toBe(true);
	await tick;
	expect(signal?.aborted).toBe(true);
	expect(poll).toHaveBeenCalledTimes(1);
	expect(vi.getTimerCount()).toBe(0);
	rejectLate(new Error("late failure")); // must be consumed by the deadline race
	provision.mockImplementation(async () => {});
	await runtime.tick();
	expect(provision).toHaveBeenCalledTimes(2);
	expect(poll).toHaveBeenCalledTimes(2);
	expect(vi.getTimerCount()).toBe(0);
});

function claimForPolling(id = SESSION_ID) {
	store.updateVoiceProvisioning({
		sessionId: id,
		expectedStep: "reserved",
		nextStep: "done",
		nextState: "desired",
		updatedAt: T0,
	});
	store.claimVoiceSession({
		sessionId: id,
		daemonBootId: "boot",
		now: T0,
		leaseTtlMs: 3_600_000,
	});
}

it("coalesces alternating poll errors with exponential spacing capped at five minutes", async () => {
	claimForPolling();
	let elapsed = 0;
	const reportTimes: number[] = [];
	const poll = vi.fn(async () => {
		throw new Error(elapsed % 2 ? "http_503" : "http_429");
	});
	const runtime = new VoiceSessionRuntime({
		store,
		timing,
		now: () => new Date(Date.parse(T0) + elapsed).toISOString(),
		provision: vi.fn(),
		poll,
		reportPollFailure: () => {
			reportTimes.push(elapsed);
		},
	});
	const times = [
		0, 3_001, 29_999, 30_000, 59_999, 89_999, 90_000, 209_999, 210_000, 449_999,
		450_000, 749_999, 750_000, 1_049_999, 1_050_000,
	];
	for (const at of times) {
		elapsed = at;
		await runtime.tick();
	}
	expect(reportTimes).toEqual([
		0, 30_000, 90_000, 210_000, 450_000, 750_000, 1_050_000,
	]);
	expect(poll).toHaveBeenCalledTimes(times.length);
	expect(store.getVoiceSession(SESSION_ID)?.state).toBe("claimed");
});

it("resets cooldown on successful polling without resetting another session", async () => {
	reserveSecond();
	claimForPolling();
	claimForPolling(SECOND_ID);
	let elapsed = 0;
	const reports: string[] = [];
	const poll = vi.fn(async (session: { sessionId: string }) => {
		if (elapsed === 3_000 && session.sessionId === SESSION_ID) return;
		throw new Error("offline");
	});
	const runtime = new VoiceSessionRuntime({
		store,
		timing,
		now: () => new Date(Date.parse(T0) + elapsed).toISOString(),
		provision: vi.fn(),
		poll,
		reportPollFailure: (session) => {
			reports.push(session.sessionId);
		},
	});
	await runtime.tick();
	elapsed = 3_000;
	await runtime.tick();
	elapsed = 6_000;
	await runtime.tick();
	expect(reports).toEqual([SESSION_ID, SECOND_ID, SESSION_ID]);
	expect(poll).toHaveBeenCalledTimes(6);
});

it("backs off a rejecting status reporter and still polls other sessions", async () => {
	reserveSecond();
	claimForPolling();
	claimForPolling(SECOND_ID);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const poll = vi.fn(async () => {
		throw new Error("offline");
	});
	const reportPollFailure = vi.fn(async () => {
		throw new Error("status_failed");
	});
	const runtime = new VoiceSessionRuntime({
		store,
		timing,
		now: () => T0,
		provision: vi.fn(),
		poll,
		reportPollFailure,
	});
	await expect(runtime.tick()).resolves.toBeUndefined();
	await expect(runtime.tick()).resolves.toBeUndefined();
	expect(poll).toHaveBeenCalledTimes(4);
	expect(reportPollFailure).toHaveBeenCalledTimes(2);
});

it.each(["missing", "unleased"] as const)(
	"forgets cooldown when a session is %s",
	async (state) => {
		claimForPolling();
		const reportPollFailure = vi.fn();
		const runtime = new VoiceSessionRuntime({
			store,
			timing,
			now: () => T0,
			provision: vi.fn(),
			poll: async () => {
				throw new Error("offline");
			},
			reportPollFailure,
		});
		await runtime.tick();
		// Model the session leaving the runtime's active lease set for one scan.
		if (state === "missing")
			vi.spyOn(store, "listVoiceSessions").mockReturnValueOnce([]);
		else vi.spyOn(store, "getActiveVoiceLease").mockReturnValueOnce(undefined);
		await runtime.tick();
		expect(reportPollFailure).toHaveBeenCalledTimes(1);
		await runtime.tick();
		expect(reportPollFailure).toHaveBeenCalledTimes(2);
	},
);

describe("VoiceSessionRuntime launch budget (FLY-2701)", () => {
	function wakeRuntime(
		now: string,
		requestWake: (session: {
			sessionId: string;
		}) => Promise<"coalesced" | "accepted" | "unavailable" | "failed">,
	) {
		return new VoiceSessionRuntime({
			store,
			timing: {
				leaseTtlMs: 15_000,
				leaseRenewMs: 4_000,
				leaseHttpTimeoutMs: 2_000,
				clockSkewGraceMs: 5_000,
				provisioningStaleMs: 120_000,
				endingTimeoutMs: 30_000,
				pollIntervalMs: 3_000,
			},
			now: () => now,
			provision: vi.fn(),
			poll: vi.fn(),
			requestWake,
			newAttemptId: () => `attempt-${now}`,
		});
	}

	beforeEach(() => {
		store.updateVoiceProvisioning({
			sessionId: SESSION_ID,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: T0,
		});
	});

	it("stops asking launchd once three accepted wakes produced no claim", async () => {
		const requestWake = vi.fn(async () => "accepted" as const);
		for (let index = 0; index < 5; index += 1) {
			await wakeRuntime(
				new Date(Date.parse(T0) + index * 60_000).toISOString(),
				requestWake,
			).wakeTick();
		}
		expect(requestWake).toHaveBeenCalledTimes(3);
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			state: "failed",
			reason: "startup_retry_exhausted",
		});
	});

	it("does not spend budget on a coalesced request", async () => {
		const requestWake = vi.fn(async () => "coalesced" as const);
		await wakeRuntime(T0, requestWake).wakeTick();
		expect(store.getVoiceLaunchBudget(SESSION_ID)).toMatchObject({
			provenFailures: 0,
		});
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			state: "desired",
		});
	});

	it("stops on the first configuration fault instead of burning the budget", async () => {
		const requestWake = vi.fn(async () => "unavailable" as const);
		await wakeRuntime(T0, requestWake).wakeTick();
		await wakeRuntime(
			new Date(Date.parse(T0) + 600_000).toISOString(),
			requestWake,
		).wakeTick();
		// One observation is enough: nothing retries a disabled or drifted unit.
		expect(requestWake).toHaveBeenCalledTimes(1);
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			state: "failed",
			reason: "startup_config_invalid",
		});
	});
});
