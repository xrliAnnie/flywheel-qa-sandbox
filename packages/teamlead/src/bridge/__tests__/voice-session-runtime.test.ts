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
		voiceChannelId: "100000000000000002",
		requestedBy: "master",
		credentialTier: "master",
		createdAt: T0,
	});
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true });
});

describe("VoiceSessionRuntime", () => {
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
		expect(provision).toHaveBeenCalledWith(SESSION_ID);
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
