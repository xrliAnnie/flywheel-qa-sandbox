import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import {
	closeRunnerTerminalView,
	WORKFLOW_TRANSITIONS,
	WorkflowFSM,
} from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import {
	CLOSE_ELIGIBLE_STATES,
	type CloseRunnerResult,
	closeRunner,
} from "../bridge/close-runner.js";
import { commDbPathForProject } from "../bridge/commdb-path.js";
import * as commDbSessionPrune from "../bridge/commdb-session-prune.js";
import { StateStore } from "../StateStore.js";

// FLY-1238: omission must stay a compile error; otherwise callers can silently
// treat a physically closed runner as fully finalized.
// @ts-expect-error commDbFinalized and retiredGateCount are required
const _missingFinalizationContract: CloseRunnerResult = { closed: true };

// ── Mock tmux-lookup ────────────────────────────────────────

const mockGetTmuxTarget = vi.fn();
const mockKillTmuxWindow = vi.fn();
const mockProbeRunnerProcessLiveness = vi.fn();
const mockHasHostProcessByExecutionId = vi.fn();
const mockProbeRunExecutionLiveness = vi.fn();

const mockKillCmuxLinkedSession = vi.fn(async () => ({ killed: true }));
const mockPrepareCodexPhaseShutdown = vi.fn();

vi.mock("../bridge/runner-teardown.js", () => ({
	reapRunnerMcp: vi.fn(async () => ({ killed: [], failed: [] })),
}));

vi.mock("flywheel-core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("flywheel-core")>();
	return {
		...actual,
		closeRunnerTerminalView: vi.fn(async () => ({
			closedTab: true,
			killedViewerSession: true,
		})),
	};
});
const mockCloseRunnerTerminalView = vi.mocked(closeRunnerTerminalView);

vi.mock("../bridge/codex-phase-shutdown.js", () => ({
	isResidentCodexPhase: (session: {
		adapter_type?: string;
		chat_thread_role?: string;
	}) =>
		session?.adapter_type === "codex-tmux" &&
		["design", "implement", "qa"].includes(session.chat_thread_role ?? ""),
	prepareCodexPhaseShutdown: (...args: unknown[]) =>
		mockPrepareCodexPhaseShutdown(...args),
}));

vi.mock("../bridge/tmux-lookup.js", () => ({
	getTmuxTargetFromCommDb: (...args: unknown[]) => mockGetTmuxTarget(...args),
	killTmuxWindow: (...args: unknown[]) => mockKillTmuxWindow(...args),
	probeRunnerProcessLiveness: (...args: unknown[]) =>
		mockProbeRunnerProcessLiveness(...args),
	killCmuxLinkedSession: (...args: unknown[]) =>
		mockKillCmuxLinkedSession(...args),
}));

vi.mock("../bridge/generalized-launch-recovery.js", () => ({
	hasHostProcessByExecutionId: (...args: unknown[]) =>
		mockHasHostProcessByExecutionId(...args),
}));

vi.mock("../bridge/run-quiescence.js", () => ({
	probeRunExecutionLiveness: (...args: unknown[]) =>
		mockProbeRunExecutionLiveness(...args),
}));

// FLY-1238: stub the atomic CommDB finalizer so tests never touch the real
// comm.db on disk. Physical teardown is not complete until this succeeds.
const mockFinalizeCommDbSession = vi.fn(() => ({
	ok: true as const,
	outcome: "finalized" as const,
	retiredGateCount: 2,
	retiredAskCount: 0,
	deletedSessionCount: 1,
}));
const mockFinalizeCommDbTerminalSession = vi.fn(() => ({
	ok: true as const,
	outcome: "finalized" as const,
	retiredGateCount: 2,
	retiredAskCount: 0,
	deletedSessionCount: 1,
}));
const mockFinalizeCommDbSessionCommunications = vi.fn(() => ({
	ok: true as const,
	outcome: "finalized" as const,
	retiredGateCount: 2,
	retiredAskCount: 0,
	deletedSessionCount: 0,
}));
vi.mock("../bridge/commdb-session-prune.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../bridge/commdb-session-prune.js")>();
	return {
		...actual,
		finalizeCommDbSession: (...args: unknown[]) =>
			mockFinalizeCommDbSession(...args),
		finalizeCommDbTerminalSession: (...args: unknown[]) =>
			mockFinalizeCommDbTerminalSession(...args),
		finalizeCommDbSessionCommunications: (...args: unknown[]) =>
			mockFinalizeCommDbSessionCommunications(...args),
	};
});

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

function seedCommSession(
	status: "running" | "completed" | "timeout" | "failed" | "blocked",
): void {
	const dbPath = commDbPathForProject("flywheel");
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new CommDB(dbPath);
	try {
		db.registerSession(
			"exec-1",
			"runner-flywheel:pending",
			"flywheel",
			"FLY-102",
			"lead-a",
		);
		if (status === "completed" || status === "timeout") {
			db.updateSessionStatus("exec-1", status);
		} else if (status === "failed" || status === "blocked") {
			db.markSessionTerminalStatus("exec-1", status);
		}
	} finally {
		db.close();
	}
}

