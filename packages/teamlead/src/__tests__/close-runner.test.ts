import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { CLOSE_ELIGIBLE_STATES, closeRunner } from "../bridge/close-runner.js";
import { StateStore } from "../StateStore.js";

// ── Mock tmux-lookup ────────────────────────────────────────

const mockGetTmuxTarget = vi.fn();
const mockKillTmuxWindow = vi.fn();

const mockKillCmuxLinkedSession = vi.fn(async () => ({ killed: true }));

vi.mock("../bridge/tmux-lookup.js", () => ({
	getTmuxTargetFromCommDb: (...args: unknown[]) => mockGetTmuxTarget(...args),
	killTmuxWindow: (...args: unknown[]) => mockKillTmuxWindow(...args),
	killCmuxLinkedSession: (...args: unknown[]) =>
		mockKillCmuxLinkedSession(...args),
}));

// FLY-638: stub the CommDB prune so tests never touch the real comm.db on disk.
const mockDeleteCommDbSession = vi.fn(() => true);
vi.mock("../bridge/commdb-session-prune.js", () => ({
	deleteCommDbSession: (...args: unknown[]) => mockDeleteCommDbSession(...args),
}));

function makeOpts(overrides: Record<string, unknown> = {}) {
	return {
		executionId: "exec-1",
		issueId: "FLY-102",
		projectName: "flywheel",
		reason: "test",
		leadId: "lead-a",
		...overrides,
	};
}

function seedSession(store: StateStore, status: string): void {
	store.upsertSession({
		execution_id: "exec-1",
		issue_id: "FLY-102",
		project_name: "flywheel",
		status,
	});
}

