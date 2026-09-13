import { describe, expect, it } from "vitest";
import { resolveCodexLeadCapabilities } from "../codex-lead-capabilities.js";

describe("explicit Codex runner capabilities", () => {
	it.each([
		{ codexProfile: "unknown", companion: true },
		{ codexProfile: "full-access", companion: true },
		{ codexProfile: "write-capable", companion: true },
	])("rejects invalid legacy tiers at every consumer: %j", (tier) => {
		expect(
			resolveCodexLeadCapabilities({ canSpawnRunners: false, ...tier }),
		).toMatchObject({ eligible: false, runnerActionsEnabled: false });
	});
	it("enables a deliberately configured department Lead", () => {
		expect(
			resolveCodexLeadCapabilities({
				backend: "codex-app-server",
				codexProfile: "full-access",
				canSpawnRunners: true,
				codexRunnerActions: true,
			}),
		).toEqual({ eligible: true, runnerActionsEnabled: true, reason: null });
	});
	it.each([
		{},
		{ canSpawnRunners: true, codexProfile: "full-access" },
		{
			canSpawnRunners: true,
			codexProfile: "full-access",
			codexRunnerActions: false,
		},
	])("does not grant a default runner capability: %j", (input) => {
		expect(
			resolveCodexLeadCapabilities({ backend: "codex-app-server", ...input }),
		).toMatchObject({ eligible: false, runnerActionsEnabled: false });
	});
	it.each([
		{ canSpawnRunners: undefined },
		{ canSpawnRunners: false },
		{ companion: true },
		{ external: true },
		{ codexProfile: undefined },
		{ codexProfile: "companion" },
		{ codexProfile: "unknown" },
		{ codexRunnerActions: "true" },
		{ codexRunnerActions: null },
	])("fails closed for invalid opt-in: %j", (override) => {
		const input = {
			backend: "codex-app-server",
			canSpawnRunners: true,
			codexProfile: "full-access",
			codexRunnerActions: true,
			...override,
		};
		const result = resolveCodexLeadCapabilities(
			input as Parameters<typeof resolveCodexLeadCapabilities>[0],
		);
		expect(result).toMatchObject({
			eligible: false,
			runnerActionsEnabled: false,
		});
		expect(result.reason).toBeTruthy();
	});
	it.each(["full-access", "write-capable"])(
		"permits dormant Claude opt-in for %s",
		(codexProfile) => {
			expect(
				resolveCodexLeadCapabilities({
					backend: "claude-code",
					codexProfile,
					canSpawnRunners: true,
					codexRunnerActions: true,
				}),
			).toEqual({ eligible: true, runnerActionsEnabled: false, reason: null });
		},
	);
	it.each([
		{ companion: true },
		{ codexProfile: "companion" },
		{ codexProfile: "write-capable" },
		{ codexProfile: "full-access" },
	])("preserves non-spawning recognized tiers: %j", (tier) => {
		expect(
			resolveCodexLeadCapabilities({
				backend: "codex-app-server",
				canSpawnRunners: false,
				...tier,
			}),
		).toEqual({ eligible: true, runnerActionsEnabled: false, reason: null });
	});
});
