import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const TOMBSTONE_FILE = ".flywheel-v2-tombstone.json";
const RESTORE_TOMBSTONE_SUFFIX = ".flywheel-v2-restore-tombstone";

export interface LegacyArchiveReceipt {
	sourcePath: string;
	archivePath: string;
	kind: "file" | "directory";
	sourceDigest: string;
	tombstonePath: string;
	sourceModes: Record<string, number>;
	parentMode: number;
}

interface LegacyTombstoneMarker {
	v: 1;
	reason: "flywheel-v2-cutover";
	source_path: string;
	archive_path: string;
	kind: "file" | "directory";
	source_digest: string;
	source_modes: Record<string, number>;
	parent_mode: number;
}

export interface LiveFireCommand {
	name: string;
	argv: string[];
	env?: Record<string, string>;
}

export interface LiveFireResult {
	name: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
}

function requireAbsolute(path: string, name: string): string {
	if (!isAbsolute(path)) throw new TypeError(`${name} must be absolute`);
	return resolve(path);
}

function fsyncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function hashFile(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function treeDigest(path: string): string {
	if (!existsSync(path)) return "missing";
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) {
		throw new Error(`legacy archive refuses symbolic link ${path}`);
	}
	if (stat.isFile()) return `f:${hashFile(path)}`;
	if (!stat.isDirectory()) {
		throw new Error(`legacy archive refuses special file ${path}`);
	}
	const rows: string[] = [];
	const walk = (root: string, prefix: string): void => {
		for (const entry of readdirSync(root, { withFileTypes: true }).sort(
			(left, right) => left.name.localeCompare(right.name),
		)) {
			const child = join(root, entry.name);
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) {
				throw new Error(`legacy archive refuses symbolic link ${child}`);
			}
			if (entry.isDirectory()) {
				rows.push(`d:${relative}`);
				walk(child, relative);
			} else if (entry.isFile()) {
				rows.push(`f:${relative}:${hashFile(child)}`);
			} else {
				throw new Error(`legacy archive refuses special file ${child}`);
			}
		}
	};
	walk(path, "");
	return `d:${createHash("sha256").update(rows.join("\n")).digest("hex")}`;
}

function treeModes(path: string): Record<string, number> {
	const modes: Record<string, number> = {};
	const walk = (current: string, relative: string): void => {
		const stat = lstatSync(current);
		modes[relative] = stat.mode & 0o777;
		if (!stat.isDirectory()) return;
		for (const entry of readdirSync(current).sort()) {
			walk(join(current, entry), relative ? `${relative}/${entry}` : entry);
		}
	};
	walk(path, ".");
	return modes;
}

function sourceModesFrom(
	value: unknown,
	kind: "file" | "directory",
	label: string,
): Record<string, number> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	const modes: Record<string, number> = {};
	for (const [relativePath, mode] of Object.entries(value)) {
		const childPath =
			relativePath === "."
				? undefined
				: relativePath.startsWith("./")
					? relativePath.slice(2)
					: undefined;
		const segments = childPath?.split("/") ?? [];
		if (
			(relativePath !== "." &&
				(childPath === undefined ||
					childPath.length === 0 ||
					segments.some(
						(segment) =>
							segment.length === 0 || segment === "." || segment === "..",
					) ||
					childPath.includes("\0"))) ||
			!Number.isSafeInteger(mode) ||
			(mode as number) < 0 ||
			(mode as number) > 0o777
		) {
			throw new Error(`${label} contains an invalid entry`);
		}
		modes[relativePath] = mode as number;
	}
	if (
		modes["."] === undefined ||
		(kind === "file" && Object.keys(modes).length !== 1)
	) {
		throw new Error(`${label} does not match kind`);
	}
	return modes;
}