describe("closeRunner", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		mockGetTmuxTarget.mockReset();
		mockKillTmuxWindow.mockReset();
	});

	it("returns session_not_found when session is absent (no event written)", async () => {
		const result = await closeRunner(makeOpts(), store);

		expect(result).toEqual({ closed: false, error: "session_not_found" });
		expect(store.getEventsByExecution("exec-1")).toEqual([]);
	});

	it.each([
		["running"],
		["awaiting_review"],
		["approved"],
		["approved_to_ship"],
	])(
		"blocks close when status is %s (status_not_eligible + blocked event)",
		async (status) => {
			seedSession(store, status);

			const result = await closeRunner(makeOpts(), store);

			expect(result).toEqual({
				closed: false,
				error: `status_not_eligible:${status}`,
			});
			const events = store.getEventsByExecution("exec-1");
			const blocked = events.find(
				(e) => e.event_type === "lead_close_runner_blocked",
			);
			expect(blocked).toBeDefined();
			expect(mockKillTmuxWindow).not.toHaveBeenCalled();
		},
	);

	it("kills tmux when status=completed + target exists", async () => {
		seedSession(store, "completed");
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "FLY-102:@0",
			sessionName: "FLY-102",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });

		const result = await closeRunner(makeOpts(), store);

		expect(result).toEqual({ closed: true, error: undefined });
		expect(mockKillTmuxWindow).toHaveBeenCalledWith("FLY-102:@0");
		const events = store.getEventsByExecution("exec-1");
		expect(events.some((e) => e.event_type === "lead_close_runner")).toBe(true);
	});

	it("returns alreadyGone=true when no tmux target (idempotent)", async () => {
		// FLY-116: failed/blocked are preserved by default; use an AUTO_CLOSE
		// status here so the alreadyGone path is exercised.
		seedSession(store, "completed");
		mockGetTmuxTarget.mockReturnValue(undefined);

		const result = await closeRunner(makeOpts(), store);

		expect(result).toEqual({ closed: true, alreadyGone: true });
		expect(mockKillTmuxWindow).not.toHaveBeenCalled();
		const events = store.getEventsByExecution("exec-1");
		const evt = events.find((e) => e.event_type === "lead_close_runner");
		expect(evt).toBeDefined();
		expect((evt!.payload as { alreadyGone?: boolean })?.alreadyGone).toBe(true);
	});

	it("records lead_close_runner_failed when killTmuxWindow errors", async () => {
		// FLY-116: pre-FLY-116 used status="blocked"; that now defaults to preserve.
		// Use "completed" (AUTO_CLOSE) so the kill is attempted and the error
		// path is exercised.
		seedSession(store, "completed");
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "FLY-102:@0",
			sessionName: "FLY-102",
		});
		mockKillTmuxWindow.mockResolvedValue({
			killed: false,
			error: "permission denied",
		});

		const result = await closeRunner(makeOpts(), store);

		expect(result).toEqual({ closed: false, error: "permission denied" });
		const events = store.getEventsByExecution("exec-1");
		expect(
			events.some((e) => e.event_type === "lead_close_runner_failed"),
		).toBe(true);
	});

	it("FLY-369: a tmux kill failure does NOT archive (cascade only on success)", async () => {
		// Seed a FULLY RESOLVABLE archive context (project + registered thread)
		// so that the PRE-fix placement (cascade before the kill) WOULD have
		// called archiveFn — i.e. this test actually exercises the success-gate.
		seedSession(store, "completed");
		store.upsertChatThread("t-x", "ch-x", "FLY-102", "lead-a");
		const project = {
			projectName: "flywheel",
			projectRoot: "/tmp/fw",
			leads: [
				{
					agentId: "lead-a",
					chatChannel: "ch-x",
					match: { labels: ["x"] },
					botToken: "tok-a",
				},
			],
		} as unknown as import("../ProjectConfig.js").ProjectEntry;
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "FLY-102:@0",
			sessionName: "FLY-102",
		});
		mockKillTmuxWindow.mockResolvedValue({
			killed: false,
			error: "permission denied",
		});
		const archiveFn = vi.fn().mockResolvedValue({ archived: true });

		const result = await closeRunner(
			makeOpts({ archive: { projects: [project], archiveFn } }),
			store,
		);

		// Close failed → thread must NOT be archived (premature-archive guard).
		expect(result).toEqual({ closed: false, error: "permission denied" });
		expect(archiveFn).not.toHaveBeenCalled();
	});

	// ───────── FLY-116: state split tests ─────────

	it.each([["failed"], ["blocked"]])(
		"FLY-116: PRESERVE — status=%s defaults to preserved (no kill, no close)",
		async (status) => {
			seedSession(store, status);
			mockGetTmuxTarget.mockReturnValue({
				tmuxWindow: "FLY-102:@0",
				sessionName: "FLY-102",
			});

			const result = await closeRunner(makeOpts(), store);

			expect(result).toEqual({
				closed: false,
				preserved: true,
				reason: "crash_preserve",
			});
			expect(mockKillTmuxWindow).not.toHaveBeenCalled();
			const events = store.getEventsByExecution("exec-1");
			expect(
				events.some((e) => e.event_type === "lead_close_runner_preserved"),
			).toBe(true);
		},
	);

	it.each([["failed"], ["blocked"]])(
		"FLY-116: forcePreserved bypasses preserve gate — status=%s kills + closes",
		async (status) => {
			seedSession(store, status);
			mockGetTmuxTarget.mockReturnValue({
				tmuxWindow: "FLY-102:@0",
				sessionName: "FLY-102",
			});
			mockKillTmuxWindow.mockResolvedValue({ killed: true });

			const result = await closeRunner(
				{ ...makeOpts(), forcePreserved: true },
				store,
			);

			expect(result).toEqual({ closed: true, error: undefined });
			expect(mockKillTmuxWindow).toHaveBeenCalledWith("FLY-102:@0");
			const events = store.getEventsByExecution("exec-1");
			expect(
				events.some(
					(e) => e.event_type === "lead_close_runner_force_preserved",
				),
			).toBe(true);
		},
	);

	it("FLY-116: forcePreserved on AUTO_CLOSE status (no-op gate, normal close)", async () => {
		seedSession(store, "completed");
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "FLY-102:@0",
			sessionName: "FLY-102",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });

		// forcePreserved=true on a non-preserve status is a no-op (does NOT
		// promote to "force_preserved" event type — only failed/blocked do).
		const result = await closeRunner(
			{ ...makeOpts(), forcePreserved: true },
			store,
		);

		expect(result).toEqual({ closed: true, error: undefined });
		const events = store.getEventsByExecution("exec-1");
		expect(events.some((e) => e.event_type === "lead_close_runner")).toBe(true);
		expect(
			events.some((e) => e.event_type === "lead_close_runner_force_preserved"),
		).toBe(false);
	});

	it.each([["rejected"], ["deferred"], ["shelved"], ["terminated"]])(
		"allows close when status is %s (extended eligibility)",
		async (status) => {
			seedSession(store, status);
			mockGetTmuxTarget.mockReturnValue(undefined);

			const result = await closeRunner(makeOpts(), store);

			expect(result.closed).toBe(true);
			expect(result.alreadyGone).toBe(true);
		},
	);

	it("audit event_id is Lead-dimensional: concurrent retry → single audit row", async () => {
		seedSession(store, "completed");
		mockGetTmuxTarget.mockReturnValue(undefined);

		await Promise.all([
			closeRunner(makeOpts(), store),
			closeRunner(makeOpts(), store),
			closeRunner(makeOpts(), store),
		]);

		const audits = store
			.getEventsByExecution("exec-1")
			.filter((e) => e.event_type === "lead_close_runner");
		expect(audits).toHaveLength(1);
	});

	it("different Leads each write their own audit row", async () => {
		seedSession(store, "completed");
		mockGetTmuxTarget.mockReturnValue(undefined);

		await closeRunner(makeOpts({ leadId: "lead-a" }), store);
		await closeRunner(makeOpts({ leadId: "lead-b" }), store);

		const audits = store
			.getEventsByExecution("exec-1")
			.filter((e) => e.event_type === "lead_close_runner");
		expect(audits).toHaveLength(2);
	});

	// ───────── FLY-638: done-mode finalize ─────────

	function transitionOpts(): ApplyTransitionOpts {
		return { store, fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS) };
	}

	it.each([["running"], ["awaiting_review"], ["approved_to_ship"]])(
		"finalizeDone transitions %s → completed, then closes (alreadyGone)",
		async (status) => {
			seedSession(store, status);
			mockGetTmuxTarget.mockReturnValue(undefined); // tmux already gone

			const result = await closeRunner(
				makeOpts({ finalizeDone: true, transitionOpts: transitionOpts() }),
				store,
			);

			expect(result).toEqual({ closed: true, alreadyGone: true });
			// Session was finalized to completed.
			expect(store.getSession("exec-1")?.status).toBe("completed");
			const events = store.getEventsByExecution("exec-1");
			const finalized = events.find(
				(e) => e.event_type === "lead_close_runner_finalized",
			);
			expect(finalized).toBeDefined();
			expect((finalized!.payload as { fromStatus?: string }).fromStatus).toBe(
				status,
			);
			// Normal close audit still written.
			expect(events.some((e) => e.event_type === "lead_close_runner")).toBe(
				true,
			);
		},
	);

	it("finalizeDone kills tmux when a target exists (parked-but-done runner)", async () => {
		seedSession(store, "awaiting_review");
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "FLY-102:@0",
			sessionName: "FLY-102",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });

		const result = await closeRunner(
			makeOpts({ finalizeDone: true, transitionOpts: transitionOpts() }),
			store,
		);

		expect(result).toEqual({ closed: true, error: undefined });
		expect(mockKillTmuxWindow).toHaveBeenCalledWith("FLY-102:@0");
		expect(store.getSession("exec-1")?.status).toBe("completed");
	});

	it("finalizeDone fires the FLY-369 archive cascade (completed + sole runner)", async () => {
		seedSession(store, "awaiting_review");
		store.upsertChatThread("t-x", "ch-x", "FLY-102", "lead-a");
		const project = {
			projectName: "flywheel",
			projectRoot: "/tmp/fw",
			leads: [
				{
					agentId: "lead-a",
					chatChannel: "ch-x",
					match: { labels: ["x"] },
					botToken: "tok-a",
				},
			],
		} as unknown as import("../ProjectConfig.js").ProjectEntry;
		mockGetTmuxTarget.mockReturnValue(undefined);
		const archiveFn = vi.fn().mockResolvedValue({ archived: true });

		const result = await closeRunner(
			makeOpts({
				finalizeDone: true,
				transitionOpts: transitionOpts(),
				archive: { projects: [project], archiveFn },
			}),
			store,
		);

		expect(result.closed).toBe(true);
		// Finalize → completed unlocks the archive cascade.
		expect(archiveFn).toHaveBeenCalledTimes(1);
	});

	it("finalizeDone is a no-op on a non-source state (already completed → normal close)", async () => {
		seedSession(store, "completed");
		mockGetTmuxTarget.mockReturnValue(undefined);

		const result = await closeRunner(
			makeOpts({ finalizeDone: true, transitionOpts: transitionOpts() }),
			store,
		);

		expect(result).toEqual({ closed: true, alreadyGone: true });
		const events = store.getEventsByExecution("exec-1");
		// No finalize event — status was already terminal.
		expect(
			events.some((e) => e.event_type === "lead_close_runner_finalized"),
		).toBe(false);
	});

	it("finalizeDone WITHOUT transitionOpts → finalize_done_unavailable (no FSM bypass)", async () => {
		seedSession(store, "awaiting_review");
		mockGetTmuxTarget.mockReturnValue(undefined);

		const result = await closeRunner(makeOpts({ finalizeDone: true }), store);

		expect(result).toEqual({
			closed: false,
			error: "finalize_done_unavailable",
		});
		expect(store.getSession("exec-1")?.status).toBe("awaiting_review");
	});

	it("WITHOUT finalizeDone, awaiting_review is still rejected (unchanged default)", async () => {
		seedSession(store, "awaiting_review");

		const result = await closeRunner(
			makeOpts({ transitionOpts: transitionOpts() }),
			store,
		);

		expect(result).toEqual({
			closed: false,
			error: "status_not_eligible:awaiting_review",
		});
		expect(store.getSession("exec-1")?.status).toBe("awaiting_review");
	});

	it("CLOSE_ELIGIBLE_STATES contains exactly 7 non-running outcomes", () => {
		expect(CLOSE_ELIGIBLE_STATES.size).toBe(7);
		expect([...CLOSE_ELIGIBLE_STATES].sort()).toEqual(
			[
				"blocked",
				"completed",
				"deferred",
				"failed",
				"rejected",
				"shelved",
				"terminated",
			].sort(),
		);
	});
});

