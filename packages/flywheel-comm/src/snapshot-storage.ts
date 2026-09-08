import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statfsSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

export const DATA_VOLUME_PATH = "/System/Volumes/Data";
export const GB_BYTES = 1_000_000_000;
export const MANAGED_SNAPSHOT_LIMIT_BYTES = 2_000_000_000;

export type SnapshotOwner =
	| {
			kind: "workflow";
			executionId: string;
			runId: string;
			nodeId: string;
			attempt: number;
			activationId: string;
	  }
	| {
			kind: "session";
			executionId: string;
			sessionStartedAt: string;
	  }
	| {
			kind: "operator";
			executionId: string;
			uid: number;
			pid: number;
			processStartIdentity: string;
			createdAt: string;
			label: string;
	  };

export class SnapshotStorageError extends Error {
	constructor(
		public readonly reason: string,
		public readonly retryable = false,
	) {
		super(reason);
	}
}

function unavailableDataDisk(reason: string) {
	return {
		disk_avail_gb: null,
		disk: {
			volume: DATA_VOLUME_PATH,
			availBytes: null,
			observedAt: null,
			unavailable: [reason],
		},
	};
}

async function acquireSnapshotLock(
	stateRoot: string,
	timeoutMs: number,
): Promise<() => void> {
	const stateDir = join(stateRoot, "state");
	const lockPath = join(stateDir, "snapshot-storage.lock");
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			mkdirSync(lockPath, { mode: 0o700 });
			return () => rmSync(lockPath, { recursive: true });
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException)?.code !== "EEXIST" ||
				Date.now() >= deadline
			) {
				throw new SnapshotStorageError(
					(error as NodeJS.ErrnoException)?.code === "EEXIST"
						? "snapshot_lock_busy"
						: "snapshot_lock_failed",
					true,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
}

export function readDataDisk(
	deps: {
		platform?: NodeJS.Platform;
		statfs?: (
			path: string,
			options: { bigint: true },
		) => { bavail: bigint; bsize: bigint };
		now?: () => Date;
	} = {},
) {
	if ((deps.platform ?? process.platform) !== "darwin") {
		return unavailableDataDisk("structural: data_volume_unsupported");
	}
	let stat: { bavail: bigint; bsize: bigint };
	try {
		stat = (deps.statfs ?? statfsSync)(DATA_VOLUME_PATH, { bigint: true });
	} catch (error) {
		return unavailableDataDisk(
			(error as NodeJS.ErrnoException)?.code === "ENOENT"
				? "structural: data_volume_missing"
				: "transient: data_volume_unreadable",
		);
	}
	const availBytesBigInt = stat.bavail * stat.bsize;
	if (
		stat.bavail < 0n ||
		stat.bsize <= 0n ||
		availBytesBigInt > BigInt(Number.MAX_SAFE_INTEGER)
	) {
		return unavailableDataDisk("transient: data_volume_invalid");
	}
	const availBytes = Number(availBytesBigInt);
	return {
		disk_avail_gb: availBytes / GB_BYTES,
		disk: {
			volume: DATA_VOLUME_PATH,
			availBytes,
			observedAt: (deps.now ?? (() => new Date()))().toISOString(),
		},
	};
}

function openReservedSource(path: string): {
	db: Database.Database;
	pageSize: number;
	reservation: number;
} {
	let sourceStat: ReturnType<typeof lstatSync>;
	try {
		sourceStat = lstatSync(path);
	} catch {
		throw new SnapshotStorageError("invalid_source");
	}
	if (!sourceStat.isFile() || sourceStat.nlink !== 1) {
		throw new SnapshotStorageError("invalid_source");
	}
	let db: Database.Database;
	try {
		db = new Database(path, { readonly: true, fileMustExist: true });
		db.exec("BEGIN");
	} catch {
		throw new SnapshotStorageError("invalid_source");
	}
	try {
		const pageSize = Number(db.pragma("page_size", { simple: true }));
		const pageCount = Number(db.pragma("page_count", { simple: true }));
		const reservation = Math.max(sourceStat.size, pageCount * pageSize);
		if (
			!Number.isSafeInteger(pageSize) ||
			pageSize <= 0 ||
			!Number.isSafeInteger(reservation) ||
			reservation <= 0
		) {
			throw new SnapshotStorageError("invalid_source_reservation");
		}
		return { db, pageSize, reservation };
	} catch (error) {
		if (db.inTransaction) db.exec("ROLLBACK");
		db.close();
		throw error;
	}
}

function closeReservedSource(source: Database.Database): void {
	if (source.inTransaction) source.exec("ROLLBACK");
	source.close();
}

function assertDataDisk(
	reservation: number,
	readDisk: typeof readDataDisk,
): void {
	const availBytes = readDisk().disk.availBytes;
	if (availBytes === null || availBytes < reservation * 5) {
		throw new SnapshotStorageError(
			availBytes === null
				? "data_volume_unavailable"
				: "insufficient_data_volume",
		);
	}
}

async function writeVerifiedSnapshot(
	source: Database.Database,
	pageSize: number,
	reservation: number,
	destination: string,
): Promise<number> {
	const startedAt = Date.now();
	await source.backup(destination, {
		progress: ({ totalPages }) => {
			if (totalPages * pageSize > reservation) {
				throw new SnapshotStorageError("source_grew_beyond_reservation", true);
			}
			if (Date.now() - startedAt > 60_000) {
				throw new SnapshotStorageError("snapshot_timeout", true);
			}
			return 100;
		},
	});
	chmodSync(destination, 0o600);
	const verified = new Database(destination, {
		readonly: true,
		fileMustExist: true,
	});
	try {
		if (verified.pragma("quick_check", { simple: true }) !== "ok") {
			throw new SnapshotStorageError("snapshot_integrity_failed");
		}
	} finally {
		verified.close();
	}
	const bytes = statSync(destination).size;
	if (bytes > reservation) {
		throw new SnapshotStorageError("snapshot_exceeded_reservation", true);
	}
	return bytes;
}

function validateOwner(owner: SnapshotOwner): void {
	const safe = (value: string) =>
		/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(value);
	if (!safe(owner.executionId)) {
		throw new SnapshotStorageError("invalid_snapshot_owner");
	}
	if (owner.kind === "workflow") {
		if (
			![owner.runId, owner.nodeId, owner.activationId].every(safe) ||
			!Number.isSafeInteger(owner.attempt) ||
			owner.attempt < 1
		) {
			throw new SnapshotStorageError("invalid_snapshot_owner");
		}
	} else if (owner.kind === "session") {
		if (!Number.isFinite(Date.parse(owner.sessionStartedAt))) {
			throw new SnapshotStorageError("invalid_snapshot_owner");
		}
	} else if (
		!Number.isSafeInteger(owner.uid) ||
		!Number.isSafeInteger(owner.pid) ||
		owner.pid < 1 ||
		!safe(owner.processStartIdentity) ||
		!Number.isFinite(Date.parse(owner.createdAt)) ||
		!safe(owner.label)
	) {
		throw new SnapshotStorageError("invalid_snapshot_owner");
	}
}

function canonicalRecord(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return JSON.stringify(
		Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
	);
}

function readOwnerFile(path: string): SnapshotOwner {
	const stat = lstatSync(path);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.nlink !== 1 ||
		(stat.mode & 0o777) !== 0o600
	) {
		throw new SnapshotStorageError("managed_snapshot_owner_unsafe");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new SnapshotStorageError("managed_snapshot_owner_invalid");
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		(parsed as { version?: unknown }).version !== 1
	) {
		throw new SnapshotStorageError("managed_snapshot_owner_invalid");
	}
	const { version: _, ...owner } = parsed as Record<string, unknown>;
	try {
		validateOwner(owner as SnapshotOwner);
	} catch {
		throw new SnapshotStorageError("managed_snapshot_owner_invalid");
	}
	return owner as SnapshotOwner;
}

