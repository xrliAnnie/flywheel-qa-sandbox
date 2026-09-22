import { describe, expect, it, vi } from "vitest";
import { VoiceLease, type VoiceSessionProjection } from "../bridge-client.js";
import { type ActiveVoiceSession, VoiceDaemon } from "../daemon.js";

/**
 * FLY-2701 QA negative control for the founder's idle-exit race.
 *
 * On demand, the daemon exits after a run of successful empty reads. The demand
 * that arrives *in that last instant* is the one that can be lost: the Bridge
 * has already written a desired row, the daemon has already decided to leave,
 * and nothing else will wake it until the next scan. The whole point of the
 * final read before exiting is that such a demand is picked up instead of
 * dropped.
 *
 * QA's mutation run showed the existing suite stayed green when that final read
 * was removed — 31 tests could not tell "exited cleanly" apart from "exited
 * while a call was waiting". This test is the missing control: the demand
 * appears only on the very last read, and it must still be claimed exactly
 * once.
 */

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

const projection: VoiceSessionProjection = {
	sessionId: SESSION_ID,
	voiceBotUserId: "323456789012345678",
	mode: "rg",
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

function session(): ActiveVoiceSession {
	return {
		start: vi.fn(async () => ({ founderPresent: true })),
		waitForFounder: vi.fn(async () => true),
		markLive: vi.fn(async () => {}),
		waitForEnd: vi.fn(
			() =>
				new Promise((resolve) =>
					setTimeout(() => resolve({ kind: "ended", reason: "she-left" }), 5),
				),
		),
		requestEnd: vi.fn(),
		speak: vi.fn(async () => "confirmed" as const),
		stop: vi.fn(async () => {}),
	};
}

describe("FLY-2701 idle-exit race (QA negative control)", () => {
	it("claims a demand that only appears on the final read before exiting", async () => {
		// idleExitMs 120s over a 5s poll: 24 sleeps reach the threshold, so the
		// 25th read is the last polling read and the 26th is the final race read.
		const FINAL_READ = 26;
		let elapsed = 0;
		let reads = 0;
		const runtime = session();
		const desired = vi.fn(async () => {
			reads += 1;
			return reads === FINAL_READ ? { sessionId: SESSION_ID } : null;
		});
		const claim = vi.fn(async () => ({
			lease: lease(),
			leaseToken: "lease",
			leaseExpiresAt: "later",
			projection,
		}));
		const daemon = new VoiceDaemon({
			bridge: {
				desired,
				claim,
				renew: vi.fn(async () => ({ state: "live", leaseExpiresAt: "later" })),
				renewRecovered: vi.fn(),
				ready: vi.fn(async () => {}),
				setState: vi.fn(async () => {}),
				outbound: vi.fn(async () => []),
				claimOutbound: vi.fn(),
				receipt: vi.fn(async () => {}),
			},
			stateStore: {
				save: vi.fn(),
				list: vi.fn(() => []),
				remove: vi.fn(),
				quarantine: vi.fn(),
			},
			bootId: "boot",
			createSession: () => runtime,
			recoverSession: vi.fn(),
			sleep: vi.fn(async (ms: number) => {
				elapsed += ms;
			}),
			monotonicNow: () => elapsed,
			timing: {
				idlePollMs: 5_000,
				idleExitMs: 120_000,
				leaseRenewMs: 4_000,
				leaseMissMax: 2,
				presenceGraceMs: 600_000,
				speechChunkTokens: 600,
			},
		});

		await daemon.run();

		// The demand written in the exit instant is served, not dropped. (After
		// serving it the daemon idles again and exits on a later empty run, so the
		// read count keeps climbing; what matters is that this one was claimed.)
		expect(reads).toBeGreaterThanOrEqual(FINAL_READ);
		expect(claim).toHaveBeenCalledTimes(1);
		expect(claim).toHaveBeenCalledWith(SESSION_ID, "boot");
		expect(runtime.start).toHaveBeenCalledTimes(1);
	});

	it("exits without claiming anything when the final read is genuinely empty", async () => {
		let elapsed = 0;
		const desired = vi.fn(async () => null);
		const claim = vi.fn();
		const daemon = new VoiceDaemon({
			bridge: {
				desired,
				claim,
				renew: vi.fn(),
				renewRecovered: vi.fn(),
				ready: vi.fn(),
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
			sleep: vi.fn(async (ms: number) => {
				elapsed += ms;
			}),
			monotonicNow: () => elapsed,
			timing: {
				idlePollMs: 5_000,
				idleExitMs: 120_000,
				leaseRenewMs: 4_000,
				leaseMissMax: 2,
				presenceGraceMs: 600_000,
				speechChunkTokens: 600,
			},
		});

		await daemon.run();

		expect(claim).not.toHaveBeenCalled();
		expect(elapsed).toBe(120_000);
	});
});
