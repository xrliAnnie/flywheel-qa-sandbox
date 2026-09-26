import { describe, expect, it } from "vitest";
import { normalizeTerminalFailureInfo } from "../terminal-failure-info.js";

describe("normalizeTerminalFailureInfo", () => {
	it("preserves the codex recovery exhaustion discriminator", () => {
		expect(
			normalizeTerminalFailureInfo({
				failureKind: "reown_exhausted",
				failureReason: "Codex recovery exhausted after 2 attempts",
			}),
		).toEqual({
			failureKind: "reown_exhausted",
			failureReason: "Codex recovery exhausted after 2 attempts",
		});
	});

	it("FLY-2778 accepts only the internal Codex auth pre-spawn failure code", () => {
		const failure = {
			failureKind: "codex_auth_pre_spawn_failed",
			failureCode: "auth_preflight_failed",
			failureReason: "source auth unavailable",
		};
		expect(normalizeTerminalFailureInfo(failure)).toEqual(failure);
		expect(
			normalizeTerminalFailureInfo({
				...failure,
				failureCode: "codex:unauthorized",
			}),
		).toBeUndefined();
		expect(
			normalizeTerminalFailureInfo({
				...failure,
				failureClass: "environment",
			}),
		).toBeUndefined();
	});
});

const quotaSignal = {
	version: 1,
	vendor: "codex",
	source: "goal_ended",
	sourceEventId: "event-1",
	bindingId: "binding-1",
	evidence: "usageLimited",
	observedAt: "2026-09-09T17:16:00.000Z",
};
it("FLY-2465 quota signal survives terminal normalization without field loss", () => {
	const failure = {
		failureKind: "goal_usage_limited",
		failureReason: "goal ended non-complete: usageLimited",
		quotaSignal,
	};
	expect(normalizeTerminalFailureInfo(failure)).toEqual(failure);
	expect(
		normalizeTerminalFailureInfo({
			...failure,
			quotaSignal: { ...quotaSignal, evidence: "429" },
		}),
	).toBeUndefined();
});
