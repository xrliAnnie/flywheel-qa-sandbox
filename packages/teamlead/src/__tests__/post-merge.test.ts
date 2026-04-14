import { beforeEach, describe, expect, it, vi } from "vitest";
import { postMergeCleanup } from "../bridge/post-merge.js";
import { StateStore } from "../StateStore.js";

// ── Mock tmux-lookup ────────────────────────────────────

const mockGetTmuxTarget = vi.fn();
const mockKillTmuxWindow = vi.fn();

vi.mock("../bridge/tmux-lookup.js", () => ({
	getTmuxTargetFromCommDb: (...args: unknown[]) => mockGetTmuxTarget(...args),
	killTmuxWindow: (...args: unknown[]) => mockKillTmuxWindow(...args),
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

describe("postMergeCleanup", () => {
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
	});

	it("closes tmux when CommDB has target", async () => {
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "GEO-280:@0",
			sessionName: "GEO-280",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });

		const result = await postMergeCleanup(makeOpts(), store);

		expect(result.tmuxClosed).toBe(true);
		expect(result.errors).toEqual([]);
		expect(mockKillTmuxWindow).toHaveBeenCalledWith("GEO-280:@0");
	});

	it("skips tmux when no CommDB target", async () => {
		mockGetTmuxTarget.mockReturnValue(undefined);

		const result = await postMergeCleanup(makeOpts(), store);

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

		const result = await postMergeCleanup(makeOpts(), store);

		expect(result.tmuxClosed).toBe(false);
		expect(result.errors).toContain("tmux: permission denied");
	});

	it("captures tmux lookup exception without throwing", async () => {
		mockGetTmuxTarget.mockImplementation(() => {
			throw new Error("CommDB corrupted");
		});

		const result = await postMergeCleanup(makeOpts(), store);

		expect(result.tmuxClosed).toBe(false);
		expect(result.errors).toContain("tmux: CommDB corrupted");
	});

	it("records post_merge_completed audit event on success", async () => {
		mockGetTmuxTarget.mockReturnValue({
			tmuxWindow: "GEO-280:@0",
			sessionName: "GEO-280",
		});
		mockKillTmuxWindow.mockResolvedValue({ killed: true });

		await postMergeCleanup(makeOpts(), store);

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

		await postMergeCleanup(makeOpts(), store);

		const events = store.getEventsByExecution("exec-1");
		const pmEvent = events.find((e) => e.event_type === "post_merge_partial");
		expect(pmEvent).toBeDefined();
	});
});