export function readManagedSnapshotOwner(
	executionId: string,
	deps: { managedRoot?: string } = {},
): SnapshotOwner | undefined {
	if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(executionId)) {
		throw new SnapshotStorageError("invalid_snapshot_owner");
	}
	const managedRoot = resolve(
		deps.managedRoot ?? join(realpathSync("/tmp"), "flywheel-snapshots"),
	);
	if (!existsSync(managedRoot)) return undefined;
	const rootStat = lstatSync(managedRoot);
	if (
		!rootStat.isDirectory() ||
		rootStat.isSymbolicLink() ||
		rootStat.uid !== process.geteuid?.() ||
		(rootStat.mode & 0o777) !== 0o700
	) {
		throw new SnapshotStorageError("managed_snapshot_root_unsafe");
	}
	const executionDir = join(managedRoot, executionId);
	if (!existsSync(executionDir)) return undefined;
	const executionStat = lstatSync(executionDir);
	if (
		!executionStat.isDirectory() ||
		executionStat.isSymbolicLink() ||
		executionStat.uid !== rootStat.uid ||
		(executionStat.mode & 0o777) !== 0o700
	) {
		throw new SnapshotStorageError("managed_snapshot_owner_directory_unsafe");
	}
	const owner = readOwnerFile(join(executionDir, ".owner.json"));
	if (owner.executionId !== executionId) {
		throw new SnapshotStorageError("managed_snapshot_owner_mismatch");
	}
	return owner;
}

