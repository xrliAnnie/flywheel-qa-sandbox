import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { openKernelDb } from "./connection.js";
import type { CutoverAuthorityState } from "./cutover-authority.js";
import { readCutoverAuthority } from "./cutover-authority.js";
import { Kernel } from "./kernel.js";
import { MIGRATION_MANIFEST } from "./migrations/index.js";
import type { RollbackState } from "./rollback-fence.js";

interface MigrationMarker {
	v: 1;
	window_id: string;
	epoch: number;
	migration_manifest_digest: string;
	published_at: string;
}

export interface ExistingDatabaseOptions {
	dbPath: string;
	markerPath: string;
	authorityPath: string;
	armedPath: string;
	expectedWindowId: string;
	expectedEpoch: number;
	allowedAuthorityStates: readonly CutoverAuthorityState[];
	allowedRollbackStates?: readonly RollbackState[];
	busyTimeoutMs?: number;
	txBudgetMs?: number;
}

export interface ExistingDatabaseEvidence {
	windowId: string;
	epoch: number;
	authorityState: CutoverAuthorityState;
	authorityRevision: number;
	migrationCount: number;
	migrationManifestDigest: string;
}

export interface PublishMigrationMarkerOptions
	extends Omit<
		ExistingDatabaseOptions,
		"allowedAuthorityStates" | "txBudgetMs"
	> {
	nowIso: string;
}

interface MetaRow {
	key: string;
	value: string;
}

function failure(message: string): Error {
	return new Error(`v2 database contract failed: ${message}`);
}

function requireAbsolute(path: string, name: string): void {
	if (!isAbsolute(path))
		throw new TypeError(`${name} must be an absolute path`);
}

function requireCanonicalIso(value: string, name: string): void {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
		throw new TypeError(`${name} must be canonical UTC ISO-8601`);
	}
}

function exactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
): boolean {
	return (
		required.every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).every((key) => required.includes(key))
	);
}

