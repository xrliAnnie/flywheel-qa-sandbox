import { describe, expect, it, vi } from "vitest";
import {
	buildCronTargetId,
	buildTargetId,
	type ManagementFlagView,
	type ManagementProjectView,
} from "../bridge/management-console-contract.js";
import {
	composeManagementSnapshot,
	type ManagementSnapshotProvider,
} from "../bridge/management-console-snapshot.js";

function topologyProject(): ManagementProjectView {
	return {
		id: "project/example",
		name: "example",
		presentationGroup: "example",
		sourceRevision: "file:config",
		leads: [],
		roles: [],
		dags: [],
		crons: [],
	};
}

function cron(label: string) {
	return {
		id: buildTargetId("cron", [label]),
		label,
		projectName: label === "managed" ? "example" : null,
		sourceHint: `${label}.plist`,
		schedule: {
			targetId: buildCronTargetId(`/tmp/${label}.plist`, label, "schedule"),
			current: null,
			source: { kind: "launchd_plist" as const, revision: "file:test" },
			writeCapability: {
				writable: false,
				consequence: "governance-readonly" as const,
				requiresAcknowledgement: true,
			},
		},
		enabled: {
			targetId: buildCronTargetId(`/tmp/${label}.plist`, label, "enabled"),
			current: true,
			source: { kind: "launchctl" as const, revision: "launchctl:test" },
			writeCapability: {
				writable: false,
				consequence: "governance-readonly" as const,
				requiresAcknowledgement: true,
			},
		},
		loaded: null,
		warnings: [],
	};
}

function flag(): ManagementFlagView {
	return {
		id: "flag/example",
		name: "FLYWHEEL_EXAMPLE",
		description: "说明",
		polarity: "default_on",
		default: true,
		valueKind: "bool",
		onMeans: "enables",
		global: {
			targetId: buildTargetId("flag", ["FLYWHEEL_EXAMPLE", "global"]),
			current: true,
			source: { kind: "flag_registry", revision: "registry:1" },
			writeCapability: {
				writable: true,
				consequence: "hot",
				requiresAcknowledgement: false,
			},
		},
		projectOverrides: [],
	};
}

function provider(
	id: string,
	kind: ManagementSnapshotProvider["sourceKind"],
	revision: string,
	fragment: ReturnType<ManagementSnapshotProvider["read"]>["fragment"],
): ManagementSnapshotProvider {
	return {
		id,
		sourceKind: kind,
		read: vi.fn(() => ({ revision, fragment })),
	};
}

describe("management snapshot composer", () => {
	it("invokes each provider once and returns one versioned aggregate", () => {
		const topology = provider("topology", "projects_json", "file:p", {
			projects: [topologyProject()],
			presentationGroups: [
				{
					id: "example",
					label: "example",
					projectIds: ["project/example"],
					leadIds: [],
					derived: false,
				},
			],
		});
		const flags = provider("flags", "flag_registry", "registry:1", {
			flags: [flag()],
		});
		const models = provider("models", "model_registry", "registry:1", {
			modelCatalog: {},
		});
		const snapshot = composeManagementSnapshot({
			providers: [flags, models, topology],
			now: () => new Date("2026-07-14T00:00:00.000Z"),
		});
		expect(topology.read).toHaveBeenCalledTimes(1);
		expect(flags.read).toHaveBeenCalledTimes(1);
		expect(models.read).toHaveBeenCalledTimes(1);
		expect(snapshot).toMatchObject({
			schemaVersion: 2,
			projects: [{ name: "example" }],
			flags: [{ name: "FLYWHEEL_EXAMPLE" }],
		});
	});

	it("records a provider error as source data and preserves healthy sections", () => {
		const broken: ManagementSnapshotProvider = {
			id: "cron",
			sourceKind: "launchd_plist",
			read: () => {
				throw new Error("plist parse failed");
			},
		};
		const healthy = provider("topology", "projects_json", "file:p", {
			projects: [topologyProject()],
		});
		const snapshot = composeManagementSnapshot({
			providers: [broken, healthy],
			now: () => new Date(0),
		});
		expect(snapshot.projects).toHaveLength(1);
		expect(snapshot.sources).toContainEqual(
			expect.objectContaining({
				kind: "launchd_plist",
				ok: false,
				error: "plist parse failed",
			}),
		);
	});

	it("keeps revision deterministic for unchanged inputs and changes on source drift", () => {
		let tick = 0;
		const make = (revision: string) =>
			composeManagementSnapshot({
				providers: [
					provider("topology", "projects_json", revision, {
						projects: [topologyProject()],
					}),
				],
				now: () => new Date(++tick),
			});
		const first = make("file:a");
		const same = make("file:a");
		const changed = make("file:b");
		expect(first.snapshotRevision).toBe(same.snapshotRevision);
		expect(first.generatedAt).not.toBe(same.generatedAt);
		expect(first.snapshotRevision).not.toBe(changed.snapshotRevision);
	});

	it("joins provider-owned DAG sections into the authoritative project", () => {
		const topology = provider("topology", "projects_json", "file:p", {
			projects: [topologyProject()],
		});
		const workflows = provider("workflows", "workflow_catalog", "db:1:digest", {
			projectDags: [
				{
					projectName: "example",
					dags: [
						{
							id: "example/default",
							title: "Engineering heavy",
							templateId: "tpl_eng_heavy",
							revision: 1,
							digest: "digest",
							nodes: [],
						},
					],
				},
			],
		});
		const snapshot = composeManagementSnapshot({
			providers: [topology, workflows],
		});
		expect(snapshot.projects[0]!.dags).toEqual([
			expect.objectContaining({ templateId: "tpl_eng_heavy" }),
		]);
	});

	it("joins managed crons and preserves unmatched scheduled jobs", () => {
		const topology = provider("topology", "projects_json", "file:p", {
			projects: [topologyProject()],
		});
		const launchd = provider("launchd", "launchd_plist", "launchd:test", {
			projectCrons: [{ projectName: "example", crons: [cron("managed")] }],
			unassignedCrons: [cron("unassigned")],
		});
		const snapshot = composeManagementSnapshot({
			providers: [topology, launchd],
		});
		expect(snapshot.projects[0]!.crons.map((item) => item.label)).toEqual([
			"managed",
		]);
		expect(snapshot.unassignedCrons.map((item) => item.label)).toEqual([
			"unassigned",
		]);
	});
});
