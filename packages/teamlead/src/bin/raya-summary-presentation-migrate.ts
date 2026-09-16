#!/usr/bin/env node
import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { runSummaryPresentationMigration } from "../bridge/summary-presentation-migration.js";
import { StateStore } from "../StateStore.js";

export interface RayaSummaryPresentationMigrationArgs {
	dbPath: string;
	workspaceRoot: string;
	projectName: string;
	leadId: string;
	ledgerPath?: string;
	decisionsPath?: string;
	maxRows?: number;
}

export function parseRayaSummaryPresentationMigrationArgs(
	argv: string[],
): RayaSummaryPresentationMigrationArgs {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
			throw new Error("invalid_arguments");
		}
		if (values.has(flag)) throw new Error(`duplicate_argument:${flag}`);
		values.set(flag, value);
	}
	const allowed = new Set([
		"--db",
		"--workspace",
		"--project",
		"--lead",
		"--ledger",
		"--decisions",
		"--max-rows",
	]);
	for (const flag of values.keys()) {
		if (!allowed.has(flag)) throw new Error(`unknown_argument:${flag}`);
	}
	const required = (flag: string): string => {
		const value = values.get(flag)?.trim();
		if (!value) throw new Error(`missing_argument:${flag}`);
		return value;
	};
	const maxRowsRaw = values.get("--max-rows");
	const maxRows = maxRowsRaw === undefined ? undefined : Number(maxRowsRaw);
	if (
		maxRows !== undefined &&
		(!Number.isSafeInteger(maxRows) || maxRows < 1)
	) {
		throw new Error("invalid_argument:--max-rows");
	}
	return {
		dbPath: resolve(required("--db")),
		workspaceRoot: resolve(required("--workspace")),
		projectName: required("--project"),
		leadId: required("--lead"),
		...(values.has("--ledger") ? { ledgerPath: values.get("--ledger")! } : {}),
		...(values.has("--decisions")
			? { decisionsPath: values.get("--decisions")! }
			: {}),
		...(maxRows === undefined ? {} : { maxRows }),
	};
}

export async function runRayaSummaryPresentationMigrationCli(
	args: RayaSummaryPresentationMigrationArgs,
): Promise<ReturnType<typeof runSummaryPresentationMigration>> {
	if (!existsSync(args.dbPath) || !lstatSync(args.dbPath).isFile()) {
		throw new Error(`teamlead_database_missing:${args.dbPath}`);
	}
	if (
		!existsSync(args.workspaceRoot) ||
		!lstatSync(args.workspaceRoot).isDirectory() ||
		lstatSync(args.workspaceRoot).isSymbolicLink()
	) {
		throw new Error(`raya_workspace_invalid:${args.workspaceRoot}`);
	}
	const store = await StateStore.create(args.dbPath);
	try {
		return runSummaryPresentationMigration({
			store: store.summaryPresentations,
			projectName: args.projectName,
			leadId: args.leadId,
			workspaceRoot: args.workspaceRoot,
			...(args.ledgerPath ? { ledgerPath: args.ledgerPath } : {}),
			...(args.decisionsPath ? { decisionsPath: args.decisionsPath } : {}),
			...(args.maxRows === undefined ? {} : { maxRows: args.maxRows }),
		});
	} finally {
		store.close();
	}
}

async function main(): Promise<void> {
	const args = parseRayaSummaryPresentationMigrationArgs(process.argv.slice(2));
	const result = await runRayaSummaryPresentationMigrationCli(args);
	process.stdout.write(`${JSON.stringify(result)}\n`);
	if (result.state !== "complete") process.exitCode = 2;
}

if (process.argv[1]?.includes("raya-summary-presentation-migrate")) {
	main().catch((error) => {
		process.stderr.write(`${(error as Error).message}\n`);
		process.exitCode = 1;
	});
}
