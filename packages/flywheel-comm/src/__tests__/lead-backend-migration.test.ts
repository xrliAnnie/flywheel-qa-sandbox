import { expect, it } from "vitest";
import {
	applyMigrationFields,
	planBackendMigration,
	rollbackMigrationFields,
} from "../lead-backend-migration.js";

const registry = () => [
	{
		projectName: "flywheel",
		projectRoot: "/project",
		leads: [
			{
				agentId: "flywheel-product-lead",
				backend: "claude-code",
				model: "opus[1m]",
				effort: "high",
				canSpawnRunners: true,
				botTokenEnv: "PRODUCT_TOKEN",
				chatChannel: "123",
				summaryRole: "producer",
				match: { labels: ["Product"] },
				privateValue: "never-in-receipt",
			},
			{ agentId: "other", model: "old" },
		],
	},
];
const input = () => ({
	registry: registry(),
	projectName: "flywheel",
	leadId: "flywheel-product-lead",
	toBackend: "codex-app-server",
	model: "gpt-6-astra",
	effort: "high",
	runnerActions: true,
	deploymentSha: "a".repeat(40),
	manifestSha: "b".repeat(64),
	plistSha: "c".repeat(64),
	createdAt: "2026-09-11T00:00:00.000Z",
});
it("plans only six target fields, without mutating or leaking raw registry", () => {
	const args = input(),
		before = structuredClone(args.registry);
	const plan = planBackendMigration(args);
	expect(args.registry).toEqual(before);
	expect(plan.target).toEqual({
		backend: "codex-app-server",
		codexProfile: "full-access",
		model: "gpt-6-astra",
		effort: "high",
		canSpawnRunners: true,
		codexRunnerActions: true,
	});
	expect(JSON.stringify(plan)).not.toContain("never-in-receipt");
	expect(plan.phase).toBe("prepared");
	const candidate = applyMigrationFields(args.registry, plan);
	expect(candidate[0].leads[0]).toEqual({
		...before[0].leads[0],
		...plan.target,
	});
});
it("CAS preserves concurrent unrelated Lead changes and recognizes own postimage", () => {
	const args = input(),
		plan = planBackendMigration(args);
	args.registry[0].leads[1].model = "new";
	const candidate = applyMigrationFields(args.registry, plan);
	expect(candidate[0].leads[1].model).toBe("new");
	expect(applyMigrationFields(candidate, plan)).toEqual(candidate);
});
it.each(["model", "chatChannel", "privateValue"])(
	"rejects target row drift in %s",
	(field) => {
		const args = input(),
			plan = planBackendMigration(args);
		(args.registry[0].leads[0] as Record<string, unknown>)[field] = "changed";
		expect(() => applyMigrationFields(args.registry, plan)).toThrow("stale");
	},
);
it("rejects project-root drift", () => {
	const args = input(),
		plan = planBackendMigration(args);
	args.registry[0].projectRoot = "/other";
	expect(() => applyMigrationFields(args.registry, plan)).toThrow("stale");
});
it.each([
	{ projectName: "other" },
	{ leadId: "other" },
	{ toBackend: "claude-code" },
	{ model: "astra" },
	{ effort: "xhigh" },
	{ runnerActions: false },
	{ codexProfile: "write-capable" },
	{ codexProfile: "companion" },
	{ deploymentSha: "bad" },
	{ manifestSha: "bad" },
	{ createdAt: "bad" },
])("refuses unsupported or malformed intent input %j", (override) => {
	expect(() => planBackendMigration({ ...input(), ...override })).toThrow();
});
it.each([
	{ companion: true },
	{ external: true },
	{ canSpawnRunners: false },
	{ canSpawnRunners: undefined },
])("refuses ineligible original row %j", (override) => {
	const args = input();
	Object.assign(args.registry[0].leads[0], override);
	expect(() => planBackendMigration(args)).toThrow();
});

it("rolls back only its own target postimage while retaining unrelated changes", () => {
	const args = input(),
		plan = planBackendMigration(args);
	const applied = applyMigrationFields(args.registry, plan);
	applied[0].leads[1].model = "new";
	const restored = rollbackMigrationFields(applied, plan);
	expect(restored[0].leads[0]).toEqual(args.registry[0].leads[0]);
	expect(restored[0].leads[1].model).toBe("new");
	expect(rollbackMigrationFields(restored, plan)).toEqual(restored);
	applied[0].leads[0].model = "unrelated-owner-change";
	expect(() => rollbackMigrationFields(applied, plan)).toThrow("stale");
});