function modeMapsEqual(
	left: Record<string, number>,
	right: Record<string, number>,
): boolean {
	const leftEntries = Object.entries(left).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	const rightEntries = Object.entries(right).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function assertArchiveReadOnly(
	path: string,
	allowWritableRestoreRoot = false,
): void {
	const walk = (current: string, isRoot: boolean): void => {
		const stat = lstatSync(current);
		if (stat.isSymbolicLink()) {
			throw new Error(`legacy archive must not contain symlinks: ${current}`);
		}
		if (stat.isDirectory()) {
			const mode = stat.mode & 0o777;
			if (
				mode !== 0o500 &&
				!(allowWritableRestoreRoot && isRoot && mode === 0o700)
			) {
				throw new Error(
					`legacy archive directory mode must be 0500: ${current}`,
				);
			}
			for (const entry of readdirSync(current)) {
				walk(join(current, entry), false);
			}
			return;
		}
		if (stat.isFile()) {
			const mode = stat.mode & 0o777;
			if (
				mode !== 0o400 &&
				!(allowWritableRestoreRoot && isRoot && mode === 0o600)
			) {
				throw new Error(`legacy archive file mode must be 0400: ${current}`);
			}
			return;
		}
		throw new Error(`legacy archive contains a special file: ${current}`);
	};
	walk(path, true);
}

function makeReadOnly(path: string): void {
	const stat = lstatSync(path);
	if (stat.isDirectory()) {
		for (const entry of readdirSync(path)) {
			makeReadOnly(join(path, entry));
		}
		chmodSync(path, 0o500);
	} else if (stat.isFile()) {
		chmodSync(path, 0o400);
	}
}

function tombstonePayload(input: {
	sourcePath: string;
	archivePath: string;
	kind: "file" | "directory";
	sourceDigest: string;
	sourceModes: Record<string, number>;
	parentMode: number;
}): Buffer {
	return Buffer.from(
		`${JSON.stringify({
			v: 1,
			reason: "flywheel-v2-cutover",
			source_path: input.sourcePath,
			archive_path: input.archivePath,
			kind: input.kind,
			source_digest: input.sourceDigest,
			source_modes: input.sourceModes,
			parent_mode: input.parentMode,
		})}\n`,
		"utf8",
	);
}

function readTombstone(
	path: string,
	allowWritableRestoreState = false,
): LegacyTombstoneMarker {
	const tombstoneStat = lstatSync(path);
	if (tombstoneStat.isSymbolicLink()) {
		throw new Error(`legacy tombstone must not be a symbolic link: ${path}`);
	}
	if (!tombstoneStat.isDirectory()) {
		throw new Error(`legacy tombstone must be a directory: ${path}`);
	}
	const tombstoneMode = tombstoneStat.mode & 0o777;
	if (
		tombstoneMode !== 0o500 &&
		!(allowWritableRestoreState && tombstoneMode === 0o700)
	) {
		throw new Error(`legacy tombstone mode must be 0500: ${path}`);
	}
	const entries = readdirSync(path);
	if (entries.length !== 1 || entries[0] !== TOMBSTONE_FILE) {
		throw new Error(`legacy tombstone has an unexpected shape: ${path}`);
	}
	const markerPath = join(path, TOMBSTONE_FILE);
	const markerStat = lstatSync(markerPath);
	if (markerStat.isSymbolicLink()) {
		throw new Error(
			`legacy tombstone marker must not be a symbolic link: ${markerPath}`,
		);
	}
	if (!markerStat.isFile()) {
		throw new Error(
			`legacy tombstone marker must be a regular file: ${markerPath}`,
		);
	}
	if ((markerStat.mode & 0o777) !== 0o400) {
		throw new Error(`legacy tombstone marker mode must be 0400: ${markerPath}`);
	}
	try {
		const value = JSON.parse(readFileSync(markerPath, "utf8")) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error("not an object");
		}
		const marker = value as Record<string, unknown>;
		const expectedKeys = [
			"archive_path",
			"kind",
			"parent_mode",
			"reason",
			"source_digest",
			"source_modes",
			"source_path",
			"v",
		];
		if (
			Object.keys(marker).sort().join("\0") !== expectedKeys.join("\0") ||
			marker.v !== 1 ||
			marker.reason !== "flywheel-v2-cutover"
		) {
			throw new Error("unexpected marker fields");
		}
		if (
			typeof marker.source_path !== "string" ||
			!isAbsolute(marker.source_path) ||
			resolve(marker.source_path) !== marker.source_path ||
			typeof marker.archive_path !== "string" ||
			!isAbsolute(marker.archive_path) ||
			resolve(marker.archive_path) !== marker.archive_path
		) {
			throw new Error(
				"source_path/archive_path must be canonical absolute paths",
			);
		}
		if (marker.kind !== "file" && marker.kind !== "directory") {
			throw new Error("kind must be file or directory");
		}
		if (
			typeof marker.source_digest !== "string" ||
			!/^[fd]:[0-9a-f]{64}$/.test(marker.source_digest) ||
			(marker.kind === "file" && !marker.source_digest.startsWith("f:")) ||
			(marker.kind === "directory" && !marker.source_digest.startsWith("d:"))
		) {
			throw new Error("kind/source_digest mismatch");
		}
		const sourceModes = sourceModesFrom(
			marker.source_modes,
			marker.kind,
			"source_modes",
		);
		if (
			!Number.isSafeInteger(marker.parent_mode) ||
			(marker.parent_mode as number) < 0 ||
			(marker.parent_mode as number) > 0o777
		) {
			throw new Error("parent_mode must be a filesystem mode");
		}
		return {
			v: 1,
			reason: "flywheel-v2-cutover",
			source_path: marker.source_path,
			archive_path: marker.archive_path,
			kind: marker.kind,
			source_digest: marker.source_digest,
			source_modes: sourceModes,
			parent_mode: marker.parent_mode as number,
		};
	} catch (error) {
		throw new Error(
			`legacy tombstone is malformed at ${markerPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function assertArchiveMatchesReceipt(
	archivePath: string,
	expected: Pick<LegacyArchiveReceipt, "kind" | "sourceDigest" | "sourceModes">,
	allowWritableRestoreRoot = false,
): void {
	const archiveStat = lstatSync(archivePath);
	if (archiveStat.isSymbolicLink()) {
		throw new Error(
			`legacy tombstone archive must not be a symbolic link: ${archivePath}`,
		);
	}
	const archiveKind = archiveStat.isDirectory()
		? "directory"
		: archiveStat.isFile()
			? "file"
			: undefined;
	assertArchiveReadOnly(archivePath, allowWritableRestoreRoot);
	const archiveModePaths = Object.keys(treeModes(archivePath)).sort();
	const sourceModePaths = Object.keys(expected.sourceModes).sort();
	if (
		archiveKind !== expected.kind ||
		archiveModePaths.join("\0") !== sourceModePaths.join("\0") ||
		treeDigest(archivePath) !== expected.sourceDigest
	) {
		throw new Error(`legacy tombstone/archive conflict for ${archivePath}`);
	}
}

function replayArchivedTombstone(
	sourcePath: string,
	archivePath: string,
	allowWritableRestoreState = false,
): LegacyArchiveReceipt {
	const marker = readTombstone(sourcePath, allowWritableRestoreState);
	if (
		marker.source_path !== sourcePath ||
		marker.archive_path !== archivePath
	) {
		throw new Error(`legacy tombstone/archive conflict for ${sourcePath}`);
	}
	const receipt: LegacyArchiveReceipt = {
		sourcePath,
		archivePath,
		kind: marker.kind,
		sourceDigest: marker.source_digest,
		tombstonePath: sourcePath,
		sourceModes: marker.source_modes,
		parentMode: marker.parent_mode,
	};
	assertArchiveMatchesReceipt(archivePath, receipt);
	if ((lstatSync(dirname(sourcePath)).mode & 0o777) !== marker.parent_mode) {
		throw new Error(`legacy tombstone parent mode changed for ${sourcePath}`);
	}
	return receipt;
}

function restoreTombstonePath(sourcePath: string): string {
	return `${sourcePath}${RESTORE_TOMBSTONE_SUFFIX}`;
}

function validateRestoreTombstone(
	path: string,
	receipt: LegacyArchiveReceipt,
): void {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`rollback restore tombstone must be a directory: ${path}`);
	}
	const mode = stat.mode & 0o777;
	if (mode !== 0o500 && mode !== 0o700) {
		throw new Error(`rollback restore tombstone mode is invalid: ${path}`);
	}
	const entries = readdirSync(path);
	if (entries.length === 0) {
		if (mode !== 0o700) {
			throw new Error(
				`rollback restore tombstone is unexpectedly empty: ${path}`,
			);
		}
		return;
	}
	if (entries.length !== 1 || entries[0] !== TOMBSTONE_FILE) {
		throw new Error(`rollback restore tombstone shape is invalid: ${path}`);
	}
	const marker = readTombstone(path, true);
	if (
		marker.source_path !== receipt.sourcePath ||
		marker.archive_path !== receipt.archivePath ||
		marker.kind !== receipt.kind ||
		marker.source_digest !== receipt.sourceDigest
	) {
		throw new Error(
			`rollback restore tombstone conflicts with receipt: ${path}`,
		);
	}
	if (!modeMapsEqual(marker.source_modes, receipt.sourceModes)) {
		throw new Error(`rollback receipt sourceModes conflict for ${path}`);
	}
	if (marker.parent_mode !== receipt.parentMode) {
		throw new Error(`rollback receipt parentMode conflict for ${path}`);
	}
}

export function archiveAndTombstoneLegacyPath(input: {
	sourcePath: string;
	archivePath: string;
}): LegacyArchiveReceipt {
	const sourcePath = requireAbsolute(input.sourcePath, "sourcePath");
	const archivePath = requireAbsolute(input.archivePath, "archivePath");
	if (sourcePath === archivePath) {
		throw new TypeError("sourcePath and archivePath must differ");
	}
	const pendingTombstonePath = restoreTombstonePath(sourcePath);
	if (existsSync(pendingTombstonePath)) {
		throw new Error(
			`rollback restore tombstone already exists: ${pendingTombstonePath}`,
		);
	}
	if (existsSync(archivePath)) {
		if (!existsSync(sourcePath)) {
			throw new Error(
				`archive exists without source tombstone: ${archivePath}`,
			);
		}
		return replayArchivedTombstone(sourcePath, archivePath);
	}
	if (!existsSync(sourcePath)) {
		throw new Error(`legacy source is missing: ${sourcePath}`);
	}
	const sourceStat = lstatSync(sourcePath);
	if (sourceStat.isSymbolicLink()) {
		throw new Error(`legacy source must not be a symbolic link: ${sourcePath}`);
	}
	const kind = sourceStat.isDirectory()
		? "directory"
		: sourceStat.isFile()
			? "file"
			: undefined;
	if (!kind)
		throw new Error(`legacy source is not a file/directory: ${sourcePath}`);
	const sourceDigest = treeDigest(sourcePath);
	const sourceModes = treeModes(sourcePath);
	const parentMode = lstatSync(dirname(sourcePath)).mode & 0o777;
	mkdirSync(dirname(archivePath), { recursive: true, mode: 0o700 });
	renameSync(sourcePath, archivePath);
	makeReadOnly(archivePath);
	const payload = tombstonePayload({
		sourcePath,
		archivePath,
		kind,
		sourceDigest,
		sourceModes,
		parentMode,
	});
	// A non-empty 0500 directory at the exact old path blocks both ordinary
	// file opens and recursive rebuild attempts: the same-uid writer cannot
	// unlink the 0400 marker without write permission on the tombstone itself.
	// Keeping the parent untouched is essential when a top-level legacy file
	// shares ~/.flywheel with the live v2 authority namespace.
	mkdirSync(sourcePath, { mode: 0o700 });
	const markerPath = join(sourcePath, TOMBSTONE_FILE);
	writeFileSync(markerPath, payload, { mode: 0o400 });
	chmodSync(markerPath, 0o400);
	chmodSync(sourcePath, 0o500);
	fsyncDirectory(dirname(sourcePath));
	fsyncDirectory(dirname(archivePath));
	return {
		sourcePath,
		archivePath,
		kind,
		sourceDigest,
		tombstonePath: sourcePath,
		sourceModes,
		parentMode,
	};
}

function validateLegacyArchiveReceipt(
	input: LegacyArchiveReceipt,
): LegacyArchiveReceipt {
	const receipt = input as unknown;
	if (
		typeof receipt !== "object" ||
		receipt === null ||
		Array.isArray(receipt)
	) {
		throw new Error("rollback receipt must be an object");
	}
	const raw = receipt as Record<string, unknown>;
	if (
		typeof raw.sourcePath !== "string" ||
		!isAbsolute(raw.sourcePath) ||
		resolve(raw.sourcePath) !== raw.sourcePath ||
		typeof raw.archivePath !== "string" ||
		!isAbsolute(raw.archivePath) ||
		resolve(raw.archivePath) !== raw.archivePath ||
		raw.sourcePath === raw.archivePath
	) {
		throw new Error(
			"rollback receipt sourcePath/archivePath must be distinct canonical absolute paths",
		);
	}
	if (raw.kind !== "file" && raw.kind !== "directory") {
		throw new Error("rollback receipt kind must be file or directory");
	}
	if (
		typeof raw.sourceDigest !== "string" ||
		!/^[fd]:[0-9a-f]{64}$/.test(raw.sourceDigest) ||
		(raw.kind === "file" && !raw.sourceDigest.startsWith("f:")) ||
		(raw.kind === "directory" && !raw.sourceDigest.startsWith("d:"))
	) {
		throw new Error("rollback receipt kind/sourceDigest mismatch");
	}
	if (raw.tombstonePath !== raw.sourcePath) {
		throw new Error("rollback receipt tombstonePath must equal sourcePath");
	}
	const sourceModes = sourceModesFrom(
		raw.sourceModes,
		raw.kind,
		"rollback receipt sourceModes",
	);
	if (
		!Number.isSafeInteger(raw.parentMode) ||
		(raw.parentMode as number) < 0 ||
		(raw.parentMode as number) > 0o777
	) {
		throw new Error("rollback receipt parentMode must be a filesystem mode");
	}
	return {
		sourcePath: raw.sourcePath,
		archivePath: raw.archivePath,
		kind: raw.kind,
		sourceDigest: raw.sourceDigest,
		tombstonePath: raw.tombstonePath,
		sourceModes,
		parentMode: raw.parentMode as number,
	};
}

export function restoreLegacyArchivePath(input: LegacyArchiveReceipt): void {
	const receipt = validateLegacyArchiveReceipt(input);
	const sourcePath = requireAbsolute(receipt.sourcePath, "sourcePath");
	const archivePath = requireAbsolute(receipt.archivePath, "archivePath");
	const pendingTombstonePath = restoreTombstonePath(sourcePath);
	if (
		legacyArchiveRestoreState(receipt, { allowInProgress: true }) === "restored"
	) {
		return;
	}
	if (existsSync(sourcePath) && existsSync(archivePath)) {
		validateRestoreTombstone(sourcePath, receipt);
		chmodSync(sourcePath, 0o700);
		renameSync(sourcePath, pendingTombstonePath);
	}
	if (!existsSync(sourcePath) && existsSync(archivePath)) {
		chmodSync(archivePath, receipt.kind === "directory" ? 0o700 : 0o600);
		renameSync(archivePath, sourcePath);
	}
	if (!existsSync(sourcePath) || existsSync(archivePath)) {
		throw new Error(
			`rollback archive promotion is inconsistent for ${sourcePath}`,
		);
	}
	const paths = Object.entries(receipt.sourceModes).sort(
		([left], [right]) => right.split("/").length - left.split("/").length,
	);
	for (const [relativePath, mode] of paths) {
		const path =
			relativePath === "." ? sourcePath : join(sourcePath, relativePath);
		if (!existsSync(path)) {
			throw new Error(`rollback preimage path is missing: ${path}`);
		}
		chmodSync(path, mode);
	}
	if (existsSync(pendingTombstonePath)) {
		validateRestoreTombstone(pendingTombstonePath, receipt);
		chmodSync(pendingTombstonePath, 0o700);
		rmSync(pendingTombstonePath, { recursive: true, force: false });
	}
	if ((lstatSync(dirname(sourcePath)).mode & 0o777) !== receipt.parentMode) {
		throw new Error(`rollback source parent mode changed for ${sourcePath}`);
	}
	fsyncDirectory(dirname(sourcePath));
	if (legacyArchiveRestoreState(receipt) !== "restored") {
		throw new Error(
			`rollback archive restore did not settle for ${sourcePath}`,
		);
	}
}

export function legacyArchiveRestoreState(
	input: LegacyArchiveReceipt,
	options: { allowInProgress?: boolean } = {},
): "pending" | "restored" {
	const receipt = validateLegacyArchiveReceipt(input);
	const sourcePath = requireAbsolute(receipt.sourcePath, "sourcePath");
	const archivePath = requireAbsolute(receipt.archivePath, "archivePath");
	const pendingTombstonePath = restoreTombstonePath(sourcePath);
	const sourceExists = existsSync(sourcePath);
	const archiveExists = existsSync(archivePath);
	const pendingTombstoneExists = existsSync(pendingTombstonePath);
	if (pendingTombstoneExists) {
		if (!options.allowInProgress) {
			throw new Error(
				`rollback restore tombstone remains at ${pendingTombstonePath}`,
			);
		}
		validateRestoreTombstone(pendingTombstonePath, receipt);
	}
	if (sourceExists && archiveExists) {
		if (pendingTombstoneExists) {
			throw new Error(
				`rollback has duplicate restore tombstones for ${sourcePath}`,
			);
		}
		const replay =
			options.allowInProgress === true
				? (() => {
						validateRestoreTombstone(sourcePath, receipt);
						assertArchiveMatchesReceipt(archivePath, receipt);
						if (
							(lstatSync(dirname(sourcePath)).mode & 0o777) !==
							receipt.parentMode
						) {
							throw new Error(
								`rollback source parent mode changed for ${sourcePath}`,
							);
						}
						return receipt;
					})()
				: replayArchivedTombstone(sourcePath, archivePath);
		if (
			replay.kind !== receipt.kind ||
			replay.sourceDigest !== receipt.sourceDigest
		) {
			throw new Error(`rollback archive digest mismatch for ${sourcePath}`);
		}
		if (!modeMapsEqual(replay.sourceModes, receipt.sourceModes)) {
			throw new Error(
				`rollback receipt sourceModes conflict for ${sourcePath}`,
			);
		}
		if (replay.parentMode !== receipt.parentMode) {
			throw new Error(`rollback receipt parentMode conflict for ${sourcePath}`);
		}
		return "pending";
	}
	if (!sourceExists && archiveExists) {
		if (!options.allowInProgress) {
			throw new Error(
				`rollback archive/tombstone is missing for ${sourcePath}`,
			);
		}
		assertArchiveMatchesReceipt(archivePath, receipt, true);
		if ((lstatSync(dirname(sourcePath)).mode & 0o777) !== receipt.parentMode) {
			throw new Error(`rollback source parent mode changed for ${sourcePath}`);
		}
		return "pending";
	}
	if (sourceExists && !archiveExists) {
		if (treeDigest(sourcePath) !== receipt.sourceDigest) {
			throw new Error(`restored legacy digest mismatch for ${sourcePath}`);
		}
		const actualModes = treeModes(sourcePath);
		const modesRestored =
			modeMapsEqual(receipt.sourceModes, actualModes) &&
			(lstatSync(dirname(sourcePath)).mode & 0o777) === receipt.parentMode;
		if (
			(!modesRestored || pendingTombstoneExists) &&
			!options.allowInProgress
		) {
			throw new Error(`restored legacy mode mismatch for ${sourcePath}`);
		}
		return modesRestored && !pendingTombstoneExists ? "restored" : "pending";
	}
	throw new Error(`rollback archive/tombstone is missing for ${sourcePath}`);
}

export function copyLegacySnapshot(input: {
	sourcePath: string;
	snapshotPath: string;
}): string {
	const sourcePath = requireAbsolute(input.sourcePath, "sourcePath");
	const snapshotPath = requireAbsolute(input.snapshotPath, "snapshotPath");
	if (!lstatSync(sourcePath).isFile()) {
		throw new Error("copyLegacySnapshot supports files only");
	}
	mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 });
	copyFileSync(sourcePath, snapshotPath);
	chmodSync(snapshotPath, 0o400);
	const fd = openSync(snapshotPath, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	fsyncDirectory(dirname(snapshotPath));
	return hashFile(snapshotPath);
}

function watchedState(paths: readonly string[]): Record<string, string> {
	const state = (path: string): string => {
		if (!existsSync(path)) return "missing";
		return JSON.stringify({
			digest: treeDigest(path),
			modes: treeModes(path),
		});
	};
	return Object.fromEntries(
		paths.flatMap((path) => {
			const resolved = resolve(path);
			const rows: Array<[string, string]> = [
				[resolved, state(resolved)],
				[
					`${resolved}#parent-mode`,
					String(lstatSync(dirname(resolved)).mode & 0o777),
				],
			];
			for (const suffix of ["-wal", "-shm"]) {
				rows.push([`${resolved}${suffix}`, state(`${resolved}${suffix}`)]);
			}
			return rows;
		}),
	);
}