function readDirectoryBytes(path: string): number {
	let total = 0;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		const stat = lstatSync(child);
		if (stat.isSymbolicLink()) {
			throw new SnapshotStorageError("managed_snapshot_symlink");
		}
		if (stat.isDirectory()) total += readDirectoryBytes(child);
		else if (stat.isFile()) total += stat.size;
		else throw new SnapshotStorageError("managed_snapshot_unknown_entry");
		if (!Number.isSafeInteger(total)) {
			throw new SnapshotStorageError("managed_snapshot_size_invalid");
		}
	}
	return total;
}

export function inspectManagedSnapshotDirectories(
	deps: { managedRoot?: string } = {},
): Array<{ owner: SnapshotOwner; bytes: number }> {
	const managedRoot = resolve(
		deps.managedRoot ?? join(realpathSync("/tmp"), "flywheel-snapshots"),
	);
	if (!existsSync(managedRoot)) return [];
	const rootStat = lstatSync(managedRoot);
	if (
		!rootStat.isDirectory() ||
		rootStat.isSymbolicLink() ||
		rootStat.uid !== process.geteuid?.() ||
		(rootStat.mode & 0o777) !== 0o700
	) {
		throw new SnapshotStorageError("managed_snapshot_root_unsafe");
	}
	return readdirSync(managedRoot, { withFileTypes: true })
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((entry) => {
			if (!entry.isDirectory() || entry.isSymbolicLink()) {
				throw new SnapshotStorageError("managed_snapshot_unknown_entry");
			}
			const owner = readManagedSnapshotOwner(entry.name, { managedRoot });
			if (!owner) {
				throw new SnapshotStorageError("managed_snapshot_owner_invalid");
			}
			return {
				owner,
				bytes: readDirectoryBytes(join(managedRoot, entry.name)),
			};
		});
}

function normalizeProject(
	databaseKind: "teamlead" | "comm",
	project: string | undefined,
): string {
	const normalized = databaseKind === "teamlead" ? "global" : project;
	if (
		(databaseKind === "teamlead" && project !== undefined) ||
		normalized === undefined ||
		!/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/.test(normalized)
	) {
		throw new SnapshotStorageError("invalid_database_project");
	}
	return normalized;
}

