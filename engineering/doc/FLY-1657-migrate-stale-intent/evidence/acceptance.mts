// FLY-1657 copy-only acceptance harness. Source CommDB files are copied as
// opaque bytes and are never opened; every SQLite operation targets sandbox.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	classifyMailboxDatabase,
	Database,
	inspectMailboxSwapIntent,
	migrateCommDbWithSwap,
	verifyMigratedDatabase,
} from "../../../../packages/flywheel-comm/src/mailbox-migration.js";

type LegacyIntent = {
	v: number;
	dbPath: string;
	backupPath: string;
	stagingPath: string;
	phase: string;
	originalMode: number;
	createdAt: string;
	sourceMessages: number;
	sourceLeadInbox: number;
	quarantinedSidecars: string[];
};

const repoRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);

function invariant(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`acceptance failed: ${message}`);
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function copyDbBundle(sourceDb: string, targetDb: string): void {
	mkdirSync(dirname(targetDb), { recursive: true });
	for (const suffix of ["", "-wal", "-shm"] as const) {
		const source = `${sourceDb}${suffix}`;
		const target = `${targetDb}${suffix}`;
		rmSync(target, { force: true });
		if (!existsSync(source)) continue;
		copyFileSync(source, target);
		chmodSync(target, 0o600);
	}
}

function rewriteIntent(
	sourceIntentPath: string,
	targetDb: string,
	copyOldBackup: boolean,
): { intentPath: string; oldBackupPath: string | undefined } {
	const source = JSON.parse(
		readFileSync(sourceIntentPath, "utf8"),
	) as LegacyIntent;
	const backupMarker = ".pre-fly1572-";
	const backupSuffix = source.backupPath.includes(backupMarker)
		? source.backupPath.slice(source.backupPath.indexOf(backupMarker))
		: `${backupMarker}old-evidence`;
	const oldBackupPath = `${targetDb}${backupSuffix}`;
	const rewritten: LegacyIntent = {
		...source,
		dbPath: targetDb,
		backupPath: oldBackupPath,
		stagingPath: join(dirname(targetDb), ".fly1572-stale", "comm.db"),
		quarantinedSidecars: source.quarantinedSidecars.map((path) =>
			path.includes("-wal")
				? `${targetDb}-wal.fly1572-quarantine`
				: `${targetDb}-shm.fly1572-quarantine`,
		),
	};
	if (copyOldBackup && existsSync(source.backupPath)) {
		copyFileSync(source.backupPath, oldBackupPath);
		chmodSync(oldBackupPath, 0o600);
	}
	const intentPath = `${targetDb}.migration-swap-intent.json`;
	writeFileSync(intentPath, `${JSON.stringify(rewritten)}\n`, { mode: 0o600 });
	return {
		intentPath,
		oldBackupPath: existsSync(oldBackupPath) ? oldBackupPath : undefined,
	};
}

function mailboxFacts(dbPath: string): Record<string, unknown> {
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		return {
			meta: db
				.prepare(
					"SELECT schema_generation, source_messages_count, source_lead_inbox_count FROM mailbox_migration_meta WHERE singleton=1",
				)
				.get(),
			mailboxRows: (
				db.prepare("SELECT COUNT(*) AS count FROM mailbox").get() as {
					count: number;
				}
			).count,
		};
	} finally {
		db.close();
	}
}

async function staleAcceptance(
	sourceDb: string,
	sourceIntent: string,
	sandbox: string,
): Promise<void> {
	rmSync(sandbox, { recursive: true, force: true });
	const dbPath = join(sandbox, "comm.db");
	copyDbBundle(sourceDb, dbPath);
	const { intentPath, oldBackupPath } = rewriteIntent(
		sourceIntent,
		dbPath,
		true,
	);
	const oldBackupHash = oldBackupPath ? sha256(oldBackupPath) : undefined;
	invariant(classifyMailboxDatabase(dbPath) === "legacy", "source is not legacy");
	const startedAt = Date.now();
	const result = await migrateCommDbWithSwap(dbPath);
	const verified = verifyMigratedDatabase(dbPath);
	const currentIntent = inspectMailboxSwapIntent(intentPath);
	const archives = readdirSync(sandbox).filter((name) =>
		name.startsWith("comm.db.migration-swap-intent.json.stale-"),
	);
	invariant(result.status === "migrated", "stale intent did not remigrate");
	invariant(currentIntent?.v === 2, "fresh intent is not v2");
	invariant(currentIntent.phase === "done", "fresh intent did not reach done");
	invariant(archives.length === 1, "stale intent was not archived exactly once");
	invariant(
		oldBackupPath === undefined || sha256(oldBackupPath) === oldBackupHash,
		"old forensic backup changed",
	);
	console.log(
		JSON.stringify(
			{
				acceptance: "stale_done_self_heal",
				sourceDb,
				sandboxDb: dbPath,
				seconds: (Date.now() - startedAt) / 1000,
				result,
				verified,
				facts: mailboxFacts(dbPath),
				archive: archives[0],
				oldBackupUntouched: oldBackupPath !== undefined,
			},
			null,
			2,
		),
	);
}

