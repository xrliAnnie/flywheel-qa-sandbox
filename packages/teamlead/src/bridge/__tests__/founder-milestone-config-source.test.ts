import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { loadFounderMilestoneReportConfigByProject } from "../founder-milestone-config-source.js";

function project(name: string, root: string): ProjectEntry {
	return { projectName: name, projectRoot: root } as ProjectEntry;
}

const BASE_YAML = `
project: p
linear:
  team_id: "T-1"
runners:
  default: claude
  available:
    claude:
      type: claude
teams:
  - name: dev
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5.0
decision_layer:
  autonomy_level: observer
  escalation_channel: "#dev"
`;

describe("loadFounderMilestoneReportConfigByProject (FLY-725)", () => {
	it("reads the CANONICAL projectRoot config, not a worktree", async () => {
		const seen: string[] = [];
		const readFile = (p: string) => {
			seen.push(p);
			return `${BASE_YAML}
founder_milestone_report:
  enabled: true
  milestones: [failed, blocked]
`;
		};
		const map = await loadFounderMilestoneReportConfigByProject(
			[project("flywheel", "/canonical/flywheel")],
			readFile,
		);
		expect(seen).toEqual([
			join("/canonical/flywheel", ".flywheel", "config.yaml"),
		]);
		expect(map.get("flywheel")).toEqual({
			enabled: true,
			milestones: ["failed", "blocked"],
		});
	});

	it("maps to undefined when the block is absent (feature off)", async () => {
		const map = await loadFounderMilestoneReportConfigByProject(
			[project("p", "/root")],
			() => BASE_YAML,
		);
		expect(map.get("p")).toBeUndefined();
	});

	it("maps to undefined on a missing config file (ENOENT)", async () => {
		const map = await loadFounderMilestoneReportConfigByProject(
			[project("p", "/nope")],
			() => {
				const e = new Error("no file") as NodeJS.ErrnoException;
				e.code = "ENOENT";
				throw e;
			},
		);
		expect(map.get("p")).toBeUndefined();
	});

	it("maps to undefined (does not throw) on a malformed config", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const map = await loadFounderMilestoneReportConfigByProject(
			[project("p", "/root")],
			() => `${BASE_YAML}
founder_milestone_report:
  enabled: true
  milestones: [ship_ready]
`,
		);
		expect(map.get("p")).toBeUndefined();
		warn.mockRestore();
	});

	// FLY-707-style: prove flywheel's own committed config actually enables it.
	it("flywheel's committed .flywheel/config.yaml enables the feature", async () => {
		const repoRoot = join(__dirname, "..", "..", "..", "..", "..");
		const map = await loadFounderMilestoneReportConfigByProject(
			[project("flywheel", repoRoot)],
			(p) => readFileSync(p, "utf-8"),
		);
		const cfg = map.get("flywheel");
		expect(cfg?.enabled).toBe(true);
		expect(cfg?.milestones).toEqual(["failed", "blocked"]);
	});
});
