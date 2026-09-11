import { expect, it } from "vitest";
import { createBetaManagementProvider } from "../bridge/beta-release-management.js";
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
				status: "legacy",
				reason: null,
				observedAtMs: 1000,
			},
			{
				projectName: "b",
				owner: "unknown",
				intervalHours: null,
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
	});
	expect(snapshot.projects[1]?.betaSchedule?.label).toContain("尚未激活");
	expect(JSON.stringify(snapshot)).not.toContain("tokenEnv");
	now = 122000;
	expect(
		provider.read().fragment.projectBetaSchedules?.[0]?.betaSchedule.owner,
	).toBe("unknown");
});
