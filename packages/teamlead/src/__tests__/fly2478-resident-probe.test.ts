import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Execute the actual plugin callback without starting Bridge services or touching
// the host. This checks the production wiring between lookup and the expiry saga.
function probe(lookup: unknown) {
	const source = readFileSync(
		new URL("../bridge/plugin.ts", import.meta.url),
		"utf8",
	);
	const body = source.match(
		/probeTarget: async \(executionId, shutdownRequested\) => \{([\s\S]*?)\n\s*\},/,
	);
	if (!body) throw new Error("resident expiry probe callback missing");
	const lookupTmuxTarget = vi.fn(() => lookup);
	const probeRunnerProcessLiveness = vi.fn(async () => "dead_pin");
	const callback = runInNewContext(`(async (executionId, shutdownRequested) => {${body[1]}})`, {
		lookupTmuxTarget,
		probeRunnerProcessLiveness,
		projectName: "flywheel",
	}) as (executionId: string, shutdownRequested?: boolean) => Promise<string>;
	return { callback, lookupTmuxTarget, probeRunnerProcessLiveness };
}

describe("FLY-2478 resident expiry probe wiring", () => {
	it.each([{ kind: "gone" }, { kind: "error", error: "sqlite busy" }])(
		"keeps $kind lookup indeterminate",
		async (lookup) => {
			const wired = probe(lookup);
			await expect(wired.callback("exec-1")).resolves.toBe("indeterminate");
			expect(wired.probeRunnerProcessLiveness).not.toHaveBeenCalled();
		},
	);
	it("accepts gone only with the current operation shutdown request", async () => {
		const wired = probe({kind: "gone"});
		await expect(wired.callback("exec-1", true)).resolves.toBe("absent");
		await expect(wired.callback("exec-1", false)).resolves.toBe("indeterminate");
		await expect(probe({kind:"error",error:"busy"}).callback("exec-1", true)).resolves.toBe("indeterminate");
	});
	it("probes a resolved target before accepting process death", async () => {
		const wired = probe({ kind: "found", target: { tmuxWindow: "runner:@1" } });
		await expect(wired.callback("exec-1")).resolves.toBe("dead_pin");
		expect(wired.lookupTmuxTarget).toHaveBeenCalledWith("exec-1", "flywheel");
		expect(wired.probeRunnerProcessLiveness).toHaveBeenCalledWith("runner:@1");
	});
});
