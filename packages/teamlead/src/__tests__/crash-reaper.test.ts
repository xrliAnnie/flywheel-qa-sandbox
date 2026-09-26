/**
 * FLY-720: unit coverage for the liveness-based crash reaper. Uses a real
 * in-memory StateStore + WorkflowFSM (so the canonical applyTransition path is
 * exercised) and injects tmux / archive / forensics deps as mocks.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import {
	type CrashReapDeps,
	defaultWriteCrashLog,
	reapCrashedRunners,
} from "../bridge/crash-reaper.js";
import type { TmuxTargetLookup } from "../bridge/tmux-lookup.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import { StateStore } from "../StateStore.js";

function minutesAgoSqlite(n: number): string {
	return new Date(Date.now() - n * 60_000)
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
}

const FOUND: (w: string) => TmuxTargetLookup = (tmuxWindow) => ({
	kind: "found",
	target: { tmuxWindow, sessionName: tmuxWindow.split(":")[0] },
});

describe("reapCrashedRunners (FLY-720)", () => {
	let store: StateStore;
	let transitionOpts: ApplyTransitionOpts;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		transitionOpts = {
			store,
			fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS),
			executor: new DirectiveExecutor(store),
		};
	});
	afterEach(() => store.close());

	function seedRunning(
		execId: string,
		staleMin: number,
		issueId = `i-${execId}`,
	) {
		store.upsertSession({
			execution_id: execId,
			issue_id: issueId,
			project_name: "geo",
			status: "running",
			heartbeat_at: minutesAgoSqlite(staleMin),
		});
	}

	function baseDeps(over: Partial<CrashReapDeps> = {}): CrashReapDeps {
		return {
			enabled: true,
			crashGraceMinutes: 60,
			orphanThresholdMinutes: 60,
			nowMs: Date.now(),
			store,
			transitionOpts,
			isSuppressed: () => false,
			hasPendingCompleteMarker: () => false,
			lookupTmuxTarget: (_e, _p) => FOUND("geo:@1"),
			probeLiveness: vi.fn(async () => "dead_pin" as const),
			captureScrollback: vi.fn(async () => ({
				ok: true as const,
				text: "CRASH",
			})),
			writeCrashLog: vi.fn(() => ({ path: "/tmp/crash.log" })),
			killCmuxLinkedSession: vi.fn(async () => ({ killed: true })),
			killTmuxWindow: vi.fn(async () => ({ killed: true })),
			closeTerminalView: vi.fn(async () => {}),
			finalizeCommDbSession: vi.fn(() => ({
				ok: true,
				outcome: "finalized",
				retiredGateCount: 1,
				deletedSessionCount: 1,
			})),
			archiveThread: vi.fn(async () => {}),
			log: () => {},
			...over,
		};
	}

	it("reaps a confirmed dead-pin past grace: teardown → terminated → prune → archive", async () => {
		seedRunning("z1", 120);
		const deps = baseDeps();
		const res = await reapCrashedRunners(deps);

		expect(res.reaped).toBe(1);
		expect(res.deadPinOwned.has("z1")).toBe(true);
		expect(deps.killCmuxLinkedSession).toHaveBeenCalledWith("geo:@1");
		expect(deps.killTmuxWindow).toHaveBeenCalledWith("geo:@1");
		expect(deps.finalizeCommDbSession).toHaveBeenCalledWith("z1", "geo");
		expect(deps.archiveThread).toHaveBeenCalledTimes(1);
		expect(store.getSession("z1")?.status).toBe("terminated");
		const events = store.getEventsByExecution("z1") ?? [];
		expect(events.some((e) => e.event_type === "runner_crash_reaped")).toBe(
			true,
		);
	});

	it("FLY-1238: a CommDB finalization failure remains cleanup-pending and never archives", async () => {
		seedRunning("z1", 120);
		const deps = baseDeps({
			finalizeCommDbSession: vi.fn(() => ({
				ok: false,
				outcome: "failed",
				retiredGateCount: 0,
				deletedSessionCount: 0,
				error: "sqlite busy",
			})),
		});

		const res = await reapCrashedRunners(deps);

		expect(res.cleanupPending).toBe(1);
		expect(res.reaped).toBe(0);
		expect(deps.archiveThread).not.toHaveBeenCalled();
		expect(store.getSession("z1")?.status).toBe("running");
	});

	it("dumps forensics BEFORE teardown", async () => {
		seedRunning("z1", 120);
		const order: string[] = [];
		const deps = baseDeps({
			captureScrollback: vi.fn(async () => {
				order.push("capture");
				return { ok: true as const, text: "CRASH" };
			}),
			killCmuxLinkedSession: vi.fn(async () => {
				order.push("killCmux");
				return { killed: true };
			}),
			killTmuxWindow: vi.fn(async () => {
				order.push("killWindow");
				return { killed: true };
			}),
		});
		await reapCrashedRunners(deps);
		expect(order).toEqual(["capture", "killCmux", "killWindow"]);
	});

	it("owns but does NOT reap a dead-pin in the [orphan, grace) middle band", async () => {
		// grace 120 > orphan 60; heartbeat stale 90 → owned, waiting.
		seedRunning("z1", 90);
		const deps = baseDeps({ crashGraceMinutes: 120 });
		const res = await reapCrashedRunners(deps);

		expect(res.deadPinOwned.has("z1")).toBe(true);
		expect(res.confirmedDeadButWaitingForGrace).toBe(1);
		expect(res.reaped).toBe(0);
		expect(deps.killTmuxWindow).not.toHaveBeenCalled();
		expect(store.getSession("z1")?.status).toBe("running");
	});

	it("leaves an `absent` window to reapOrphans (not owned, not reaped)", async () => {
		seedRunning("z1", 120);
		const deps = baseDeps({
			probeLiveness: vi.fn(async () => "absent" as const),
		});
		const res = await reapCrashedRunners(deps);

		expect(res.deadPinOwned.has("z1")).toBe(false);
		expect(res.absentPassedToOrphan).toBe(1);
		expect(res.reaped).toBe(0);
		expect(deps.killTmuxWindow).not.toHaveBeenCalled();
		expect(store.getSession("z1")?.status).toBe("running");
	});

	it("suppresses on CommDB lookup error (GEO-374), never reaps", async () => {
		seedRunning("z1", 120);
		const deps = baseDeps({
			lookupTmuxTarget: () => ({ kind: "error", error: "db locked" }),
		});
		const res = await reapCrashedRunners(deps);
		expect(res.indeterminateSuppressed).toBe(1);
		expect(res.deadPinOwned.size).toBe(0);
		expect(deps.probeLiveness).not.toHaveBeenCalled();
	});

	it("suppresses on pane-probe indeterminate, never reaps", async () => {
		seedRunning("z1", 120);
		const deps = baseDeps({
			probeLiveness: vi.fn(async () => "indeterminate" as const),
		});
		const res = await reapCrashedRunners(deps);
		expect(res.indeterminateSuppressed).toBe(1);
		expect(res.deadPinOwned.size).toBe(0);
		expect(store.getSession("z1")?.status).toBe("running");
	});

	it("skips a suppressed (reconnecting/monitor-lost) session", async () => {
		seedRunning("z1", 120);
		const deps = baseDeps({ isSuppressed: (id) => id === "z1" });
		const res = await reapCrashedRunners(deps);
		expect(res.deadPinOwned.size).toBe(0);
		expect(deps.lookupTmuxTarget).not.toBeUndefined();
		expect(deps.probeLiveness).not.toHaveBeenCalled();
	});

	it("skips a session with a pending complete marker (FLY-172 owns it)", async () => {
		seedRunning("z1", 120);
		const deps = baseDeps({ hasPendingCompleteMarker: (id) => id === "z1" });
		const res = await reapCrashedRunners(deps);
		expect(res.deadPinOwned.size).toBe(0);
		expect(deps.probeLiveness).not.toHaveBeenCalled();
	});

	it("cleanup_pending on tmux window kill error: stays running, no archive, retried next cycle", async () => {
		seedRunning("z1", 120);
		const deps = baseDeps({
			killTmuxWindow: vi.fn(async () => ({ killed: false, error: "boom" })),
		});
		const res = await reapCrashedRunners(deps);

		expect(res.cleanupPending).toBe(1);
		expect(res.reaped).toBe(0);
		expect(res.deadPinOwned.has("z1")).toBe(true); // still owned
		expect(deps.archiveThread).not.toHaveBeenCalled();
		expect(store.getSession("z1")?.status).toBe("running");
	});

	it("cmux kill failure → cleanup_pending, does NOT kill the window (Codex code R1 HIGH)", async () => {
		// If we killed the window on a cmux failure, next cycle the probe reads
		// `absent` → the row drops out of deadPinOwned → reapOrphans force-fails it to
		// `failed` (skipping terminated+archive) and cmux loses its re-resolution point.
		seedRunning("z1", 120);
		const deps = baseDeps({
			killCmuxLinkedSession: vi.fn(async () => ({
				killed: false,
				error: "tmux busy",
			})),
		});
		const res = await reapCrashedRunners(deps);

		expect(res.cleanupPending).toBe(1);
		expect(res.reaped).toBe(0);
		expect(res.deadPinOwned.has("z1")).toBe(true); // still owned → reapOrphans skips it
		expect(deps.killTmuxWindow).not.toHaveBeenCalled(); // window preserved for retry
		expect(deps.archiveThread).not.toHaveBeenCalled();
		expect(store.getSession("z1")?.status).toBe("running");
	});

	it("terminal-close failure is best-effort (does NOT block reap)", async () => {
		seedRunning("z1", 120);
		const deps = baseDeps({
			closeTerminalView: vi.fn(async () => {
				throw new Error("osascript nope");
			}),
		});
		const res = await reapCrashedRunners(deps);
		expect(res.reaped).toBe(1);
		expect(store.getSession("z1")?.status).toBe("terminated");
	});

	it("post-teardown race: row moved off running → no force-terminate, prune + skip event", async () => {
		seedRunning("z1", 120);
		// Simulate a concurrent transition to completed AFTER teardown succeeds by
		// flipping the row inside killTmuxWindow.
		const deps = baseDeps({
			killTmuxWindow: vi.fn(async () => {
				store.upsertSession({
					execution_id: "z1",
					issue_id: "i-z1",
					project_name: "geo",
					status: "completed",
				});
				return { killed: true };
			}),
		});
		const res = await reapCrashedRunners(deps);

		expect(res.transitionSkipped).toBe(1);
		expect(res.reaped).toBe(0);
		expect(deps.archiveThread).not.toHaveBeenCalled();
		expect(store.getSession("z1")?.status).toBe("completed"); // NOT forced to terminated
		expect(deps.finalizeCommDbSession).toHaveBeenCalledWith("z1", "geo");
		const events = store.getEventsByExecution("z1") ?? [];
		expect(
			events.some(
				(e) => e.event_type === "runner_crash_teardown_transition_skipped",
			),
		).toBe(true);
	});

	it("records dumpError when scrollback capture fails but still reaps", async () => {
		seedRunning("z1", 120);
		const deps = baseDeps({
			captureScrollback: vi.fn(async () => ({
				ok: false as const,
				error: "no window",
			})),
			writeCrashLog: vi.fn(() => ({ path: undefined, error: "unused" })),
		});
		const res = await reapCrashedRunners(deps);
		expect(res.reaped).toBe(1);
		const events = store.getEventsByExecution("z1") ?? [];
		const ev = events.find((e) => e.event_type === "runner_crash_reaped");
		expect(ev?.payload).toMatchObject({ dumpError: "no window" });
	});

	it("is a no-op when disabled", async () => {
		seedRunning("z1", 120);
		const deps = baseDeps({ enabled: false });
		const res = await reapCrashedRunners(deps);
		expect(res.reaped).toBe(0);
		expect(res.deadPinOwned.size).toBe(0);
		expect(deps.probeLiveness).not.toHaveBeenCalled();
	});

	it("skips an alive pane defensively", async () => {
		seedRunning("z1", 120);
		const deps = baseDeps({
			probeLiveness: vi.fn(async () => "alive" as const),
		});
		const res = await reapCrashedRunners(deps);
		expect(res.deadPinOwned.size).toBe(0);
		expect(res.reaped).toBe(0);
		expect(store.getSession("z1")?.status).toBe("running");
	});

	// ─── FLY-1050: reaped three-stage QA rows notify the orchestrator ───

	it("FLY-1050: reaping a chat_thread_role='qa' row fires onQaPhaseTerminated (post-transition)", async () => {
		store.upsertSession({
			execution_id: "qa-z1",
			issue_id: "FLY-967",
			project_name: "geo",
			status: "running",
			session_role: "qa",
			chat_thread_role: "qa",
			heartbeat_at: minutesAgoSqlite(120),
		});
		const onQaPhaseTerminated = vi.fn();
		const deps = baseDeps({ onQaPhaseTerminated });
		const res = await reapCrashedRunners(deps);
		expect(res.reaped).toBe(1);
		expect(store.getSession("qa-z1")?.status).toBe("terminated");
		expect(onQaPhaseTerminated).toHaveBeenCalledOnce();
		expect(onQaPhaseTerminated).toHaveBeenCalledWith("qa-z1", "FLY-967");
	});

	it("FLY-1050: a non-qa row never fires onQaPhaseTerminated; a throwing hook never breaks the reap", async () => {
		seedRunning("z1", 120); // no chat_thread_role → 'main'
		const onQaPhaseTerminated = vi.fn(() => {
			throw new Error("hook exploded");
		});
		const deps = baseDeps({ onQaPhaseTerminated });
		const res = await reapCrashedRunners(deps);
		expect(res.reaped).toBe(1);
		expect(onQaPhaseTerminated).not.toHaveBeenCalled();

		// qa row + throwing hook → reap still completes (archive + event intact)
		store.upsertSession({
			execution_id: "qa-z2",
			issue_id: "FLY-968",
			project_name: "geo",
			status: "running",
			session_role: "qa",
			chat_thread_role: "qa",
			heartbeat_at: minutesAgoSqlite(120),
		});
		const res2 = await reapCrashedRunners(deps);
		expect(res2.reaped).toBe(1);
		expect(onQaPhaseTerminated).toHaveBeenCalledWith("qa-z2", "FLY-968");
		expect(store.getSession("qa-z2")?.status).toBe("terminated");
	});
});

describe("defaultWriteCrashLog (FLY-720)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly720-crashlog-home-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("writes the crash log 0600 with the captured text (atomic rename)", () => {
		// Point HOME at a temp dir so the log lands under a hermetic location.
		const prevHome = process.env.HOME;
		process.env.HOME = dir;
		try {
			const r = defaultWriteCrashLog(
				"exec-1/weird",
				"trace-body",
				1730000000000,
			);
			expect(r.error).toBeUndefined();
			expect(r.path).toBeDefined();
			const path = r.path as string;
			// sanitized execId (no slash) + stamp
			expect(path).toContain("exec-1_weird-1730000000000.log");
			expect(readFileSync(path, "utf8")).toBe("trace-body");
			const mode = statSync(path).mode & 0o777;
			expect(mode).toBe(0o600);
		} finally {
			process.env.HOME = prevHome;
		}
	});
});
