import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GoalStore } from "./goal-store.js";
import { PortfolioSampler, probeGitHubAuth } from "./sampler.js";

describe("portfolio transport ownership", () => {
	it("contains no default process or network driver in the business modules", () => {
		for (const name of ["sampler.ts", "goal-store.ts"]) {
			const source = readFileSync(new URL(name, import.meta.url), "utf8");
			expect(source).not.toContain('from "node:child_process"');
			expect(source).not.toMatch(/\?\?\s*fetch\s*;/);
		}
	});
	it("requires a host-supplied command adapter rather than starting private processes", async () => {
		expect(
			() =>
				new PortfolioSampler({
					gitBin: "/usr/bin/git",
					ghBin: "/usr/bin/gh",
					linearApiKey: null,
					codexCwd: "/tmp",
					commandTimeoutMs: 1000,
				}),
		).toThrow(/host.*adapter/);
		expect(
			() =>
				new GoalStore({
					goalsFile: "/tmp/goals.md",
					gitBin: "/usr/bin/git",
					commandTimeoutMs: 1000,
				}),
		).toThrow(/host.*adapter/);
		expect(await probeGitHubAuth("/not/a/binary", 100)).toBe(
			"unavailable:host_command_adapter_required",
		);
	});
});
