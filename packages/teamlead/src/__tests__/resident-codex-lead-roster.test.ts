import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProjectEntry } from "../ProjectConfig.js";
import { findResidentCodexLeadTargets } from "../resident-codex-lead-roster.js";

describe("FLY-2216 resident Codex Lead roster", () => {
	it("enumerates two opted-in targets without activating an existing non-opted Lead", () => {
		const projects = [
			{
				projectName: "growth",
				projectRoot: "/growth",
				leads: [
					{
						agentId: "mufasa-lead",
						backend: "codex-app-server",
						companion: true,
						canSpawnRunners: false,
						codexResidencyPatrol: true,
					},
				],
			},
			{
				projectName: "raya",
				projectRoot: "/raya",
				leads: [
					{
						agentId: "raya",
						backend: "codex-app-server",
						codexProfile: "full-access",
						canSpawnRunners: false,
						codexResidencyPatrol: true,
					},
				],
			},
			{
				projectName: "flywheel",
				projectRoot: "/flywheel",
				leads: [
					{
						agentId: "codex-infra-bot-lead",
						backend: "codex-app-server",
						codexProfile: "full-access",
						canSpawnRunners: false,
					},
				],
			},
		] as ProjectEntry[];

		expect(findResidentCodexLeadTargets(projects)).toEqual([
			{
				projectName: "growth",
				projectRoot: "/growth",
				leadId: "mufasa-lead",
				leadKey: "growth-mufasa-lead",
			},
			{
				projectName: "raya",
				projectRoot: "/raya",
				leadId: "raya",
				leadKey: "raya-raya",
			},
		]);
	});

	it("uses generic lifecycle and patrol modules without Raya-only symbols", () => {
		const sources = [
			new URL(
				"../lead-backends/codex/resident-codex-lead-lifecycle.ts",
				import.meta.url,
			),
			new URL("../bridge/resident-codex-lead-patrol.ts", import.meta.url),
		].map((url) => readFileSync(fileURLToPath(url), "utf8"));
		expect(sources.join("\n")).not.toMatch(/RayaBrain|FLYWHEEL_RAYA_BRAIN/);
	});
});