describe("closeRunner", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		mockGetTmuxTarget.mockReset();
		mockKillTmuxWindow.mockReset();
		mockHasHostProcessByExecutionId.mockReset();
		mockHasHostProcessByExecutionId.mockResolvedValue(true);
		mockProbeRunExecutionLiveness.mockReset();
		mockProbeRunExecutionLiveness.mockImplementation(async () =>
			(await mockHasHostProcessByExecutionId()) ? "alive" : "dead",
		);
		mockProbeRunnerProcessLiveness.mockReset();
		mockProbeRunnerProcessLiveness.mockResolvedValue("indeterminate");
		mockFinalizeCommDbSession.mockReset();
		mockFinalizeCommDbSession.mockReturnValue({
			ok: true,
			outcome: "finalized",
			retiredGateCount: 2,
			retiredAskCount: 0,
			deletedSessionCount: 1,
		});
		mockFinalizeCommDbTerminalSession.mockReset();
		mockFinalizeCommDbTerminalSession.mockReturnValue({
			ok: true,
			outcome: "finalized",
			retiredGateCount: 2,
			retiredAskCount: 0,
			deletedSessionCount: 1,
		});
		mockFinalizeCommDbSessionCommunications.mockReset();
		mockFinalizeCommDbSessionCommunications.mockReturnValue({
			ok: true,
			outcome: "finalized",
			retiredGateCount: 2,
			retiredAskCount: 0,
			deletedSessionCount: 0,
		});
		mockPrepareCodexPhaseShutdown.mockReset();
		mockPrepareCodexPhaseShutdown.mockResolvedValue({
			kind: "not_applicable",
		});
		mockCloseRunnerTerminalView.mockReset();
		mockCloseRunnerTerminalView.mockResolvedValue({
			closedTab: true,
			killedViewerSession: true,
		});
	});

	it("FLY-1269: treats an adapter-acknowledged resident Codex phase as closed without direct kill", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-102",
			project_name: "flywheel",
			status: "completed",
			adapter_type: "codex-tmux",
			chat_thread_role: "qa",
		});
		mockPrepareCodexPhaseShutdown.mockResolvedValue({
			kind: "graceful",
			requestId: "shutdown-1",
		});

		const result = await closeRunner(makeOpts(), store);

		expect(result).toEqual({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 2,
		});
		expect(mockKillTmuxWindow).not.toHaveBeenCalled();
		expect(mockFinalizeCommDbSession).toHaveBeenCalledWith(
			"exec-1",
			"flywheel",
		);
	});

	it("fences a stale collector after graceful phase shutdown before finalization", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-102",
			project_name: "flywheel",
			status: "completed",
			adapter_type: "codex-tmux",
			chat_thread_role: "qa",
		});
		let shutdownFinished = false;
		mockPrepareCodexPhaseShutdown.mockImplementation(async () => {
			shutdownFinished = true;
			return { kind: "graceful", requestId: "shutdown-stale" };
		});
		const authorityCheck = vi.fn(async () =>
			shutdownFinished
				? { ok: false, reason: "collector_lease_lost" }
				: { ok: true },
		);

		const result = await closeRunner(makeOpts({ authorityCheck }), store);

		expect(result).toMatchObject({
			closed: false,
			error: "authority_lost:post_phase_shutdown:collector_lease_lost",
		});
		expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
		expect(
			store
				.getEventsByExecution("exec-1")
				.filter(
					(event) => event.event_type === "lead_close_runner_authority_lost",
				),
		).toHaveLength(1);
	});

	it("FLY-1269: preserves a live Codex phase and its rows when the shutdown handshake blocks", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-102",
			project_name: "flywheel",
			status: "completed",
			adapter_type: "codex-tmux",
			chat_thread_role: "design",
		});
		mockPrepareCodexPhaseShutdown.mockResolvedValue({
			kind: "blocked",
			error: "phase_shutdown_ack_timeout_live_controller",
		});

		const result = await closeRunner(makeOpts(), store);

		expect(result).toEqual({
			closed: false,
			commDbFinalized: false,
			retiredGateCount: 0,
			error: "phase_shutdown_ack_timeout_live_controller",
		});
		expect(mockKillTmuxWindow).not.toHaveBeenCalled();
		expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
	});

	it("FLY-1269: a proven-orphan Codex phase falls through to the legacy direct kill", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-102",
			project_name: "flywheel",
			status: "completed",
			adapter_type: "codex-tmux",
			chat_thread_role: "implement",
		});
		mockPrepareCodexPhaseShutdown.mockResolvedValue({
			kind: "direct",
			reason: "controller_heartbeat_stopped",
		});
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "FLY-102:@0",
			sessionName: "FLY-102",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });

		const result = await closeRunner(makeOpts(), store);

		expect(result.closed).toBe(true);
		expect(mockKillTmuxWindow).toHaveBeenCalledWith("FLY-102:@0");
	});

	it("returns session_not_found when session is absent (no event written)", async () => {
		const result = await closeRunner(makeOpts(), store);

		expect(result).toEqual({
			closed: false,
			commDbFinalized: false,
			retiredGateCount: 0,
			error: "session_not_found",
		});
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
				commDbFinalized: false,
				retiredGateCount: 0,
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

		const resolveCommDbPath = vi.spyOn(commDbSessionPrune, "resolveCommDbPath");
		const result = await closeRunner(makeOpts(), store);

		expect(result).toEqual({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 2,
			error: undefined,
		});
		expect(JSON.stringify(result)).toBe(
			'{"closed":true,"commDbFinalized":true,"retiredGateCount":2}',
		);
		expect(mockProbeRunnerProcessLiveness).not.toHaveBeenCalled();
		expect(resolveCommDbPath).not.toHaveBeenCalled();
		resolveCommDbPath.mockRestore();
		expect(mockKillTmuxWindow).toHaveBeenCalledWith("FLY-102:@0");
		const events = store.getEventsByExecution("exec-1");
		expect(events.some((e) => e.event_type === "lead_close_runner")).toBe(true);
	});

	it("FLY-2313: host-process absence proves a terminal pending runner is gone", async () => {
		seedSession(store, "completed");
		seedCommSession("completed");
		mockHasHostProcessByExecutionId.mockResolvedValue(false);
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "runner-flywheel:pending",
			sessionName: "runner-flywheel",
		});
		mockKillTmuxWindow.mockResolvedValue({
			killed: false,
			error: "tmux window identity is still pending",
		});
		const archiveFn = vi.fn();

		const result = await closeRunner(
			makeOpts({ archive: { projects: [], archiveFn } }),
			store,
		);

		expect(result).toEqual({
			closed: false,
			physicalGone: true,
			runnerDeathProven: true,
			commDbFinalized: true,
			retiredGateCount: 2,
			error: "tmux window identity is still pending",
		});
		expect(mockProbeRunExecutionLiveness).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: "exec-1" }),
			"exec-1",
			"flywheel",
		);
		expect(mockFinalizeCommDbTerminalSession).toHaveBeenCalledWith(
			"exec-1",
			"flywheel",
			"runner-flywheel:pending",
		);
		expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
		expect(mockFinalizeCommDbSessionCommunications).not.toHaveBeenCalled();
		expect(mockProbeRunnerProcessLiveness).not.toHaveBeenCalled();
		expect(mockCloseRunnerTerminalView).not.toHaveBeenCalled();
		expect(archiveFn).not.toHaveBeenCalled();
	});

	it("FLY-2313: a host process keeps a terminal pending runner unknown", async () => {
		seedSession(store, "completed");
		seedCommSession("completed");
		mockHasHostProcessByExecutionId.mockResolvedValue(true);
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "runner-flywheel:pending",
			sessionName: "runner-flywheel",
		});
		mockKillTmuxWindow.mockResolvedValue({
			killed: false,
			error: "tmux window identity is still pending",
		});

		const result = await closeRunner(makeOpts(), store);

		expect(result).toEqual({
			closed: false,
			physicalGone: false,
			commDbFinalized: false,
			retiredGateCount: 0,
			error: "commdb_finalize_skipped:tmux window identity is still pending",
		});
		expect(mockProbeRunExecutionLiveness).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: "exec-1" }),
			"exec-1",
			"flywheel",
		);
		expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
		expect(mockFinalizeCommDbSessionCommunications).not.toHaveBeenCalled();
	});

	it("FLY-2313: a live Codex daemon vetoes a misleading pgrep no-match", async () => {
		seedSession(store, "completed");
		store.patchSessionMetadata("exec-1", { adapter_type: "codex-tmux" });
		seedCommSession("completed");
		mockHasHostProcessByExecutionId.mockResolvedValue(false);
		mockProbeRunExecutionLiveness.mockResolvedValue("alive");
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "runner-flywheel:pending",
			sessionName: "runner-flywheel",
		});
		mockKillTmuxWindow.mockResolvedValue({
			killed: false,
			error: "tmux window identity is still pending",
		});

		const result = await closeRunner(makeOpts(), store);

		expect(result).toMatchObject({
			closed: false,
			physicalGone: false,
			commDbFinalized: false,
		});
		expect(mockProbeRunExecutionLiveness).toHaveBeenCalledWith(
			expect.objectContaining({ adapter_type: "codex-tmux" }),
			"exec-1",
			"flywheel",
		);
		expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
		expect(mockFinalizeCommDbSessionCommunications).not.toHaveBeenCalled();
	});

	it("FLY-2313: keeps a running pending session even when the probe seam would say absent", async () => {
		seedSession(store, "running");
		seedCommSession("running");
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "runner-flywheel:pending",
			sessionName: "runner-flywheel",
		});
		mockKillTmuxWindow.mockResolvedValue({
			killed: false,
			error: "tmux window identity is still pending",
		});
		mockProbeRunnerProcessLiveness.mockResolvedValue("absent");

		const result = await closeRunner(
			makeOpts({ issueTerminalOverride: true }),
			store,
		);

		expect(result).toEqual({
			closed: false,
			physicalGone: false,
			commDbFinalized: false,
			retiredGateCount: 0,
			error: "commdb_finalize_skipped:tmux window identity is still pending",
		});
		expect(mockProbeRunnerProcessLiveness).not.toHaveBeenCalled();
		expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
		expect(mockFinalizeCommDbSessionCommunications).not.toHaveBeenCalled();
	});

	it("FLY-2313: rechecks authority before finalizing without a successful kill", async () => {
		seedSession(store, "completed");
		seedCommSession("completed");
		mockHasHostProcessByExecutionId.mockResolvedValue(false);
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "runner-flywheel:pending",
			sessionName: "runner-flywheel",
		});
		mockKillTmuxWindow.mockResolvedValue({
			killed: false,
			error: "tmux window identity is still pending",
		});
		let authorityChecks = 0;
		const authorityCheck = vi.fn(async () => {
			authorityChecks += 1;
			return authorityChecks < 4
				? { ok: true }
				: { ok: false, reason: "authority_reopened" };
		});

		const result = await closeRunner(makeOpts({ authorityCheck }), store);

		expect(result).toMatchObject({
			closed: false,
			commDbFinalized: false,
			error: "authority_lost:pre_commdb_finalize:authority_reopened",
		});
		expect(authorityCheck).toHaveBeenCalledTimes(4);
		expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
		expect(mockFinalizeCommDbSessionCommunications).not.toHaveBeenCalled();
	});

	it.each([
		["timeout", { issueTerminalOverride: true }],
		["failed", { forcePreserved: true }],
		["blocked", { forcePreserved: true }],
	] as const)(
		"FLY-2313: finalizes terminal pending CommDB status=%s",
		async (status, overrides) => {
			seedSession(store, status);
			seedCommSession(status);
			mockHasHostProcessByExecutionId.mockResolvedValue(false);
			mockGetTmuxTarget.mockReturnValue({
				tmuxWindow: "runner-flywheel:pending",
				sessionName: "runner-flywheel",
			});
			mockKillTmuxWindow.mockResolvedValue({
				killed: false,
				error: "tmux window identity is still pending",
			});

			const result = await closeRunner(makeOpts(overrides), store);

			expect(result).toMatchObject({
				closed: false,
				physicalGone: true,
				commDbFinalized: true,
				error: "tmux window identity is still pending",
			});
			expect(mockProbeRunnerProcessLiveness).not.toHaveBeenCalled();
			const expectedFinalizeArgs: unknown[] = [
				"exec-1",
				"flywheel",
				"runner-flywheel:pending",
			];
			if (status === "failed" || status === "blocked") {
				expectedFinalizeArgs.push(status);
			}
			expect(mockFinalizeCommDbTerminalSession).toHaveBeenCalledWith(
				...expectedFinalizeArgs,
			);
			expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
			expect(mockFinalizeCommDbSessionCommunications).not.toHaveBeenCalled();
		},
	);

	it.each(["failed", "blocked"] as const)(
		"FLY-2313: death proof promotes an unmirrored pending CommDB row to StateStore status=%s",
		async (status) => {
			seedSession(store, status);
			seedCommSession("running");
			mockHasHostProcessByExecutionId.mockResolvedValue(false);
			mockGetTmuxTarget.mockReturnValue({
				tmuxWindow: "runner-flywheel:pending",
				sessionName: "runner-flywheel",
			});
			mockKillTmuxWindow.mockResolvedValue({
				killed: false,
				error: "tmux window identity is still pending",
			});

			const result = await closeRunner(
				makeOpts({ forcePreserved: true }),
				store,
			);

			expect(result).toMatchObject({
				closed: false,
				physicalGone: true,
				commDbFinalized: true,
				error: "tmux window identity is still pending",
			});
			expect(mockFinalizeCommDbTerminalSession).toHaveBeenCalledWith(
				"exec-1",
				"flywheel",
				"runner-flywheel:pending",
				status,
			);
		},
	);

	it("FLY-2313: refuses crash-authorized finalization when StateStore leaves terminal status during the death probe", async () => {
		seedSession(store, "failed");
		seedCommSession("running");
		mockProbeRunExecutionLiveness.mockImplementationOnce(async () => {
			store.forceStatus("exec-1", "running", new Date().toISOString());
			return "dead";
		});
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "runner-flywheel:pending",
			sessionName: "runner-flywheel",
		});
		mockKillTmuxWindow.mockResolvedValue({
			killed: false,
			error: "tmux window identity is still pending",
		});

		const result = await closeRunner(makeOpts({ forcePreserved: true }), store);

		expect(result).toMatchObject({
			closed: false,
			physicalGone: true,
			runnerDeathProven: true,
			commDbFinalized: false,
			error:
				"commdb_finalize_failed:state_store_terminal_changed; tmux window identity is still pending",
		});
		expect(mockFinalizeCommDbTerminalSession).not.toHaveBeenCalled();
	});

	it.each(["absent", "dead_pin"] as const)(
		"FLY-2313: does not delete a nonterminal identity when its registered target is %s",
		async (liveness) => {
			seedSession(store, "completed");
			seedCommSession("running");
			mockGetTmuxTarget.mockReturnValue({
				tmuxWindow: "runner-flywheel:@42",
				sessionName: "runner-flywheel",
			});
			mockKillTmuxWindow.mockResolvedValue({
				killed: false,
				error: "permission denied",
			});
			mockProbeRunnerProcessLiveness.mockResolvedValue(liveness);

			const result = await closeRunner(makeOpts(), store);

			expect(result).toEqual({
				closed: false,
				physicalGone: false,
				commDbFinalized: false,
				retiredGateCount: 0,
				error: "commdb_finalize_skipped:permission denied",
			});
			expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
			expect(mockFinalizeCommDbSessionCommunications).not.toHaveBeenCalled();
		},
	);

	it.each(["alive", "indeterminate"] as const)(
		"FLY-2313: does not finalize a nonterminal row when liveness is %s",
		async (liveness) => {
			seedSession(store, "completed");
			seedCommSession("running");
			mockGetTmuxTarget.mockReturnValue({
				tmuxWindow: "runner-flywheel:@42",
				sessionName: "runner-flywheel",
			});
			mockKillTmuxWindow.mockResolvedValue({
				killed: false,
				error: "permission denied",
			});
			mockProbeRunnerProcessLiveness.mockResolvedValue(liveness);

			const result = await closeRunner(makeOpts(), store);

			expect(result).toEqual({
				closed: false,
				physicalGone: false,
				commDbFinalized: false,
				retiredGateCount: 0,
				error: "commdb_finalize_skipped:permission denied",
			});
			expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
			expect(mockFinalizeCommDbSessionCommunications).not.toHaveBeenCalled();
		},
	);

	it("FLY-2313: an alive probe vetoes terminal CommDB evidence", async () => {
		seedSession(store, "completed");
		seedCommSession("completed");
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "runner-flywheel:@42",
			sessionName: "runner-flywheel",
		});
		mockKillTmuxWindow.mockResolvedValue({
			killed: false,
			error: "permission denied",
		});
		mockProbeRunnerProcessLiveness.mockResolvedValue("alive");

		const result = await closeRunner(makeOpts(), store);

		expect(result).toMatchObject({
			closed: false,
			physicalGone: false,
			commDbFinalized: false,
			error: "commdb_finalize_skipped:permission denied",
		});
		expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
		expect(mockFinalizeCommDbSessionCommunications).not.toHaveBeenCalled();
	});

	it("FLY-2313: indeterminate liveness cannot finalize terminal communications", async () => {
		seedSession(store, "completed");
		seedCommSession("completed");
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "runner-flywheel:@42",
			sessionName: "runner-flywheel",
		});
		mockKillTmuxWindow.mockResolvedValue({
			killed: false,
			error: "probe unavailable",
		});
		mockProbeRunnerProcessLiveness.mockResolvedValue("indeterminate");

		const result = await closeRunner(makeOpts(), store);

		expect(result).toMatchObject({
			closed: false,
			physicalGone: false,
			commDbFinalized: false,
			error: "commdb_finalize_skipped:probe unavailable",
		});
		expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
		expect(mockFinalizeCommDbSessionCommunications).not.toHaveBeenCalled();
	});

	it("FLY-2313: preserves both a finalizer failure and the pending kill refusal", async () => {
		seedSession(store, "completed");
		seedCommSession("completed");
		mockHasHostProcessByExecutionId.mockResolvedValue(false);
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "runner-flywheel:pending",
			sessionName: "runner-flywheel",
		});
		mockKillTmuxWindow.mockResolvedValue({
			killed: false,
			error: "tmux window identity is still pending",
		});
		mockFinalizeCommDbTerminalSession.mockReturnValue({
			ok: false,
			outcome: "failed",
			retiredGateCount: 0,
			retiredAskCount: 0,
			deletedSessionCount: 0,
			error: "sqlite busy",
		});

		const result = await closeRunner(makeOpts(), store);

		expect(result).toMatchObject({
			closed: false,
			physicalGone: true,
			commDbFinalized: false,
			error:
				"commdb_finalize_failed:sqlite busy; tmux window identity is still pending",
		});
		expect(store.getCommDbFinalizeFailure("exec-1")?.attempts).toBe(1);
	});

	it("FLY-2313: stale target absence cannot create a proven-death failure episode", async () => {
		seedSession(store, "completed");
		seedCommSession("completed");
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "runner-flywheel:@42",
			sessionName: "runner-flywheel",
		});
		mockKillTmuxWindow.mockResolvedValue({
			killed: false,
			error: "permission denied",
		});
		mockProbeRunnerProcessLiveness.mockResolvedValue("absent");
		mockFinalizeCommDbSessionCommunications.mockReturnValue({
			ok: false,
			outcome: "failed",
			retiredGateCount: 0,
			retiredAskCount: 0,
			deletedSessionCount: 0,
			error: "sqlite busy",
		});

		const result = await closeRunner(makeOpts(), store);

		expect(result).toMatchObject({
			closed: false,
			physicalGone: false,
			commDbFinalized: false,
		});
		expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
		expect(store.getCommDbFinalizeFailure("exec-1")).toBeUndefined();
	});

	it("returns alreadyGone=true when no tmux target (idempotent)", async () => {
		// FLY-116: failed/blocked are preserved by default; use an AUTO_CLOSE
		// status here so the alreadyGone path is exercised.
		seedSession(store, "completed");
		mockGetTmuxTarget.mockReturnValue(undefined);

		const result = await closeRunner(makeOpts(), store);

		expect(result).toEqual({
			closed: true,
			alreadyGone: true,
			commDbFinalized: true,
			retiredGateCount: 2,
		});
		expect(mockKillTmuxWindow).not.toHaveBeenCalled();
		const events = store.getEventsByExecution("exec-1");
		const evt = events.find((e) => e.event_type === "lead_close_runner");
		expect(evt).toBeDefined();
		expect((evt!.payload as { alreadyGone?: boolean })?.alreadyGone).toBe(true);
	});

	it("checks sticky collection authority before the already-gone success path", async () => {
		seedSession(store, "completed");
		mockGetTmuxTarget.mockReturnValue(undefined);
		const authorityCheck = vi.fn(async () => ({
			ok: false,
			reason: "collector_lease_lost",
		}));

		const result = await closeRunner(makeOpts({ authorityCheck }), store);

		expect(result).toMatchObject({
			closed: false,
			error: "authority_lost:preflight:collector_lease_lost",
		});
		expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
		expect(
			store
				.getEventsByExecution("exec-1")
				.filter(
					(event) => event.event_type === "lead_close_runner_authority_lost",
				),
		).toHaveLength(1);
	});

	it("FLY-1238: fails communication finalization closed and skips archive when tmux is already gone", async () => {
		seedSession(store, "completed");
		mockGetTmuxTarget.mockReturnValue(undefined);
		mockFinalizeCommDbSession.mockReturnValue({
			ok: false,
			outcome: "failed",
			retiredGateCount: 0,
			deletedSessionCount: 0,
			error: "sqlite busy",
		} as never);
		const archiveFn = vi.fn();

		const result = await closeRunner(
			makeOpts({ archive: { projects: [], archiveFn } }),
			store,
		);

		expect(result).toEqual({
			closed: true,
			alreadyGone: true,
			commDbFinalized: false,
			retiredGateCount: 0,
			error: "commdb_finalize_failed:sqlite busy",
		});
		expect(archiveFn).not.toHaveBeenCalled();
	});

	it("FLY-1238: fails communication finalization closed and skips archive after a successful kill", async () => {
		seedSession(store, "completed");
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "FLY-102:@0",
			sessionName: "FLY-102",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });
		mockFinalizeCommDbSession.mockReturnValue({
			ok: false,
			outcome: "failed",
			retiredGateCount: 0,
			deletedSessionCount: 0,
			error: "disk full",
		} as never);
		const archiveFn = vi.fn();

		const result = await closeRunner(
			makeOpts({ archive: { projects: [], archiveFn } }),
			store,
		);

		expect(result).toEqual({
			closed: true,
			commDbFinalized: false,
			retiredGateCount: 0,
			error: "commdb_finalize_failed:disk full",
		});
		expect(archiveFn).not.toHaveBeenCalled();
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

		expect(result).toEqual({
			closed: false,
			physicalGone: false,
			commDbFinalized: false,
			retiredGateCount: 0,
			error: "commdb_finalize_skipped:permission denied",
		});
		const events = store.getEventsByExecution("exec-1");
		expect(
			events.some((e) => e.event_type === "lead_close_runner_failed"),
		).toBe(true);
	});

	it("R4#2: authority lost after the MCP reap aborts BEFORE the tmux kill (audited)", async () => {
		seedSession(store, "completed");
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "FLY-102:@0",
			sessionName: "FLY-102",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });
		// A Linear reopen lands between the (awaited) MCP reap and the first
		// destructive kill → the teardown must stop, never touching tmux.
		const authorityCheck = vi.fn(async () => ({
			ok: false,
			reason: "authority_reopened",
		}));

		const result = await closeRunner(makeOpts({ authorityCheck }), store);

		expect(result).toEqual({
			closed: false,
			commDbFinalized: false,
			retiredGateCount: 0,
			error: "authority_lost:preflight:authority_reopened",
		});
		expect(mockKillTmuxWindow).not.toHaveBeenCalled();
		expect(authorityCheck).toHaveBeenCalled();
		const events = store.getEventsByExecution("exec-1");
		expect(
			events.some((e) => e.event_type === "lead_close_runner_authority_lost"),
		).toBe(true);
	});

	it("R4#2: a throwing authorityCheck is fail-closed (aborts the teardown)", async () => {
		seedSession(store, "completed");
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "FLY-102:@0",
			sessionName: "FLY-102",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });
		const authorityCheck = vi.fn(async () => {
			throw new Error("linear boom");
		});

		const result = await closeRunner(makeOpts({ authorityCheck }), store);

		expect(result.closed).toBe(false);
		expect(result.error).toContain("authority_lost:preflight");
		expect(result.error).toContain("authority_check_failed");
		expect(mockKillTmuxWindow).not.toHaveBeenCalled();
	});

	it("R4#2: an authorized check lets the teardown proceed to the kill (byte-compat)", async () => {
		seedSession(store, "completed");
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "FLY-102:@0",
			sessionName: "FLY-102",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });
		const authorityCheck = vi.fn(async () => ({ ok: true }));

		const result = await closeRunner(makeOpts({ authorityCheck }), store);

		expect(result).toEqual({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 2,
			error: undefined,
		});
		expect(mockKillTmuxWindow).toHaveBeenCalledWith("FLY-102:@0");
		// called before EACH external boundary (pre-cmux, pre-tmux, post-kill).
		expect(authorityCheck.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("brackets an explicit operator close with a committed intent and run cascade", async () => {
		seedSession(store, "completed");
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "FLY-102:@0",
			sessionName: "FLY-102",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });
		const cascade = vi
			.spyOn(store, "cascadeRunTerminationOnCarrierClose")
			.mockReturnValue({
				ok: false,
				reason: "carrier_not_enrolled",
			});

		const result = await closeRunner(
			makeOpts({
				reason: "operator close",
				runCloseAuthority: { mode: "done", principal: "lead-a" },
			}),
			store,
		);

		expect(result.closed).toBe(true);
		expect(store.getWorkflowOperatorCloseIntent("exec-1")).toMatchObject({
			mode: "done",
			reason: "operator close",
			stage: "committed",
		});
		expect(cascade).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "exec-1",
				mode: "done",
				principal: "lead-a",
			}),
		);

		const replay = await closeRunner(
			makeOpts({
				reason: "operator close retry",
				runCloseAuthority: { mode: "done", principal: "lead-a" },
			}),
			store,
		);
		expect(replay).toMatchObject({ closed: true, alreadyGone: true });
		expect(mockKillTmuxWindow).toHaveBeenCalledTimes(1);
		expect(cascade).toHaveBeenCalledTimes(2);
	});

	it("fences a stale collector after tmux closes before communication finalization", async () => {
		seedSession(store, "completed");
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "FLY-102:@0",
			sessionName: "FLY-102",
		});
		let tmuxKilled = false;
		mockKillTmuxWindow.mockImplementation(async () => {
			tmuxKilled = true;
			return { killed: true };
		});
		const authorityCheck = vi.fn(async () =>
			tmuxKilled ? { ok: false, reason: "collector_lease_lost" } : { ok: true },
		);

		const result = await closeRunner(makeOpts({ authorityCheck }), store);

		expect(result).toMatchObject({
			closed: false,
			error: "authority_lost:post_tmux_kill:collector_lease_lost",
		});
		expect(mockCloseRunnerTerminalView).not.toHaveBeenCalled();
		expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
		expect(
			store
				.getEventsByExecution("exec-1")
				.filter(
					(event) => event.event_type === "lead_close_runner_authority_lost",
				),
		).toHaveLength(1);
	});

	it("fences a stale collector after bounded terminal-view cleanup", async () => {
		seedSession(store, "completed");
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "FLY-102:@0",
			sessionName: "FLY-102",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });
		let terminalViewClosed = false;
		mockCloseRunnerTerminalView.mockImplementation(async () => {
			terminalViewClosed = true;
			return { closedTab: true, killedViewerSession: true };
		});
		const authorityCheck = vi.fn(async () =>
			terminalViewClosed
				? { ok: false, reason: "collector_lease_lost" }
				: { ok: true },
		);

		const result = await closeRunner(makeOpts({ authorityCheck }), store);

		expect(result).toMatchObject({
			closed: false,
			error: "authority_lost:post_terminal_view:collector_lease_lost",
		});
		expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
		expect(
			store
				.getEventsByExecution("exec-1")
				.filter(
					(event) => event.event_type === "lead_close_runner_authority_lost",
				),
		).toHaveLength(1);
	});

	it("FLY-2313: stale non-pending absence does not authorize archive", async () => {
		// Seed a FULLY RESOLVABLE archive context (project + registered thread)
		// so that the PRE-fix placement (cascade before the kill) WOULD have
		// called archiveFn — i.e. this test actually exercises the success-gate.
		seedSession(store, "completed");
		seedCommSession("completed");
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
		mockProbeRunnerProcessLiveness.mockResolvedValue("absent");
		const archiveFn = vi.fn().mockResolvedValue({ archived: true });

		const result = await closeRunner(
			makeOpts({
				archive: {
					projects: [project],
					archiveFn,
					probeFn: vi
						.fn()
						.mockResolvedValueOnce({
							ok: true,
							name: "thread",
							archived: false,
						})
						.mockResolvedValueOnce({
							ok: true,
							name: "thread",
							archived: true,
						}),
					frontierFn: vi.fn().mockResolvedValue({
						ok: true,
						messageId: "100000000000000000",
					}),
				},
			}),
			store,
		);

		// The registered target is absent, but its CommDB mapping may be stale.
		// That can settle terminal communications only; it is not execution-death
		// proof and therefore cannot delete the identity or archive the thread.
		expect(result).toEqual({
			closed: false,
			physicalGone: false,
			commDbFinalized: true,
			retiredGateCount: 2,
			error: "permission denied",
		});
		expect(mockFinalizeCommDbSession).not.toHaveBeenCalled();
		expect(mockFinalizeCommDbSessionCommunications).toHaveBeenCalledWith(
			"exec-1",
			"flywheel",
			"FLY-102:@0",
		);
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
				commDbFinalized: false,
				retiredGateCount: 0,
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

			expect(result).toEqual({
				closed: true,
				commDbFinalized: true,
				retiredGateCount: 2,
				error: undefined,
			});
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

		expect(result).toEqual({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 2,
			error: undefined,
		});
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

			expect(result).toEqual({
				closed: true,
				alreadyGone: true,
				commDbFinalized: true,
				retiredGateCount: 2,
			});
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

		expect(result).toEqual({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 2,
			error: undefined,
		});
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
				archive: {
					projects: [project],
					archiveFn,
					probeFn: vi
						.fn()
						.mockResolvedValueOnce({
							ok: true,
							name: "thread",
							archived: false,
						})
						.mockResolvedValueOnce({
							ok: true,
							name: "thread",
							archived: true,
						}),
					frontierFn: vi.fn().mockResolvedValue({
						ok: true,
						messageId: "100000000000000000",
					}),
				},
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

		expect(result).toEqual({
			closed: true,
			alreadyGone: true,
			commDbFinalized: true,
			retiredGateCount: 2,
		});
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
			commDbFinalized: false,
			retiredGateCount: 0,
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
			commDbFinalized: false,
			retiredGateCount: 0,
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

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		mockGetTmuxTarget.mockReset();
		mockKillTmuxWindow.mockReset();
		mockKillCmuxLinkedSession.mockReset();
		dir = mkdtempSync(join(tmpdir(), "fly685-close-"));
		markerFile = join(dir, "close-requested");
		process.env.FLYWHEEL_CMUX_CLOSE_REQUEST_FILE = markerFile;
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

		expect(result).toEqual({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 2,
			error: undefined,
		});
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

		expect(result).toEqual({
			closed: true,
			commDbFinalized: true,
			retiredGateCount: 2,
			error: undefined,
		});
	});
});

