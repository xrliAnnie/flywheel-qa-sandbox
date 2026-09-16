import { expect, it } from "vitest";
import { LeadModelContextGuard } from "../lead-model-context.js";

const event = (threadId = "thread", used = 90, window = 100) => ({
	threadId,
	tokenUsage: {
		last: { totalTokens: used },
		total: { totalTokens: 999999 },
		modelContextWindow: window,
	},
});
it("uses the current request context and window, not cumulative session consumption", () => {
	const guard = new LeadModelContextGuard();
	guard.observe(event());
	expect(() => guard.assertCompatible("thread", 100)).not.toThrow();
	expect(() => guard.assertCompatible("thread", 99)).toThrow(
		"context_window_incompatible",
	);
	guard.observe(event("thread", 110));
	expect(() => guard.assertCompatible("thread", 100)).toThrow(
		"context_window_incompatible",
	);
});
it("fails closed on missing, wrong-thread, invalidated or unknown capacity evidence", () => {
	const guard = new LeadModelContextGuard();
	guard.observe(event("other"));
	expect(() => guard.assertCompatible("thread", 100)).toThrow(
		"context_window_incompatible",
	);
	guard.observe(event());
	expect(() => guard.assertCompatible("thread", undefined)).toThrow(
		"context_window_incompatible",
	);
	guard.observe({ threadId: "thread", tokenUsage: {} });
	expect(() => guard.assertCompatible("thread", 100)).toThrow(
		"context_window_incompatible",
	);
});
it("includes the pinned configured context window without changing it", () => {
	const guard = new LeadModelContextGuard();
	guard.observe(event());
	expect(() => guard.assertCompatible("thread", 100, 200)).toThrow(
		"context_window_incompatible",
	);
	expect(() => guard.assertCompatible("thread", 200, 200)).not.toThrow();
});
