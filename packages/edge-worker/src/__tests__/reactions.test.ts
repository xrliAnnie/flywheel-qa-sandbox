import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApproveHandler } from "../reactions/ApproveHandler.js";
import { DeferHandler } from "../reactions/DeferHandler.js";
import { RejectHandler } from "../reactions/RejectHandler.js";
import type { SlackAction } from "../SlackInteractionServer.js";

// Mock global fetch for response_url calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

function makeAction(overrides?: Partial<SlackAction>): SlackAction {
	return {
		actionId: "flywheel_approve_issue-123",
		issueId: "issue-123",
		action: "approve",
		userId: "U12345",
		responseUrl: "https://hooks.slack.com/actions/respond",
		messageTs: "1704110400.000100",
		...overrides,
	};
}

describe("ApproveHandler", () => {
	let mockExec: ReturnType<typeof vi.fn>;
	let handler: ApproveHandler;

	beforeEach(() => {
		vi.clearAllMocks();
		mockFetch.mockResolvedValue({ ok: true });
		mockExec = vi.fn();
		handler = new ApproveHandler(mockExec, "/project", "xrliAnnie/GeoForge3D");
	});

	it("finds PR for branch and merges", async () => {
		// gh pr list returns PR
		mockExec
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					{
						number: 42,
						url: "https://github.com/xrliAnnie/GeoForge3D/pull/42",
					},
				]),
			})
			// gh pr merge
			.mockResolvedValueOnce({ stdout: "Merged" });

		const result = await handler.execute(makeAction());

		expect(result.success).toBe(true);
		expect(result.message).toContain("42");
		// Verify gh pr list was called with correct branch pattern
		expect(mockExec.mock.calls[0][1]).toContain("--head");
	});

	it("merges PR with squash", async () => {
		mockExec
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					{ number: 42, url: "https://github.com/test/repo/pull/42" },
				]),
			})
			.mockResolvedValueOnce({ stdout: "Merged" });

		await handler.execute(makeAction());

		// Second call should be merge with --squash
		const mergeArgs = mockExec.mock.calls[1][1];
		expect(mergeArgs).toContain("--squash");
	});

	it("fails if no PR found", async () => {
		mockExec.mockResolvedValueOnce({ stdout: "[]" });

		const result = await handler.execute(makeAction());

		expect(result.success).toBe(false);
		expect(result.message).toContain("No PR found");
	});

	it("posts confirmation to response_url", async () => {
		mockExec
			.mockResolvedValueOnce({
				stdout: JSON.stringify([
					{ number: 42, url: "https://github.com/test/repo/pull/42" },
				]),
			})
			.mockResolvedValueOnce({ stdout: "Merged" });

		await handler.execute(makeAction());

		expect(mockFetch).toHaveBeenCalledWith(
			"https://hooks.slack.com/actions/respond",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
			}),
		);
	});
});

describe("RejectHandler", () => {
	let handler: RejectHandler;

	beforeEach(() => {
		vi.clearAllMocks();
		mockFetch.mockResolvedValue({ ok: true });
		handler = new RejectHandler();
	});

	it("returns success", async () => {
		const result = await handler.execute(makeAction({ action: "reject" }));
		expect(result.success).toBe(true);
	});

	it("posts response_url confirmation", async () => {
		await handler.execute(makeAction({ action: "reject" }));

		expect(mockFetch).toHaveBeenCalledWith(
			"https://hooks.slack.com/actions/respond",
			expect.objectContaining({ method: "POST" }),
		);
		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.text).toContain("reject");
	});
});

describe("DeferHandler", () => {
	let handler: DeferHandler;

	beforeEach(() => {
		vi.clearAllMocks();
		mockFetch.mockResolvedValue({ ok: true });
		handler = new DeferHandler();
	});

	it("returns success", async () => {
		const result = await handler.execute(makeAction({ action: "defer" }));
		expect(result.success).toBe(true);
	});

	it("posts response_url confirmation", async () => {
		await handler.execute(makeAction({ action: "defer" }));

		expect(mockFetch).toHaveBeenCalledWith(
			"https://hooks.slack.com/actions/respond",
			expect.objectContaining({ method: "POST" }),
		);
		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.text).toContain("defer");
	});
});