export async function createRepairSnapshot(
	input: {
		source: string;
		issueIdentifier: string;
		databaseKind: "teamlead" | "comm";
		project?: string;
	},
	deps: {
		stateRoot?: string;
		readDataDisk?: typeof readDataDisk;
		now?: () => Date;
		uuid?: () => string;
		lockTimeoutMs?: number;
	} = {},
) {
	if (!/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(input.issueIdentifier)) {
		throw new SnapshotStorageError("invalid_issue_identifier");
	}
	const project = normalizeProject(input.databaseKind, input.project);
	const source = openReservedSource(input.source);
	let partialDir: string | undefined;
	let releaseLock: (() => void) | undefined;
	try {
		const stateRoot = deps.stateRoot ?? join(homedir(), ".flywheel");
		releaseLock = await acquireSnapshotLock(
			stateRoot,
			deps.lockTimeoutMs ?? 5_000,
		);
		assertDataDisk(source.reservation, deps.readDataDisk ?? readDataDisk);
		const repairRoot = join(stateRoot, "patrol-repairs");
		const uuid = (deps.uuid ?? randomUUID)();
		partialDir = join(repairRoot, ".partial", uuid);
		mkdirSync(partialDir, { recursive: true, mode: 0o700 });
		const partialPath = join(partialDir, "snapshot.db");
		const bytes = await writeVerifiedSnapshot(
			source.db,
			source.pageSize,
			source.reservation,
			partialPath,
		);
		const createdAt = (deps.now ?? (() => new Date()))().toISOString();
		const group = `${input.databaseKind}-${project}`;
		const finalPath = join(
			repairRoot,
			`${input.issueIdentifier}__${group}__${createdAt}__${uuid}.db`,
		);
		linkSync(partialPath, finalPath);
		unlinkSync(partialPath);
		rmSync(partialDir, { recursive: true, force: true });
		partialDir = undefined;
		return {
			path: finalPath,
			bytes,
			createdAt,
			group: {
				issueIdentifier: input.issueIdentifier,
				databaseKind: input.databaseKind,
				project,
			},
		};
	} finally {
		if (partialDir !== undefined) {
			rmSync(partialDir, { recursive: true, force: true });
		}
		closeReservedSource(source.db);
		releaseLock?.();
	}
}

