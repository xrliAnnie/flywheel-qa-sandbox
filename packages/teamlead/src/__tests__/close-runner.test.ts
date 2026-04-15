import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_ELIGIBLE_STATES, closeRunner } from "../bridge/close-runner.js";
import { StateStore } from "../StateStore.js";

// ── Mock tmux-lookup ────────────────────────────────────────

const mockGetTmuxTarget = vi.fn();
const mockKillTmuxWindow = vi.fn();

vi.mock("../bridge/tmux-lookup.js", () => ({
	getTmuxTargetFromCommDb: (...args: unknown[]) => mockGetTmuxTarget(...args),
	killTmuxWindow: (...args: unknown[]) => mockKillTmuxWindow(...args),
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
		seedSession(store, "failed");
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
		seedSession(store, "blocked");
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
