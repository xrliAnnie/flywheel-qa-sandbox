import { describe, expect, it, vi } from "vitest";
import type { ReconnectController } from "../../HeartbeatService.js";
import type { Session } from "../../StateStore.js";
import type { IssueDisplayRefreshHandle } from "../issue-display-refresher.js";
import { settleReconnectTitlesAndRefresh } from "../reconnect-title-restore.js";

function session(exec: string, issue: string): Session {
	return {
		execution_id: exec,
		issue_id: issue,
		project_name: "flywheel",
		status: "running",
	} as Session;
}

describe("settleReconnectTitlesAndRefresh", () => {
	it("settles exact reconnect execs and enqueues each affected issue once", () => {
		const settleReconnectTitles = vi
			.fn()
			.mockReturnValue([
				session("e-design", "issue-1"),
				session("e-impl", "issue-1"),
				session("e-other", "issue-2"),
			]);
		const reconnect = {
			settleReconnectTitles,
		} as unknown as ReconnectController;
		const enqueue = vi.fn();
		const refresher = { enqueue } as unknown as IssueDisplayRefreshHandle;

		expect(
			settleReconnectTitlesAndRefresh(reconnect, refresher, [
				"e-design",
				"e-impl",
				"e-other",
			]),
		).toEqual(["issue-1", "issue-2"]);
		expect(settleReconnectTitles).toHaveBeenCalledWith([
			"e-design",
			"e-impl",
			"e-other",
		]);
		expect(enqueue.mock.calls).toEqual([["issue-1"], ["issue-2"]]);
	});

	it("still enqueues canonical refresh after an early accepted event cleared the title state", () => {
		const reconnect = {
			settleReconnectTitles: vi
				.fn()
				.mockReturnValue([session("e-cleared", "issue-early")]),
		} as unknown as ReconnectController;
		const enqueue = vi.fn();
		const refresher = { enqueue } as unknown as IssueDisplayRefreshHandle;
		expect(
			settleReconnectTitlesAndRefresh(reconnect, refresher, ["e-cleared"]),
		).toEqual(["issue-early"]);
		expect(enqueue).toHaveBeenCalledWith("issue-early");
	});

	it("settles every active pre-bind title episode when execution ids are omitted", () => {
		const settleReconnectTitles = vi
			.fn()
			.mockReturnValue([session("e-prebind", "issue-prebind")]);
		const reconnect = {
			settleReconnectTitles,
		} as unknown as ReconnectController;
		const enqueue = vi.fn();
		const refresher = { enqueue } as unknown as IssueDisplayRefreshHandle;

		expect(settleReconnectTitlesAndRefresh(reconnect, refresher)).toEqual([
			"issue-prebind",
		]);
		expect(settleReconnectTitles).toHaveBeenCalledWith();
		expect(enqueue).toHaveBeenCalledWith("issue-prebind");
	});
});
