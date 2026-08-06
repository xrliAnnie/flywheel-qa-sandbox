#!/usr/bin/env npx tsx

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CommDB } from "../packages/flywheel-comm/src/db.js";
import {
	Database,
	ensureCanonicalDbWritable,
	migrateCommDbWithSwap,
	rollbackMailboxMigration,
} from "../packages/flywheel-comm/src/mailbox-migration.js";

type DbState = "legacy" | "migrated" | "mixed" | "unknown";

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
		const hasLegacyTables =
			objects.get("messages") === "table" ||
			objects.get("lead_inbox") === "table";
		if (objects.get("mailbox_migration_meta") === "table") {
			const generation = db
				.prepare(
					"SELECT schema_generation FROM mailbox_migration_meta WHERE singleton=1",
				)
				.get() as { schema_generation?: string } | undefined;
			if (generation?.schema_generation !== "mailbox_v1") return "unknown";
			// FLY-1646: a completed cutover DROPS the legacy tables, so finding
			// them next to a mailbox_v1 marker proves the swap never finished.
			// Reporting that as "migrated" made `main()` silently `continue` past
			// the shard — production `growth` was left in exactly this shape by
			// the aborted rollout and would have been skipped on redeploy while
			// still serving from stale legacy tables.
			return hasLegacyTables ? "mixed" : "migrated";
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

function assertFilesOwnerWritable(paths: string[]): void {
	for (const path of paths) {
		if (!existsSync(path)) continue;
		const mode = statSync(path).mode & 0o777;
		if ((mode & 0o200) === 0) {
			throw new Error(
				`canonical CommDB file is not owner-writable: ${path} mode=${mode.toString(8).padStart(4, "0")}; remediation: chmod 0600 ${path}`,
			);
		}
	}
}

function assertCanonicalSidecarsOwnerWritable(dbPath: string): void {
	assertFilesOwnerWritable([`${dbPath}-wal`, `${dbPath}-shm`]);
}

function assertCanonicalFilesOwnerWritable(dbPath: string): void {
	assertFilesOwnerWritable([dbPath, `${dbPath}-wal`, `${dbPath}-shm`]);
}

function verifyCommDbOpen(dbPath: string): void {
	assertCanonicalFilesOwnerWritable(dbPath);
	let db: CommDB | undefined;
	try {
		db = new CommDB(dbPath, false, false);
	} finally {
		db?.close();
	}
	assertCanonicalFilesOwnerWritable(dbPath);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const paths = explicitDbs(args);
	const dbs = paths.length > 0 ? paths : discover();
	if (dbs.length === 0)
		throw new Error("no legacy or migrated CommDB files found");
	assertUniqueFiles(dbs);
	for (const path of dbs) assertCanonicalSidecarsOwnerWritable(path);
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
	// --rollback is the recovery path FOR a half-migrated shard, so it must run
	// before the `mixed` guard below — that guard exists to stop a *cutover*
	// from silently skipping such a shard, not to strand it.
	if (args.includes("--rollback")) {
		for (const item of inventory) {
			if (!existsSync(`${item.path}.migration-swap-intent.json`)) continue;
			console.log(JSON.stringify(rollbackMailboxMigration(item.path)));
		}
		return;
	}
	// FLY-1646: fail loud, never skip. A completed cutover drops the legacy
	// tables, so legacy tables next to a mailbox_v1 marker prove the swap never
	// finished. Classifying that as "migrated" made the cutover loop `continue`
	// past the shard, leaving it serving from stale legacy tables. It needs an
	// explicit operator decision (--rollback, or finish the cutover) first.
	const halfMigrated = inventory.filter((item) => item.state === "mixed");
	if (halfMigrated.length > 0) {
		throw new Error(
			`half-migrated CommDB detected (legacy tables coexist with a mailbox_v1 marker); resolve it explicitly (--rollback restores the pre-fly1572 backup) before any cutover: ${halfMigrated
				.map((item) => item.path)
				.join(", ")}`,
		);
	}
	for (const item of inventory) {
		if (item.state === "migrated") {
			ensureCanonicalDbWritable(item.path);
			continue;
		}
		const result = await migrateCommDbWithSwap(item.path);
		console.log(JSON.stringify(result));
		console.log(
			`rollback: npx tsx scripts/migrate-fly1572-mailbox.ts --rollback --db ${JSON.stringify(item.path)}`,
		);
	}
	for (const item of inventory) verifyCommDbOpen(item.path);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