async function rootIdempotencyAcceptance(
	sourceDb: string,
	sourceIntent: string,
	sandbox: string,
): Promise<void> {
	rmSync(sandbox, { recursive: true, force: true });
	const dbPath = join(sandbox, "comm.db");
	copyDbBundle(sourceDb, dbPath);
	const { intentPath } = rewriteIntent(sourceIntent, dbPath, false);
	invariant(classifyMailboxDatabase(dbPath) === "migrated", "root copy is not migrated");
	const mainBefore = sha256(dbPath);
	const factsBefore = mailboxFacts(dbPath);
	const libraryResult = await migrateCommDbWithSwap(dbPath);
	invariant(sha256(dbPath) === mainBefore, "library resume changed root main bytes");
	invariant(
		JSON.stringify(mailboxFacts(dbPath)) === JSON.stringify(factsBefore),
		"library resume changed root mailbox facts",
	);
	const command = spawnSync(
		"pnpm",
		[
			"exec",
			"tsx",
			"scripts/migrate-fly1572-mailbox.ts",
			"--confirm-quiesced",
			"--db",
			dbPath,
		],
		{
			cwd: repoRoot,
			encoding: "utf8",
			env: {
				...process.env,
				FLYWHEEL_COMM_DB: "",
			},
		},
	);
	invariant(command.status === 0, `root cutover skip failed: ${command.stderr}`);
	const inventory = JSON.parse(command.stdout) as {
		inventory: Array<{
			path: string;
			state: string;
			intent?: { phase: string };
		}>;
	};
	invariant(inventory.inventory.length === 1, "root skip inventory is not singular");
	invariant(inventory.inventory[0]?.state === "migrated", "root was not skipped");
	invariant(
		inventory.inventory[0]?.intent?.phase === "done",
		"root done intent was not visible",
	);
	invariant(
		inspectMailboxSwapIntent(intentPath)?.phase === "done",
		"root intent changed",
	);
	console.log(
		JSON.stringify(
			{
				acceptance: "migrated_root_done_intent_idempotency",
				sourceDb,
				sandboxDb: dbPath,
				libraryResult,
				cutoverInventory: inventory.inventory,
				facts: mailboxFacts(dbPath),
				mainBytesUnchangedByLibraryResume: true,
			},
			null,
			2,
		),
	);
}

function currentInventoryAcceptance(
	sourceHome: string,
	sandboxHome: string,
): void {
	rmSync(sandboxHome, { recursive: true, force: true });
	const shardNames = [
		"flywheel",
		"geoforge3d",
		"growth",
		"joycon-typeless",
		"personal-assistant",
		"sub",
		"test-slot-1",
		"tidal-echo",
	];
	const sources = [
		join(sourceHome, "comm.db"),
		...shardNames.map((name) => join(sourceHome, "comm", name, "comm.db")),
	];
	for (const sourceDb of sources) {
		invariant(existsSync(sourceDb), `missing source DB ${sourceDb}`);
		const relativePath = relative(sourceHome, sourceDb);
		const targetDb = join(sandboxHome, relativePath);
		copyDbBundle(sourceDb, targetDb);
		const sourceIntent = `${sourceDb}.migration-swap-intent.json`;
		if (existsSync(sourceIntent)) rewriteIntent(sourceIntent, targetDb, false);
	}
	const command = spawnSync(
		"pnpm",
		["exec", "tsx", "scripts/migrate-fly1572-mailbox.ts", "--inventory"],
		{
			cwd: repoRoot,
			encoding: "utf8",
			env: {
				...process.env,
				FLYWHEEL_HOME: sandboxHome,
				FLYWHEEL_COMM_DB: "",
			},
		},
	);
	invariant(command.status === 0, `inventory failed: ${command.stderr}`);
	const output = JSON.parse(command.stdout) as {
		inventory: Array<{
			path: string;
			state: string;
			intent?: { phase: string };
		}>;
	};
	invariant(output.inventory.length === sources.length, "inventory count mismatch");
	invariant(
		output.inventory.every((item) =>
			["legacy", "migrated"].includes(item.state),
		),
		"inventory contains mixed or unknown state",
	);
	for (const item of output.inventory) {
		const relativePath = relative(sandboxHome, item.path);
		if (relativePath === "comm.db") {
			invariant(item.state === "migrated", "root copy is not migrated");
			invariant(item.intent?.phase === "done", "root intent is not done");
		} else if (relativePath === join("comm", "flywheel", "comm.db")) {
			invariant(item.state === "legacy", "flywheel copy is not legacy");
			invariant(item.intent?.phase === "done", "flywheel intent is not done");
		} else {
			invariant(item.intent === undefined, `unexpected intent on ${relativePath}`);
		}
	}
	console.log(
		JSON.stringify(
			{
				acceptance: "current_copy_inventory",
				sourceCount: sources.length,
				inventory: output.inventory.map((item) => ({
					...item,
					path: relative(sandboxHome, item.path),
				})),
			},
			null,
			2,
		),
	);
}

const [mode, first, second, third] = process.argv.slice(2);
if (mode === "stale" && first && second && third) {
	await staleAcceptance(resolve(first), resolve(second), resolve(third));
} else if (mode === "root" && first && second && third) {
	await rootIdempotencyAcceptance(
		resolve(first),
		resolve(second),
		resolve(third),
	);
} else if (mode === "inventory" && first && second) {
	currentInventoryAcceptance(resolve(first), resolve(second));
} else {
	throw new Error(
		"usage: acceptance.mts stale|root <source-db> <source-intent> <sandbox> | inventory <source-home> <sandbox-home>",
	);
}

// Keep accidental source mutation obvious even when a future edit changes the
// harness: source files are only ever read/copied, never chmod'ed or opened.
if (first && existsSync(first) && statSync(first).isFile()) {
	invariant(resolve(first) !== resolve(third ?? second ?? ""), "source equals sandbox");
}
