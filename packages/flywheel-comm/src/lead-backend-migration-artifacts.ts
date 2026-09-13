import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { MigrationObservation } from "./lead-backend-migration-executor.js";
import { migrationArtifactDirectory } from "./lead-backend-migration-io.js";

type Kind = "manifest" | "plist";
type Expected = { manifestSha: string; plistSha: string };
const hash = (value: Buffer | string) =>
	createHash("sha256").update(value).digest("hex");
function paths(home: string, kind: Kind) {
	const dir = migrationArtifactDirectory(home);
	const live =
		kind === "manifest"
			? join(home, ".flywheel/manifests/flywheel-flywheel-product-lead.json")
			: join(
					home,
					"Library/LaunchAgents/com.flywheel.lead.flywheel-flywheel-product-lead.plist",
				);
	for (const parent of kind === "manifest"
		? [dirname(live)]
		: [join(home, "Library"), dirname(live)]) {
		const stat = lstatSync(parent);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o022) !== 0
		)
			throw new Error("unsafe artifact directory");
	}
	return { live, backup: join(dir, `${kind}.before`) };
}
function read(path: string): Buffer | null {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o022) !== 0 ||
			stat.size > 1024 * 1024
		)
			throw new Error("unsafe migration artifact");
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}
function syncDir(path: string) {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
function tempFile(path: string, bytes: Buffer): string {
	const temp = join(dirname(path), `.migration-artifact-${randomUUID()}.tmp`);
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeFileSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	return temp;
}
function expectedHash(expected: Expected, kind: Kind): string {
	const value = expected[kind === "manifest" ? "manifestSha" : "plistSha"];
	if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid artifact hash");
	return value;
}
/** Read the live artifact on every replay; a receipt is not its postimage. */
export function observeMigrationArtifact(
	home: string,
	expected: Expected,
	kind: Kind,
	after: string,
	assertStopped: () => void,
): MigrationObservation {
	if (!after || Buffer.byteLength(after) > 1024 * 1024)
		throw new Error("invalid migration artifact target");
	const current = read(paths(home, kind).live);
	if (!current) {
		if (kind === "plist") assertStopped();
		return {
			state: kind === "plist" ? "pre" : "conflict",
			proofSha: hash(`missing:${kind}`),
		};
	}
	const proofSha = hash(current);
	return {
		state: current.equals(Buffer.from(after))
			? "post"
			: proofSha === expectedHash(expected, kind)
				? "pre"
				: "conflict",
		proofSha,
	};
}

/** Read/copy only; must run before the existing lifecycle helper removes the old plist. */
export function preserveMigrationArtifacts(
	home: string,
	expected: Expected,
): void {
	for (const kind of ["manifest", "plist"] as const) {
		const { live, backup } = paths(home, kind);
		const wanted = expectedHash(expected, kind);
		const previous = read(backup);
		if (previous) {
			if (hash(previous) !== wanted)
				throw new Error("artifact backup conflict");
			continue;
		}
		const bytes = read(live);
		if (!bytes || hash(bytes) !== wanted)
			throw new Error("artifact preimage conflict");
		const temp = tempFile(backup, bytes);
		try {
			linkSync(temp, backup);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				try {
					unlinkSync(temp);
				} catch {}
				throw error;
			}
		}
		unlinkSync(temp);
		syncDir(dirname(backup));
		const saved = read(backup);
		if (!saved || hash(saved) !== wanted)
			throw new Error("artifact backup conflict");
	}
}
/** Check both restore inputs before a caller starts changing registry fields. */
export function assertMigrationArtifactRestorable(
	home: string,
	expected: Expected,
	kind: Kind,
	after: string,
): void {
	const { live, backup } = paths(home, kind);
	const before = read(backup),
		current = read(live),
		target = Buffer.from(after);
	if (
		!before ||
		hash(before) !== expectedHash(expected, kind) ||
		target.length === 0 ||
		target.length > 1024 * 1024
	)
		throw new Error("artifact backup or target conflict");
	if (
		current
			? !current.equals(before) && !current.equals(target)
			: kind !== "plist"
	)
		throw new Error("artifact live conflict");
}

/** One target file per coordinator checkpoint; no launchctl or global materializer call. */
export function replaceMigrationArtifact(
	home: string,
	expected: Expected,
	kind: Kind,
	after: string,
	direction: "apply" | "rollback",
	assertWindowAndStopped: () => void,
): "written" | "unchanged" {
	assertWindowAndStopped();
	const { live, backup } = paths(home, kind);
	const before = read(backup);
	if (!before || hash(before) !== expectedHash(expected, kind))
		throw new Error("artifact backup conflict");
	const target = Buffer.from(after);
	if (target.length === 0 || target.length > 1024 * 1024)
		throw new Error("invalid artifact target");
	const desired = direction === "apply" ? target : before;
	const other = direction === "apply" ? before : target;
	const current = read(live);
	if (current?.equals(desired)) return "unchanged";
	// Both old and new lifecycle stop remove the plist. A verified stopped owner
	// plus the pinned backup permits recreation; a missing manifest remains a conflict.
	if (current ? !current.equals(other) : kind !== "plist")
		throw new Error("artifact live conflict");
	const temp = tempFile(live, desired);
	try {
		assertWindowAndStopped();
		const fresh = read(live);
		if (current ? !fresh || !fresh.equals(current) : fresh !== null)
			throw new Error("artifact changed before replacement");
		renameSync(temp, live);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {}
		throw error;
	}
	syncDir(dirname(live));
	if (!read(live)?.equals(desired))
		throw new Error("artifact readback conflict");
	return "written";
}
