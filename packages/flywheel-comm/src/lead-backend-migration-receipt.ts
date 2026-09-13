import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withMkdirLock } from "flywheel-config";
import {
	MIGRATION_STEPS,
	type MigrationExecutionReceipt,
} from "./lead-backend-migration-executor.js";
import {
	migrationArtifactDirectory,
	readCommittedMigrationIntent,
	readMigrationIntentRecord,
} from "./lead-backend-migration-io.js";

const HASH = /^[a-f0-9]{64}$/;
function bad(): never {
	throw new Error("invalid migration execution receipt");
}
function parse(value: unknown): MigrationExecutionReceipt {
	if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
	const r = value as MigrationExecutionReceipt;
	if (
		Object.keys(r).some(
			(key) =>
				![
					"version",
					"intentSha",
					"revision",
					"status",
					"pending",
					"completed",
					"failure",
					"recovery",
					"sourceCarrier",
					"verification",
				].includes(key),
		)
	)
		return bad();
	if (r.sourceCarrier !== undefined) {
		const source = r.sourceCarrier;
		if (
			!source ||
			typeof source !== "object" ||
			Array.isArray(source) ||
			Object.keys(source).length !== 2 ||
			!Number.isSafeInteger(source.pid) ||
			source.pid <= 0 ||
			typeof source.start !== "string" ||
			!source.start.trim() ||
			source.start.length > 128
		)
			return bad();
	}
	if (
		r.version !== 1 ||
		typeof r.intentSha !== "string" ||
		!HASH.test(r.intentSha) ||
		!Number.isSafeInteger(r.revision) ||
		r.revision < 0
	)
		return bad();
	if (
		![
			"executing",
			"held",
			"deployed_unverified",
			"failed",
			"verified",
			"committed",
		].includes(r.status) ||
		(r.pending !== null && !MIGRATION_STEPS.includes(r.pending)) ||
		![null, "step_failed"].includes(r.failure)
	)
		return bad();
	if (
		!r.completed ||
		typeof r.completed !== "object" ||
		Array.isArray(r.completed)
	)
		return bad();
	const keys = Object.keys(r.completed);
	if (
		keys.some(
			(key) =>
				!MIGRATION_STEPS.includes(key as (typeof MIGRATION_STEPS)[number]),
		)
	)
		return bad();
	if (
		Object.values(r.completed).some(
			(v) => typeof v !== "string" || !HASH.test(v),
		)
	)
		return bad();
	// Completed steps are a prefix; a phase label cannot skip an unproven stage.
	for (let i = 0; i < keys.length; i++)
		if (!Object.hasOwn(r.completed, MIGRATION_STEPS[i]!)) return bad();
	if (r.recovery !== undefined) {
		const recovery = r.recovery;
		if (
			!recovery ||
			typeof recovery !== "object" ||
			Array.isArray(recovery) ||
			Object.keys(recovery).length !== 3 ||
			recovery.reason !== "activation_preflight_failed" ||
			!["pending", "restored"].includes(recovery.state) ||
			(recovery.state === "pending"
				? recovery.proofSha !== null
				: typeof recovery.proofSha !== "string" ||
					!HASH.test(recovery.proofSha)) ||
			keys.length !== MIGRATION_STEPS.length - 1 ||
			r.failure !== "step_failed" ||
			!["held", "failed"].includes(r.status) ||
			(r.status === "failed" &&
				(recovery.state !== "restored" || r.pending !== null))
		)
			return bad();
	} else if (r.status === "failed") return bad();
	if (
		["deployed_unverified", "verified", "committed"].includes(r.status) &&
		(keys.length !== MIGRATION_STEPS.length ||
			r.pending !== null ||
			r.failure !== null)
	)
		return bad();

	const final = r.status === "verified" || r.status === "committed";
	if (final !== (r.verification !== undefined)) return bad();
	if (r.verification !== undefined) {
		const v = r.verification;
		if (
			!v ||
			typeof v !== "object" ||
			Array.isArray(v) ||
			Object.keys(v).length !== 2 ||
			typeof v.evidenceSha !== "string" ||
			!HASH.test(v.evidenceSha) ||
			typeof v.proofSha !== "string" ||
			!HASH.test(v.proofSha)
		)
			return bad();
	}
	if (r.status === "held" && r.failure !== "step_failed") return bad();
	return structuredClone(r);
}
export function loadMigrationReceipt(
	home: string,
): MigrationExecutionReceipt | null {
	const path = join(
		migrationArtifactDirectory(home),
		"FLY-2459-honey-lemon.receipt.json",
	);
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
			stat.size > 65536
		)
			return bad();
		return parse(JSON.parse(readFileSync(fd, "utf8")));
	} finally {
		closeSync(fd);
	}
}
export async function saveMigrationReceipt(
	home: string,
	value: MigrationExecutionReceipt,
	previousRevision: number | null,
): Promise<void> {
	const next = parse(value);
	const dir = migrationArtifactDirectory(home);
	const lock = join(dir, "receipt.lock");
	try {
		const stat = lstatSync(lock);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return bad();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await withMkdirLock(
		lock,
		async () => {
			const current = loadMigrationReceipt(home);
			if (
				(current?.revision ?? null) !== previousRevision ||
				next.revision !==
					(previousRevision === null ? 0 : previousRevision + 1) ||
				(current && current.intentSha !== next.intentSha)
			)
				throw new Error("migration receipt CAS conflict");
			const path = join(dir, "FLY-2459-honey-lemon.receipt.json");
			const temp = join(dir, `.receipt-${randomUUID()}.tmp`);
			const fd = openSync(temp, "wx", 0o600);
			try {
				writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			try {
				renameSync(temp, path);
			} catch (error) {
				try {
					unlinkSync(temp);
				} catch {}
				throw error;
			}
			const directory = openSync(dir, "r");
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
		},
		{ timeoutMs: 1000 },
	);
}

/** Finalization is outside the restart window and writes only this receipt.
 * Live checks run without the short receipt lock; revision CAS rejects races.
 */
export async function commitMigrationVerification(
	home: string,
	intentSha: string,
	evidenceSha: string,
	verify: () => Promise<string>,
): Promise<MigrationExecutionReceipt> {
	let current = loadMigrationReceipt(home);
	if (
		!HASH.test(intentSha) ||
		!HASH.test(evidenceSha) ||
		!current ||
		current.intentSha !== intentSha ||
		!["deployed_unverified", "verified", "committed"].includes(
			current.status,
		) ||
		(current.verification && current.verification.evidenceSha !== evidenceSha)
	)
		throw Error("migration verification evidence conflict");
	const check = async () => {
		const proof = await verify();
		if (!HASH.test(proof)) throw Error("migration verification unproven");
		return proof;
	};
	let proofSha = await check();
	if (current.status === "committed") return current;
	if (current.status === "deployed_unverified") {
		const next: MigrationExecutionReceipt = {
			...current,
			revision: current.revision + 1,
			status: "verified",
			verification: { evidenceSha, proofSha },
		};
		await saveMigrationReceipt(home, next, current.revision);
		current = next;
	}
	proofSha = await check();
	const next: MigrationExecutionReceipt = {
		...current,
		revision: current.revision + 1,
		status: "committed",
		verification: { evidenceSha, proofSha },
	};
	await saveMigrationReceipt(home, next, current.revision);
	return next;
}

/** Only receipt-bound successful intent retirement; archive content is immutable. */
export async function retireCommittedMigrationIntent(
	home: string,
	intentSha: string,
): Promise<void> {
	const dir = migrationArtifactDirectory(home),
		lock = join(dir, "receipt.lock");
	try {
		const stat = lstatSync(lock);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return bad();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await withMkdirLock(lock, async () => {
		const receipt = loadMigrationReceipt(home);
		if (
			receipt?.status !== "committed" ||
			!receipt.verification ||
			receipt.intentSha !== intentSha
		)
			throw Error("migration intent is not committed");
		const active = join(dir, "FLY-2459-honey-lemon.json"),
			archive = join(dir, "FLY-2459-honey-lemon.committed.json");
		const present = (path: string) => {
			try {
				lstatSync(path);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
				throw error;
			}
		};
		if (present(archive)) {
			if (readCommittedMigrationIntent(home).intentSha !== intentSha)
				throw Error("migration archive conflict");
			if (present(active))
				throw Error("migration active intent reappeared after commitment");
			return;
		}
		if (readMigrationIntentRecord(home, active).intentSha !== intentSha)
			throw Error("migration intent changed before retirement");
		// Receipt lock serializes all retirement callers. No archive replacement is permitted.
		renameSync(active, archive);
		const fd = openSync(dir, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	});
}
