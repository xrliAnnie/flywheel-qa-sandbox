#!/usr/bin/env npx tsx

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	Database,
	migrateCommDbWithSwap,
	rollbackMailboxMigration,
} from "../packages/flywheel-comm/src/mailbox-migration.js";

type DbState = "legacy" | "migrated" | "unknown";

function classify(path: string): DbState {
	const db = new Database(path, { readonly: true, fileMustExist: true });
	try {
		const objects = new Map(
			(
				db
					.prepare(
						"SELECT name, type FROM sqlite_master WHERE name IN ('messages','lead_inbox','mailbox_migration_meta')",
					)
					.all() as Array<{ name: string; type: string }>
			).map((row) => [row.name, row.type]),
		);
		if (objects.get("mailbox_migration_meta") === "table") {
			const generation = db
				.prepare(
					"SELECT schema_generation FROM mailbox_migration_meta WHERE singleton=1",
				)
				.get() as { schema_generation?: string } | undefined;
			return generation?.schema_generation === "mailbox_v1"
				? "migrated"
				: "unknown";
		}
		if (
			objects.get("messages") === "table" &&
			objects.get("lead_inbox") === "table"
		) {
			return "legacy";
		}
		return "unknown";
	} finally {
		db.close();
	}
}

function explicitDbs(argv: string[]): string[] {
	const paths: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] === "--db" && argv[index + 1])
			paths.push(resolve(argv[++index]));
	}
	return paths;
}

function discover(): string[] {
	const flywheelHome =
		process.env.FLYWHEEL_HOME ?? join(homedir(), ".flywheel");
	const candidates = new Set<string>();
	const rootDb = join(flywheelHome, "comm.db");
	if (existsSync(rootDb)) candidates.add(rootDb);
	const commRoot = join(flywheelHome, "comm");
	if (existsSync(commRoot)) {
		for (const entry of readdirSync(commRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = join(commRoot, entry.name, "comm.db");
			if (existsSync(path)) candidates.add(path);
		}
	}
	if (process.env.FLYWHEEL_COMM_DB) {
		candidates.add(resolve(process.env.FLYWHEEL_COMM_DB));
	}
	return [...candidates].sort();
}

function assertUniqueFiles(paths: string[]): void {
	const seen = new Map<string, string>();
	for (const path of paths) {
		const stat = statSync(path);
		const key = `${stat.dev}:${stat.ino}`;
		const previous = seen.get(key);
		if (previous)
			throw new Error(
				`same CommDB appears under two paths: ${previous}, ${path}`,
			);
		seen.set(key, path);
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const paths = explicitDbs(args);
	const dbs = paths.length > 0 ? paths : discover();
	if (dbs.length === 0)
		throw new Error("no legacy or migrated CommDB files found");
	assertUniqueFiles(dbs);
	const inventory = dbs.map((path) => ({ path, state: classify(path) }));
	console.log(JSON.stringify({ inventory }, null, 2));
	if (args.includes("--inventory")) return;
	if (!args.includes("--confirm-quiesced")) {
		throw new Error(
			"refusing to write: stop Bridge, Leads, Runners, and ad-hoc CommDB writers, then pass --confirm-quiesced",
		);
	}
	if (inventory.some((item) => item.state === "unknown")) {
		throw new Error(
			"inventory contains an unknown schema; refusing partial cutover",
		);
	}
	if (args.includes("--rollback")) {
		for (const item of inventory) {
			if (!existsSync(`${item.path}.migration-swap-intent.json`)) continue;
			console.log(JSON.stringify(rollbackMailboxMigration(item.path)));
		}
		return;
	}
	for (const item of inventory) {
		if (item.state === "migrated") continue;
		const result = await migrateCommDbWithSwap(item.path);
		console.log(JSON.stringify(result));
		console.log(
			`rollback: npx tsx scripts/migrate-fly1572-mailbox.ts --rollback --db ${JSON.stringify(item.path)}`,
		);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