/**
 * FLY-1048 PR-C (C5): a COMMITTED close is "cleanup entered" — every active
 * detection episode of the target flips to CLEARING so all detection kinds
 * stay quiet while the pane churns through teardown (FLY-970 ghost spam). A
 * REFUSED close (not eligible / preserved) never marks anything.
 */
describe("closeRunner C5 detection CLEARING (FLY-1048)", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		mockGetTmuxTarget.mockReset();
		mockKillTmuxWindow.mockReset();
	});

	function seedEpisode(store: StateStore): void {
		store.upsertDetectionEscalation({
			targetKey: "exec-1",
			kind: "detection_stuck_confirmed",
			episodeFingerprint: "fp:1",
			firstDetectedAtMs: 1,
		});
	}

	it("an eligible close marks the target's active episodes CLEARING", async () => {
		seedSession(store, "completed");
		seedEpisode(store);
		mockGetTmuxTarget.mockReturnValue(undefined); // already-gone path
		await closeRunner(makeOpts(), store);
		expect(
			store.getDetectionEscalation(
				"exec-1",
				"detection_stuck_confirmed",
				"fp:1",
			)?.status,
		).toBe("CLEARING");
	});

	it("a refused close (status_not_eligible) marks nothing", async () => {
		seedSession(store, "running");
		seedEpisode(store);
		await closeRunner(makeOpts(), store);
		expect(
			store.getDetectionEscalation(
				"exec-1",
				"detection_stuck_confirmed",
				"fp:1",
			)?.status,
		).toBe("NEW");
	});

	it("a crash-preserved close (failed, not forced) marks nothing", async () => {
		seedSession(store, "failed");
		seedEpisode(store);
		await closeRunner(makeOpts(), store);
		expect(
			store.getDetectionEscalation(
				"exec-1",
				"detection_stuck_confirmed",
				"fp:1",
			)?.status,
		).toBe("NEW");
	});

	it("marks CLEARING on the killed success path too", async () => {
		seedSession(store, "completed");
		seedEpisode(store);
		mockGetTmuxTarget.mockReturnValue({ tmuxWindow: "w:@1" });
		mockKillTmuxWindow.mockResolvedValue({ killed: true });

		const result = await closeRunner(makeOpts(), store);
		expect(result.closed).toBe(true);
		expect(
			store.getDetectionEscalation(
				"exec-1",
				"detection_stuck_confirmed",
				"fp:1",
			)?.status,
		).toBe("CLEARING");
	});

	it("does NOT mark CLEARING when the tmux kill failed (runner may still be alive)", async () => {
		seedSession(store, "completed");
		seedEpisode(store);
		mockGetTmuxTarget.mockReturnValue({ tmuxWindow: "w:@1" });
		mockKillTmuxWindow.mockResolvedValue({ killed: false, error: "eperm" });

		const result = await closeRunner(makeOpts(), store);
		expect(result.closed).toBe(false);
		expect(
			store.getDetectionEscalation(
				"exec-1",
				"detection_stuck_confirmed",
				"fp:1",
			)?.status,
		).toBe("NEW");
	});
});
