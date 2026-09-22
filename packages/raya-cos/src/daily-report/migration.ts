import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { join } from "node:path";
import {
	type DailyReportStatus,
	parseDailyReportState,
} from "../contracts/daily-report.js";
import { type JsonValue, OperationStore } from "../operation-store.js";

type Action =
	| "prepare_generation"
	| "reconcile_repository"
	| "reconcile_context"
	| "reconcile_delivery"
	| "preserve_posted"
	| "reconcile_failure_notice"
	| "preserve_failed"
	| "quarantine_required";
export interface ReportMigrationEntry {
	date: string;
	path: string;
	sha256: string;
	bytes: number;
	action: Action;
	legacyStatus?: DailyReportStatus;
	bodyVerified: boolean;
	body?: { path: string; sha256: string; bytes: number };
	reason?: string;
}
const actions: Record<DailyReportStatus, Action> = {
	generating: "prepare_generation",
	generated: "reconcile_repository",
	file_written: "reconcile_repository",
	ingesting: "reconcile_context",
	ingested: "reconcile_context",
	posting: "reconcile_delivery",
	posted_unknown: "reconcile_delivery",
	recovered_unknown: "reconcile_delivery",
	posted: "preserve_posted",
	failed_pending_notice: "reconcile_failure_notice",
	failed: "preserve_failed",
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function directory(path: string): boolean {
	try {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("unsafe migration directory or symlink");
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
function read(path: string, max: number): string {
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > max)
			throw new Error("invalid migration file");
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}
export function planDailyReportMigration(workspace: string): {
	schemaVersion: 1;
	kind: "daily_report_migration";
	entries: ReportMigrationEntry[];
	digest: string;
} {
	const root = realpathSync(workspace),
		state = join(root, "state"),
		dir = join(state, "daily-report");
	const entries: ReportMigrationEntry[] = [];
	if (directory(state) && directory(dir)) {
		const names = readdirSync(dir)
			.filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
			.sort();
		if (names.length > 10000)
			throw new Error("migration inventory exceeds limit");
		for (const name of names) {
			const date = name.slice(0, 10),
				path = `state/daily-report/${name}`,
				text = read(join(dir, name), 1024 * 1024);
			const entry: ReportMigrationEntry = {
				date,
				path,
				sha256: hash(text),
				bytes: Buffer.byteLength(text),
				action: "quarantine_required",
				bodyVerified: false,
			};
			try {
				const legacy = parseDailyReportState(text, date);
				entry.legacyStatus = legacy.status;
				if (legacy.bodyFile !== undefined) {
					const body = read(join(dir, legacy.bodyFile), 16 * 1024);
					if (
						hash(body) !== legacy.bodySha256 ||
						Buffer.byteLength(body) !== legacy.bodyBytes
					)
						throw new Error("body mismatch");
					entry.bodyVerified = true;
					entry.body = {
						path: `state/daily-report/${legacy.bodyFile}`,
						sha256: hash(body),
						bytes: Buffer.byteLength(body),
					};
				}
				entry.action = actions[legacy.status];
			} catch {
				entry.reason = "legacy_state_or_body_invalid";
			}
			entries.push(entry);
		}
	}
	return {
		schemaVersion: 1,
		kind: "daily_report_migration",
		entries,
		digest: hash(JSON.stringify(entries)),
	};
}

export function applyDailyReportMigration(
	workspace: string,
	expectedDigest: string,
	identity: { flywheelSha: string; rayaSha: string },
): { digest: string; imported: string[] } {
	if (
		!/^[a-f0-9]{64}$/.test(expectedDigest) ||
		Object.keys(identity).length !== 2 ||
		![identity.flywheelSha, identity.rayaSha].every(
			(sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha),
		)
	)
		throw new Error(
			"migration requires plan digest and paired commit identities",
		);
	const plan = planDailyReportMigration(workspace);
	if (plan.digest !== expectedDigest)
		throw new Error("migration inventory changed");
	if (plan.entries.some((entry) => entry.action === "quarantine_required"))
		throw new Error("migration requires explicit quarantine resolution");
	const store = new OperationStore(workspace),
		imported: string[] = [];
	// Check every target before writing a backup or reserving any date.
	const binding = hash(JSON.stringify({ digest: plan.digest, ...identity }));
	for (const entry of plan.entries) {
		const old = store.read(`daily-report:${entry.date}`);
		if (
			old &&
			(old.kind !== "daily_report" ||
				(old.material as Record<string, JsonValue>).migrationBinding !==
					binding)
		)
			throw new Error("migration target already owned");
	}
	for (const entry of plan.entries) {
		const raw = read(join(workspace, entry.path), 1024 * 1024);
		if (hash(raw) !== entry.sha256) throw new Error("migration source changed");
		const body = entry.body
			? read(join(workspace, entry.body.path), 16 * 1024)
			: null;
		if (entry.body && (body === null || hash(body) !== entry.body.sha256))
			throw new Error("migration body changed");
		const backupId = `daily-report-migration:${binding}:${entry.date}`;
		const backupMaterial = {
			entry: entry as unknown as JsonValue,
			rawState: raw,
			rawBody: body,
			identity,
			planDigest: plan.digest,
		};
		const oldBackup = store.read(backupId);
		if (oldBackup) {
			if (
				oldBackup.inputDigest !== binding ||
				JSON.stringify(oldBackup.material) !== JSON.stringify(backupMaterial)
			)
				throw new Error("migration backup conflict");
		} else
			store.commit(
				{
					operationId: backupId,
					kind: "migration_backup",
					inputDigest: binding,
					stage: "complete",
					sourceRefs: [entry.path],
					material: backupMaterial,
				},
				0,
			);
		// Revalidate after the durable backup, before the target's atomic CAS.
		if (planDailyReportMigration(workspace).digest !== expectedDigest)
			throw new Error("migration inventory changed after backup");
		const operationId = `daily-report:${entry.date}`;
		const existing = store.read(operationId);
		if (
			existing &&
			(existing.kind !== "daily_report" ||
				(existing.material as Record<string, JsonValue>).migrationBinding !==
					binding)
		)
			throw new Error("migration target already owned");
		if (!existing) {
			const legacy = parseDailyReportState(raw, entry.date);
			store.commit(
				{
					operationId,
					kind: "daily_report",
					inputDigest: binding,
					sourceRefs: [entry.path],
					stage:
						entry.action === "preserve_posted"
							? "posted"
							: entry.action === "preserve_failed"
								? "failed"
								: "legacy_reconciliation",
					material: {
						migrationBinding: binding,
						legacyMigration: {
							date: entry.date,
							action: entry.action,
							backupId,
							state: legacy as unknown as JsonValue,
						},
						receipts: [
							{
								action: "import_legacy_state",
								backupId,
								planDigest: plan.digest,
								identity,
							},
						],
					},
				},
				0,
			);
		}
		imported.push(operationId);
	}
	return { digest: plan.digest, imported };
}
