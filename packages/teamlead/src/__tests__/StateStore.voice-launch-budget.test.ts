import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const T0 = "2026-09-22T08:00:00.000Z";

let store: StateStore;
let root: string;

function desired(): void {
	store.reserveVoiceSession({
		sessionId: SESSION_ID,
		mode: "rg",
		projectName: "flywheel",
		leadId: "lead-a",
		guildId: "100000000000000001",
		voiceBotUserId: "100000000000000005",
		voiceChannelId: "100000000000000002",
		requestedBy: "master",
		credentialTier: "master",
		createdAt: T0,
	});
	store.updateVoiceProvisioning({
		sessionId: SESSION_ID,
		expectedStep: "reserved",
		nextStep: "done",
		nextState: "desired",
		updatedAt: T0,
	});
}

function at(offsetMs: number): string {
	return new Date(Date.parse(T0) + offsetMs).toISOString();
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "flywheel-voice-launch-"));
	store = await StateStore.create(join(root, "teamlead.db"));
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true });
});

describe("StateStore voice launch budget", () => {
	it("allows the first wake and holds the next one behind a backoff", () => {
		desired();
		expect(
			store.admitVoiceLaunchAttempt({
				sessionId: SESSION_ID,
				attemptId: "40000000-0000-4000-8000-000000000001",
				now: T0,
			}),
		).toMatchObject({ status: "admitted" });
		// An accepted command that has not yet had time to produce a claim is not
		// a failure, so the next attempt waits rather than spraying kickstarts.
		store.recordVoiceLaunchResult({
			attemptId: "40000000-0000-4000-8000-000000000001",
			commandResult: "accepted",
			observedAt: at(10),
		});
		expect(
			store.admitVoiceLaunchAttempt({
				sessionId: SESSION_ID,
				attemptId: "40000000-0000-4000-8000-000000000002",
				now: at(3_000),
			}),
		).toMatchObject({ status: "deferred" });
		expect(
			store.admitVoiceLaunchAttempt({
				sessionId: SESSION_ID,
				attemptId: "40000000-0000-4000-8000-000000000002",
				now: at(60_000),
			}),
		).toMatchObject({ status: "admitted" });
	});

	it("exhausts the budget after three accepted wakes that never produced a claim", () => {
		desired();
		let now = 0;
		for (let index = 1; index <= 3; index += 1) {
			const attemptId = `40000000-0000-4000-8000-00000000000${index}`;
			expect(
				store.admitVoiceLaunchAttempt({
					sessionId: SESSION_ID,
					attemptId,
					now: at(now),
				}),
			).toMatchObject({ status: "admitted" });
			store.recordVoiceLaunchResult({
				attemptId,
				commandResult: "accepted",
				observedAt: at(now + 10),
			});
			now += 60_000;
		}
		expect(
			store.admitVoiceLaunchAttempt({
				sessionId: SESSION_ID,
				attemptId: "40000000-0000-4000-8000-000000000004",
				now: at(now),
			}),
		).toMatchObject({
			status: "exhausted",
			provenFailures: 3,
		});
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			state: "desired",
		});
	});

	it("does not count an unknown command result as a proven failure", () => {
		desired();
		for (let index = 1; index <= 5; index += 1) {
			const attemptId = `40000000-0000-4000-8000-00000000000${index}`;
			store.admitVoiceLaunchAttempt({
				sessionId: SESSION_ID,
				attemptId,
				now: at((index - 1) * 60_000),
			});
			store.recordVoiceLaunchResult({
				attemptId,
				commandResult: "unknown",
				observedAt: at((index - 1) * 60_000 + 10),
			});
		}
		expect(
			store.admitVoiceLaunchAttempt({
				sessionId: SESSION_ID,
				attemptId: "40000000-0000-4000-8000-00000000000f",
				now: at(600_000),
			}),
		).toMatchObject({ status: "admitted" });
	});

	it("stops immediately on a permanent configuration failure", () => {
		desired();
		store.admitVoiceLaunchAttempt({
			sessionId: SESSION_ID,
			attemptId: "40000000-0000-4000-8000-000000000001",
			now: T0,
		});
		store.recordVoiceLaunchResult({
			attemptId: "40000000-0000-4000-8000-000000000001",
			commandResult: "unavailable",
			failureClass: "startup_config_invalid",
			observedAt: at(10),
		});
		expect(
			store.admitVoiceLaunchAttempt({
				sessionId: SESSION_ID,
				attemptId: "40000000-0000-4000-8000-000000000002",
				now: at(600_000),
			}),
		).toMatchObject({
			status: "exhausted",
			failureClass: "startup_config_invalid",
		});
	});

	it("a claim clears the budget, so a later session starts from zero", () => {
		desired();
		store.admitVoiceLaunchAttempt({
			sessionId: SESSION_ID,
			attemptId: "40000000-0000-4000-8000-000000000001",
			now: T0,
		});
		store.recordVoiceLaunchResult({
			attemptId: "40000000-0000-4000-8000-000000000001",
			commandResult: "accepted",
			observedAt: at(10),
		});
		const claim = store.claimVoiceSession({
			sessionId: SESSION_ID,
			daemonBootId: "boot-1",
			now: at(5_000),
			leaseTtlMs: 15_000,
		});
		expect(claim).toBeDefined();
		// The claim is the only proof a boot actually arrived; it belongs to the
		// attempt that asked for it.
		expect(store.getVoiceLaunchBudget(SESSION_ID)).toMatchObject({
			provenFailures: 0,
			claimed: true,
		});
	});

	it("keeps each session's budget to itself", () => {
		desired();
		store.admitVoiceLaunchAttempt({
			sessionId: SESSION_ID,
			attemptId: "40000000-0000-4000-8000-000000000001",
			now: T0,
		});
		store.recordVoiceLaunchResult({
			attemptId: "40000000-0000-4000-8000-000000000001",
			commandResult: "accepted",
			observedAt: at(10),
		});
		expect(
			store.getVoiceLaunchBudget("10000000-0000-4000-8000-0000000000ff"),
		).toMatchObject({ provenFailures: 0, attempts: 0 });
	});
});
