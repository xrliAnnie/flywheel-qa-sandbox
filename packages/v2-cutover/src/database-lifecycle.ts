import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { initializeEngineDb } from "flywheel-v2-engine";
import {
	armCutoverAuthority,
	initializeRollbackFenceTx,
	Kernel,
	MIGRATION_MANIFEST,
	migrateDatabase,
	publishMigrationCompleteMarker,
	readCutoverAuthority,
	seedPreCutoverAuthority,
	validateExistingDatabase,
} from "flywheel-v2-kernel";
import type { CutoverTargetManifest } from "./manifest.js";

export type PromotionFaultPoint =
	| "after_checkpoint"
	| "after_rename"
	| "after_directory_fsync"
	| "after_marker";

function requireIso(value: string): void {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
		throw new TypeError("nowIso must be canonical UTC ISO-8601");
	}
}

function fsyncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function validateStaging(path: string, target: CutoverTargetManifest): void {
	const db = new Database(path, { readonly: true, fileMustExist: true });
	try {
		const migrations = db
			.prepare("SELECT id,checksum FROM schema_migrations ORDER BY rowid")
			.all();
		if (JSON.stringify(migrations) !== JSON.stringify(MIGRATION_MANIFEST)) {
			throw new Error("staging migration manifest mismatch");
		}
		const meta = new Map(
			(
				db
					.prepare(
						`SELECT key,value FROM meta
						  WHERE key IN (
						    'cutover_window_id',
						    'cutover_epoch',
						    'cutover_authority_state',
						    'rollback_state',
						    'external_effect_intent_count'
						  )`,
					)
					.all() as Array<{ key: string; value: string }>
			).map((row) => [row.key, row.value]),
		);
		if (
			meta.get("cutover_window_id") !== target.windowId ||
			meta.get("cutover_epoch") !== String(target.epoch) ||
			meta.get("cutover_authority_state") !== "cutover" ||
			meta.get("rollback_state") !== "clear" ||
			meta.get("external_effect_intent_count") !== "0"
		) {
			throw new Error("staging cutover metadata mismatch");
		}
		if (db.pragma("integrity_check", { simple: true }) !== "ok") {
			throw new Error("staging integrity_check failed");
		}
		if ((db.pragma("foreign_key_check") as unknown[]).length > 0) {
			throw new Error("staging foreign_key_check failed");
		}
	} finally {
		db.close();
	}
	if ((statSync(path).mode & 0o777) !== 0o600) {
		throw new Error("staging database must be mode 0600");
	}
}

function ensureCutoverAuthority(
	target: CutoverTargetManifest,
	nowIso: string,
): void {
	const authority = {
		authorityPath: target.database.authorityPath,
		armedPath: target.database.armedPath,
		windowId: target.windowId,
		epoch: target.epoch,
		nowIso,
	};
	if (!existsSync(target.database.authorityPath)) {
		seedPreCutoverAuthority(authority);
	}
	if (!existsSync(target.database.armedPath)) {
		armCutoverAuthority(authority);
	}
	const current = readCutoverAuthority({
		authorityPath: authority.authorityPath,
		armedPath: authority.armedPath,
		expectedWindowId: target.windowId,
		expectedEpoch: target.epoch,
	});
	if (current.mode !== "armed" || current.authority.state !== "cutover") {
		throw new Error("database preparation requires cutover authority");
	}
}

export function stagingDatabasePath(target: CutoverTargetManifest): string {
	return `${target.database.finalPath}.staging-${target.windowId}`;
}

