import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants as fsConstants,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	type CodexHomeAttemptReceipt,
	computeCodexHomeInventoryDigest,
	evaluateCodexHomeMigrationDeadlines,
} from "flywheel-claude-runner";
import type { CodexCredentialHomeRosterEntry } from "./credential-home-roster.js";
import type {
	CodexQuotaHostDiagnostic,
	CodexQuotaHostInventory,
	CodexQuotaUnattributedReader,
} from "./host-readiness.js";
import type { CodexQuotaReadinessResult } from "./readiness.js";

export interface CodexQuotaReadinessManifest {
	schemaVersion: 1;
	buildSha: string;
	inventoryDigest: string;
	createdAt: string;
	homes: Array<{
		home: string;
		ownership: "managed" | "independent";
		credentialShared: boolean;
		checkedAt: string;
	}>;
}

export type ReadinessDependencyState =
	| { status: "pending" }
	| { status: "invalid"; reason: string }
	| { status: "verified"; evidenceDigest: string };

export interface RegisteredHomeReadinessInput {
	canonicalHome: string;
	roster: readonly CodexCredentialHomeRosterEntry[];
	expectedBuildSha: string;
	migrationState: unknown;
	attemptReceipts: unknown[];
	manifest: CodexQuotaReadinessManifest;
	inventory: CodexQuotaHostInventory;
	global: CodexQuotaReadinessResult;
	dependencies: {
		"FLY-2729": ReadinessDependencyState;
		desktopCredentialAuthority: {
			status: "unknown" | "pending" | "verified";
			issueId: string | null;
		};
	};
}

export interface RegisteredHomeReadinessResult {
	registered: {
		ready: boolean;
		homeIds: string[];
		failures: Array<{ homeId?: string; reason: string }>;
	};
	global: CodexQuotaReadinessResult;
	unattributedReaders: CodexQuotaUnattributedReader[];
	activation: { authorized: false; ownedBy: "separate_gated_task" };
	dependencies: RegisteredHomeReadinessInput["dependencies"];
}

export interface RegisteredReadinessEvidence
	extends RegisteredHomeReadinessResult {
	schemaVersion: 1;
	scope: "registered_homes";
	inventoryDigest: string;
	deployedSha: string;
	checkedAt: string;
}

function ensureEvidenceDirectory(path: string): void {
	try {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error("evidence_directory_unsafe");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		mkdirSync(path, { mode: 0o700 });
	}
	chmodSync(path, 0o700);
}

