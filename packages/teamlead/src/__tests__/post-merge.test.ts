import { beforeEach, describe, expect, it, vi } from "vitest";
import { postMergeTmuxCleanup } from "../bridge/post-merge.js";
import { StateStore } from "../StateStore.js";

// ── Mock tmux-lookup ────────────────────────────────────

const mockGetTmuxTarget = vi.fn();
const mockKillTmuxWindow = vi.fn();

const mockKillCmuxLinkedSession = vi.fn(async () => ({ killed: true }));
const mockPrepareCodexPhaseShutdown = vi.fn();

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

vi.mock("../bridge/runner-teardown.js", () => ({
	reapRunnerMcp: vi.fn(async () => ({ killed: [], failed: [] })),
}));

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
	killCmuxLinkedSession: (...args: unknown[]) =>
		mockKillCmuxLinkedSession(...args),
}));

// FLY-638: stub the CommDB prune so tests never touch the real comm.db on disk.
const mockDeleteCommDbSession = vi.fn(() => true);
vi.mock("../bridge/commdb-session-prune.js", () => ({
	deleteCommDbSession: (...args: unknown[]) => mockDeleteCommDbSession(...args),
}));

// ── Helpers ─────────────────────────────────────────────

function makeOpts(overrides: Record<string, unknown> = {}) {
	return {
		executionId: "exec-1",
		issueId: "GEO-280",
		projectName: "geoforge3d",
		...overrides,
	};
}

describe("postMergeTmuxCleanup", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		// Seed a session so insertEvent doesn't fail on FK
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "GEO-280",
			project_name: "geoforge3d",
			status: "approved",
		});
		mockGetTmuxTarget.mockReset();
		mockKillTmuxWindow.mockReset();
		mockDeleteCommDbSession.mockReset();
		mockDeleteCommDbSession.mockReturnValue(true);
		mockPrepareCodexPhaseShutdown.mockReset();
		mockPrepareCodexPhaseShutdown.mockResolvedValue({
			kind: "not_applicable",
		});
	});

	it("FLY-1269: shipping Codex QA waits for the shared graceful shutdown and skips direct kill", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "GEO-280",
			project_name: "geoforge3d",
			status: "completed",
			adapter_type: "codex-tmux",
			chat_thread_role: "qa",
		});
		store.patchSessionMetadata("exec-1", {
			adapter_type: "codex-tmux",
			chat_thread_role: "qa",
		});
		mockPrepareCodexPhaseShutdown.mockResolvedValue({
			kind: "graceful",
			requestId: "shutdown-qa",
		});

		const result = await postMergeTmuxCleanup(makeOpts(), store);

		expect(result).toEqual({ tmuxClosed: true, errors: [] });
		expect(mockKillTmuxWindow).not.toHaveBeenCalled();
		expect(mockDeleteCommDbSession).toHaveBeenCalledWith(
			"exec-1",
			"geoforge3d",
		);
	});

	it("FLY-1269: shipping preserves a live Codex QA when the handshake fails", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "GEO-280",
			project_name: "geoforge3d",
			status: "completed",
			adapter_type: "codex-tmux",
			chat_thread_role: "qa",
		});
		store.patchSessionMetadata("exec-1", {
			adapter_type: "codex-tmux",
			chat_thread_role: "qa",
		});
		mockPrepareCodexPhaseShutdown.mockResolvedValue({
			kind: "blocked",
			error: "phase_shutdown_ack_timeout_live_controller",
		});

		const result = await postMergeTmuxCleanup(makeOpts(), store);

		expect(result.tmuxClosed).toBe(false);
		expect(result.errors).toEqual([
			"phase-shutdown: phase_shutdown_ack_timeout_live_controller",
		]);
		expect(mockKillTmuxWindow).not.toHaveBeenCalled();
		expect(mockDeleteCommDbSession).not.toHaveBeenCalled();
	});

	it("FLY-1269: shipping uses direct cleanup only for a proven orphan Codex QA", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "GEO-280",
			project_name: "geoforge3d",
			status: "completed",
			adapter_type: "codex-tmux",
			chat_thread_role: "qa",
		});
		store.patchSessionMetadata("exec-1", {
			adapter_type: "codex-tmux",
			chat_thread_role: "qa",
		});
		mockPrepareCodexPhaseShutdown.mockResolvedValue({
			kind: "direct",
			reason: "controller_heartbeat_stopped",
		});
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "GEO-280:@0",
			sessionName: "GEO-280",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });

		const result = await postMergeTmuxCleanup(makeOpts(), store);

		expect(result.tmuxClosed).toBe(true);
		expect(mockKillTmuxWindow).toHaveBeenCalledWith("GEO-280:@0");
	});

	it("closes tmux when CommDB has target", async () => {
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "GEO-280:@0",
			sessionName: "GEO-280",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });

		const result = await postMergeTmuxCleanup(makeOpts(), store);

		expect(result.tmuxClosed).toBe(true);
		expect(result.errors).toEqual([]);
		expect(mockKillTmuxWindow).toHaveBeenCalledWith("GEO-280:@0");
	});

	it("skips tmux when no CommDB target", async () => {
		mockGetTmuxTarget.mockReturnValue(undefined);

		const result = await postMergeTmuxCleanup(makeOpts(), store);

		expect(result.tmuxClosed).toBe(false);
		expect(result.errors).toEqual([]);
		expect(mockKillTmuxWindow).not.toHaveBeenCalled();
	});

	it("captures tmux kill error without throwing", async () => {
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "GEO-280:@0",
			sessionName: "GEO-280",
		});
		mockKillTmuxWindow.mockResolvedValue({
			killed: false,
			error: "permission denied",
		});

		const result = await postMergeTmuxCleanup(makeOpts(), store);

		expect(result.tmuxClosed).toBe(false);
		expect(result.errors).toContain("tmux: permission denied");
	});

	it("captures tmux lookup exception without throwing", async () => {
		mockGetTmuxTarget.mockImplementation(() => {
			throw new Error("CommDB corrupted");
		});

		const result = await postMergeTmuxCleanup(makeOpts(), store);

		expect(result.tmuxClosed).toBe(false);
		expect(result.errors).toContain("tmux: CommDB corrupted");
	});

	it("records post_merge_completed audit event on success", async () => {
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "GEO-280:@0",
			sessionName: "GEO-280",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });

		await postMergeTmuxCleanup(makeOpts(), store);

		const events = store.getEventsByExecution("exec-1");
		const pmEvent = events.find((e) => e.event_type === "post_merge_completed");
		expect(pmEvent).toBeDefined();
		expect(pmEvent!.source).toBe("bridge.post-merge");
	});

	it("records post_merge_partial audit event on partial failure", async () => {
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "GEO-280:@0",
			sessionName: "GEO-280",
		});
		mockKillTmuxWindow.mockResolvedValue({
			killed: false,
			error: "timeout",
		});

		await postMergeTmuxCleanup(makeOpts(), store);

		const events = store.getEventsByExecution("exec-1");
		const pmEvent = events.find((e) => e.event_type === "post_merge_partial");
		expect(pmEvent).toBeDefined();
	});
});
