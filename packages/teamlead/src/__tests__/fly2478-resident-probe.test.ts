import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Execute the actual plugin callback without starting Bridge services or touching
// the host. This checks that expiry consumes the shared body truth rather than a
// tmux target/window observation.
function observe(verdict: "alive" | "dead" | "unknown") {
	const source = readFileSync(
		new URL("../bridge/plugin.ts", import.meta.url),
		"utf8",
	);
	const body = source.match(
		/observeBody: async \(executionId\) =>\s*(observeBodyOnDemand\(executionId, projectName\)),/,
	);
	if (!body) throw new Error("resident expiry body callback missing");
	const observeBodyOnDemand = vi.fn(async () => verdict);
	const lookupTmuxTarget = vi.fn();
	const probeRunnerProcessLiveness = vi.fn();
	const callback = runInNewContext(`(async (executionId) => ${body[1]})`, {
		observeBodyOnDemand,
		lookupTmuxTarget,
		probeRunnerProcessLiveness,
		projectName: "flywheel",
	}) as (executionId: string) => Promise<"alive" | "dead" | "unknown">;
	return {
		callback,
		observeBodyOnDemand,
		lookupTmuxTarget,
		probeRunnerProcessLiveness,
	};
}

describe("FLY-2478 resident expiry probe wiring", () => {
	it.each(["alive", "dead", "unknown"] as const)(
		"forwards the shared %s body verdict without consulting windows",
		async (verdict) => {
			const wired = observe(verdict);
			await expect(wired.callback("exec-1")).resolves.toBe(verdict);
			expect(wired.observeBodyOnDemand).toHaveBeenCalledWith(
				"exec-1",
				"flywheel",
			);
			expect(wired.lookupTmuxTarget).not.toHaveBeenCalled();
			expect(wired.probeRunnerProcessLiveness).not.toHaveBeenCalled();
		},
	);
});
