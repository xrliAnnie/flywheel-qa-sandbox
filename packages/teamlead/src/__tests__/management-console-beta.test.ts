import { expect, it } from "vitest";
import { createBetaManagementProvider } from "../bridge/beta-release-management.js";
import { assertManagementSnapshot } from "../bridge/management-console-contract.js";
import { composeManagementSnapshot } from "../bridge/management-console-snapshot.js";

const store = { lanes: () => [], active: () => null, latestResult: () => null };
it("joins cached beta projections by project, keeping missing workflow and stale ownership explicit", () => {
	let now = 1000;
	const provider = createBetaManagementProvider({
		store,
		now: () => now,
		observations: () => [
			{
				projectName: "a",
				owner: "legacy",
				intervalHours: 24,
				sourceOrigin: "local_deployed_sha",
				status: "legacy",
				reason: null,
				observedAtMs: 1000,
			},
			{
				projectName: "b",
				owner: "unknown",
				intervalHours: null,
				sourceOrigin: null,
				status: "unconfigured",
				reason: "unconfigured",
				observedAtMs: 1000,
			},
		],
	});
	const topology = {
		id: "topology",
		sourceKind: "projects_json" as const,
		read: () => ({
			revision: "r",
			fragment: {
				projects: ["a", "b"].map((name) => ({
					id: name,
					name,
					presentationGroup: name,
					sourceRevision: "r",
					leads: [],
					roles: [],
					dags: [],
					crons: [],
					handbookRegistryActive: false,
					handbookRosterAvailable: false,
					handbookRosterStatus: "not_applicable" as const,
					handbookResolvedRefs: [],
				})),
			},
		}),
	};
	const snapshot = composeManagementSnapshot({
		providers: [provider, topology],
	});
	expect(snapshot.projects[0]?.betaSchedule).toMatchObject({
		owner: "legacy",
		effectiveIntervalHours: 6,
		sourceOrigin: "local_deployed_sha",
	});
	expect(snapshot.projects[1]?.betaSchedule?.label).toContain("尚未激活");
	for (const sourceOrigin of [
		"default_branch_head",
		"local_deployed_sha",
		null,
	]) {
		const candidate = structuredClone(snapshot);
		candidate.projects[0]!.betaSchedule!.sourceOrigin = sourceOrigin as never;
		expect(() => assertManagementSnapshot(candidate)).not.toThrow();
	}
	for (const sourceOrigin of ["x", 1, undefined, "<script>"]) {
		const candidate = structuredClone(snapshot);
		candidate.projects[0]!.betaSchedule!.sourceOrigin = sourceOrigin as never;
		expect(() => assertManagementSnapshot(candidate)).toThrow(
			"invalid beta schedule source origin",
		);
	}
	expect(JSON.stringify(snapshot)).not.toContain("tokenEnv");
	now = 122000;
	expect(
		provider.read().fragment.projectBetaSchedules?.[0]?.betaSchedule.owner,
	).toBe("unknown");
});
