import type { CompiledLeadIdentityRow } from "flywheel-comm/lead-identity";
import { describe, expect, it } from "vitest";
import { RUNNER_ACTION_TOOL_NAMES } from "../../lead-backends/codex/runner-action-names.js";
import { resolveLeadCapabilities } from "../resolve.js";

const row = (overrides = {}): CompiledLeadIdentityRow =>
	({
		project: { projectName: "flywheel", leads: [] },
		lead: {
			agentId: "product",
			summaryRole: "producer",
			backend: "codex-app-server",
			codexProfile: "full-access",
			canSpawnRunners: false,
			codexCapabilityBundleVersion: 2,
			...overrides,
		},
		identity: {
			projectName: "flywheel",
			leadId: "product",
			backend: "codex-app-server",
			role: "dept",
		},
	}) as CompiledLeadIdentityRow;
const resolve = (
	current = row(),
	integrations: string[] = ["discord"],
	handlers = ["discord.thread.read"],
) =>
	resolveLeadCapabilities({
		row: current,
		integrationIds: integrations,
		handlerOperationIds: handlers,
		adoptedMenuShapes: [],
	});

describe("current Lead capability projection", () => {
	it("retains unconditional denials without requiring forbidden providers", () => {
		const result = resolve(row(), [], []);
		expect(result.operations.map((op) => op.operationId).sort()).toEqual([
			"git.feature.push",
			"github.issue.comment",
			"github.pr.create",
		]);
		expect(result.operations.every((op) => op.unconditionalDenial)).toBe(true);
	});
	it("never advertises a missing credential consumer or missing handler as usable", () => {
		expect(
			resolve()
				.operations.filter((op) => !op.unconditionalDenial)
				.map((op) => op.operationId),
		).toEqual(["discord.thread.read"]);
		expect(resolve().missingOperationIds).toContain("linear.issue.get");
		expect(
			resolve(row(), []).operations.filter((op) => !op.unconditionalDenial),
		).toEqual([]);
		expect(
			resolve(row(), ["discord"], []).operations.filter(
				(op) => !op.unconditionalDenial,
			),
		).toEqual([]);
	});
	it("keeps voice operations absent from both available and missing until opt-in", () => {
		const voiceIds = [
			"voice.session.start",
			"voice.session.status",
			"voice.session.stop",
		];
		const unconfigured = resolve(row(), ["bridge"], voiceIds)!;
		expect(
			unconfigured.operations.filter((op) => voiceIds.includes(op.operationId)),
		).toEqual([]);
		expect(
			unconfigured.missingOperationIds.filter((id) => voiceIds.includes(id)),
		).toEqual([]);
		const enabled = resolve(
			row({ codexVoiceActions: true }),
			["bridge"],
			voiceIds,
		)!;
		expect(
			enabled.operations
				.filter((op) => voiceIds.includes(op.operationId))
				.map((op) => op.operationId),
		).toEqual(voiceIds);
		expect(
			resolve(row({ codexVoiceActions: true }), ["bridge"], [])!
				.missingOperationIds,
		).toEqual(expect.arrayContaining(voiceIds));
	});
	it("keeps old rows unadopted and never turns reserved handlers into available operations", () => {
		expect(
			resolve(row({ codexCapabilityBundleVersion: undefined })),
		).toBeNull();
		expect(() => resolve(row(), ["discord"], ["bridge.ship"])).toThrow(
			/reserved/,
		);
		expect(() => resolve(row(), ["discord"], ["arbitrary.command"])).toThrow(
			/unknown/,
		);
	});
	it("requires a matching canonical department identity", () => {
		for (const role of ["cos", "companion", "external"]) {
			const current = row();
			current.identity.role =
				role as CompiledLeadIdentityRow["identity"]["role"];
			expect(() => resolve(current)).toThrow(/department/);
		}
		const current = row();
		current.identity.leadId = "foreign";
		expect(() => resolve(current)).toThrow(/identity/);
		expect(() => resolve(row({ external: true }))).toThrow(/capability/);
	});
	it("retains adopted menu constraints only with explicit runner authorization", () => {
		const input = {
			row: row({ canSpawnRunners: true, codexRunnerActions: true }),
			integrationIds: ["bridge"],
			handlerOperationIds: [...RUNNER_ACTION_TOOL_NAMES],
			adoptedMenuShapes: ["engineering"],
		};
		expect(resolveLeadCapabilities(input)?.runnerActionToolNames).toHaveLength(
			6,
		);
		expect(resolveLeadCapabilities(input)?.adoptedMenuShapes).toEqual([
			"engineering",
		]);
		expect(
			resolveLeadCapabilities({ ...input, adoptedMenuShapes: [] })
				?.runnerActionToolNames,
		).toEqual([]);
		expect(resolve()?.runnerActionToolNames).toEqual([]);
		expect(
			resolveLeadCapabilities({ ...input, handlerOperationIds: [] })
				?.runnerActionToolNames,
		).toEqual([]);
		expect(
			resolveLeadCapabilities({
				...input,
				adoptedMenuShapes: [],
			})?.operations.some((op) => op.parityId === "P01"),
		).toBe(false);
	});
});