export async function createManagedSnapshot(
	input: {
		source: string;
		owner: SnapshotOwner;
		databaseKind: "teamlead" | "comm";
		project?: string;
	},
	deps: {
		stateRoot?: string;
		managedRoot?: string;
		readDataDisk?: typeof readDataDisk;
		uuid?: () => string;
		lockTimeoutMs?: number;
	} = {},
) {
	validateOwner(input.owner);
	const project = normalizeProject(input.databaseKind, input.project);
	const source = openReservedSource(input.source);
	const stateRoot = deps.stateRoot ?? join(homedir(), ".flywheel");
	const managedRoot = resolve(
		deps.managedRoot ?? join(realpathSync("/tmp"), "flywheel-snapshots"),
	);
	let releaseLock: (() => void) | undefined;
	let executionDir: string | undefined;
	let partialPath: string | undefined;
	let createdExecutionDir = false;
	try {
		releaseLock = await acquireSnapshotLock(
			stateRoot,
			deps.lockTimeoutMs ?? 5_000,
		);
		assertDataDisk(source.reservation, deps.readDataDisk ?? readDataDisk);
		mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
		const rootStat = lstatSync(managedRoot);
		if (
			!rootStat.isDirectory() ||
			rootStat.isSymbolicLink() ||
			rootStat.uid !== process.geteuid?.() ||
			(rootStat.mode & 0o777) !== 0o700
		) {
			throw new SnapshotStorageError("managed_snapshot_root_unsafe");
		}
		executionDir = join(managedRoot, input.owner.executionId);
		if (!existsSync(executionDir)) {
			mkdirSync(executionDir, { mode: 0o700 });
			createdExecutionDir = true;
		}
		const executionStat = lstatSync(executionDir);
		if (
			!executionStat.isDirectory() ||
			executionStat.isSymbolicLink() ||
			executionStat.uid !== rootStat.uid ||
			(executionStat.mode & 0o777) !== 0o700
		) {
			throw new SnapshotStorageError("managed_snapshot_owner_directory_unsafe");
		}
		const ownerPath = join(executionDir, ".owner.json");
		const ownerRecord = { version: 1 as const, ...input.owner };
		const ownerJson = `${JSON.stringify(ownerRecord)}\n`;
		if (existsSync(ownerPath)) {
			const existing = readOwnerFile(ownerPath);
			if (canonicalRecord(existing) !== canonicalRecord(input.owner)) {
				throw new SnapshotStorageError("managed_snapshot_owner_mismatch");
			}
		}
		const existingBytes = readDirectoryBytes(executionDir);
		const ownerBytes = existsSync(ownerPath) ? 0 : Buffer.byteLength(ownerJson);
		if (
			existingBytes + ownerBytes + source.reservation >
			MANAGED_SNAPSHOT_LIMIT_BYTES
		) {
			throw new SnapshotStorageError("managed_snapshot_budget_exceeded");
		}
		if (!existsSync(ownerPath)) {
			writeFileSync(ownerPath, ownerJson, { flag: "wx", mode: 0o600 });
		}
		const uuid = (deps.uuid ?? randomUUID)();
		partialPath = join(executionDir, `.partial-${uuid}.db`);
		const bytes = await writeVerifiedSnapshot(
			source.db,
			source.pageSize,
			source.reservation,
			partialPath,
		);
		const finalPath = join(executionDir, `${input.databaseKind}-${uuid}.db`);
		linkSync(partialPath, finalPath);
		unlinkSync(partialPath);
		partialPath = undefined;
		return { path: finalPath, bytes, owner: input.owner, project };
	} finally {
		if (partialPath !== undefined) rmSync(partialPath, { force: true });
		if (createdExecutionDir && executionDir !== undefined) {
			const entries = existsSync(executionDir) ? readdirSync(executionDir) : [];
			if (entries.length === 1 && entries[0] === ".owner.json") {
				rmSync(executionDir, { recursive: true });
			}
		}
		closeReservedSource(source.db);
		releaseLock?.();
	}
}

export async function cleanupRunnerSnapshots(
	input: {
		executionId: string;
		expectedOwner: SnapshotOwner;
		authorize: (owner: SnapshotOwner) => boolean | Promise<boolean>;
	},
	deps: {
		stateRoot?: string;
		managedRoot?: string;
		lockTimeoutMs?: number;
	} = {},
) {
	validateOwner(input.expectedOwner);
	if (input.executionId !== input.expectedOwner.executionId) {
		throw new SnapshotStorageError("managed_snapshot_owner_mismatch");
	}
	const managedRoot = resolve(
		deps.managedRoot ?? join(realpathSync("/tmp"), "flywheel-snapshots"),
	);
	if (!existsSync(managedRoot)) {
		return { status: "already_absent" as const, bytesReleased: 0 };
	}
	const rootStat = lstatSync(managedRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new SnapshotStorageError("managed_snapshot_root_unsafe");
	}
	const stateRoot = deps.stateRoot ?? join(homedir(), ".flywheel");
	const releaseLock = await acquireSnapshotLock(
		stateRoot,
		deps.lockTimeoutMs ?? 5_000,
	);
	try {
		const executionDir = join(managedRoot, input.executionId);
		if (!existsSync(executionDir)) {
			return { status: "already_absent" as const, bytesReleased: 0 };
		}
		const executionStat = lstatSync(executionDir);
		if (!executionStat.isDirectory() || executionStat.isSymbolicLink()) {
			throw new SnapshotStorageError("managed_snapshot_owner_directory_unsafe");
		}
		const ownerPath = join(executionDir, ".owner.json");
		if (!existsSync(ownerPath)) {
			return { status: "owner_missing" as const, bytesReleased: 0 };
		}
		const owner = readOwnerFile(ownerPath);
		if (canonicalRecord(owner) !== canonicalRecord(input.expectedOwner)) {
			return { status: "owner_mismatch" as const, bytesReleased: 0 };
		}
		let authorized: boolean;
		try {
			authorized = await input.authorize(owner);
		} catch {
			throw new SnapshotStorageError("snapshot_authorization_failed", true);
		}
		if (!authorized) {
			return { status: "not_authorized" as const, bytesReleased: 0 };
		}
		if (canonicalRecord(readOwnerFile(ownerPath)) !== canonicalRecord(owner)) {
			return { status: "owner_changed" as const, bytesReleased: 0 };
		}
		const bytesReleased = readDirectoryBytes(executionDir);
		const freshRoot = lstatSync(managedRoot);
		if (freshRoot.dev !== rootStat.dev || freshRoot.ino !== rootStat.ino) {
			throw new SnapshotStorageError("managed_snapshot_root_changed", true);
		}
		rmSync(executionDir, { recursive: true });
		return { status: "deleted" as const, bytesReleased };
	} finally {
		releaseLock();
	}
}

