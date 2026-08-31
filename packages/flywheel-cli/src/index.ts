#!/usr/bin/env node

/**
 * FLY-137 Phase 6: flywheel-cli — project scaffolding + diagnostics.
 *
 * Subcommands: init / doctor / migrate-agent-registry
 *
 * Designed to mirror flywheel-comm's invocation pattern:
 *   pnpm --filter flywheel-cli exec flywheel <cmd> [--project-path <path>]
 *
 * Direct node invocation:
 *   node packages/flywheel-cli/dist/index.js <cmd> [...]
 */

import { parseArgs } from "node:util";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runMigrateAgentRegistry } from "./commands/migrate-agent-registry.js";

function printUsage(): void {
	console.log(`Usage: flywheel <command> [options]

Commands:
  init [--project-path <path>] [--depts <a,b,c> | --no-depts] [--force] [--project-name <name>]
       Scaffold a fresh .flywheel/ directory in a git project.

  doctor [--project-path <path>] [--bundled-registry <path>]
       Validate bundled registry + project registry + config node references.

  migrate-agent-registry [--project-path <path>] [--bundled-registry <path>] [--node-map <file>] [--force]
       Cut path-authored agents over to stable registry nodes and emit a receipt.

Global flags:
  --project-path <path>   Project root (default: walk up to find .flywheel/)

Run any command with --help for subcommand-specific usage.`);
}

function csv(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];

	if (!command || command === "--help" || command === "-h") {
		printUsage();
		process.exit(0);
	}

	const rest = args.slice(1);

	switch (command) {
		case "init": {
			const { values } = parseArgs({
				args: rest,
				options: {
					"project-path": { type: "string" },
					depts: { type: "string" },
					"no-depts": { type: "boolean", default: false },
					force: { type: "boolean", default: false },
					"project-name": { type: "string" },
				},
				allowPositionals: false,
			});
			runInit({
				projectPath: values["project-path"],
				depts: csv(values.depts),
				noDepts: values["no-depts"],
				force: values.force,
				projectName: values["project-name"],
			});
			process.exit(0);
			break;
		}
		case "doctor": {
			const { values } = parseArgs({
				args: rest,
				options: {
					"project-path": { type: "string" },
					"bundled-registry": { type: "string" },
				},
				allowPositionals: false,
			});
			const code = await runDoctor({
				projectPath: values["project-path"],
				bundledRegistryPath: values["bundled-registry"],
			});
			process.exit(code);
			break;
		}
		case "migrate-agent-registry": {
			const { values } = parseArgs({
				args: rest,
				options: {
					"project-path": { type: "string" },
					"bundled-registry": { type: "string" },
					"node-map": { type: "string" },
					force: { type: "boolean", default: false },
				},
				allowPositionals: false,
			});
			const code = runMigrateAgentRegistry({
				projectPath: values["project-path"],
				bundledRegistryPath: values["bundled-registry"],
				nodeMap: values["node-map"],
				force: values.force,
			});
			process.exit(code);
			break;
		}
		default:
			console.error(`Unknown command: ${command}`);
			printUsage();
			process.exit(1);
	}
}

main().catch((err) => {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`Error: ${message}`);
	process.exit(1);
});
