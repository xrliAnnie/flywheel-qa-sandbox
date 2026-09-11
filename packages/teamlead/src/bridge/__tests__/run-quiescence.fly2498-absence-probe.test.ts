import { describe, expect, it, vi } from "vitest";
import { probeExecutionAbsenceBeyondTarget } from "../run-quiescence.js";

describe("FLY-2498 execution absence independent of registered window name", () => {
	const codex = { adapter_type: "codex-tmux" };
	function deps() {
		return {
			probeCodexDaemon: vi.fn(async () => "absent" as const),
			discover: vi.fn(async () => ({ kind: "missing" as const })),
			hasHostProcess: vi.fn(async () => false),
		};
	}
	it.each(["alive", "unknown"] as const)(
		"daemon %s never permits absence",
		async (state) => {
			const d = deps();
			const probeCodexDaemon = vi.fn(async () => state);
			expect(
				await probeExecutionAbsenceBeyondTarget(codex, "exec", "flywheel", {
					...d,
					probeCodexDaemon,
				}),
			).toBe(state);
			expect(d.discover).not.toHaveBeenCalled();
			expect(d.hasHostProcess).not.toHaveBeenCalled();
		},
	);
	it("requires daemon absence, no marker window, and no host process", async () => {
		const d = deps();
		expect(
			await probeExecutionAbsenceBeyondTarget(codex, "exec", "flywheel", d),
		).toBe("dead");
		expect(d.probeCodexDaemon).toHaveBeenCalledWith("exec");
		expect(d.discover).toHaveBeenCalledWith("exec");
		expect(d.hasHostProcess).toHaveBeenCalledWith("exec");
	});
	it.each([undefined, { adapter_type: "claude-tmux" }])(
		"does not probe a Codex daemon for %j",
		async (session) => {
			const d = deps();
			expect(
				await probeExecutionAbsenceBeyondTarget(session, "exec", "flywheel", d),
			).toBe("dead");
			expect(d.probeCodexDaemon).not.toHaveBeenCalled();
		},
	);
	it.each(["found", "ambiguous", "indeterminate"] as const)(
		"a %s marker result cannot prove absence even with a dead pane",
		async (kind) => {
			const d = deps();
			const discover = vi.fn(async () =>
				kind === "found"
					? { kind, tmuxWindow: "renamed:@1" }
					: kind === "ambiguous"
						? { kind, tmuxWindows: ["a", "b"] }
						: { kind, error: "lookup failed" },
			);
			expect(
				await probeExecutionAbsenceBeyondTarget(codex, "exec", "flywheel", {
					...d,
					discover,
				}),
			).toBe("unknown");
			expect(d.hasHostProcess).not.toHaveBeenCalled();
		},
	);
	it("host process presence vetoes absence", async () => {
		expect(
			await probeExecutionAbsenceBeyondTarget(codex, "exec", "flywheel", {
				...deps(),
				hasHostProcess: async () => true,
			}),
		).toBe("unknown");
	});
	it.each(["probeCodexDaemon", "discover", "hasHostProcess"] as const)(
		"%s errors fail closed",
		async (name) => {
			expect(
				await probeExecutionAbsenceBeyondTarget(codex, "exec", "flywheel", {
					...deps(),
					[name]: async () => {
						throw new Error("unavailable");
					},
				}),
			).toBe("unknown");
		},
	);
});