export function runLegacyWriterLiveFire(input: {
	commands: LiveFireCommand[];
	watchedPaths: string[];
	timeoutMs?: number;
	baseEnv?: NodeJS.ProcessEnv;
}): LiveFireResult[] {
	if (input.commands.length === 0) {
		throw new TypeError("live-fire requires at least one legacy writer");
	}
	const before = watchedState(input.watchedPaths);
	const results = input.commands.map((command) => {
		if (command.argv.length === 0) {
			throw new TypeError(`live-fire command ${command.name} is empty`);
		}
		const [executable, ...args] = command.argv;
		const result = spawnSync(executable as string, args, {
			encoding: "utf8",
			timeout: input.timeoutMs ?? 10_000,
			env: { ...(input.baseEnv ?? process.env), ...(command.env ?? {}) },
		});
		const stderr = result.stderr || result.error?.message || "";
		if (result.status === 0) {
			throw new Error(
				`legacy live-fire writer ${command.name} unexpectedly succeeded`,
			);
		}
		if (
			!/(EACCES|EPERM|EISDIR|ENOTEMPTY|SQLITE_CANTOPEN|read-?only|frozen|fail closed|not a database|unable to open database file|is a directory|directory not empty|permission denied)/i.test(
				stderr,
			)
		) {
			throw new Error(
				`legacy live-fire writer ${command.name} did not fail loud: ${stderr}`,
			);
		}
		return {
			name: command.name,
			exitCode: result.status,
			signal: result.signal,
			stderr,
		};
	});
	const after = watchedState(input.watchedPaths);
	if (JSON.stringify(after) !== JSON.stringify(before)) {
		throw new Error("legacy live-fire changed a frozen path or WAL sidecar");
	}
	return results;
}
