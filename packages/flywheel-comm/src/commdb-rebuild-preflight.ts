import {
	closeSync,
	fsyncSync,
	openSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { canonicalJsonString } from "flywheel-config";
import {
	CommDbPreflightStaleError,
	commDbSourceBinding,
	FLY2268_REBUILD_RECEIPT_SUFFIX,
	type Fly2268CommDbRebuildReceipt,
	hasLegacyRunnerShutdownPrimaryKey,
	runnerShutdownSchemaDigest,
	sha256File,
} from "./commdb-open-gate.js";
import { backupCommDb } from "./mailbox-migration.js";

function sameBinding(
	left: Fly2268CommDbRebuildReceipt["sourceBinding"],
	right: Fly2268CommDbRebuildReceipt["sourceBinding"],
): boolean {
	return (
		left.mainSha256 === right.mainSha256 && left.walSha256 === right.walSha256
	);
}

function verifyBackup(path: string): void {
	const db = new Database(path, { readonly: true, fileMustExist: true });
	try {
		if (String(db.pragma("quick_check", { simple: true })) !== "ok") {
			throw new Error(
				"commdb_schema_preflight_required: backup quick_check failed",
			);
		}
	} finally {
		db.close();
	}
}

function durableWrite(path: string, content: string): void {
	const tempPath = `${path}.tmp-${process.pid}`;
	writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx" });
	const file = openSync(tempPath, "r");
	try {
		fsyncSync(file);
	} finally {
		closeSync(file);
	}
	renameSync(tempPath, path);
	const directory = openSync(dirname(path), "r");
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}

export async function prepareFly2268CommDbRebuild(
	dbPath: string,
): Promise<Fly2268CommDbRebuildReceipt | null> {
	if (!hasLegacyRunnerShutdownPrimaryKey(dbPath)) return null;
	const receiptPath = `${dbPath}${FLY2268_REBUILD_RECEIPT_SUFFIX}`;
	let lastMismatch = "";
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const before = commDbSourceBinding(dbPath);
		const sourceSchemaDigest = runnerShutdownSchemaDigest(dbPath);
		const createdAt = new Date().toISOString();
		const backupPath = `${dbPath}.pre-fly2268-${createdAt.replaceAll(":", "-")}-${attempt}.bak`;
		try {
			await backupCommDb(dbPath, backupPath);
			verifyBackup(backupPath);
			const after = commDbSourceBinding(dbPath);
			if (!sameBinding(before, after)) {
				lastMismatch = "source changed while backup was taken";
				rmSync(backupPath, { force: true });
				rmSync(`${backupPath}.refs-manifest.json`, { force: true });
				continue;
			}
			const receipt: Fly2268CommDbRebuildReceipt = {
				backupPath,
				backupSha256: sha256File(backupPath),
				sourceBinding: before,
				sourceSchemaDigest,
				createdAt,
			};
			durableWrite(receiptPath, `${canonicalJsonString(receipt)}\n`);
			return receipt;
		} catch (error) {
			rmSync(backupPath, { force: true });
			rmSync(`${backupPath}.refs-manifest.json`, { force: true });
			throw error;
		}
	}
	throw new CommDbPreflightStaleError(
		lastMismatch || "source did not stabilize",
	);
}
