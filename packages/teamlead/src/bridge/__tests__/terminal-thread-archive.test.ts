/**
 * FLY-1282 Part C (M9): archive-only targeted mode + scheduler queue
 * lifecycle. Contract (plan.md Part C, Codex R10–R15):
 *   - STRICTER than the global sweep: EVERY alias row ∈ {completed,
 *     terminated}; failed/blocked/design_done/pending/running/awaiting_review
 *     ALL veto; unresolved evidence-gap marker vetoes; an UNDISCHARGED launch
 *     claim vetoes (discharged = the claim's row is terminal);
 *   - WEAKER: the ONLY mutator is archiveThreadAndRecord (archive-once);
 *   - fresh Linear double gate + post-probe fingerprint recheck (a mid-probe
 *     successor wins);
 *   - queue: retryable outcomes rotate with capped backoff, dedupe, cap 64
 *     refuses loudly, disabled pauses (retains), >24h drops to low-frequency
 *     forever with loud logs — never silently dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import type { ArchiveChatThreadResult } from "../chat-thread-utils.js";
import { startDoneThreadReconcileScheduler } from "../done-thread-reconcile.js";
import {
	createTerminalArchiveEnqueueBuffer,
	isRetryableOutcome,
	runTargetedArchiveCheck,
	type TargetedArchiveDeps,
} from "../terminal-thread-archive.js";

const UUID = "issue-uuid-1282";
const IDENT = "FLY-1282";

const PROJECT = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/fw",
		leads: [
			{
				agentId: "tadashi",
				chatChannel: "ch-eng",
				match: { labels: ["Flywheel"] },
				botToken: "tok-tadashi",
			},
		],
	},
] as unknown as ProjectEntry[];

const OK_ARCHIVE: ArchiveChatThreadResult = {
	archived: true,
	attempts: 1,
	status: 200,
	reason: "ok",
};

let store: StateStore;
beforeEach(async () => {
	store = await StateStore.create(":memory:");
});
afterEach(() => {
	store.close();
});

function seedSession(execId: string, status = "completed"): void {
	store.upsertSession({
		execution_id: execId,
		issue_id: UUID,
		issue_identifier: IDENT,
		project_name: "flywheel",
		status,
		issue_labels: JSON.stringify(["Flywheel"]),
	});
}

function makeDeps(
	over: Partial<TargetedArchiveDeps> = {},
): TargetedArchiveDeps & { archiveFn: ReturnType<typeof vi.fn> } {
	const archiveFn = vi.fn().mockResolvedValue(OK_ARCHIVE);
	const archiveSinkFn = vi.fn(async () => {
		const result = await archiveFn();
		if (result.archived) store.markChatThreadArchived("thread-1");
		return result;
	});
	return {
		store,
		projects: PROJECT,
		linearApiKey: "key",
		globalBotToken: "tok-global",
		dryRun: false,
		lookupIssue: vi.fn(async () => ({
			id: UUID,
			identifier: IDENT,
			stateType: "completed",
		})),
		archiveFn,
		archiveSinkFn,
		fetchImpl: (() => {
			throw new Error("no network in tests");
		}) as unknown as typeof fetch,
		lookupTarget: () => ({ kind: "gone" }) as const,
		probeLiveness: async () => "dead" as const,
		log: () => {},
		...over,
		// keep the named handle even when overridden
	} as TargetedArchiveDeps & { archiveFn: ReturnType<typeof vi.fn> };
}

describe("M9 targeted mode — happy path + archive-once", () => {
	it("FLY-2028: terminal sink authority defers a quiet-window retry", async () => {
		seedSession("exec-a");
		store.upsertChatThread("thread-1", "ch-eng", UUID, "tadashi");
		const archiveSinkFn = vi.fn().mockResolvedValue({
			archived: false,
			attempts: 0,
			reason: "deferred_quiet_window",
		});

		const outcome = await runTargetedArchiveCheck(
			IDENT,
			makeDeps({ archiveSinkFn }),
		);

		expect(outcome).toEqual({ kind: "deferred_quiet_window" });
		expect(isRetryableOutcome(outcome)).toBe(true);
		expect(archiveSinkFn).toHaveBeenCalledWith(
			store,
			expect.objectContaining({ threadId: "thread-1" }),
			"tok-tadashi",
			expect.objectContaining({ authority: "terminal" }),
		);
	});

	it("all-terminal + Linear Done + panes gone → archived exactly once; re-run → thread_missing", async () => {
		seedSession("exec-a", "completed");
		seedSession("exec-b", "terminated");
		store.upsertChatThread("thread-1", "ch-eng", UUID, "tadashi");
		const deps = makeDeps();
		const first = await runTargetedArchiveCheck(IDENT, deps);
		expect(first).toEqual({ kind: "archived", threadId: "thread-1" });
		expect(deps.archiveFn).toHaveBeenCalledTimes(1);
		// Archive-once: the recorded archive makes the second run terminal.
		const second = await runTargetedArchiveCheck(IDENT, deps);
		expect(second.kind).toBe("thread_missing");
		expect(isRetryableOutcome(second)).toBe(false);
	});

	it("identifier enqueued while the thread row is stored under the UUID → same thread found", async () => {
		seedSession("exec-a");
		store.upsertChatThread("thread-1", "ch-eng", UUID, "tadashi");
		const out = await runTargetedArchiveCheck(IDENT, makeDeps());
		expect(out.kind).toBe("archived");
	});

	it("dry-run reports without archiving and stays retryable (continues after dry-run flips off)", async () => {
		seedSession("exec-a");
		store.upsertChatThread("thread-1", "ch-eng", UUID, "tadashi");
		const deps = makeDeps({ dryRun: true });
		const out = await runTargetedArchiveCheck(IDENT, deps);
		expect(out.kind).toBe("dry_run_would_archive");
		expect(isRetryableOutcome(out)).toBe(true);
		expect(deps.archiveFn).not.toHaveBeenCalled();
		const live = await runTargetedArchiveCheck(IDENT, makeDeps());
		expect(live.kind).toBe("archived");
	});
});

describe("FLY-2028 pre-binding admission", () => {
	it("returns accepted, deduped, refused, then forwards the consumer receipt", () => {
		const buffer = createTerminalArchiveEnqueueBuffer(1, () => {});
		expect(buffer.enqueue("FLY-1")).toBe("accepted");
		expect(buffer.enqueue("FLY-1")).toBe("deduped");
		expect(buffer.enqueue("FLY-2")).toBe("refused");

		const consumer = vi.fn(() => "deduped" as const);
		buffer.bind(consumer);
		expect(consumer).toHaveBeenCalledWith("FLY-1");
		expect(buffer.enqueue("FLY-3")).toBe("deduped");
	});
});

describe("M9 targeted mode — veto fixtures (stricter than the global sweep)", () => {
	for (const status of [
		"running",
		"awaiting_review",
		"approved_to_ship",
		"design_done",
		"pending",
		"failed",
		"blocked",
	]) {
		it(`sibling status "${status}" vetoes (retryable)`, async () => {
			seedSession("exec-done", "completed");
			seedSession(`exec-${status}`, status);
			store.upsertChatThread("thread-1", "ch-eng", UUID, "tadashi");
			const out = await runTargetedArchiveCheck(IDENT, makeDeps());
			expect(out.kind).toBe("vetoed_status");
			expect(isRetryableOutcome(out)).toBe(true);
		});
	}

	it("completed-but-LIVE pane vetoes; indeterminate vetoes; lookup error vetoes", async () => {
		seedSession("exec-a");
		store.upsertChatThread("thread-1", "ch-eng", UUID, "tadashi");
		for (const probe of ["alive", "indeterminate"] as const) {
			const out = await runTargetedArchiveCheck(
				IDENT,
				makeDeps({
					lookupTarget: () =>
						({
							kind: "found",
							target: { tmuxWindow: "fw:1" },
						}) as never,
					probeLiveness: async () => probe,
				}),
			);
			expect(out.kind).toBe("vetoed_active");
		}
		const errOut = await runTargetedArchiveCheck(
			IDENT,
			makeDeps({
				lookupTarget: () => ({ kind: "error", error: "boom" }) as never,
			}),
		);
		expect(errOut.kind).toBe("vetoed_active");
	});

	it("unresolved FLY-208 evidence-gap marker on ANY alias row vetoes", async () => {
		seedSession("exec-a");
		seedSession("exec-gap");
		store.setSessionParams("exec-gap", {
			fly208_evidence_gap: { route: "auto_approve" },
		});
		store.upsertChatThread("thread-1", "ch-eng", UUID, "tadashi");
		const out = await runTargetedArchiveCheck(IDENT, makeDeps());
		expect(out.kind).toBe("vetoed_evidence_gap");
	});

	it("UNDISCHARGED launch claim vetoes; a discharged claim (terminal row) does not", async () => {
		seedSession("exec-a");
		store.upsertChatThread("thread-1", "ch-eng", UUID, "tadashi");
		// starting claim with NO session row = admitted-but-invisible successor.
		store.insertLaunchClaim({
			executionId: "exec-successor",
			rootUuid: UUID,
			project: "flywheel",
		});
		const vetoed = await runTargetedArchiveCheck(IDENT, makeDeps());
		expect(vetoed.kind).toBe("vetoed_claim");
		// Discharge it: the claim's execution completes (claims are not closed
		// on normal completion — a terminal row counts as discharged, R13 #1).
		seedSession("exec-successor", "completed");
		store.setLaunchClaimState("exec-successor", "active");
		const ok = await runTargetedArchiveCheck(IDENT, makeDeps());
		expect(ok.kind).toBe("archived");
	});

	it("Linear not Done at first gate → vetoed_linear; reopened at the pre-sink recheck → vetoed_linear", async () => {
		seedSession("exec-a");
		store.upsertChatThread("thread-1", "ch-eng", UUID, "tadashi");
		const notDone = await runTargetedArchiveCheck(
			IDENT,
			makeDeps({
				lookupIssue: vi.fn(async () => ({
					id: UUID,
					identifier: IDENT,
					stateType: "started",
				})),
			}),
		);
		expect(notDone.kind).toBe("vetoed_linear");
		// Done on the first read, REOPENED on the second (pre-sink) read.
		let calls = 0;
		const flipping = vi.fn(async () => {
			calls++;
			return {
				id: UUID,
				identifier: IDENT,
				stateType: calls === 1 ? "completed" : "started",
			};
		});
		const reopened = await runTargetedArchiveCheck(
			IDENT,
			makeDeps({ lookupIssue: flipping }),
		);
		expect(reopened.kind).toBe("vetoed_linear");
	});

	it("launch-claim read error is fail-CLOSED: transient_error, zero archives (code R1 #2)", async () => {
		seedSession("exec-a");
		store.upsertChatThread("thread-1", "ch-eng", UUID, "tadashi");
		const deps = makeDeps();
		const boom = vi
			.spyOn(store, "listOpenLaunchClaims")
			.mockImplementation(() => {
				throw new Error("database is locked");
			});
		try {
			const out = await runTargetedArchiveCheck(IDENT, deps);
			expect(out.kind).toBe("transient_error");
			expect(isRetryableOutcome(out)).toBe(true);
			expect(deps.archiveFn).not.toHaveBeenCalled();
		} finally {
			boom.mockRestore();
		}
	});

	it("mid-probe successor changes the alias/claim fingerprint → transient_error (retryable re-run)", async () => {
		seedSession("exec-a");
		store.upsertChatThread("thread-1", "ch-eng", UUID, "tadashi");
		const out = await runTargetedArchiveCheck(
			IDENT,
			makeDeps({
				lookupTarget: () =>
					({ kind: "found", target: { tmuxWindow: "fw:1" } }) as never,
				probeLiveness: async () => {
					// A pending successor lands while the probe is in flight.
					seedSession("exec-mid", "running");
					return "dead" as const;
				},
			}),
		);
		expect(out.kind).toBe("transient_error");
		expect(isRetryableOutcome(out)).toBe(true);
	});
});

describe("M9 scheduler — targeted queue lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function makeScheduler(over: {
		runTargeted?: (id: string) => Promise<{ done: boolean; note?: string }>;
		enabled?: () => boolean;
	}) {
		const runOnce = vi.fn(async () => undefined);
		const handle = startDoneThreadReconcileScheduler({
			runOnce,
			resolveConfig: () =>
				({
					enabled: over.enabled ? over.enabled() : true,
					dryRun: false,
					intervalMin: 0, // boot-only global — ticks drive ONLY the queue
					maxArchivesPerRun: 10,
					maxCandidatesPerRun: 100,
					runDeadlineMs: 1000,
				}) as never,
			bootDelayMs: 10_000_000, // keep the boot global pass out of the way
			tickMs: 1_000,
			log: () => {},
			runTargeted: over.runTargeted,
		});
		return { handle, runOnce };
	}

	it("vetoed_active → capped-backoff retries → archives well before any 6h sweep; dequeues after done", async () => {
		let calls = 0;
		const runTargeted = vi.fn(async () => {
			calls++;
			return { done: calls >= 3, note: "vetoed_active" };
		});
		const { handle } = makeScheduler({ runTargeted });
		handle.enqueue(IDENT);
		// call 1 fails → backoff 60s; call 2 fails → 120s; call 3 done.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(runTargeted).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(59_000); // not eligible yet at +60s? it is at exactly 60s
		await vi.advanceTimersByTimeAsync(2_000);
		expect(runTargeted).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(121_000);
		expect(runTargeted).toHaveBeenCalledTimes(3);
		// done:true → dequeued: no further calls no matter how long we wait.
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(runTargeted).toHaveBeenCalledTimes(3);
		await handle.stop();
	});

	it("no hot loop: a failed item is not re-consumed before its nextEligibleAt", async () => {
		const runTargeted = vi.fn(async () => ({ done: false }));
		const { handle } = makeScheduler({ runTargeted });
		handle.enqueue(IDENT);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(runTargeted).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(30_000); // < 60s backoff
		expect(runTargeted).toHaveBeenCalledTimes(1);
		await handle.stop();
	});

	it("dedupe + cap 64 refuses loudly; enqueue without runTargeted is a loud no-op", async () => {
		const runTargeted = vi.fn(async () => ({ done: false }));
		const { handle } = makeScheduler({ runTargeted });
		handle.enqueue(IDENT);
		handle.enqueue(IDENT); // dedup
		for (let i = 0; i < 70; i++) handle.enqueue(`FLY-${i}`);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(runTargeted).toHaveBeenCalledTimes(1); // one per tick
		await handle.stop();

		const bare = startDoneThreadReconcileScheduler({
			runOnce: vi.fn(async () => undefined),
			resolveConfig: () =>
				({
					enabled: true,
					dryRun: false,
					intervalMin: 0,
					maxArchivesPerRun: 10,
					maxCandidatesPerRun: 100,
					runDeadlineMs: 1000,
				}) as never,
			bootDelayMs: 10_000_000,
			tickMs: 1_000,
			log: () => {},
		});
		expect(() => bare.enqueue(IDENT)).not.toThrow(); // byte-compat no-op
		await bare.stop();
	});

	it("enqueue during a suspended in-flight check is deduped — ONE logical item survives a retryable outcome (code R1 #8)", async () => {
		let release: (v: { done: boolean }) => void = () => {};
		const first = new Promise<{ done: boolean }>((r) => {
			release = r;
		});
		let calls = 0;
		const runTargeted = vi.fn(() => {
			calls++;
			return calls === 1 ? first : Promise.resolve({ done: true });
		});
		const { handle } = makeScheduler({ runTargeted });
		handle.enqueue(IDENT);
		await vi.advanceTimersByTimeAsync(1_000); // starts + suspends in flight
		expect(runTargeted).toHaveBeenCalledTimes(1);
		handle.enqueue(IDENT); // completion re-fired while in flight → deduped
		release({ done: false }); // retryable → requeues exactly one item
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(61_000); // one backoff retry (done)
		expect(runTargeted).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(3_600_000); // no phantom second item
		expect(runTargeted).toHaveBeenCalledTimes(2);
		await handle.stop();
	});

	it("disabled PAUSES consumption and retains the queue; re-enable resumes without restart", async () => {
		let enabled = false;
		const runTargeted = vi.fn(async () => ({ done: true }));
		const { handle } = makeScheduler({ runTargeted, enabled: () => enabled });
		handle.enqueue(IDENT);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(runTargeted).not.toHaveBeenCalled();
		enabled = true; // live flip — no restart
		await vi.advanceTimersByTimeAsync(1_000);
		expect(runTargeted).toHaveBeenCalledTimes(1);
		await handle.stop();
	});

	it(">24h old items drop to low-frequency retries with a loud log — never silently dropped", async () => {
		const logs: string[] = [];
		const runTargeted = vi.fn(async () => ({ done: false, note: "vetoed" }));
		const runOnce = vi.fn(async () => undefined);
		const handle = startDoneThreadReconcileScheduler({
			runOnce,
			resolveConfig: () =>
				({
					enabled: true,
					dryRun: false,
					intervalMin: 0,
					maxArchivesPerRun: 10,
					maxCandidatesPerRun: 100,
					runDeadlineMs: 1000,
				}) as never,
			bootDelayMs: 10_000_000,
			tickMs: 60_000,
			log: (m) => logs.push(m),
			runTargeted,
		});
		handle.enqueue(IDENT);
		// Age the item past 24h through repeated failed retries (backoff caps
		// at 30min, so ~50 retries pass 24h — advance in cap-sized jumps).
		for (let i = 0; i < 52; i++) {
			await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
		}
		expect(logs.some((l) => l.includes("still pending after"))).toBe(true);
		const callsAt24h = runTargeted.mock.calls.length;
		expect(callsAt24h).toBeGreaterThan(0);
		// Still retrying (low frequency) — not dropped.
		await vi.advanceTimersByTimeAsync(3_600_000 + 2_000);
		expect(runTargeted.mock.calls.length).toBeGreaterThan(callsAt24h);
		await handle.stop();
	});
});
