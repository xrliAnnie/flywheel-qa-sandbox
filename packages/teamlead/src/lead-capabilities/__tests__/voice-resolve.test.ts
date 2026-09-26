import { describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { LEAD_CAPABILITY_CATALOG } from "../catalog.js";
import { resolveVoiceBackgroundCapabilities } from "../voice-resolve.js";

function project(backend: "claude-code" | "codex-app-server"): ProjectEntry {
	return {
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		projectRepo: "acme/flywheel",
		leads: [
			{
				agentId: "eng",
				summaryRole: "producer",
				backend,
				chatChannel: "12345678901234567",
				match: { labels: ["Engineering"] },
				voiceBackground: { enabled: true, browser: "founder_chrome" },
			},
		],
	} as ProjectEntry;
}

describe("voice background capability resolution", () => {
	it.each(["claude-code", "codex-app-server"] as const)(
		"uses the Lead-wide non-reserved union for a %s Lead without forging its backend",
		(backend) => {
			const resolved = resolveVoiceBackgroundCapabilities({
				project: project(backend),
				leadId: "eng",
				sessionId: "10000000-0000-4000-8000-000000000001",
				browserMode: "founder_chrome",
			});
			expect(resolved.identity).toMatchObject({
				projectName: "flywheel",
				leadId: "eng",
				backend,
				activationId: "voice:10000000-0000-4000-8000-000000000001",
				actor: "voice",
			});
			expect(resolved.operations.map(({ operationId }) => operationId)).toEqual(
				LEAD_CAPABILITY_CATALOG.filter(
					({ classification }) => classification !== "reserved",
				).map(({ operationId }) => operationId),
			);
			expect(
				resolved.deniedOperations.map(({ operationId }) => operationId),
			).toEqual([
				"terminal.close",
				"bridge.ship",
				"bridge.merge",
				"bridge.terminate",
				"bridge.restart",
				"bridge.park",
				"bridge.unpark",
				"bridge.approve_to_ship",
			]);
		},
	);

	it("fails closed when the session, Lead, browser mode, or enablement is not current", () => {
		for (const input of [
			{ leadId: "missing" },
			{ sessionId: "not-a-uuid" },
			{ browserMode: "invalid" },
			{
				project: {
					...project("claude-code"),
					leads: [
						{
							...project("claude-code").leads[0]!,
							voiceBackground: { enabled: false },
						},
					],
				},
			},
		] as const) {
			expect(() =>
				resolveVoiceBackgroundCapabilities({
					project: project("claude-code"),
					leadId: "eng",
					sessionId: "10000000-0000-4000-8000-000000000001",
					browserMode: "founder_chrome",
					...input,
				} as never),
			).toThrow("voice_capability_scope_denied");
		}
	});
});
