import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	leadToolsConfigSha,
	probeLeadAutoCompact,
} from "../lead-auto-compact.js";
import type { LeadModelLaunchDecision } from "../lead-model-launch.js";

it("probes actual option parsing and ignores version-only false positives", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2567-compact-"));
	try {
		const binary = join(root, "claude");
		const configPath = join(root, "mcp.json");
		const config = {
			mcpServers: {
				inbox: {
					command: "node",
					args: ["/tmp/inbox.js"],
					env: { TOKEN: "test-secret" },
				},
			},
		};
		writeFileSync(configPath, JSON.stringify(config));
		const baseline = {
			inputFloorTokens: 180000,
			inputFloorOffTokens: 190000,
			claudeVersion: "2.test",
			model: "claude-fable-5-1",
			rulesBodySha: "a".repeat(64),
			toolsConfigSha: leadToolsConfigSha(config),
			bootstrapPolicyVersion: "bounded-v1",
		};
		const decision = {
			model: baseline.model,
			autoCompactWindowTokens: 400000,
			autoCompactBaseline: baseline,
		} as LeadModelLaunchDecision;
		const options = {
			binary,
			mcpConfigPath: configPath,
			rulesBodySha: baseline.rulesBodySha,
		};
		writeFileSync(
			binary,
			'#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2.test; exit 0; fi\necho "error: unknown option --autocompact" >&2\nexit 1\n',
			{ mode: 0o700 },
		);
		expect(probeLeadAutoCompact(decision, options).windowTokens).toBeNull();
		writeFileSync(
			binary,
			'#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2.test; exit 0; fi\n[ "$1" = "-p" ] && [ "$2" = "--autocompact" ] && [ "$3" = "400000" ] || exit 5\necho "Error: Input must be provided either through stdin or as a prompt argument when using --print" >&2\nexit 1\n',
			{ mode: 0o700 },
		);
		expect(probeLeadAutoCompact(decision, options)).toEqual({
			windowTokens: 400000,
			reason: "eligible",
		});
		expect(
			probeLeadAutoCompact(decision, {
				...options,
				rulesBodySha: "c".repeat(64),
			}).windowTokens,
		).toBeNull();
		expect(
			probeLeadAutoCompact(decision, { ...options, environmentOverride: true })
				.windowTokens,
		).toBeNull();
		expect(
			probeLeadAutoCompact(
				{ ...decision, autoCompactBaseline: undefined },
				options,
			).windowTokens,
		).toBeNull();
		const changedSecret = {
			mcpServers: {
				inbox: { ...config.mcpServers.inbox, env: { TOKEN: "rotated-secret" } },
			},
		};
		expect(leadToolsConfigSha(changedSecret)).toBe(baseline.toolsConfigSha);
		expect(
			leadToolsConfigSha({ mcpServers: { other: config.mcpServers.inbox } }),
		).not.toBe(baseline.toolsConfigSha);
		expect(() =>
			leadToolsConfigSha({
				mcpServers: {
					remote: {
						url: "https://example.test",
						headers: { Authorization: "secret" },
					},
				},
			}),
		).toThrow("tools_identity_unknown");
		expect(
			leadToolsConfigSha(config, ["--agent", "lead", "--session-id", "one"]),
		).toBe(
			leadToolsConfigSha(config, ["--agent", "lead", "--session-id", "two"]),
		);
		expect(leadToolsConfigSha(config, ["--agent", "lead-a"])).not.toBe(
			leadToolsConfigSha(config, ["--agent", "lead-b"]),
		);
		writeFileSync(
			binary,
			'#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2.test; fi\nexit 0\n',
			{ mode: 0o700 },
		);
		expect(probeLeadAutoCompact(decision, options).reason).toBe(
			"cli_capability_unverified",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