function currentProcessStartIdentity(pid: number): string {
	const observed = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
		encoding: "utf8",
		env: { ...process.env, LC_ALL: "C" },
	}).trim();
	if (!observed) {
		throw new SnapshotStorageError("operator_process_identity_unavailable");
	}
	return createHash("sha256").update(observed).digest("hex");
}

export function isOperatorSnapshotOwnerDead(
	owner: Extract<SnapshotOwner, { kind: "operator" }>,
	deps: {
		uid?: number;
		signalProcess?: (pid: number) => void;
		processStartIdentity?: (pid: number) => string;
	} = {},
): boolean {
	if ((deps.uid ?? process.geteuid?.()) !== owner.uid) return false;
	try {
		(deps.signalProcess ?? ((pid) => process.kill(pid, 0)))(owner.pid);
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "ESRCH";
	}
	try {
		return (
			(deps.processStartIdentity ?? currentProcessStartIdentity)(owner.pid) !==
			owner.processStartIdentity
		);
	} catch {
		return false;
	}
}

export async function withOperatorSnapshots<T>(
	input: { label: string },
	use: (context: {
		owner: Extract<SnapshotOwner, { kind: "operator" }>;
		createSnapshot: (snapshot: {
			source: string;
			databaseKind: "teamlead" | "comm";
			project?: string;
		}) => ReturnType<typeof createManagedSnapshot>;
	}) => T | Promise<T>,
	deps: {
		stateRoot?: string;
		managedRoot?: string;
		readDataDisk?: typeof readDataDisk;
		uuid?: () => string;
		lockTimeoutMs?: number;
		uid?: number;
		pid?: number;
		processStartIdentity?: (pid: number) => string;
		now?: () => Date;
	} = {},
): Promise<T> {
	const uid = deps.uid ?? process.geteuid?.();
	const pid = deps.pid ?? process.pid;
	if (uid === undefined) {
		throw new SnapshotStorageError("operator_uid_unavailable");
	}
	const owner: Extract<SnapshotOwner, { kind: "operator" }> = {
		kind: "operator",
		executionId: `operator-${(deps.uuid ?? randomUUID)()}`,
		uid,
		pid,
		processStartIdentity: (
			deps.processStartIdentity ?? currentProcessStartIdentity
		)(pid),
		createdAt: (deps.now ?? (() => new Date()))().toISOString(),
		label: input.label,
	};
	validateOwner(owner);
	try {
		return await use({
			owner,
			createSnapshot: (snapshot) =>
				createManagedSnapshot(
					{ ...snapshot, owner },
					{
						stateRoot: deps.stateRoot,
						managedRoot: deps.managedRoot,
						readDataDisk: deps.readDataDisk,
						uuid: deps.uuid,
						lockTimeoutMs: deps.lockTimeoutMs,
					},
				),
		});
	} finally {
		await cleanupRunnerSnapshots(
			{
				executionId: owner.executionId,
				expectedOwner: owner,
				authorize: (freshOwner) =>
					canonicalRecord(freshOwner) === canonicalRecord(owner),
			},
			{
				stateRoot: deps.stateRoot,
				managedRoot: deps.managedRoot,
				lockTimeoutMs: deps.lockTimeoutMs,
			},
		);
	}
}

