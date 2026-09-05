import { describe, expect, it, vi } from "vitest";
import {
	defaultMattSkillsReadiness,
	defaultPonytailReadiness,
} from "../Blueprint.js";

describe("FLY-2331 Blueprint plugin readiness", () => {
	it.each([
		["ponytail", defaultPonytailReadiness, "ponytail@ponytail"],
		["matt", defaultMattSkillsReadiness, "matt-skills@matt-skills"],
	] as const)(
		"runs the %s probe asynchronously with a 20 second deadline",
		async (_name, probe, plugin) => {
			const execFile = vi
				.fn()
				.mockResolvedValue({ stdout: "installed\n", stderr: "" });

			await expect(probe("claude-tmux", execFile)).resolves.toBe(true);
			expect(execFile).toHaveBeenCalledWith(
				"claude",
				["plugin", "details", plugin],
				{ timeoutMs: 20_000 },
			);
		},
	);
});