// ── FLY-685: close_runner writes a cmux close-request marker ─────────────────
// On a successful window kill, closeRunner appends the runner's window_name to
// the marker file the cmux-sync watcher drains to remove the stale sidebar pin.
// The window_name is derived from killCmuxLinkedSession's resolved cmuxSession
// ("cmux-<window_name>"). Best-effort — never blocks/affects the close.

describe("closeRunner — FLY-685 cmux pin marker", () => {
	let store: StateStore;
	let dir: string;
	let markerFile: string;
	const prevFile = process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE;
	const prevSwitch = process.env.FLYWHEEL_CMUX_CLOSE_REQUEST;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		mockGetTmuxTarget.mockReset();
		mockKillTmuxWindow.mockReset();
		mockKillCmuxLinkedSession.mockReset();
		dir = mkdtempSync(join(tmpdir(), "fly685-close-"));
		markerFile = join(dir, "close-requested");
		process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE = markerFile;
		delete process.env.FLYWHEEL_CMUX_CLOSE_REQUEST;
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "runner-flywheel:@46",
			sessionName: "runner-flywheel",
		});
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		if (prevFile === undefined)
			delete process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE;
		else process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE = prevFile;
		if (prevSwitch === undefined)
			delete process.env.FLYWHEEL_CMUX_CLOSE_REQUEST;
		else process.env.FLYWHEEL_CMUX_CLOSE_REQUEST = prevSwitch;
		// restore the shared mock's default resolution for the rest of the suite
		mockKillCmuxLinkedSession.mockResolvedValue({ killed: true });
	});

	it("writes the derived window_name on a successful close", async () => {
		seedSession(store, "completed");
		mockKillCmuxLinkedSession.mockResolvedValue({
			killed: true,
			cmuxSession: "cmux-FLY-102-claude-close-runner-stale-pin",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });

		const result = await closeRunner(makeOpts(), store);

		expect(result).toEqual({ closed: true });
		expect(readFileSync(markerFile, "utf8")).toBe(
			"FLY-102-claude-close-runner-stale-pin\n",
		);
	});

	it("does NOT write when the tmux kill failed (runner may still be alive)", async () => {
		seedSession(store, "completed");
		mockKillCmuxLinkedSession.mockResolvedValue({
			killed: true,
			cmuxSession: "cmux-FLY-102-claude-x",
		});
		mockKillTmuxWindow.mockResolvedValue({
			killed: false,
			error: "permission denied",
		});

		await closeRunner(makeOpts(), store);

		expect(existsSync(markerFile)).toBe(false);
	});

	it("does NOT write when cmuxSession is absent (window already gone)", async () => {
		seedSession(store, "completed");
		mockKillCmuxLinkedSession.mockResolvedValue({ killed: true }); // no cmuxSession
		mockKillTmuxWindow.mockResolvedValue({ killed: true });

		await closeRunner(makeOpts(), store);

		expect(existsSync(markerFile)).toBe(false);
	});

	it("does NOT write when the kill-switch is off (byte-compat)", async () => {
		process.env.FLYWHEEL_CMUX_CLOSE_REQUEST = "0";
		seedSession(store, "completed");
		mockKillCmuxLinkedSession.mockResolvedValue({
			killed: true,
			cmuxSession: "cmux-FLY-102-claude-x",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });

		const result = await closeRunner(makeOpts(), store);

		expect(result).toEqual({ closed: true });
		expect(existsSync(markerFile)).toBe(false);
	});

	it("marker write never affects the close result (unwritable path)", async () => {
		process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE = join(
			dir,
			"no-such-dir",
			"marker",
		);
		seedSession(store, "completed");
		mockKillCmuxLinkedSession.mockResolvedValue({
			killed: true,
			cmuxSession: "cmux-FLY-102-claude-x",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });

		const result = await closeRunner(makeOpts(), store);

		expect(result).toEqual({ closed: true });
	});
});
