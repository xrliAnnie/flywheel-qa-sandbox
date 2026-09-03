import { describe, expect, it } from "vitest";
import type { ArchiveChatThreadResult } from "../bridge/chat-thread-utils.js";
import { isArchiveObligationSettled } from "../bridge/post-ship-finalization.js";
import {
	isRetryableOutcome,
	mapArchiveSinkResult,
} from "../bridge/terminal-thread-archive.js";

const result = (
	reason: ArchiveChatThreadResult["reason"],
	extra: Partial<ArchiveChatThreadResult> = {},
): ArchiveChatThreadResult => ({
	archived: false,
	attempts: 0,
	reason,
	...extra,
});

describe("FLY-1709 archive outcome consumers", () => {
	it.each(["already_archived", "in_active_use"] as const)(
		"treats %s as a settled finalization obligation",
		(reason) => {
			expect(isArchiveObligationSettled(result(reason))).toBe(true);
		},
	);

	it("keeps reopen_check_failed retryable during finalization", () => {
		expect(isArchiveObligationSettled(result("reopen_check_failed"))).toBe(
			false,
		);
	});

	it("keeps founder reopen retryable for terminal authority", () => {
		const outcome = mapArchiveSinkResult(
			result("founder_reopened"),
			"thread-1",
		);
		expect(outcome).toEqual({
			kind: "transient_error",
			error: "archive sink: founder_reopened",
		});
		expect(isRetryableOutcome(outcome)).toBe(true);
	});

	it("maps quiet-window deferral to a retryable terminal outcome", () => {
		const outcome = mapArchiveSinkResult(
			result("deferred_quiet_window"),
			"thread-1",
		);
		expect(outcome).toEqual({ kind: "deferred_quiet_window" });
		expect(isRetryableOutcome(outcome)).toBe(true);
	});

	it("preserves an already_archived outcome when Discord verification is true", () => {
		expect(
			mapArchiveSinkResult(
				result("already_archived", { archived: true }),
				"thread-1",
			),
		).toEqual({ kind: "already_archived" });
	});

	it("uses the sink's real active execution identity", () => {
		expect(
			mapArchiveSinkResult(
				result("in_active_use", { activeExecutionId: "exec-live" }),
				"thread-1",
			),
		).toEqual({ kind: "vetoed_active", executionId: "exec-live" });
	});

	it("fails closed when an active-use result omits its execution identity", () => {
		const outcome = mapArchiveSinkResult(result("in_active_use"), "thread-1");
		expect(outcome).toEqual({
			kind: "transient_error",
			error: "archive sink: in_active_use missing activeExecutionId",
		});
		expect(isRetryableOutcome(outcome)).toBe(true);
	});
});
