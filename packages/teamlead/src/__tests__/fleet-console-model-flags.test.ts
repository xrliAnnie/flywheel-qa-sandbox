import { resolveAllFlags } from "flywheel-config";
import { describe, expect, it } from "vitest";
import { buildConsoleSnapshot } from "../bridge/fleet-console-model.js";
import type { ProjectEntry } from "../ProjectConfig.js";

// FLY-709: the console snapshot carries the read-only feature-flag views and the
// (optional) FLY-728 per-issue-model seam.

const PROJECTS: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		leads: [{ agentId: "flywheel-eng-lead" }],
	} as unknown as ProjectEntry,
];

describe("buildConsoleSnapshot — feature flags", () => {
	it("attaches resolved feature flags when provided", () => {
		const flags = resolveAllFlags({ env: {} });
		const snap = buildConsoleSnapshot(PROJECTS, undefined, {
			featureFlags: flags,
		});
		expect(snap.featureFlags?.length).toBe(flags.length);
		// governance gates come through read-only.
		const gate = snap.featureFlags?.find(
			(f) => f.name === "founder_consent_decision_mode",
		);
		expect(gate?.toggleable).toBe("readonly");
	});

	it("omits featureFlags entirely when not provided (byte-compat)", () => {
		const snap = buildConsoleSnapshot(PROJECTS);
		expect(snap.featureFlags).toBeUndefined();
		expect(snap.leads.length).toBe(1);
	});

	it("FLY-728 seam: omitted when the provider yields no rows", () => {
		const snap = buildConsoleSnapshot(PROJECTS, undefined, {
			perIssueModels: [],
		});
		expect(snap.perIssueModels).toBeUndefined();
	});

	it("FLY-728 seam: present only when rows exist", () => {
		const snap = buildConsoleSnapshot(PROJECTS, undefined, {
			perIssueModels: [
				{ issueId: "x", identifier: "FLY-1", model: "fable", source: "label" },
			],
		});
		expect(snap.perIssueModels?.length).toBe(1);
	});
});
