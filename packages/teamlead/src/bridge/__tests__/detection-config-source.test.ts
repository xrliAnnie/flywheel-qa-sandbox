/**
 * FLY-1048 PR-C (C3-w): per-project detection-grace loader. Reads each
 * project's CANONICAL `.flywheel/config.yaml` (the auto-qa-config-source
 * precedent — never a PR worktree) and returns the `detection.lead_grace_ms`
 * overrides. A missing file / missing block is simply "no override"; a
 * malformed config warns and falls back to the GLOBAL grace — a broken
 * tuning knob must neither disable escalation nor invent a value.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { loadDetectionGraceByProject } from "../detection-config-source.js";

const BASE = `
project: p1
linear:
  team_id: "TEAM-1"
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

function project(name: string, root: string): ProjectEntry {
	return {
		projectName: name,
		projectRoot: root,
		leads: [],
	} as unknown as ProjectEntry;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("loadDetectionGraceByProject (FLY-1048 C3-w)", () => {
	it("returns the configured lead_grace_ms per project", async () => {
		const map = await loadDetectionGraceByProject(
			[project("flywheel", "/roots/flywheel")],
			() => `${BASE}detection:\n  lead_grace_ms: 600000\n`,
		);
		expect(map.get("flywheel")).toBe(600_000);
	});

	it("no config file (ENOENT) → no override entry", async () => {
		const map = await loadDetectionGraceByProject(
			[project("flywheel", "/roots/flywheel")],
			() => {
				const err = new Error("not found") as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			},
		);
		expect(map.has("flywheel")).toBe(false);
	});

	it("config without a detection block / without lead_grace_ms → no override entry", async () => {
		const map = await loadDetectionGraceByProject(
			[project("no-block", "/roots/a"), project("empty-block", "/roots/b")],
			(p) => (p.startsWith("/roots/a") ? BASE : `${BASE}detection: {}\n`),
		);
		expect(map.size).toBe(0);
	});

	it("malformed config → warns and yields NO override (global grace wins)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const map = await loadDetectionGraceByProject(
			[project("broken", "/roots/broken")],
			() => `${BASE}detection:\n  lead_grace_ms: -5\n`,
		);
		expect(map.has("broken")).toBe(false);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("detection config"),
		);
	});

	it("reads each project's own root", async () => {
		const paths: string[] = [];
		await loadDetectionGraceByProject(
			[project("a", "/roots/a"), project("b", "/roots/b")],
			(p) => {
				paths.push(p);
				return `${BASE}detection:\n  lead_grace_ms: 60000\n`;
			},
		);
		expect(paths).toEqual([
			"/roots/a/.flywheel/config.yaml",
			"/roots/b/.flywheel/config.yaml",
		]);
	});
});
