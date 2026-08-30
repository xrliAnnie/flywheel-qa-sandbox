import { createHash } from "node:crypto";
import {
	type ApplyResult,
	FEATURE_FLAGS,
	type FlywheelConfig,
	resolveAllFlags,
	STORE_MANAGED_FLAGS,
} from "flywheel-config";
import { describe, expect, it } from "vitest";
import { buildTargetId } from "../bridge/management-console-contract.js";
import {
	createExistingManagementWriters,
	createManagementFlagProvider,
	createManagementRunnerProvider,
} from "../bridge/management-existing-writers.js";
import {
	coalesceManagementChangeRequests,
	type ManagementWriter,
	ManagementWriterRegistry,
} from "../bridge/management-writer.js";
import type { ProjectEntry } from "../ProjectConfig.js";

const PROJECTS_REVISION = "file:projects-v1";
const CONFIG = [
	"roles:",
	"  runner:",
	"    backend: claude-tmux",
	"    model: claude-fable-5",
	"    effort: high",
	"",
].join("\n");
const CONFIG_SHA = createHash("sha256").update(CONFIG).digest("hex");

function projects(): ProjectEntry[] {
	return [
		{
			projectName: "flywheel",
			projectRoot: "/server/flywheel",
			leads: [
				{
					agentId: "flywheel-eng-lead",
					backend: "claude-code",
					model: "claude-fable-5",
					effort: "high",
				},
			],
		},
	];
}

function configs(): Map<
	string,
	{ config?: FlywheelConfig; revision: string; error?: string }
> {
	return new Map([
		[
			"flywheel",
			{
				revision: `file:${CONFIG_SHA}`,
				config: {
					roles: {
						runner: {
							backend: "claude-tmux",
							model: "claude-fable-5",
							effort: "high",
						},
					},
				},
			},
		],
	]);
}

function fakeWriter(id: string, kind: "lead" | "runner"): ManagementWriter {
	return {
		id,
		kind,
		resolve: () => null,
		preflight: () => ({
			ok: false,
			code: "unknown_target",
			reason: "not used",
		}),
		apply: async () => ({ status: "rejected", reason: "not used" }),
	};
}

describe("management writer registry", () => {
	it("maps one exact target kind to one writer and fails unknown/duplicate registration", () => {
		const registry = new ManagementWriterRegistry([
			fakeWriter("lead-v1", "lead"),
		]);
		expect(
			registry.writerForTarget(buildTargetId("lead", ["p", "l", "dispatch"]))
				.id,
		).toBe("lead-v1");
		expect(() =>
			registry.writerForTarget(buildTargetId("cron", ["p", "schedule"])),
		).toThrow(/no writer registered/);
		expect(() => registry.register(fakeWriter("lead-v2", "lead"))).toThrow(
			/duplicate writer/,
		);
	});

	it("coalesces identical duplicate requests and rejects conflicting desired values", () => {
		const targetId = buildTargetId("runner", [
			"flywheel",
			"default",
			"dispatch",
		]);
		const request = {
			targetId,
			desiredValue: { provider: "anthropic", model: "claude-fable-5" },
			observedRevision: "file:1",
		};
		expect(coalesceManagementChangeRequests([request, { ...request }])).toEqual(
			[request],
		);
		expect(() =>
			coalesceManagementChangeRequests([
				request,
				{
					...request,
					desiredValue: { provider: "openai", model: "gpt-5.6-sol" },
				},
			]),
		).toThrow(/conflicting duplicate/);
	});
});