const REPAIR_NAME =
	/^([A-Z][A-Z0-9]*-[1-9][0-9]*)__((?:teamlead-global)|(?:comm-[A-Za-z0-9][A-Za-z0-9.-]{0,63}))__(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)__([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.db$/;

function readLegacyRepairMap(repairRoot: string): Map<
	string,
	{
		group: string;
		createdAt: number;
		size: number;
		mtimeNs: string;
		device: string;
		inode: string;
	}
> {
	const result = new Map();
	const path = join(repairRoot, "legacy-map.json");
	if (!existsSync(path)) return result;
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
		return result;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return result;
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		(parsed as { version?: unknown }).version !== 1 ||
		!Array.isArray((parsed as { entries?: unknown }).entries)
	) {
		return result;
	}
	for (const raw of (parsed as { entries: unknown[] }).entries) {
		try {
			if (typeof raw !== "object" || raw === null) continue;
			const entry = raw as Record<string, unknown>;
			if (
				typeof entry.basename !== "string" ||
				!entry.basename.endsWith(".db") ||
				entry.basename !== entry.basename.split("/").at(-1) ||
				typeof entry.issueIdentifier !== "string" ||
				!/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(entry.issueIdentifier) ||
				(entry.databaseKind !== "teamlead" && entry.databaseKind !== "comm") ||
				typeof entry.project !== "string" ||
				typeof entry.size !== "number" ||
				!Number.isSafeInteger(entry.size) ||
				entry.size < 0 ||
				typeof entry.mtimeNs !== "string" ||
				!/^[0-9]+$/.test(entry.mtimeNs) ||
				typeof entry.device !== "string" ||
				!/^[0-9]+$/.test(entry.device) ||
				typeof entry.inode !== "string" ||
				!/^[0-9]+$/.test(entry.inode) ||
				typeof entry.createdAt !== "string" ||
				!Number.isFinite(Date.parse(entry.createdAt)) ||
				typeof entry.provenance !== "string" ||
				entry.provenance.trim() === ""
			) {
				continue;
			}
			if (entry.databaseKind === "teamlead" && entry.project !== "global") {
				continue;
			}
			const project =
				entry.databaseKind === "teamlead"
					? "global"
					: normalizeProject("comm", entry.project);
			result.set(entry.basename, {
				group: `${entry.issueIdentifier}__${entry.databaseKind}-${project}`,
				createdAt: Date.parse(entry.createdAt),
				size: entry.size,
				mtimeNs: entry.mtimeNs,
				device: entry.device,
				inode: entry.inode,
			});
		} catch {
			// Invalid entries remain visible as unmapped and are never deleted.
		}
	}
	return result;
}

export async function pruneRepairSnapshots(
	input: { dryRun: boolean; now: Date },
	deps: { stateRoot?: string; lockTimeoutMs?: number } = {},
) {
	if (!Number.isFinite(input.now.getTime())) {
		throw new SnapshotStorageError("invalid_prune_time");
	}
	const stateRoot = deps.stateRoot ?? join(homedir(), ".flywheel");
	const repairRoot = join(stateRoot, "patrol-repairs");
	const releaseLock = await acquireSnapshotLock(
		stateRoot,
		deps.lockTimeoutMs ?? 5_000,
	);
	try {
		if (!existsSync(repairRoot)) {
			return {
				mode: input.dryRun ? "dry-run" : "apply",
				items: [],
				candidate_count: 0,
				candidate_bytes: 0,
				patrol_repairs_total_bytes: 0,
				retained_group_count: 0,
				unmapped_bytes: 0,
			};
		}
		const rootStat = lstatSync(repairRoot);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
			throw new SnapshotStorageError("repair_snapshot_root_unsafe");
		}
		const candidates: Array<{
			path: string;
			group: string;
			createdAt: number;
			bytes: number;
			stat: NonNullable<ReturnType<typeof lstatSync>>;
		}> = [];
		const items: Array<{
			path: string;
			group: string | null;
			bytes: number;
			action: "keep" | "delete" | "skip";
			reason: string;
		}> = [];
		let totalBytes = 0;
		let unmappedBytes = 0;
		const legacyMap = readLegacyRepairMap(repairRoot);
		for (const entry of readdirSync(repairRoot, { withFileTypes: true })) {
			if (!entry.name.endsWith(".db")) continue;
			const path = join(repairRoot, entry.name);
			const stat = lstatSync(path);
			totalBytes += stat.size;
			const match = REPAIR_NAME.exec(entry.name);
			const mapped = match === null ? legacyMap.get(entry.name) : undefined;
			const createdAt = match
				? Date.parse(match[3]!)
				: (mapped?.createdAt ?? Number.NaN);
			const bigStat = mapped ? statSync(path, { bigint: true }) : undefined;
			const mappedIdentityMatches =
				mapped !== undefined &&
				mapped.size === stat.size &&
				mapped.mtimeNs === bigStat?.mtimeNs.toString() &&
				mapped.device === bigStat?.dev.toString() &&
				mapped.inode === bigStat?.ino.toString();
			if (
				!entry.isFile() ||
				stat.isSymbolicLink() ||
				stat.nlink !== 1 ||
				(match === null && !mappedIdentityMatches) ||
				!Number.isFinite(createdAt)
			) {
				unmappedBytes += stat.size;
				items.push({
					path: entry.name,
					group: null,
					bytes: stat.size,
					action: "skip",
					reason: "unmapped",
				});
				continue;
			}
			candidates.push({
				path: entry.name,
				group: match ? `${match[1]}__${match[2]}` : mapped!.group,
				createdAt,
				bytes: stat.size,
				stat,
			});
		}
		const latest = new Map<string, (typeof candidates)[number]>();
		for (const candidate of candidates) {
			const current = latest.get(candidate.group);
			if (
				current === undefined ||
				candidate.createdAt > current.createdAt ||
				(candidate.createdAt === current.createdAt &&
					candidate.path > current.path)
			) {
				latest.set(candidate.group, candidate);
			}
		}
		const cutoff = input.now.getTime() - 24 * 60 * 60 * 1_000;
		for (const candidate of candidates) {
			let reason: string;
			let action: "keep" | "delete";
			if (candidate.createdAt > input.now.getTime()) {
				action = "keep";
				reason = "clock_skew";
			} else if (candidate.createdAt >= cutoff) {
				action = "keep";
				reason = "within_24h";
			} else if (latest.get(candidate.group) === candidate) {
				action = "keep";
				reason = "latest_in_group";
			} else {
				action = "delete";
				reason = "expired";
				if (!input.dryRun) {
					const path = join(repairRoot, candidate.path);
					const fresh = lstatSync(path);
					if (
						fresh.dev !== candidate.stat.dev ||
						fresh.ino !== candidate.stat.ino ||
						fresh.size !== candidate.stat.size ||
						fresh.mtimeMs !== candidate.stat.mtimeMs
					) {
						action = "keep";
						reason = "changed_since_scan";
					} else {
						unlinkSync(path);
					}
				}
			}
			items.push({
				path: candidate.path,
				group: candidate.group,
				bytes: candidate.bytes,
				action,
				reason,
			});
		}
		return {
			mode: input.dryRun ? "dry-run" : "apply",
			items,
			candidate_count: candidates.length,
			candidate_bytes: candidates.reduce(
				(sum, candidate) => sum + candidate.bytes,
				0,
			),
			patrol_repairs_total_bytes: totalBytes,
			retained_group_count: latest.size,
			unmapped_bytes: unmappedBytes,
		};
	} finally {
		releaseLock();
	}
}