function fsyncDirectory(path: string): void {
	const fd = openSync(path, fsConstants.O_RDONLY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Persist an immutable, content-addressed acceptance snapshot. */
export function writeRegisteredReadinessEvidence(input: {
	stateRoot: string;
	evidence: RegisteredReadinessEvidence;
}): { path: string; evidenceDigest: string } {
	if (
		!isAbsolute(input.stateRoot) ||
		resolve(input.stateRoot) !== input.stateRoot ||
		!/^[a-f0-9]{64}$/.test(input.evidence.inventoryDigest) ||
		!/^[a-f0-9]{40}$/.test(input.evidence.deployedSha)
	) {
		throw new Error("evidence_identity_invalid");
	}
	const stateStat = lstatSync(input.stateRoot);
	if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
		throw new Error("evidence_state_root_unsafe");
	}
	const quotaRoot = join(input.stateRoot, "codex-quota");
	const quotaStat = lstatSync(quotaRoot);
	if (!quotaStat.isDirectory() || quotaStat.isSymbolicLink()) {
		throw new Error("evidence_quota_root_unsafe");
	}
	const root = join(quotaRoot, "registered-readiness");
	ensureEvidenceDirectory(root);
	const digestRoot = join(root, input.evidence.inventoryDigest);
	ensureEvidenceDirectory(digestRoot);
	const bytes = `${JSON.stringify(input.evidence, null, 2)}\n`;
	const evidenceDigest = createHash("sha256").update(bytes).digest("hex");
	const path = join(digestRoot, `${evidenceDigest}.json`);
	try {
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			(stat.mode & 0o777) !== 0o600 ||
			stat.size !== Buffer.byteLength(bytes) ||
			createHash("sha256").update(readFileSync(path)).digest("hex") !==
				evidenceDigest
		) {
			throw new Error("evidence_existing_unsafe");
		}
		return { path, evidenceDigest };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temporary = join(
		digestRoot,
		`.${evidenceDigest}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
	);
	try {
		writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
		const fd = openSync(temporary, fsConstants.O_RDONLY);
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
		chmodSync(path, 0o600);
		fsyncDirectory(dirname(path));
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
	return { path, evidenceDigest };
}

async function topologyFailure(
	entry: CodexCredentialHomeRosterEntry,
	canonicalAuthPath: string,
): Promise<string | null> {
	try {
		const home = await lstat(entry.home);
		const authPath = join(entry.home, "auth.json");
		const auth = await lstat(authPath);
		const pending = await lstat(
			join(entry.home, ".credential-copy-pending"),
		).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (!home.isDirectory() || home.isSymbolicLink()) return "home_unsafe";
		if (entry.ownership === "managed") {
			if (!auth.isSymbolicLink() || pending) return "credential_not_shared";
			if ((await realpath(authPath)) !== (await realpath(canonicalAuthPath))) {
				return "credential_not_shared";
			}
		}
		return null;
	} catch {
		return "topology_unavailable";
	}
}

function diagnosticBlocksRegistered(
	diagnostic: CodexQuotaHostDiagnostic,
): boolean {
	return diagnostic.scope === "registered" || diagnostic.scope === "all";
}

/**
 * Evaluate the deliberately bounded registered-home claim. This function does
 * not alter or reinterpret the global checker result; desktop/unattributed
 * readers remain visible and continue to prohibit activation.
 */
export async function evaluateRegisteredHomeReadiness(
	input: RegisteredHomeReadinessInput,
): Promise<RegisteredHomeReadinessResult> {
	const failures: RegisteredHomeReadinessResult["registered"]["failures"] = [];
	const homeIds = input.roster.map((entry) => entry.id);
	let expectedDigest: string | null = null;
	try {
		expectedDigest = computeCodexHomeInventoryDigest(
			input.roster.map(({ home, ownership }) => ({ home, ownership })),
		);
	} catch {
		failures.push({ reason: "roster_invalid" });
	}

	if (!/^[a-f0-9]{40}$/.test(input.expectedBuildSha)) {
		failures.push({ reason: "build_identity_invalid" });
	}
	if (
		input.manifest.schemaVersion !== 1 ||
		input.manifest.buildSha !== input.expectedBuildSha ||
		input.manifest.inventoryDigest !== expectedDigest ||
		input.inventory.inventoryDigest !== expectedDigest ||
		input.inventory.buildSha !== input.expectedBuildSha
	) {
		failures.push({ reason: "receipt_identity_mismatch" });
	}

	const manifestHomes = new Map(
		input.manifest.homes.map((home) => [home.home, home] as const),
	);
	const observedHomes = new Map(
		input.inventory.homes.map((home) => [home.home, home] as const),
	);
	if (
		manifestHomes.size !== input.roster.length ||
		observedHomes.size !== input.roster.length
	) {
		failures.push({ reason: "home_set_mismatch" });
	}

	let statuses: ReturnType<typeof evaluateCodexHomeMigrationDeadlines> = [];
	try {
		statuses = evaluateCodexHomeMigrationDeadlines(
			input.migrationState,
			input.attemptReceipts as CodexHomeAttemptReceipt[],
			new Date(),
		);
	} catch {
		failures.push({ reason: "migration_evidence_invalid" });
	}
	const statusById = new Map(statuses.map((status) => [status.homeId, status]));
	const canonicalAuthPath = join(input.canonicalHome, "auth.json");
	try {
		const canonical = await lstat(canonicalAuthPath);
		if (
			!canonical.isFile() ||
			canonical.isSymbolicLink() ||
			(canonical.mode & 0o777) !== 0o600
		) {
			failures.push({ reason: "canonical_unavailable" });
		}
	} catch {
		failures.push({ reason: "canonical_unavailable" });
	}

	for (const entry of input.roster) {
		const manifest = manifestHomes.get(entry.home);
		if (
			!manifest ||
			manifest.ownership !== entry.ownership ||
			manifest.credentialShared !== (entry.ownership === "managed")
		) {
			failures.push({ homeId: entry.id, reason: "manifest_home_mismatch" });
		}
		const observed = observedHomes.get(entry.home);
		if (
			!observed ||
			observed.ownership !== entry.ownership ||
			observed.activity === "unknown"
		) {
			failures.push({ homeId: entry.id, reason: "home_authority_unknown" });
		}
		if (!statusById.get(entry.id)?.satisfied) {
			failures.push({
				homeId: entry.id,
				reason: "satisfaction_receipt_missing",
			});
		}
		const topology = await topologyFailure(entry, canonicalAuthPath);
		if (topology) failures.push({ homeId: entry.id, reason: topology });
	}

	if (!input.inventory.registeredComplete) {
		failures.push({ reason: "registered_census_incomplete" });
	}
	for (const diagnostic of input.inventory.diagnostics) {
		if (diagnosticBlocksRegistered(diagnostic)) {
			failures.push({ reason: diagnostic.reason });
		}
	}

	return {
		registered: { ready: failures.length === 0, homeIds, failures },
		global: input.global,
		unattributedReaders: input.inventory.unattributedReaders,
		activation: { authorized: false, ownedBy: "separate_gated_task" },
		dependencies: input.dependencies,
	};
}