function sha256(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export const MIGRATION_MANIFEST_DIGEST = sha256(
	JSON.stringify(MIGRATION_MANIFEST),
);

function validatePaths(options: {
	dbPath: string;
	markerPath: string;
	authorityPath: string;
	armedPath: string;
}): void {
	requireAbsolute(options.dbPath, "dbPath");
	requireAbsolute(options.markerPath, "markerPath");
	requireAbsolute(options.authorityPath, "authorityPath");
	requireAbsolute(options.armedPath, "armedPath");
	if (
		new Set([
			options.dbPath,
			options.markerPath,
			options.authorityPath,
			options.armedPath,
		]).size !== 4
	) {
		throw new TypeError("database contract paths must be distinct");
	}
}

function validatePermissions(
	path: string,
	expected: number,
	label: string,
): void {
	const mode = statSync(path).mode & 0o777;
	if (mode !== expected) {
		throw failure(
			`${label} must be ${expected.toString(8).padStart(4, "0")}; found ${mode.toString(8).padStart(4, "0")}`,
		);
	}
}

function validateDatabaseCore(options: {
	dbPath: string;
	expectedWindowId: string;
	expectedEpoch: number;
	allowedRollbackStates?: readonly RollbackState[];
	busyTimeoutMs?: number;
}): void {
	if (!existsSync(options.dbPath)) {
		throw failure(`database is missing: ${options.dbPath}`);
	}
	const stat = statSync(options.dbPath);
	if (!stat.isFile()) throw failure("database path is not a regular file");
	validatePermissions(options.dbPath, 0o600, "database");
	validatePermissions(dirname(options.dbPath), 0o700, "database directory");

	const db = openKernelDb({
		path: options.dbPath,
		readonly: true,
		busyTimeoutMs: options.busyTimeoutMs,
	});
	try {
		const applied = db
			.prepare("SELECT id,checksum FROM schema_migrations ORDER BY rowid")
			.all() as Array<{ id: string; checksum: string }>;
		if (JSON.stringify(applied) !== JSON.stringify(MIGRATION_MANIFEST)) {
			throw failure(
				`migration manifest mismatch: expected ${MIGRATION_MANIFEST.map((row) => row.id).join(",")}`,
			);
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
						   'external_effect_intent_count',
						   'rollback_state'
						 )`,
					)
					.all() as MetaRow[]
			).map((row) => [row.key, row.value]),
		);
		if (meta.get("cutover_window_id") !== options.expectedWindowId) {
			throw failure("database cutover window does not match authority");
		}
		if (meta.get("cutover_epoch") !== String(options.expectedEpoch)) {
			throw failure("database cutover epoch does not match authority");
		}
		const rollbackState = meta.get("rollback_state");
		const allowedRollbackStates = options.allowedRollbackStates ?? ["clear"];
		if (
			(meta.get("cutover_authority_state") !== "cutover" &&
				meta.get("cutover_authority_state") !== "live") ||
			!allowedRollbackStates.includes(rollbackState as RollbackState) ||
			!meta.get("external_effect_intent_count")?.match(/^(0|[1-9][0-9]*)$/)
		) {
			throw failure("database rollback fence is missing or malformed");
		}
	} finally {
		db.close();
	}
}

function parseMarker(path: string): MigrationMarker {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw failure(
			`migration marker is unreadable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		!exactKeys(parsed as Record<string, unknown>, [
			"v",
			"window_id",
			"epoch",
			"migration_manifest_digest",
			"published_at",
		])
	) {
		throw failure("migration marker is malformed");
	}
	const value = parsed as Record<string, unknown>;
	if (
		value.v !== 1 ||
		typeof value.window_id !== "string" ||
		typeof value.epoch !== "number" ||
		!Number.isSafeInteger(value.epoch) ||
		typeof value.migration_manifest_digest !== "string" ||
		typeof value.published_at !== "string"
	) {
		throw failure("migration marker is malformed");
	}
	try {
		requireCanonicalIso(value.published_at, "migration marker published_at");
	} catch (error) {
		throw failure(error instanceof Error ? error.message : String(error));
	}
	return value as unknown as MigrationMarker;
}

function validateMarker(
	path: string,
	expectedWindowId: string,
	expectedEpoch: number,
): void {
	if (!existsSync(path)) throw failure("migration marker is missing");
	validatePermissions(path, 0o600, "migration marker");
	const marker = parseMarker(path);
	if (marker.window_id !== expectedWindowId || marker.epoch !== expectedEpoch) {
		throw failure("migration marker window or epoch mismatch");
	}
	if (marker.migration_manifest_digest !== MIGRATION_MANIFEST_DIGEST) {
		throw failure("migration marker manifest digest mismatch");
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

function atomicWrite(path: string, bytes: Buffer): void {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	chmodSync(parent, 0o700);
	const tempPath = join(parent, `.${randomUUID()}.tmp`);
	const fd = openSync(tempPath, "wx", 0o600);
	try {
		writeFileSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tempPath, path);
	chmodSync(path, 0o600);
	fsyncDirectory(parent);
}

export function validateExistingDatabase(
	options: ExistingDatabaseOptions,
): ExistingDatabaseEvidence {
	validatePaths(options);
	if (options.allowedAuthorityStates.length === 0) {
		throw new TypeError("allowedAuthorityStates must not be empty");
	}
	if (options.allowedRollbackStates?.length === 0) {
		throw new TypeError("allowedRollbackStates must not be empty");
	}
	const authority = readCutoverAuthority({
		authorityPath: options.authorityPath,
		armedPath: options.armedPath,
		expectedWindowId: options.expectedWindowId,
		expectedEpoch: options.expectedEpoch,
	});
	if (authority.mode !== "armed") {
		throw failure("database cannot open before cutover authority is armed");
	}
	if (!options.allowedAuthorityStates.includes(authority.authority.state)) {
		throw failure(
			`authority state ${authority.authority.state} is not allowed`,
		);
	}
	validateDatabaseCore(options);
	validateMarker(
		options.markerPath,
		options.expectedWindowId,
		options.expectedEpoch,
	);
	return {
		windowId: options.expectedWindowId,
		epoch: options.expectedEpoch,
		authorityState: authority.authority.state,
		authorityRevision: authority.authority.revision,
		migrationCount: MIGRATION_MANIFEST.length,
		migrationManifestDigest: MIGRATION_MANIFEST_DIGEST,
	};
}

export function openExistingKernel(options: ExistingDatabaseOptions): Kernel {
	validateExistingDatabase(options);
	return Kernel.open({
		path: options.dbPath,
		busyTimeoutMs: options.busyTimeoutMs,
		txBudgetMs: options.txBudgetMs,
	});
}

export function publishMigrationCompleteMarker(
	options: PublishMigrationMarkerOptions,
): MigrationMarker {
	validatePaths(options);
	requireCanonicalIso(options.nowIso, "nowIso");
	const authority = readCutoverAuthority({
		authorityPath: options.authorityPath,
		armedPath: options.armedPath,
		expectedWindowId: options.expectedWindowId,
		expectedEpoch: options.expectedEpoch,
	});
	if (authority.mode !== "armed" || authority.authority.state !== "cutover") {
		throw failure("migration marker publication requires cutover authority");
	}
	validateDatabaseCore(options);
	const marker: MigrationMarker = {
		v: 1,
		window_id: options.expectedWindowId,
		epoch: options.expectedEpoch,
		migration_manifest_digest: MIGRATION_MANIFEST_DIGEST,
		published_at: options.nowIso,
	};
	const bytes = Buffer.from(`${JSON.stringify(marker)}\n`, "utf8");
	if (existsSync(options.markerPath)) {
		const existing = readFileSync(options.markerPath);
		if (!existing.equals(bytes)) {
			throw failure("existing migration marker conflicts with publication");
		}
		return marker;
	}
	atomicWrite(options.markerPath, bytes);
	return marker;
}
