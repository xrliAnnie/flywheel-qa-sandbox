import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
	type LeadModelLaunchDecision,
	resolveLeadAutoCompactWindow,
} from "./lead-model-launch.js";

/** Only understood, non-secret stdio selectors enter this measurement hash. */
export function leadToolsConfigSha(
	config: unknown,
	launchArgs: string[] = [],
): string {
	if (
		!config ||
		typeof config !== "object" ||
		!("mcpServers" in config) ||
		!config.mcpServers ||
		typeof config.mcpServers !== "object"
	)
		throw new Error("tools_identity_unknown");
	const servers = Object.entries(config.mcpServers)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, value]) => {
			if (!value || typeof value !== "object")
				throw new Error("tools_identity_unknown");
			const server = value as Record<string, unknown>;
			if (
				Object.keys(server).some(
					(key) =>
						!["command", "args", "env", "type", "disabled"].includes(key),
				) ||
				typeof server.command !== "string" ||
				(server.type !== undefined && server.type !== "stdio") ||
				(server.disabled !== undefined &&
					typeof server.disabled !== "boolean") ||
				!Array.isArray(server.args) ||
				server.args.some(
					(arg) =>
						typeof arg !== "string" ||
						!(
							isAbsolute(arg) ||
							/^--?[a-z-]+$/.test(arg) ||
							["mcp", "serve", "server", "start"].includes(arg)
						),
				) ||
				(server.env !== undefined &&
					(!server.env ||
						typeof server.env !== "object" ||
						Array.isArray(server.env)))
			)
				throw new Error("tools_identity_unknown");
			return {
				name,
				command: server.command,
				args: server.args,
				type: server.type ?? "stdio",
				disabled: server.disabled ?? false,
				envNames: Object.keys(server.env ?? {}).sort(),
			};
		});
	const stableArgs: string[] = [];
	for (let i = 0; i < launchArgs.length; i++) {
		if (
			[
				"--resume",
				"--session-id",
				"--autocompact",
				"--append-system-prompt-file",
				"--model",
				"--effort",
			].includes(launchArgs[i]!)
		) {
			i++;
			continue;
		}
		stableArgs.push(launchArgs[i]!);
	}
	return createHash("sha256")
		.update(JSON.stringify({ servers, launchArgs: stableArgs }))
		.digest("hex");
}

export function probeLeadAutoCompact(
	decision: LeadModelLaunchDecision,
	options: {
		binary: string;
		mcpConfigPath: string;
		rulesBodySha: string;
		launchArgs?: string[];
		environmentOverride?: boolean;
	},
): { windowTokens: number | null; reason: string } {
	if (decision.autoCompactWindowTokens === undefined)
		return { windowTokens: null, reason: "not_configured" };
	if (!decision.autoCompactBaseline)
		return { windowTokens: null, reason: "baseline_missing" };
	if (options.environmentOverride)
		return { windowTokens: null, reason: "environment_override" };
	try {
		const version = spawnSync(options.binary, ["--version"], {
			encoding: "utf8",
			input: "",
			timeout: 5000,
			maxBuffer: 16384,
		});
		if (version.error || version.status !== 0)
			return { windowTokens: null, reason: "version_probe_failed" };
		const candidate = resolveLeadAutoCompactWindow(decision, {
			model: decision.model,
			claudeVersion: version.stdout.trim(),
			rulesBodySha: options.rulesBodySha,
			toolsConfigSha: leadToolsConfigSha(
				JSON.parse(readFileSync(options.mcpConfigPath, "utf8")),
				options.launchArgs,
			),
			bootstrapPolicyVersion: "bounded-v1",
		});
		if (candidate.windowTokens === null) return candidate;
		// --version exits before parsing unknown options. Empty --print input instead
		// reaches argument validation without submitting a model request.
		const probe = spawnSync(
			options.binary,
			["-p", "--autocompact", String(candidate.windowTokens)],
			{ encoding: "utf8", input: "", timeout: 5000, maxBuffer: 16384 },
		);
		if (
			probe.error ||
			probe.status !== 1 ||
			!/^Error: Input must be provided either through stdin or as a prompt argument when using --print\s*$/.test(
				probe.stderr.trim(),
			)
		)
			return { windowTokens: null, reason: "cli_capability_unverified" };
		return candidate;
	} catch {
		return { windowTokens: null, reason: "tools_or_probe_unavailable" };
	}
}
