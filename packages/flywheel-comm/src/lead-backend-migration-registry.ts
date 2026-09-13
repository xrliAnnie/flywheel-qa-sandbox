import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	applyMigrationFields,
	type BackendMigrationPlan,
	rollbackMigrationFields,
} from "./lead-backend-migration.js";
import {
	assertMigrationArtifactRestorable,
	replaceMigrationArtifact,
} from "./lead-backend-migration-artifacts.js";
import type { MigrationObservation } from "./lead-backend-migration-executor.js";
import {
	migrationArtifactDirectory,
	parseMigrationIntent,
} from "./lead-backend-migration-io.js";
import { compileSummaryAssignments } from "./summary-assignment.js";
import { readSummaryGranularity } from "./summary-config.js";
import { verifySummaryRegistryActivation } from "./summary-registry-migration.js";
export interface MigrationRegistryDeps {
	/** Inherited only from the existing config_write_locked Python flock wrapper. */
	configLockHeld: boolean;
	/** Revalidate actual restart/admission ownership and stopped writer; no waiting or restart here. */
	assertWindowAndStopped(): void;
	validateCandidate(path: string): void;
}
function hash(bytes: string): string {
	return createHash("sha256").update(bytes).digest("hex");
}
/** Restore only the pinned source files while the existing config flock is held.
 * Service installation happens after the caller releases that lock and verifies these files.
 */
export function restoreMigrationFilesLocked(
	home: string,
	plan: BackendMigrationPlan,
	target: { manifest: string; plist: string },
	deps: MigrationRegistryDeps,
): ReturnType<typeof migrateRegistryFieldsLocked> {
	if (!deps.configLockHeld)
		throw new Error("existing configuration flock is required");
	deps.assertWindowAndStopped();
	for (const kind of ["manifest", "plist"] as const)
		assertMigrationArtifactRestorable(home, plan.expected, kind, target[kind]);
	const registry = migrateRegistryFieldsLocked(home, plan, "rollback", deps);
	for (const kind of ["manifest", "plist"] as const)
		replaceMigrationArtifact(
			home,
			plan.expected,
			kind,
			target[kind],
			"rollback",
			deps.assertWindowAndStopped,
		);
	return registry;
}
export function observeMigrationRegistry(
	home: string,
	input: BackendMigrationPlan,
): MigrationObservation {
	const plan = parseMigrationIntent(input);
	migrationArtifactDirectory(home);
	const bytes = readPrivate(join(home, ".flywheel/projects.json"));
	const raw: unknown = JSON.parse(bytes);
	const candidate = applyMigrationFields(raw, plan);
	return {
		state: isDeepStrictEqual(raw, candidate) ? "post" : "pre",
		proofSha: hash(bytes),
	};
}

export function readMigrationRegistry(home: string): unknown {
	migrationArtifactDirectory(home);
	return JSON.parse(readPrivate(join(home, ".flywheel/projects.json")));
}

function readPrivate(path: string): string {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o077) !== 0 ||
			stat.size > 16 * 1024 * 1024
		)
			throw new Error("unsafe migration registry source");
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}
/** Internal configure/rollback operation. Does not acquire or claim restart authority itself. */
export function migrateRegistryFieldsLocked(
	home: string,
	input: BackendMigrationPlan,
	direction: "apply" | "rollback",
	deps: MigrationRegistryDeps,
): {
	status: "written" | "unchanged";
	projectsSha: string;
	summaryAssignmentDigest: string;
} {
	if (!deps.configLockHeld)
		throw new Error("existing configuration flock is required");
	const plan = parseMigrationIntent(input);
	migrationArtifactDirectory(home);
	deps.assertWindowAndStopped();
	const projectsPath = join(home, ".flywheel/projects.json");
	const receiptPath = join(
		home,
		".flywheel/state/summary-registry/migration-receipt.json",
	);
	const before = readPrivate(projectsPath);
	const receiptBefore = readPrivate(receiptPath);
	const verify = () =>
		verifySummaryRegistryActivation(
			{ projectsPath, receiptPath, homeDir: home },
			{ validateTeamleadCandidate: deps.validateCandidate },
		);
	const receipt = verify();
	const raw: unknown = JSON.parse(before);
	const candidate =
		direction === "apply"
			? applyMigrationFields(raw, plan)
			: rollbackMigrationFields(raw, plan);
	const projection = compileSummaryAssignments(
		candidate,
		readSummaryGranularity({ homeDir: home }),
	);
	if (projection.digest !== receipt.summaryAssignmentDigest)
		throw new Error("migration summary assignment conflict");
	if (isDeepStrictEqual(candidate, raw))
		return {
			status: "unchanged",
			projectsSha: hash(before),
			summaryAssignmentDigest: projection.digest,
		};
	const next = `${JSON.stringify(candidate, null, 2)}\n`;
	const temp = join(
		dirname(projectsPath),
		`.migration-registry-${randomUUID()}.tmp`,
	);
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeFileSync(fd, next);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		deps.validateCandidate(temp);
		deps.assertWindowAndStopped();
		if (
			readPrivate(projectsPath) !== before ||
			readPrivate(receiptPath) !== receiptBefore
		)
			throw new Error("migration registry source changed under lock");
		verify();
		renameSync(temp, projectsPath);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {}
		throw error;
	}
	const dir = openSync(dirname(projectsPath), "r");
	try {
		fsyncSync(dir);
	} finally {
		closeSync(dir);
	}
	if (readPrivate(projectsPath) !== next)
		throw new Error("migration registry readback mismatch");
	const after = verify();
	if (
		after.summaryAssignmentDigest !== projection.digest ||
		readPrivate(receiptPath) !== receiptBefore
	)
		throw new Error("migration summary readback mismatch");
	return {
		status: "written",
		projectsSha: hash(next),
		summaryAssignmentDigest: projection.digest,
	};
}
