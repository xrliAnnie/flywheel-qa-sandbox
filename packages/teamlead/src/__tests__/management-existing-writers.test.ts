import { createHash } from "node:crypto";
import {
	type ApplyResult,
	type FlywheelConfig,
	resolveAllFlags,
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

	it("runner and flag snapshot providers expose live managed targets", () => {
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

		const env = { FLYWHEEL_AUTO_QA: "0" };
		const flagProvider = createManagementFlagProvider({
			views: () => resolveAllFlags({ env, projectConfigs: configs() }),
			revision: () => "registry:flags-v1",
			projectNames: () => ["flywheel"],
		});
		const flags = flagProvider.read().fragment.flags ?? [];
		expect(
			flags.find((flag) => flag.name === "auto_qa_killswitch")?.global,
		).toMatchObject({
			current: false,
			writeCapability: { writable: true, consequence: "hot" },
		});
		expect(
			flags.find((flag) => flag.name === "qa_auto")?.projectOverrides[0]?.value
				.writeCapability,
		).toMatchObject({ writable: false });
	});

	it("direct flag delegates the safe env writer, refreshes live state, and rejects unsupported scopes", async () => {
		const env: Record<string, string | undefined> = {};
		let envFile = "KEEP=1\n";
		const views = () => resolveAllFlags({ env, projectConfigs: configs() });
		const { flag } = createExistingManagementWriters({
			projects,
			projectsRevision: () => PROJECTS_REVISION,
			projectConfigs: configs,
			readProjectConfig: () => CONFIG,
			readEnvFile: () => envFile,
			writeEnvFile: (_path, content) => {
				envFile = content;
			},
			envPath: "/server/.flywheel/.env",
			env,
			flagViews: views,
			flagLock: (fn) => fn(),
			applyLeadCanonical: async () => ({ status: "applied" }),
		});
		const targetId = buildTargetId("flag", ["auto_qa_killswitch", "global"]);
		const target = await flag.resolve(targetId);
		expect(target?.currentValue).toBe(true);
		const ready = await flag.preflight(target!, false, target!.sourceRevision);
		if (!ready.ok) throw new Error(ready.reason);
		expect(await flag.apply(ready.change)).toMatchObject({ status: "applied" });
		expect(env.FLYWHEEL_AUTO_QA).toBe("0");
		expect((await flag.resolve(targetId))?.currentValue).toBe(false);

		const projectFlag = buildTargetId("flag", [
			"qa_auto",
			"project",
			"flywheel",
		]);
		const projectTarget = await flag.resolve(projectFlag);
		expect(
			await flag.preflight(
				projectTarget!,
				false,
				projectTarget!.sourceRevision,
			),
		).toMatchObject({ ok: false, code: "readonly_registry_policy" });

		const globalOnlyOverride = buildTargetId("flag", [
			"auto_qa_killswitch",
			"project",
			"flywheel",
		]);
		const globalOnlyTarget = await flag.resolve(globalOnlyOverride);
		expect(globalOnlyTarget?.writeCapability.reason).toMatch(/global/i);
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

	it("groups shared-authority changes into one Fleet batch and rebases sequential .env writes", async () => {
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
		let envFile = "";
		const env: Record<string, string | undefined> = {};
		const writers = createExistingManagementWriters({
			projects: multiProjects,
			projectsRevision: () => PROJECTS_REVISION,
			projectConfigs: configs,
			readProjectConfig: () => CONFIG,
			readEnvFile: () => envFile,
			writeEnvFile: (_path, content) => {
				envFile = content;
			},
			flagLock: (fn) => fn(),
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

		const flagChanges = [];
		for (const name of ["auto_qa_killswitch", "codex_hard_gate_killswitch"]) {
			const target = await writers.flag.resolve(
				buildTargetId("flag", [name, "global"]),
			);
			const checked = await writers.flag.preflight(
				target!,
				false,
				target!.sourceRevision,
			);
			if (!checked.ok) throw new Error(checked.reason);
			flagChanges.push(checked.change);
		}
		expect(await writers.flag.applyGroup!(flagChanges)).toEqual([
			expect.objectContaining({ status: "applied" }),
			expect.objectContaining({ status: "applied" }),
		]);
		expect(env).toMatchObject({
			FLYWHEEL_AUTO_QA: "0",
			FLYWHEEL_CODEX_HARD_GATE: "0",
		});
	});
});
