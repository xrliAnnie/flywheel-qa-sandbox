#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	fullAccessLeadActionsConfigFromEnv,
	toFullAccessMcpServerToml,
} from "../lead-backends/codex/lead-actions/mcp-config.js";
export function renderLeadActionsConfig(env: NodeJS.ProcessEnv): string {
	return toFullAccessMcpServerToml(
		"lead_actions",
		fullAccessLeadActionsConfigFromEnv(env),
	);
}
if (
	process.argv[1] &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		process.stdout.write(renderLeadActionsConfig(process.env));
	} catch {
		process.stderr.write(
			"lead-actions configuration rejected; verify canonical context and required coordinates\n",
		);
		process.exitCode = 1;
	}
}