export function prepareStagingDatabase(
	target: CutoverTargetManifest,
	options: { nowIso: string },
): {
	status: "prepared" | "already_prepared" | "already_promoted";
	path: string;
} {
	requireIso(options.nowIso);
	ensureCutoverAuthority(target, options.nowIso);
	if (
		existsSync(target.database.finalPath) &&
		existsSync(target.database.markerPath)
	) {
		validateExistingDatabase({
			dbPath: target.database.finalPath,
			markerPath: target.database.markerPath,
			authorityPath: target.database.authorityPath,
			armedPath: target.database.armedPath,
			expectedWindowId: target.windowId,
			expectedEpoch: target.epoch,
			allowedAuthorityStates: ["cutover"],
		});
		return {
			status: "already_promoted",
			path: target.database.finalPath,
		};
	}
	if (existsSync(target.database.finalPath)) {
		throw new Error(
			"final database exists without migration-complete marker; reconcile promotion",
		);
	}
	const stagingPath = stagingDatabasePath(target);
	if (existsSync(stagingPath)) {
		validateStaging(stagingPath, target);
		return { status: "already_prepared", path: stagingPath };
	}
	const parent = dirname(target.database.finalPath);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	chmodSync(parent, 0o700);
	migrateDatabase({ path: stagingPath });
	const kernel = Kernel.open({ path: stagingPath });
	try {
		initializeEngineDb(kernel);
		kernel.write("cutover.prepare-staging", (tx) => {
			initializeRollbackFenceTx(tx, {
				authorityState: "cutover",
				nowIso: options.nowIso,
			});
			tx.run(
				`INSERT INTO meta(key,value,updated_at)
				 VALUES ('cutover_window_id',@windowId,@nowIso),
				        ('cutover_epoch',@epoch,@nowIso),
				        ('cutover_intent','frozen',@nowIso)
				 ON CONFLICT(key) DO UPDATE SET
				   value=excluded.value,updated_at=excluded.updated_at`,
				{
					windowId: target.windowId,
					epoch: String(target.epoch),
					nowIso: options.nowIso,
				},
			);
		});
	} finally {
		kernel.close();
	}
	chmodSync(stagingPath, 0o600);
	const stagingFd = openSync(stagingPath, "r");
	try {
		fsyncSync(stagingFd);
	} finally {
		closeSync(stagingFd);
	}
	fsyncDirectory(parent);
	validateStaging(stagingPath, target);
	return { status: "prepared", path: stagingPath };
}

function cleanupDrainedSidecars(path: string): void {
	const wal = `${path}-wal`;
	if (existsSync(wal) && statSync(wal).size > 0) {
		throw new Error(`database WAL was not drained: ${wal}`);
	}
	for (const suffix of ["-wal", "-shm"]) {
		const sidecar = `${path}${suffix}`;
		if (existsSync(sidecar)) unlinkSync(sidecar);
	}
}

export function promoteStagingDatabase(
	target: CutoverTargetManifest,
	options: {
		nowIso: string;
		fault?(point: PromotionFaultPoint): void;
	},
): { status: "promoted" | "reconciled" | "already_promoted" } {
	requireIso(options.nowIso);
	const contract = {
		dbPath: target.database.finalPath,
		markerPath: target.database.markerPath,
		authorityPath: target.database.authorityPath,
		armedPath: target.database.armedPath,
		expectedWindowId: target.windowId,
		expectedEpoch: target.epoch,
		allowedAuthorityStates: ["cutover"] as const,
	};
	if (existsSync(target.database.markerPath)) {
		validateExistingDatabase(contract);
		return { status: "already_promoted" };
	}
	const stagingPath = stagingDatabasePath(target);
	if (existsSync(target.database.finalPath)) {
		if (existsSync(stagingPath)) {
			throw new Error(
				"both staging and final databases exist; refusing ambiguous promotion",
			);
		}
		publishMigrationCompleteMarker({
			...contract,
			nowIso: options.nowIso,
		});
		options.fault?.("after_marker");
		validateExistingDatabase(contract);
		return { status: "reconciled" };
	}
	if (!existsSync(stagingPath)) {
		throw new Error("staging database is missing");
	}
	validateStaging(stagingPath, target);
	const connection = new Database(stagingPath, {
		fileMustExist: true,
		timeout: 5_000,
	});
	try {
		const rows = connection.pragma("wal_checkpoint(TRUNCATE)") as Array<{
			busy: number;
			log: number;
			checkpointed: number;
		}>;
		const checkpoint = rows[0];
		if (
			!checkpoint ||
			checkpoint.busy !== 0 ||
			checkpoint.log !== checkpoint.checkpointed
		) {
			throw new Error(
				`WAL checkpoint did not drain: ${JSON.stringify(checkpoint)}`,
			);
		}
	} finally {
		connection.close();
	}
	cleanupDrainedSidecars(stagingPath);
	options.fault?.("after_checkpoint");
	const fileFd = openSync(stagingPath, "r");
	try {
		fsyncSync(fileFd);
	} finally {
		closeSync(fileFd);
	}
	renameSync(stagingPath, target.database.finalPath);
	options.fault?.("after_rename");
	fsyncDirectory(dirname(target.database.finalPath));
	options.fault?.("after_directory_fsync");
	publishMigrationCompleteMarker({
		...contract,
		nowIso: options.nowIso,
	});
	options.fault?.("after_marker");
	validateExistingDatabase(contract);
	cleanupDrainedSidecars(target.database.finalPath);
	return { status: "promoted" };
}
