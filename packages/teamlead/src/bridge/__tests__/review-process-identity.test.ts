import { describe, expect, it, vi } from "vitest";
import type { CodexReviewAttempt } from "../../StateStore.js";
import {
	probeRetiredReviewAttempt,
	type ReviewProcessIdentityDeps,
	terminateRetiredReviewAttempt,
} from "../review-process-identity.js";

const start = "Sat Sep 26 10:00:00 2026";
const job = { request_id: "r1", execution_id: "e1", target_repo_path: "/repo" };
const attempt: CodexReviewAttempt = {
	request_id: "r1",
	attempt_generation: 1,
	reviewer_session_uuid: "session-1",
	owner_boot_id: "boot-1",
	reviewer_started_at: new Date(start).toISOString(),
	configured_timeout_ms: 1000,
	deadline_at: new Date(Date.parse(start) + 1000).toISOString(),
	pid: null,
	pgid: null,
	process_started_at: null,
	recovery_state: "retired",
	retired_at: null,
	next_probe_at: null,
	termination_claimed_at: null,
};
const argv =
	"claude -p review --session-id session-1 --output-format json --model claude-opus-4-8 --settings {}";
function snapshot(
	command = argv,
	env = "FLYWHEEL_REVIEW_REQUEST_ID=r1 FLYWHEEL_REVIEW_ATTEMPT_GENERATION=1 FLYWHEEL_REVIEW_OWNER_BOOT_ID=boot-1",
) {
	return {
		argsBefore: `42 42 ${start} ${command}\n`,
		authoritative: `42 42 ${start} S claude ${command} ${env}\n`,
		argsAfter: `42 42 ${start} ${command}\n`,
	};
}
function deps(
	overrides: Partial<ReviewProcessIdentityDeps> = {},
): ReviewProcessIdentityDeps {
	return {
		captureSnapshot: async () => snapshot(),
		readCwd: async () => "/repo",
		signalGroup: vi.fn(() => true),
		now: () => Date.parse(start) + 2000,
		...overrides,
	};
}
describe("retired reviewer exact identity", () => {
	it("finds a pre-spawn intent from actual environment without stored PID", async () => {
		expect(
			await probeRetiredReviewAttempt(job, attempt, undefined, deps()),
		).toEqual({
			state: "alive",
			identity: { pid: 42, pgid: 42, processStartedAt: start },
		});
	});
	it("never accepts ownership markers from the prompt", async () => {
		const d = deps({
			captureSnapshot: async () =>
				snapshot(
					argv.replace(
						"review",
						"FLYWHEEL_REVIEW_REQUEST_ID=r1 FLYWHEEL_REVIEW_ATTEMPT_GENERATION=1 FLYWHEEL_REVIEW_OWNER_BOOT_ID=boot-1",
					),
					"HOME=/tmp",
				),
		});
		expect(
			(await probeRetiredReviewAttempt(job, attempt, undefined, d)).state,
		).toBe("unknown");
	});
	it("proves absence without a stored PID from a complete unrelated snapshot", async () => {
		const s = snapshot("launchd", "HOME=/");
		s.authoritative = s.authoritative.replace("S claude", "S launchd");
		expect(
			(
				await probeRetiredReviewAttempt(
					job,
					attempt,
					undefined,
					deps({ captureSnapshot: async () => s }),
				)
			).state,
		).toBe("absent");
	});
	it.each(["", "malformed"])(
		"rejects incomplete/malformed snapshot %s",
		async (text) => {
			expect(
				(
					await probeRetiredReviewAttempt(
						job,
						attempt,
						undefined,
						deps({
							captureSnapshot: async () => ({ ...snapshot(), argsAfter: text }),
						}),
					)
				).state,
			).toBe("unknown");
		},
	);
	it("rejects a missing authoritative row", async () => {
		expect(
			(
				await probeRetiredReviewAttempt(
					job,
					attempt,
					undefined,
					deps({
						captureSnapshot: async () => ({
							...snapshot(),
							authoritative: `1 1 ${start} S launchd launchd HOME=/\n`,
						}),
					}),
				)
			).state,
		).toBe("unknown");
	});
	it("tolerates unrelated process churn but requires every potential reviewer row", async () => {
		const s = snapshot();
		s.argsBefore += `100 100 ${start} /bin/ps -axww\n`;
		s.authoritative += `101 101 ${start} R ps /bin/ps -axwwE\n`;
		s.argsAfter += `102 102 ${start} /bin/ps -axww\n`;
		expect(
			(
				await probeRetiredReviewAttempt(
					job,
					attempt,
					undefined,
					deps({ captureSnapshot: async () => s }),
				)
			).state,
		).toBe("alive");
	});
	it("proves legacy identity only from exact session, cwd, start and original budget", async () => {
		const legacy = { ...attempt, owner_boot_id: null };
		expect(
			(
				await probeRetiredReviewAttempt(
					job,
					legacy,
					undefined,
					deps({ captureSnapshot: async () => snapshot(argv, "HOME=/tmp") }),
				)
			).state,
		).toBe("alive");
		expect(
			(
				await probeRetiredReviewAttempt(
					job,
					{ ...legacy, deadline_at: null },
					undefined,
					deps(),
				)
			).reason,
		).toBe("legacy_owner_unverified");
	});
	it("leaves a still-alive child for operator handling without repeating the signal", async () => {
		const d = deps();
		expect(
			(await terminateRetiredReviewAttempt(job, attempt, undefined, d)).state,
		).toBe("alive");
		expect(d.signalGroup).toHaveBeenCalledTimes(1);
	});
	it("does not accept another request or generation as the retired owner", async () => {
		const d = deps({
			captureSnapshot: async () =>
				snapshot(
					argv,
					"FLYWHEEL_REVIEW_REQUEST_ID=r1 FLYWHEEL_REVIEW_ATTEMPT_GENERATION=2 FLYWHEEL_REVIEW_OWNER_BOOT_ID=boot-1",
				),
		});
		expect(
			(await terminateRetiredReviewAttempt(job, attempt, undefined, d)).state,
		).toBe("unknown");
		expect(d.signalGroup).not.toHaveBeenCalled();
	});
	it("fails closed when the process environment sensor omitted all environment", async () => {
		expect(
			(
				await probeRetiredReviewAttempt(
					job,
					attempt,
					undefined,
					deps({
						captureSnapshot: async () =>
							snapshot(argv.replace("session-1", "other-session"), ""),
					}),
				)
			).state,
		).toBe("unknown");
	});
	it("does not signal a reused PID or another cwd", async () => {
		for (const old of [
			{ ...attempt, pid: 42, pgid: 42, process_started_at: "different" },
			attempt,
		]) {
			const d = deps({
				readCwd: async () => (old === attempt ? "/other" : "/repo"),
			});
			expect(
				(await terminateRetiredReviewAttempt(job, old, undefined, d)).state,
			).toBe("unknown");
			expect(d.signalGroup).not.toHaveBeenCalled();
		}
	});
	it("requires the original deadline and reliable legacy budget", async () => {
		const d = deps({ now: () => Date.parse(start) });
		expect(
			(await terminateRetiredReviewAttempt(job, attempt, undefined, d)).state,
		).toBe("unknown");
		expect(
			(
				await probeRetiredReviewAttempt(
					job,
					{ ...attempt, owner_boot_id: null, reviewer_started_at: null },
					undefined,
					d,
				)
			).reason,
		).toBe("legacy_owner_unverified");
		expect(d.signalGroup).not.toHaveBeenCalled();
	});
	it("revalidates identity twice, signals once, and confirms absence", async () => {
		let calls = 0;
		const empty = snapshot("launchd", "HOME=/");
		empty.authoritative = empty.authoritative.replace("S claude", "S launchd");
		const d = deps({
			captureSnapshot: async () => (++calls <= 2 ? snapshot() : empty),
		});
		expect(
			(await terminateRetiredReviewAttempt(job, attempt, undefined, d)).state,
		).toBe("absent");
		expect(calls).toBe(3);
		expect(d.signalGroup).toHaveBeenCalledTimes(1);
	});
	it("does not signal after identity changes during the second read", async () => {
		let calls = 0;
		const d = deps({
			captureSnapshot: async () =>
				++calls === 1 ? snapshot() : { ...snapshot(), argsAfter: "bad" },
		});
		expect(
			(await terminateRetiredReviewAttempt(job, attempt, undefined, d)).state,
		).toBe("unknown");
		expect(d.signalGroup).not.toHaveBeenCalled();
	});
	it("aborts a hanging snapshot within the shared deadline without signaling", async () => {
		vi.useFakeTimers();
		try {
			const d = deps({ captureSnapshot: () => new Promise(() => {}) });
			const result = terminateRetiredReviewAttempt(job, attempt, undefined, d);
			await vi.advanceTimersByTimeAsync(5000);
			expect((await result).state).toBe("unknown");
			expect(d.signalGroup).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
	it("respects caller abort even when injected I/O ignores it", async () => {
		const controller = new AbortController();
		const d = deps({ captureSnapshot: () => new Promise(() => {}) });
		const pending = probeRetiredReviewAttempt(
			job,
			attempt,
			controller.signal,
			d,
		);
		controller.abort();
		expect((await pending).state).toBe("unknown");
		expect(d.signalGroup).not.toHaveBeenCalled();
	});
});
it.each(["wrapper", "surviving-group"])(
	"does not call related live non-claude %s absent",
	async (kind) => {
		const s =
			kind === "wrapper"
				? snapshot(argv.replace("claude -p", "node /cli.js -p"))
				: snapshot("sleep 100", "HOME=/");
		s.authoritative = s.authoritative.replace("S claude", "S node");
		if (kind === "surviving-group") {
			s.argsBefore = s.argsBefore.replace(/^42 42/, "43 42");
			s.authoritative = s.authoritative.replace(/^42 42/, "43 42");
			s.argsAfter = s.argsAfter.replace(/^42 42/, "43 42");
		}
		expect(
			(
				await probeRetiredReviewAttempt(
					job,
					{ ...attempt, pid: 42, pgid: 42, process_started_at: start },
					undefined,
					deps({ captureSnapshot: async () => s }),
				)
			).state,
		).toBe("unknown");
	},
);
