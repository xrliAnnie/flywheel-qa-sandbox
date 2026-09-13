import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	type MigrationCutoffArtifact,
	parseMigrationCutoffs,
} from "./lead-backend-migration-cutoff.js";
import { migrationArtifactDirectory } from "./lead-backend-migration-io.js";

export interface MigrationOperatorArtifact {
	version: 1;
	intentSha: string;
	cutoffs: MigrationCutoffArtifact;
}
interface OperatorInput {
	home: string;
	/** Digest of the immutable intent used by the execution receipt. */
	intentSha: string;
	botUserId: string;
	channelIds: string[];
	collect(): Promise<MigrationCutoffArtifact>;
}
function reject(): never {
	throw new Error("invalid migration operator artifact");
}
function parse(
	value: unknown,
	input: Omit<OperatorInput, "collect">,
): MigrationOperatorArtifact {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return reject();
	const row = value as Record<string, unknown>;
	if (
		Object.keys(row).length !== 3 ||
		row.version !== 1 ||
		row.intentSha !== input.intentSha ||
		!Object.hasOwn(row, "cutoffs")
	)
		return reject();
	return {
		version: 1,
		intentSha: input.intentSha,
		cutoffs: parseMigrationCutoffs(row.cutoffs, input),
	};
}
function read(
	path: string,
	input: Omit<OperatorInput, "collect">,
): MigrationOperatorArtifact | null {
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
			(stat.mode & 0o777) !== 0o600 ||
			stat.size > 2 * 1024 * 1024
		)
			return reject();
		return parse(JSON.parse(readFileSync(fd, "utf8")), input);
	} finally {
		closeSync(fd);
	}
}
export function loadMigrationOperator(
	input: Omit<OperatorInput, "collect">,
): MigrationOperatorArtifact | null {
	if (!/^[a-f0-9]{64}$/.test(input.intentSha)) return reject();
	return read(
		join(
			migrationArtifactDirectory(input.home),
			"FLY-2459-honey-lemon.operator.json",
		),
		input,
	);
}

/** Write-once operator evidence: retries never move the cutoff or discard unresolved IDs. */
export async function loadOrCollectMigrationOperator(
	input: OperatorInput,
): Promise<MigrationOperatorArtifact> {
	if (!/^[a-f0-9]{64}$/.test(input.intentSha)) return reject();
	const dir = migrationArtifactDirectory(input.home);
	const path = join(dir, "FLY-2459-honey-lemon.operator.json");
	const existing = read(path, input);
	if (existing) return existing;
	const artifact = parse(
		{ version: 1, intentSha: input.intentSha, cutoffs: await input.collect() },
		input,
	);
	// Recheck the protected directory after the asynchronous network operation.
	migrationArtifactDirectory(input.home);
	const temp = join(dir, `.operator-${randomUUID()}.tmp`);
	try {
		const fd = openSync(temp, "wx", 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify(artifact, null, 2)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		try {
			linkSync(temp, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	} finally {
		rmSync(temp, { force: true });
		const fd = openSync(dir, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
	// A concurrent collector may have won. Its original, validated snapshot is authoritative.
	return read(path, input) ?? reject();
}