describe("existing management writer adapters", () => {
	it("Lead reuses the Fleet canonical path and refuses provider/backend forgery", async () => {
		const applied: unknown[] = [];
		const { lead } = createExistingManagementWriters({
			projects,
			projectsRevision: () => PROJECTS_REVISION,
			projectConfigs: configs,
			readProjectConfig: () => CONFIG,
			readEnvFile: () => "",
			envPath: "/server/.flywheel/.env",
			env: {},
			applyLeadCanonical: async (request) => {
				applied.push(request);
				return { status: "applied" };
			},
		});
		const targetId = buildTargetId("lead", [
			"flywheel",
			"flywheel-eng-lead",
			"dispatch",
		]);
		const target = await lead.resolve(targetId);
		expect(target?.currentValue).toEqual({
			provider: "anthropic",
			model: "claude-fable-5",
			effort: "high",
		});
		const ready = await lead.preflight(
			target!,
			{
				provider: "anthropic",
				model: "claude-opus-4-8",
				effort: "xhigh",
			},
			PROJECTS_REVISION,
		);
		expect(ready).toMatchObject({ ok: true, status: "ready" });
		if (!ready.ok) throw new Error(ready.reason);
		expect(await lead.apply(ready.change)).toMatchObject({ status: "applied" });
		expect(applied).toHaveLength(1);
		expect(applied[0]).toMatchObject({
			changes: [
				{
					key: "flywheel-flywheel-eng-lead",
					from: { model: "claude-fable-5", effort: "high" },
					to: { model: "claude-opus-4-8", effort: "xhigh" },
				},
			],
		});

		for (const desired of [
			{ provider: "openai", model: "gpt-5.6-sol", effort: "xhigh" },
			{
				provider: "anthropic",
				model: "claude-fable-5",
				backend: "codex-app-server",
			},
		]) {
			const rejected = await lead.preflight(
				target!,
				desired,
				PROJECTS_REVISION,
			);
			expect(rejected).toMatchObject({
				ok: false,
				code: "readonly_cross_provider",
			});
		}
	});

	it("runner resolves the server project root and applies with the reviewed config SHA", async () => {
		const calls: Array<{
			path: string;
			change: unknown;
			opts: { expectedSha?: string };
		}> = [];
		const { runner } = createExistingManagementWriters({
			projects,
			projectsRevision: () => PROJECTS_REVISION,
			projectConfigs: configs,
			readProjectConfig: (path) => {
				expect(path).toBe("/server/flywheel/.flywheel/config.yaml");
				return CONFIG;
			},
			applyRunner: async (path, change, opts): Promise<ApplyResult> => {
				calls.push({ path, change, opts });
				return { changed: ["roles.runner.model"] };
			},
			readEnvFile: () => "",
			envPath: "/server/.flywheel/.env",
			env: {},
			applyLeadCanonical: async () => ({ status: "applied" }),
		});
		const targetId = buildTargetId("runner", [
			"flywheel",
			"default",
			"dispatch",
		]);
		const target = await runner.resolve(targetId);
		expect(target?.sourceRevision).toBe(`file:${CONFIG_SHA}`);
		const ready = await runner.preflight(
			target!,
			{
				provider: "openai",
				model: "gpt-5.6-sol",
				effort: "xhigh",
			},
			`file:${CONFIG_SHA}`,
		);
		expect(ready).toMatchObject({ ok: true });
		if (!ready.ok) throw new Error(ready.reason);
		await runner.apply(ready.change);
		expect(calls).toEqual([
			{
				path: "/server/flywheel/.flywheel/config.yaml",
				change: {
					backend: "codex-tmux",
					model: "gpt-5.6-sol",
					effort: "xhigh",
				},
				opts: { expectedSha: CONFIG_SHA },
			},
		]);
	});

	it("runner and flag snapshot providers expose store-only managed targets", () => {
		const runnerProvider = createManagementRunnerProvider({
			projects,
			projectConfigs: configs,
		});
		const runner = runnerProvider.read().fragment.projectRunnerDefaults?.[0];
		expect(runner?.runnerDefault?.dispatch.current).toEqual({
			provider: "anthropic",
			model: "claude-fable-5",
			effort: "high",
		});

		const env = { FLYWHEEL_LOOP_PROFILER: "0" };
		const flagProvider = createManagementFlagProvider({
			views: () => resolveAllFlags({ env, projectConfigs: configs() }),
			revision: () => "registry:flags-v1",
			projectNames: () => ["flywheel"],
		});
		const flags = flagProvider.read().fragment.flags ?? [];
		expect(
			flags.find((flag) => flag.name === "loop_profiler")?.global,
		).toMatchObject({
			current: false,
			writeCapability: {
				writable: false,
				consequence: "governance-readonly",
				reason: expect.stringContaining("SQLite flag store"),
			},
		});
		expect(
			flags.find((flag) => flag.name === "doc_flow")?.projectOverrides[0]?.value
				.writeCapability,
		).toMatchObject({ writable: false });
	});

	it("projects store-managed flags as read-only even when registry metadata is direct", () => {
		const view = resolveAllFlags({ env: {} }).find(
			(flag) => flag.name === "workflow_turn_divergence_alerts",
		);
		if (!view) throw new Error("missing workflow_turn_divergence_alerts");
		const value = createManagementFlagProvider({
			views: () => [
				{
					...view,
					storeManaged: true,
					storeEffective: false,
					clockReadiness: "ready",
				},
			],
			revision: () => "store:1",
			projectNames: () => ["flywheel"],
		}).read().fragment.flags?.[0]?.global;
		expect(value?.current).toBe(false);
		expect(value?.writeCapability).toMatchObject({
			writable: false,
			consequence: "governance-readonly",
		});
		expect(value?.writeCapability.reason).toContain("SQLite flag store");
	});

	it("reads project flag global/project cells from the scoped DB overlay and points writes to CLI", () => {
		const base = resolveAllFlags({ env: {}, projectConfigs: configs() }).find(
			(flag) => flag.name === "doc_flow",
		);
		if (!base) throw new Error("missing doc_flow");
		const read = (
			rows: Array<{ scope: string; raw: string; value: boolean }>,
			projectNames: string[] = ["flywheel", "geoforge3d"],
		) =>
			createManagementFlagProvider({
				views: () => [
					{
						...base,
						projectStoreManaged: true,
						storeManaged: false,
						scopedStore: { rows },
						effectiveByProject: [
							{
								projectName: "flywheel",
								value: false,
								via: "project_row",
							},
							{
								projectName: "geoforge3d",
								value: true,
								via: "star_row",
							},
						],
					},
				],
				revision: () => "store:scoped",
				projectNames: () => projectNames,
			}).read().fragment.flags?.[0];

		const withStar = read([
			{ scope: "*", raw: "1", value: true },
			{ scope: "flywheel", raw: "0", value: false },
		]);
		expect(withStar?.global.current).toBe(true);
		expect(withStar?.projectOverrides).toMatchObject([
			{ projectName: "flywheel", value: { current: false } },
			{ projectName: "geoforge3d", value: { current: true } },
		]);
		expect(withStar?.global.writeCapability).toMatchObject({ writable: false });
		expect(withStar?.global.writeCapability.reason).toContain(
			"flywheel-comm feature-flags set --project",
		);
		expect(
			withStar?.projectOverrides[0]?.value.writeCapability.reason,
		).toContain("flywheel-comm feature-flags set --project");

		expect(
			read([{ scope: "flywheel", raw: "0", value: false }])?.global.current,
		).toBe(base.default);
		expect(read([], [])?.projectOverrides).toEqual([]);
		expect(read([], [])?.global.current).toBe(base.default);
	});

	it("management flag values use displayEffective and disable writes on source divergence", () => {
		const flagProvider = createManagementFlagProvider({
			views: () =>
				resolveAllFlags({
					env: { FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS: "1" },
					envFile: {
						status: "readable",
						content: "FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS=0\n",
					},
					projectConfigs: configs(),
				}),
			revision: () => "registry:diverged",
			projectNames: () => ["flywheel"],
		});
		const value = flagProvider
			.read()
			.fragment.flags?.find(
				(flag) => flag.name === "workflow_turn_divergence_alerts",
			)?.global;
		expect(value?.current).toBeNull();
		expect(value?.writeCapability).toMatchObject({
			writable: false,
		});
		expect(value?.writeCapability.reason).toContain(".env 已改,Bridge 未拾取");
	});

	it.each([
		["staged_restart", ".env 已改,待重启生效"],
		["split_brain", "CLI 与 Bridge 见值不同"],
		["bridge_stale", ".env 已改,Bridge 未拾取"],
		["source_unavailable", ".env 不可读,无法确认或操作"],
	] as const)(
		"localhost flag DTO explains %s with the observable sources and no write capability",
		(divergence, message) => {
			const base = resolveAllFlags({ env: {} }).find(
				(flag) => flag.name === "workflow_turn_divergence_alerts",
			);
			if (!base) throw new Error("missing workflow_turn_divergence_alerts");
			const flagProvider = createManagementFlagProvider({
				views: () => [
					{
						...base,
						bridgeEffective: true,
						fileEffective:
							divergence === "source_unavailable" ? undefined : false,
						displayEffective: undefined,
						divergence,
					},
				],
				revision: () => `registry:${divergence}`,
				projectNames: () => ["flywheel"],
			});
			const value = flagProvider.read().fragment.flags?.[0]?.global;
			expect(value?.current).toBeNull();
			expect(value?.writeCapability.writable).toBe(false);
			expect(value?.writeCapability.reason).toContain(message);
			expect(value?.writeCapability.reason).toContain("Bridge: ON");
			if (divergence !== "source_unavailable") {
				expect(value?.writeCapability.reason).toContain(".env: OFF");
			}
		},
	);

	it("writer preflight independently refuses every store-managed flag", async () => {
		const { flag } = createExistingManagementWriters({
			projects,
			projectsRevision: () => PROJECTS_REVISION,
			projectConfigs: configs,
			readProjectConfig: () => CONFIG,
			readEnvFile: () => "",
			envPath: "/server/.flywheel/.env",
			env: {},
			flagViews: () => resolveAllFlags({ env: {} }),
			applyLeadCanonical: async () => ({ status: "applied" }),
		});
		expect(STORE_MANAGED_FLAGS.size).toBeGreaterThan(0);
		for (const name of STORE_MANAGED_FLAGS) {
			const spec = FEATURE_FLAGS.find((candidate) => candidate.name === name);
			expect(spec, name).toBeDefined();
			if (!spec) continue;
			const target = await flag.resolve(
				buildTargetId("flag", [name, "global"]),
			);
			expect(target, name).toBeDefined();
			if (!target) continue;
			const desired =
				spec.valueKind === "enum"
					? spec.enumValues?.find((value) => value !== spec.default)
					: spec.valueKind === "bool"
						? !spec.default
						: spec.valueKind === "value"
							? String(spec.default)
							: undefined;
			expect(desired, `${name} needs a management target`).toBeDefined();
			if (desired === undefined) continue;
			expect(
				await flag.preflight(target, desired, target.sourceRevision),
				name,
			).toMatchObject({
				ok: false,
				code: "readonly_registry_policy",
				reason: expect.stringContaining("SQLite flag store"),
			});
		}
	});

	it("ignores client-only authority fields because desired values are closed-shape", async () => {
		const { runner } = createExistingManagementWriters({
			projects,
			projectsRevision: () => PROJECTS_REVISION,
			projectConfigs: configs,
			readProjectConfig: () => CONFIG,
			readEnvFile: () => "",
			envPath: "/server/.flywheel/.env",
			env: {},
			applyLeadCanonical: async () => ({ status: "applied" }),
		});
		const target = await runner.resolve(
			buildTargetId("runner", ["flywheel", "default", "dispatch"]),
		);
		const result = await runner.preflight(
			target!,
			{
				provider: "anthropic",
				model: "claude-fable-5",
				projectRoot: "/client/forged",
				writerId: "evil",
				consequence: "hot",
				from: null,
			},
			target!.sourceRevision,
		);
		expect(result).toMatchObject({ ok: false, code: "invalid_desired_value" });
	});

	it("groups shared-authority changes into one Fleet batch", async () => {
		const multiProjects = () => {
			const value = projects();
			value[0]!.leads.push({
				agentId: "flywheel-ops-lead",
				backend: "claude-code",
				model: "claude-fable-5",
				effort: "high",
			});
			return value;
		};
		const fleetBatches: unknown[] = [];
		const env: Record<string, string | undefined> = {};
		const writers = createExistingManagementWriters({
			projects: multiProjects,
			projectsRevision: () => PROJECTS_REVISION,
			projectConfigs: configs,
			readProjectConfig: () => CONFIG,
			readEnvFile: () => "",
			envPath: "/server/.flywheel/.env",
			env,
			flagViews: () => resolveAllFlags({ env, projectConfigs: configs() }),
			applyLeadCanonical: async (batch) => {
				fleetBatches.push(batch);
				return { status: "accepted", details: { batchId: batch.batchId } };
			},
		});
		const leadChanges = [];
		for (const leadId of ["flywheel-eng-lead", "flywheel-ops-lead"]) {
			const target = await writers.lead.resolve(
				buildTargetId("lead", ["flywheel", leadId, "dispatch"]),
			);
			const checked = await writers.lead.preflight(
				target!,
				{
					provider: "anthropic",
					model: "claude-opus-4-8",
					effort: "xhigh",
				},
				PROJECTS_REVISION,
			);
			if (!checked.ok) throw new Error(checked.reason);
			leadChanges.push(checked.change);
		}
		const leadResults = await writers.lead.applyGroup!(leadChanges);
		expect(leadResults).toHaveLength(2);
		expect(fleetBatches).toHaveLength(1);
		expect(fleetBatches[0]).toMatchObject({ changes: [{}, {}] });
	});
});
