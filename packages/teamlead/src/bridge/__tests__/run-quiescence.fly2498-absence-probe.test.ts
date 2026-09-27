import { describe, expect, it, vi } from "vitest";
import { probeExecutionAbsenceBeyondTarget } from "../run-quiescence.js";

describe("FLY-2498 execution absence independent of registered window name", () => {
	it.each(["alive", "dead", "unknown"] as const)(
		"uses common body %s for every presentation state",
		async (body) => {
			for (const kind of ["found", "missing", "ambiguous", "indeterminate"]) {
				const discover = vi.fn(async () => ({
					kind,
					tmuxWindow: "renamed:@42",
				}));
				const host = vi.fn(async () => false);
				expect(
					await probeExecutionAbsenceBeyondTarget(
						{ adapter_type: "codex-tmux" },
						"exec",
						"flywheel",
						{
							readBodyLiveness: () => body,
							discover,
							hasHostProcess: host,
						} as never,
					),
				).toBe(body);
				expect(discover).not.toHaveBeenCalled();
				expect(host).not.toHaveBeenCalled();
			}
		},
	);
	it("refuses missing or failed common evidence", async () => {
		expect(
			await probeExecutionAbsenceBeyondTarget(undefined, "exec", "flywheel"),
		).toBe("unknown");
		expect(
			await probeExecutionAbsenceBeyondTarget(undefined, "exec", "flywheel", {
				readBodyLiveness: () => {
					throw new Error("unavailable");
				},
			}),
		).toBe("unknown");
	});
});
