/**
 * FLY-869: `loadFounderUxExemptLabels` — the runs-route helper that loads a
 * project's `founder_ux_gate.exempt_labels` from its CANONICAL
 * `.flywheel/config.yaml` (never an implementation PR's worktree) and
 * resolves it through `resolveEffectiveFounderUxConfig`. Absent project /
 * missing config file / missing `founder_ux_gate` block / malformed config
 * must all collapse to the resolver's default exempt list
 * (`["brainstorm-exempt"]`), never throw and never silently exempt
 * everything.
 */

import { describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { loadFounderUxExemptLabels } from "../runs-route.js";

const MINIMAL_CONFIG = `
project: test-project
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

function makeProject(): ProjectEntry {
	return {
		projectName: "test-project",
		projectRoot: "/fake/root",
		leads: [],
	} as unknown as ProjectEntry;
}

describe("FLY-869 loadFounderUxExemptLabels", () => {
	it("undefined project → resolver default exempt labels", async () => {
		const result = await loadFounderUxExemptLabels(undefined);
		expect(result).toEqual(["brainstorm-exempt"]);
	});

	it("ENOENT (no config file) → resolver default exempt labels", async () => {
		const readFile = () => {
			const err = new Error("no such file") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		};
		const result = await loadFounderUxExemptLabels(makeProject(), readFile);
		expect(result).toEqual(["brainstorm-exempt"]);
	});

	it("config present, founder_ux_gate absent → resolver default exempt labels", async () => {
		const readFile = () => MINIMAL_CONFIG;
		const result = await loadFounderUxExemptLabels(makeProject(), readFile);
		expect(result).toEqual(["brainstorm-exempt"]);
	});

	it("config present, explicit exempt_labels → those exact labels", async () => {
		const readFile = () => `${MINIMAL_CONFIG}
founder_ux_gate:
  mode: enforce
  exempt_labels:
    - chore
    - no-brainstorm
`;
		const result = await loadFounderUxExemptLabels(makeProject(), readFile);
		expect(result).toEqual(["chore", "no-brainstorm"]);
	});

	it("malformed config (non-ENOENT load error) → resolver default exempt labels, does not throw", async () => {
		const readFile = () => `not: [valid, yaml, :::`;
		const result = await loadFounderUxExemptLabels(makeProject(), readFile);
		expect(result).toEqual(["brainstorm-exempt"]);
	});
});
