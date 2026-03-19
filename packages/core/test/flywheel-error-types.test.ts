import { describe, expect, it } from "vitest";
import {
	DEFAULT_RETRY_POLICY,
	type FlywheelError,
	isRetryable,
	type RetryPolicy,
	retryDelay,
} from "../src/flywheel-error-types.js";

describe("FlywheelError", () => {
	describe("isRetryable", () => {
		it("returns true for runner_timeout", () => {
			const err: FlywheelError = { type: "runner_timeout", elapsed: 30000 };
			expect(isRetryable(err)).toBe(true);
		});

		it("returns true for runner_startup_failure", () => {
			const err: FlywheelError = {
				type: "runner_startup_failure",
				reason: "trust prompt stuck",
			};
			expect(isRetryable(err)).toBe(true);
		});

		it("returns true for hook_callback_timeout", () => {
			const err: FlywheelError = {
				type: "hook_callback_timeout",
				token: "abc-123",
			};
			expect(isRetryable(err)).toBe(true);
		});

		it("returns false for terminal_error", () => {
			const err: FlywheelError = {
				type: "terminal_error",
				reason: "repo not found",
			};
			expect(isRetryable(err)).toBe(false);
		});

		it("returns false for git_conflict", () => {
			const err: FlywheelError = {
				type: "git_conflict",
				worktree: "/tmp/wt",
				files: ["a.ts"],
			};
			expect(isRetryable(err)).toBe(false);
		});

		it("returns false for decision_escalation", () => {
			const err: FlywheelError = {
				type: "decision_escalation",
				reason: "security concern",
			};
			expect(isRetryable(err)).toBe(false);
		});
	});

	describe("retryDelay", () => {
		it("fixed returns constant base delay", () => {
			const policy: RetryPolicy = {
				maxRetries: 3,
				delaySeconds: 10,
				backoff: "fixed",
			};
			expect(retryDelay(policy, 1)).toBe(10_000);
			expect(retryDelay(policy, 2)).toBe(10_000);
			expect(retryDelay(policy, 3)).toBe(10_000);
		});

		it("linear scales with attempt number", () => {
			const policy: RetryPolicy = {
				maxRetries: 3,
				delaySeconds: 10,
				backoff: "linear",
				backoffRate: 1,
			};
			expect(retryDelay(policy, 1)).toBe(10_000);
			expect(retryDelay(policy, 2)).toBe(20_000);
			expect(retryDelay(policy, 3)).toBe(30_000);
		});

		it("exponential doubles by default", () => {
			const policy: RetryPolicy = {
				maxRetries: 3,
				delaySeconds: 10,
				backoff: "exponential",
			};
			expect(retryDelay(policy, 1)).toBe(10_000); // 10 * 2^0
			expect(retryDelay(policy, 2)).toBe(20_000); // 10 * 2^1
			expect(retryDelay(policy, 3)).toBe(40_000); // 10 * 2^2
		});

		it("exponential uses custom backoffRate", () => {
			const policy: RetryPolicy = {
				maxRetries: 3,
				delaySeconds: 5,
				backoff: "exponential",
				backoffRate: 3,
			};
			expect(retryDelay(policy, 1)).toBe(5_000); // 5 * 3^0
			expect(retryDelay(policy, 2)).toBe(15_000); // 5 * 3^1
			expect(retryDelay(policy, 3)).toBe(45_000); // 5 * 3^2
		});
	});

	describe("DEFAULT_RETRY_POLICY", () => {
		it("has expected conservative defaults", () => {
			expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(1);
			expect(DEFAULT_RETRY_POLICY.delaySeconds).toBe(30);
			expect(DEFAULT_RETRY_POLICY.backoff).toBe("fixed");
		});
	});
});
