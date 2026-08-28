import { execFileSync } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { appendRotatedLogSync } from "flywheel-config";
import {
	effectiveLeadBackend,
	readCanonicalLeadCatalog,
} from "./canonical-lead.js";
import {
	type CanonicalLeadIdentity,
	LeadIdentityError,
	resolveLeadIdentity,
} from "./lead-identity.js";
import { LeadLeaseModeStore } from "./lead-lease-mode.js";
import type { MessageProvenance } from "./types.js";

export {
	type LeadLeaseMode,
	type LeadLeaseModeRead,
	LeadLeaseModeStore,
} from "./lead-lease-mode.js";
export type { MessageProvenance } from "./types.js";

const LEAD_LEASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS lead_lease (
  lead_key TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  identity_digest TEXT,
  generation INTEGER NOT NULL,
  supervisor_pid INTEGER,
  supervisor_start TEXT,
  supervisor_generation INTEGER,
  holder_pid INTEGER,
  holder_start TEXT,
  bound_at TEXT,
  acquired_at TEXT NOT NULL,
  acquired_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lease_generation_history (
  lead_key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  holder_pid INTEGER NOT NULL,
  holder_start TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  PRIMARY KEY (lead_key, generation)
);
CREATE TABLE IF NOT EXISTS lease_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_key TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL,
  materialized_at TEXT
);
CREATE TABLE IF NOT EXISTS store_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

export class LeaseStoreError extends Error {
	constructor(
		message: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "LeaseStoreError";
	}
}

export class LeadLeaseDeniedError extends Error {
	constructor(
		message: string,
		public readonly reason: string,
	) {
		super(message);
		this.name = "LeadLeaseDeniedError";
	}
}

export interface LeadLeaseRow {
	leadKey: string;
	project: string;
	leadId: string;
	identityDigest: string | null;
	generation: number;
	supervisorPid: number | null;
	supervisorStart: string | null;
	supervisorGeneration: number | null;
	holderPid: number | null;
	holderStart: string | null;
	boundAt: string | null;
	acquiredAt: string;
	acquiredBy: string;
}

export type ProcessTupleState = "alive" | "dead" | "sensor_error";

export type LeadLeaseRowFormat = "version_valid" | "legacy" | "malformed";

export interface LeadLeaseHistoryRow {
	leadKey: string;
	generation: number;
	holderPid: number;
	holderStart: string;
	boundAt: string;
}

export interface LeaseAuditRow {
	id: number;
	leadKey: string;
	event: string;
	detail: string | null;
	createdAt: string;
	materializedAt: string | null;
}

export interface LeadWriteAuthorizationDeps {
	now?: () => number;
	processAliveWithStart?: (pid: number, start: string) => boolean;
	processStart?: (pid: number) => string;
	/** Readiness-only probe. null means the process environment was unprovable. */
	processEnvHas?: (pid: number, name: string) => boolean | null;
}

export interface AcquireLeaseInput {
	leadKey: string;
	project: string;
	leadId: string;
	/** Canonical digest, or explicit null only when constructing a legacy row. */
	identityDigest: string | null;
	supervisorPid: number;
	supervisorStart: string;
	acquiredBy: string;
	now?: string;
}

export interface BindLeaseInput {
	leadKey: string;
	generation: number;
	expectedSupervisorPid: number;
	expectedSupervisorStart: string;
	panePid: number;
	paneStart: string;
	/** Required for canonical rows; omitted only matches a legacy NULL row. */
	identityDigest?: string;
	now?: string;
}

export interface VerifyBoundLeaseInput {
	leadKey: string;
	expectedSupervisorPid: number;
	expectedSupervisorStart: string;
	expectedHolderPid: number;
	expectedHolderStart: string;
	/** Required by the CLI; omitted only verifies legacy lifecycle shape. */
	identityDigest?: string;
}

interface RawLeaseRow {
	lead_key: string;
	project: string;
	lead_id: string;
	identity_digest: string | null;
	generation: number;
	supervisor_pid: number | null;
	supervisor_start: string | null;
	supervisor_generation: number | null;
	holder_pid: number | null;
	holder_start: string | null;
	bound_at: string | null;
	acquired_at: string;
	acquired_by: string;
}

interface RawHistoryRow {
	lead_key: string;
	generation: number;
	holder_pid: number;
	holder_start: string;
	bound_at: string;
}

interface RawAuditRow {
	id: number;
	lead_key: string;
	event: string;
	detail: string | null;
	created_at: string;
	materialized_at: string | null;
}

function mapLease(row: RawLeaseRow): LeadLeaseRow {
	return {
		leadKey: row.lead_key,
		project: row.project,
		leadId: row.lead_id,
		identityDigest: row.identity_digest,
		generation: row.generation,
		supervisorPid: row.supervisor_pid,
		supervisorStart: row.supervisor_start,
		supervisorGeneration: row.supervisor_generation,
		holderPid: row.holder_pid,
		holderStart: row.holder_start,
		boundAt: row.bound_at,
		acquiredAt: row.acquired_at,
		acquiredBy: row.acquired_by,
	};
}

function mapHistory(row: RawHistoryRow): LeadLeaseHistoryRow {
	return {
		leadKey: row.lead_key,
		generation: row.generation,
		holderPid: row.holder_pid,
		holderStart: row.holder_start,
		boundAt: row.bound_at,
	};
}

function mapAudit(row: RawAuditRow): LeaseAuditRow {
	return {
		id: row.id,
		leadKey: row.lead_key,
		event: row.event,
		detail: row.detail,
		createdAt: row.created_at,
		materializedAt: row.materialized_at,
	};
}

function isValidProcessTuple(
	pid: number | null,
	start: string | null,
): boolean {
	return (
		pid !== null &&
		Number.isSafeInteger(pid) &&
		pid > 0 &&
		start !== null &&
		start.trim().length > 0
	);
}

function leaseRowFormat(row: RawLeaseRow): LeadLeaseRowFormat {
	const supervisorFields = [
		row.supervisor_pid,
		row.supervisor_start,
		row.supervisor_generation,
	];
	if (supervisorFields.every((value) => value === null)) return "legacy";
	if (isValidProcessTuple(row.supervisor_pid, row.supervisor_start)) {
		if (row.supervisor_generation === null) return "legacy";
		if (!Number.isSafeInteger(row.supervisor_generation)) return "malformed";
		return row.supervisor_generation === row.generation
			? "version_valid"
			: "legacy";
	}
	return "malformed";
}

/** Match both PID and immutable OS launch time, so PID reuse is not liveness. */
export function getProcessStart(pid: number): string {
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		throw new Error(`invalid pid: ${pid}`);
	}
	const actual = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
	if (!actual) throw new Error(`process ${pid} has no lstart`);
	return actual;
}

export function processStateIsZombie(state: string): boolean {
	return state.trimStart().startsWith("Z");
}

export function getProcessState(pid: number): string {
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		throw new Error(`invalid pid: ${pid}`);
	}
	const state = execFileSync("ps", ["-o", "state=", "-p", String(pid)], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
	if (!state) throw new Error(`process ${pid} has no state`);
	return state;
}

export function processAliveWithStart(
	pid: number,
	expectedStart: string,
): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0 || expectedStart.length === 0) {
		return false;
	}
	try {
		return getProcessStart(pid) === expectedStart.trim();
	} catch {
		return false;
	}
}

/**
 * Fail closed when the OS can confirm neither death nor an immutable tuple.
 * A mismatched lstart is a conclusive PID-reuse/death result for this tuple.
 */
export function processTupleStateWithStart(
	pid: number,
	expectedStart: string,
): ProcessTupleState {
	if (
		!Number.isSafeInteger(pid) ||
		pid <= 0 ||
		expectedStart.trim().length === 0
	) {
		return "sensor_error";
	}
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH"
			? "dead"
			: "sensor_error";
	}
	try {
		if (getProcessStart(pid) !== expectedStart.trim()) return "dead";
		return processStateIsZombie(getProcessState(pid)) ? "dead" : "alive";
	} catch {
		try {
			process.kill(pid, 0);
			return "sensor_error";
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH"
				? "dead"
				: "sensor_error";
		}
	}
}

function processEnvHas(pid: number, name: string): boolean | null {
	if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[A-Z0-9_]+$/.test(name)) {
		return null;
	}
	try {
		const command = execFileSync(
			"ps",
			["eww", "-p", String(pid), "-o", "command="],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		return new RegExp(`(?:^|\\s)${name}=`).test(command);
	} catch {
		return null;
	}
}

export function hashCarrierInstanceId(rawInstanceId: string): string {
	return createHash("sha256").update(rawInstanceId).digest("hex");
}

/** Exact loopback contract shared with the Bridge server-side Host guard. */
export function isAllowedLoopbackHostname(hostname: string): boolean {
	return (
		hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
	);
}

/**
 * A raw carrier capability may leave a process only toward the local Bridge.
 * Do not broaden this to 127/8 or DNS-resolved hosts: client and server must
 * accept the same three literal loopback identities.
 */
export function assertLoopbackCarrierUrl(rawUrl: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error("carrier capability URL must be a valid loopback URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("carrier capability URL protocol must be http or https");
	}
	if (parsed.username || parsed.password) {
		throw new Error("carrier capability URL must not contain userinfo");
	}
	const hostname =
		parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
			? parsed.hostname.slice(1, -1)
			: parsed.hostname;
	if (!isAllowedLoopbackHostname(hostname)) {
		throw new Error(
			"carrier capability URL must use an exact loopback hostname",
		);
	}
	return parsed;
}

export async function postCarrierClaim(input: {
	url: string;
	carrierClaim: string;
	body: Record<string, unknown>;
	headers?: RequestInit["headers"];
	fetchImpl?: typeof fetch;
}): Promise<Response> {
	if (!input.carrierClaim) {
		throw new Error("carrier capability claim must be non-empty");
	}
	const url = assertLoopbackCarrierUrl(input.url);
	const headers = new Headers(input.headers);
	if (!headers.has("content-type")) {
		headers.set("content-type", "application/json");
	}
	return (input.fetchImpl ?? fetch)(url.href, {
		method: "POST",
		headers,
		body: JSON.stringify({ ...input.body, carrierClaim: input.carrierClaim }),
		redirect: "error",
	});
}

export class LeadLeaseStore {
	private readonly db: Database.Database;
	private readonly processTupleState: (
		pid: number,
		start: string,
	) => ProcessTupleState;

	constructor(
		dbPath: string,
		deps: {
			processAliveWithStart?: (pid: number, start: string) => boolean;
			processTupleState?: (pid: number, start: string) => ProcessTupleState;
		} = {},
	) {
		this.processTupleState =
			deps.processTupleState ??
			(deps.processAliveWithStart
				? (pid, start) =>
						deps.processAliveWithStart?.(pid, start) ? "alive" : "dead"
				: processTupleStateWithStart);
		try {
			mkdirSync(dirname(dbPath), { recursive: true });
			this.db = new Database(dbPath);
			this.db.pragma("journal_mode = WAL");
			this.db.pragma("busy_timeout = 5000");
			this.db.exec(LEAD_LEASE_SCHEMA);
			this.migrateSupervisorColumns();
			this.db
				.prepare(
					"INSERT OR IGNORE INTO store_meta (k, v) VALUES ('store_instance_id', ?)",
				)
				.run(randomUUID());
		} catch (error) {
			throw new LeaseStoreError(
				`failed to open lead lease store at ${dbPath}`,
				error,
			);
		}
	}

	private migrateSupervisorColumns(): void {
		const migrations = [
			["supervisor_pid", "INTEGER"],
			["supervisor_start", "TEXT"],
			["supervisor_generation", "INTEGER"],
			["identity_digest", "TEXT"],
		] as const;
		for (const [column, type] of migrations) {
			try {
				this.db.exec(`ALTER TABLE lead_lease ADD COLUMN ${column} ${type}`);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					error.message !== `duplicate column name: ${column}`
				) {
					throw error;
				}
			}
		}
	}

	acquire(input: AcquireLeaseInput):
		| { status: "acquired" | "idempotent"; generation: number }
		| {
				status: "idempotent_adopted";
				generation: number;
				holderPid: number;
				holderStart: string;
		  }
		| {
				status: "holder_orphaned";
				generation: number;
				holderPid: number;
				holderStart: string;
				supervisorPid: number;
				supervisorStart: string;
		  }
		| {
				status:
					| "denied_holder_alive"
					| "denied_sensor_degraded"
					| "denied_identity_drift_live"
					| "denied_identity_drift_sensor_degraded";
				generation: number;
		  } {
		const transaction = this.db.transaction((args: AcquireLeaseInput) => {
			const existing = this.readLease(args.leadKey);
			const requestedIdentityDigest = args.identityDigest ?? null;
			if (existing !== undefined) {
				if (
					existing.identity_digest !== null &&
					requestedIdentityDigest === null
				) {
					throw new LeaseStoreError(
						`identity digest cannot be removed from ${args.leadKey}`,
					);
				}
				const rowFormat = leaseRowFormat(existing);
				const identityDrift =
					existing.identity_digest !== requestedIdentityDigest;
				if (identityDrift) {
					if (rowFormat === "malformed") {
						return {
							status: "denied_identity_drift_sensor_degraded" as const,
							generation: existing.generation,
						};
					}
					const priorTupleStates =
						rowFormat === "legacy"
							? [this.tupleState(existing.holder_pid, existing.holder_start)]
							: existing.bound_at === null
								? [
										this.tupleState(
											existing.supervisor_pid,
											existing.supervisor_start,
										),
									]
								: [
										this.tupleState(
											existing.supervisor_pid,
											existing.supervisor_start,
										),
										this.tupleState(existing.holder_pid, existing.holder_start),
									];
					if (priorTupleStates.includes("alive")) {
						return {
							status: "denied_identity_drift_live" as const,
							generation: existing.generation,
						};
					}
					if (priorTupleStates.includes("sensor_error")) {
						return {
							status: "denied_identity_drift_sensor_degraded" as const,
							generation: existing.generation,
						};
					}
				}
				const requesterIsSupervisor =
					existing.supervisor_pid === args.supervisorPid &&
					existing.supervisor_start === args.supervisorStart;
				const requesterIsUnboundHolder =
					existing.bound_at === null &&
					existing.holder_pid === args.supervisorPid &&
					existing.holder_start === args.supervisorStart;

				if (!identityDrift && rowFormat === "malformed") {
					return {
						status: "denied_sensor_degraded" as const,
						generation: existing.generation,
					};
				}

				if (
					!identityDrift &&
					existing.bound_at === null &&
					requesterIsUnboundHolder &&
					(rowFormat === "legacy" || requesterIsSupervisor)
				) {
					if (rowFormat === "legacy") {
						this.db
							.prepare(
								`UPDATE lead_lease
								 SET supervisor_pid = ?, supervisor_start = ?,
								     supervisor_generation = generation
								 WHERE lead_key = ? AND generation = ?
								   AND holder_pid = ? AND holder_start = ? AND bound_at IS NULL`,
							)
							.run(
								args.supervisorPid,
								args.supervisorStart,
								args.leadKey,
								existing.generation,
								args.supervisorPid,
								args.supervisorStart,
							);
					}
					return {
						status: "idempotent" as const,
						generation: existing.generation,
					};
				}

				if (!identityDrift && rowFormat === "legacy") {
					const holderState = this.tupleState(
						existing.holder_pid,
						existing.holder_start,
					);
					if (holderState === "alive") {
						return {
							status: "denied_holder_alive" as const,
							generation: existing.generation,
						};
					}
					if (holderState === "sensor_error") {
						return {
							status: "denied_sensor_degraded" as const,
							generation: existing.generation,
						};
					}
				} else if (!identityDrift && existing.bound_at === null) {
					const supervisorState = this.tupleState(
						existing.supervisor_pid,
						existing.supervisor_start,
					);
					if (supervisorState === "alive") {
						return {
							status: "denied_holder_alive" as const,
							generation: existing.generation,
						};
					}
					if (supervisorState === "sensor_error") {
						return {
							status: "denied_sensor_degraded" as const,
							generation: existing.generation,
						};
					}
				} else if (!identityDrift && requesterIsSupervisor) {
					const holderState = this.tupleState(
						existing.holder_pid,
						existing.holder_start,
					);
					if (
						holderState === "alive" &&
						existing.holder_pid !== null &&
						existing.holder_start !== null
					) {
						return {
							status: "idempotent_adopted" as const,
							generation: existing.generation,
							holderPid: existing.holder_pid,
							holderStart: existing.holder_start,
						};
					}
					if (holderState === "sensor_error") {
						return {
							status: "denied_sensor_degraded" as const,
							generation: existing.generation,
						};
					}
				} else if (!identityDrift) {
					const supervisorState = this.tupleState(
						existing.supervisor_pid,
						existing.supervisor_start,
					);
					if (supervisorState === "alive") {
						return {
							status: "denied_holder_alive" as const,
							generation: existing.generation,
						};
					}
					if (supervisorState === "sensor_error") {
						return {
							status: "denied_sensor_degraded" as const,
							generation: existing.generation,
						};
					}

					const holderState = this.tupleState(
						existing.holder_pid,
						existing.holder_start,
					);
					if (
						holderState === "alive" &&
						existing.holder_pid !== null &&
						existing.holder_start !== null &&
						existing.supervisor_pid !== null &&
						existing.supervisor_start !== null
					) {
						return {
							status: "holder_orphaned" as const,
							generation: existing.generation,
							holderPid: existing.holder_pid,
							holderStart: existing.holder_start,
							supervisorPid: existing.supervisor_pid,
							supervisorStart: existing.supervisor_start,
						};
					}
					if (holderState === "sensor_error") {
						return {
							status: "denied_sensor_degraded" as const,
							generation: existing.generation,
						};
					}
				}
			}

			const generation = (existing?.generation ?? 0) + 1;
			this.db
				.prepare(
					`INSERT INTO lead_lease (
						lead_key, project, lead_id, identity_digest, generation,
						supervisor_pid, supervisor_start, supervisor_generation,
						holder_pid, holder_start, bound_at, acquired_at, acquired_by
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
					ON CONFLICT(lead_key) DO UPDATE SET
						project = excluded.project,
						lead_id = excluded.lead_id,
						identity_digest = excluded.identity_digest,
						generation = excluded.generation,
						supervisor_pid = excluded.supervisor_pid,
						supervisor_start = excluded.supervisor_start,
						supervisor_generation = excluded.supervisor_generation,
						holder_pid = excluded.holder_pid,
						holder_start = excluded.holder_start,
						bound_at = NULL,
						acquired_at = excluded.acquired_at,
						acquired_by = excluded.acquired_by`,
				)
				.run(
					args.leadKey,
					args.project,
					args.leadId,
					requestedIdentityDigest,
					generation,
					args.supervisorPid,
					args.supervisorStart,
					generation,
					args.supervisorPid,
					args.supervisorStart,
					args.now ?? new Date().toISOString(),
					args.acquiredBy,
				);
			return { status: "acquired" as const, generation };
		});
		try {
			return transaction.immediate(input);
		} catch (error) {
			if (error instanceof LeaseStoreError) throw error;
			throw new LeaseStoreError(
				`failed to acquire lead lease ${input.leadKey}`,
				error,
			);
		}
	}

	bind(input: BindLeaseInput): {
		status: "bound" | "stale_generation";
		generation: number;
	} {
		const transaction = this.db.transaction((args: BindLeaseInput) => {
			const boundAt = args.now ?? new Date().toISOString();
			const updated = this.db
				.prepare(
					`UPDATE lead_lease
					 SET holder_pid = ?, holder_start = ?, bound_at = ?
					 WHERE lead_key = ? AND generation = ?
					   AND identity_digest IS ?
					   AND supervisor_pid = ? AND supervisor_start = ?
					   AND supervisor_generation = generation
					   AND holder_pid = ? AND holder_start = ? AND bound_at IS NULL`,
				)
				.run(
					args.panePid,
					args.paneStart,
					boundAt,
					args.leadKey,
					args.generation,
					args.identityDigest ?? null,
					args.expectedSupervisorPid,
					args.expectedSupervisorStart,
					args.expectedSupervisorPid,
					args.expectedSupervisorStart,
				);
			if (updated.changes !== 1) {
				return {
					status: "stale_generation" as const,
					generation: args.generation,
				};
			}
			this.db
				.prepare(
					`INSERT INTO lease_generation_history
					 (lead_key, generation, holder_pid, holder_start, bound_at)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run(
					args.leadKey,
					args.generation,
					args.panePid,
					args.paneStart,
					boundAt,
				);
			return { status: "bound" as const, generation: args.generation };
		});
		try {
			return transaction.immediate(input);
		} catch (error) {
			throw new LeaseStoreError(
				`failed to bind lead lease ${input.leadKey}`,
				error,
			);
		}
	}

	verifyBound(input: VerifyBoundLeaseInput):
		| { status: "verified"; generation: number }
		| {
				status: "mismatch";
				reason:
					| "missing_lease"
					| "unbound"
					| "missing_identity_digest"
					| "identity_digest_mismatch"
					| "supervisor_mismatch"
					| "holder_mismatch"
					| "supervisor_generation_mismatch"
					| "missing_history";
		  } {
		const transaction = this.db.transaction((args: VerifyBoundLeaseInput) => {
			const lease = this.readLease(args.leadKey);
			if (!lease)
				return {
					status: "mismatch" as const,
					reason: "missing_lease" as const,
				};
			if (lease.bound_at === null) {
				return { status: "mismatch" as const, reason: "unbound" as const };
			}
			if (args.identityDigest !== undefined) {
				if (lease.identity_digest === null) {
					return {
						status: "mismatch" as const,
						reason: "missing_identity_digest" as const,
					};
				}
				if (lease.identity_digest !== args.identityDigest) {
					return {
						status: "mismatch" as const,
						reason: "identity_digest_mismatch" as const,
					};
				}
			}
			if (
				lease.supervisor_pid !== args.expectedSupervisorPid ||
				lease.supervisor_start !== args.expectedSupervisorStart
			) {
				return {
					status: "mismatch" as const,
					reason: "supervisor_mismatch" as const,
				};
			}
			if (
				lease.holder_pid !== args.expectedHolderPid ||
				lease.holder_start !== args.expectedHolderStart
			) {
				return {
					status: "mismatch" as const,
					reason: "holder_mismatch" as const,
				};
			}
			if (lease.supervisor_generation !== lease.generation) {
				return {
					status: "mismatch" as const,
					reason: "supervisor_generation_mismatch" as const,
				};
			}
			const history = this.db
				.prepare(
					"SELECT 1 FROM lease_generation_history WHERE lead_key = ? AND generation = ?",
				)
				.get(args.leadKey, lease.generation);
			if (!history) {
				return {
					status: "mismatch" as const,
					reason: "missing_history" as const,
				};
			}
			return { status: "verified" as const, generation: lease.generation };
		});
		try {
			return transaction(input);
		} catch (error) {
			throw new LeaseStoreError(
				`failed to verify bound lead lease ${input.leadKey}`,
				error,
			);
		}
	}

	progressSnapshot(leadKey: string):
		| { status: "absent" }
		| {
				status: "present";
				rowFormat: LeadLeaseRowFormat;
				generation: number;
				supervisorPid: number | null;
				supervisorStart: string | null;
				supervisorGeneration: number | null;
				holderPid: number | null;
				holderStart: string | null;
				boundAt: string | null;
				acquiredAt: string;
				identityDigest: string | null;
		  } {
		const transaction = this.db.transaction((key: string) => {
			const row = this.readLease(key);
			if (!row) return { status: "absent" as const };
			return {
				status: "present" as const,
				rowFormat: leaseRowFormat(row),
				generation: row.generation,
				supervisorPid: row.supervisor_pid,
				supervisorStart: row.supervisor_start,
				supervisorGeneration: row.supervisor_generation,
				holderPid: row.holder_pid,
				holderStart: row.holder_start,
				boundAt: row.bound_at,
				acquiredAt: row.acquired_at,
				identityDigest: row.identity_digest,
			};
		});
		try {
			return transaction(leadKey);
		} catch (error) {
			throw new LeaseStoreError(
				`failed to read lead lease progress ${leadKey}`,
				error,
			);
		}
	}

	validate(input: {
		leaseKey: string;
		generation: number;
		identityDigest: string;
	}):
		| { valid: true; reason: "current_bound" }
		| {
				valid: false;
				reason:
					| "missing_lease"
					| "stale_generation"
					| "unbound"
					| "missing_identity_digest"
					| "identity_digest_mismatch"
					| "missing_history";
		  } {
		const transaction = this.db.transaction(
			(args: {
				leaseKey: string;
				generation: number;
				identityDigest: string;
			}) => {
				const lease = this.readLease(args.leaseKey);
				if (!lease)
					return { valid: false as const, reason: "missing_lease" as const };
				if (lease.generation !== args.generation) {
					return {
						valid: false as const,
						reason: "stale_generation" as const,
					};
				}
				if (lease.identity_digest === null) {
					return {
						valid: false as const,
						reason: "missing_identity_digest" as const,
					};
				}
				if (lease.identity_digest !== args.identityDigest) {
					return {
						valid: false as const,
						reason: "identity_digest_mismatch" as const,
					};
				}
				if (lease.bound_at === null) {
					return { valid: false as const, reason: "unbound" as const };
				}
				const history = this.db
					.prepare(
						"SELECT 1 FROM lease_generation_history WHERE lead_key = ? AND generation = ?",
					)
					.get(args.leaseKey, args.generation);
				if (!history) {
					return { valid: false as const, reason: "missing_history" as const };
				}
				return { valid: true as const, reason: "current_bound" as const };
			},
		);
		return transaction(input);
	}

	getLease(leadKey: string): LeadLeaseRow | undefined {
		const row = this.readLease(leadKey);
		return row ? mapLease(row) : undefined;
	}

	getGenerationHistory(
		leadKey: string,
		generation: number,
	): LeadLeaseHistoryRow | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM lease_generation_history WHERE lead_key = ? AND generation = ?",
			)
			.get(leadKey, generation) as RawHistoryRow | undefined;
		return row ? mapHistory(row) : undefined;
	}

	getStoreInstanceId(): string {
		const row = this.db
			.prepare("SELECT v FROM store_meta WHERE k = 'store_instance_id'")
			.get() as { v: string };
		return row.v;
	}

	appendAudit(input: {
		leadKey: string;
		event: string;
		detail?: string | null;
		createdAt?: string;
	}): number {
		const info = this.db
			.prepare(
				"INSERT INTO lease_audit (lead_key, event, detail, created_at) VALUES (?, ?, ?, ?)",
			)
			.run(
				input.leadKey,
				input.event,
				input.detail ?? null,
				input.createdAt ?? new Date().toISOString(),
			);
		return Number(info.lastInsertRowid);
	}

	listPendingAudit(): LeaseAuditRow[] {
		return (
			this.db
				.prepare(
					"SELECT * FROM lease_audit WHERE materialized_at IS NULL ORDER BY id ASC",
				)
				.all() as RawAuditRow[]
		).map(mapAudit);
	}

	markAuditMaterialized(
		ids: readonly number[],
		now = new Date().toISOString(),
	): void {
		if (ids.length === 0) return;
		const statement = this.db.prepare(
			"UPDATE lease_audit SET materialized_at = ? WHERE id = ? AND materialized_at IS NULL",
		);
		const transaction = this.db.transaction((rowIds: readonly number[]) => {
			for (const id of rowIds) statement.run(now, id);
		});
		transaction.immediate(ids);
	}

	pruneMaterializedAudit(maxAgeMs: number, nowMs = Date.now()): number {
		const cutoff = new Date(nowMs - Math.max(0, maxAgeMs)).toISOString();
		return this.db
			.prepare(
				"DELETE FROM lease_audit WHERE materialized_at IS NOT NULL AND created_at <= ?",
			)
			.run(cutoff).changes;
	}

	close(): void {
		this.db.close();
	}

	private tupleState(
		pid: number | null,
		start: string | null,
	): ProcessTupleState {
		if (!isValidProcessTuple(pid, start) || pid === null || start === null) {
			return "sensor_error";
		}
		return this.processTupleState(pid, start);
	}

	private readLease(leadKey: string): RawLeaseRow | undefined {
		return this.db
			.prepare("SELECT * FROM lead_lease WHERE lead_key = ?")
			.get(leadKey) as RawLeaseRow | undefined;
	}
}

export interface LeadWriteAuthorization {
	disposition:
		| "off"
		| "unprotected"
		| "lease_validated"
		| "carrier_passthrough"
		| "audit_allowed";
	provenance?: MessageProvenance;
	leaseClaim?: {
		leaseKey: string;
		generation: number;
		identityDigest: string;
	};
	identityDigest?: string;
	/** Raw capability: memory/loopback transport only. Never persist or log. */
	carrierClaim?: string;
}

export interface CarrierEvidenceEntry {
	leadKey: string;
	backend: "codex-app-server";
	identityDigest: string;
	pid: number;
	lstart: string;
	instanceDigest: string;
}

export interface CarrierEvidenceDocument {
	schemaVersion: number;
	collectedAt: string;
	leads: Record<string, CarrierEvidenceEntry>;
}

export interface CarrierRuntimeAssertion {
	schemaVersion: 1;
	leadKey: string;
	identityDigest: string;
	pid: number;
	lstart: string;
	instanceDigest: string;
	publishedAt: string;
}

const CARRIER_EVIDENCE_MAX_AGE_MS = 90_000;

function atomicWritePrivateJson(path: string, value: unknown): void {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	try {
		if (lstatSync(path).isSymbolicLink()) {
			throw new Error(`refusing to replace symlink: ${path}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temp = join(parent, `.${process.pid}-${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(temp, "wx", 0o600);
		writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temp, path);
		const dirFd = openSync(parent, "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(temp);
		} catch {
			// Preserve the original write error.
		}
		throw error;
	}
}

function carrierAssertionPath(assertionDir: string, leadKey: string): string {
	if (!leadKey || leadKey === "." || leadKey === "..") {
		throw new Error("carrier assertion leadKey is invalid");
	}
	return join(assertionDir, `${encodeURIComponent(leadKey)}.json`);
}

function isCarrierRuntimeAssertion(
	value: unknown,
): value is CarrierRuntimeAssertion {
	if (!value || typeof value !== "object") return false;
	const row = value as Partial<CarrierRuntimeAssertion>;
	return (
		row.schemaVersion === 1 &&
		typeof row.leadKey === "string" &&
		/^[a-f0-9]{64}$/.test(row.identityDigest ?? "") &&
		Number.isSafeInteger(row.pid) &&
		(row.pid ?? 0) > 0 &&
		typeof row.lstart === "string" &&
		row.lstart.length > 0 &&
		/^[a-f0-9]{64}$/i.test(row.instanceDigest ?? "") &&
		typeof row.publishedAt === "string" &&
		Number.isFinite(Date.parse(row.publishedAt))
	);
}

/**
 * Runtime-side publication. Each carrier owns exactly one private assertion;
 * FleetPoller is the only component allowed to aggregate these into the
 * shared authorization-evidence snapshot.
 */
export function publishCarrierRuntimeAssertion(input: {
	env?: NodeJS.ProcessEnv;
	leadKey: string;
	identityDigest: string;
	rawCarrierInstanceId: string;
	pid: number;
	lstart: string;
	now?: string;
}): CarrierRuntimeAssertion {
	const env = input.env ?? process.env;
	const assertionDir =
		env.FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR ??
		join(homedir(), ".flywheel", "state", "carrier-assertions");
	const assertion: CarrierRuntimeAssertion = {
		schemaVersion: 1,
		leadKey: input.leadKey,
		identityDigest: input.identityDigest,
		pid: input.pid,
		lstart: input.lstart,
		instanceDigest: hashCarrierInstanceId(input.rawCarrierInstanceId),
		publishedAt: input.now ?? new Date().toISOString(),
	};
	if (!isCarrierRuntimeAssertion(assertion)) {
		throw new Error("carrier runtime assertion is invalid");
	}
	atomicWritePrivateJson(
		carrierAssertionPath(assertionDir, input.leadKey),
		assertion,
	);
	return assertion;
}

export function readCarrierRuntimeAssertion(
	env: NodeJS.ProcessEnv,
	leadKey: string,
): CarrierRuntimeAssertion | null {
	const assertionDir =
		env.FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR ??
		join(homedir(), ".flywheel", "state", "carrier-assertions");
	try {
		const parsed = JSON.parse(
			readFileSync(carrierAssertionPath(assertionDir, leadKey), "utf8"),
		) as unknown;
		return isCarrierRuntimeAssertion(parsed) && parsed.leadKey === leadKey
			? parsed
			: null;
	} catch {
		return null;
	}
}

/** Full-snapshot write primitive reserved for FleetPoller's single-writer path. */
export function writeCarrierAuthorizationEvidenceSnapshot(input: {
	env?: NodeJS.ProcessEnv;
	collectedAt: string;
	leads: Record<string, CarrierEvidenceEntry>;
}): void {
	const env = input.env ?? process.env;
	const path =
		env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE ??
		join(homedir(), ".flywheel", "lead-carrier-evidence.json");
	atomicWritePrivateJson(path, {
		schemaVersion: 1,
		collectedAt: input.collectedAt,
		leads: input.leads,
	} satisfies CarrierEvidenceDocument);
}

function safeDigestMatch(actualHex: string, expectedHex: string): boolean {
	if (
		!/^[a-f0-9]{64}$/i.test(actualHex) ||
		!/^[a-f0-9]{64}$/i.test(expectedHex)
	) {
		return false;
	}
	return timingSafeEqual(
		Buffer.from(actualHex, "hex"),
		Buffer.from(expectedHex, "hex"),
	);
}

function readCarrierEvidence(
	path: string,
	leadKey: string,
	identityDigest: string,
	rawClaim: string | undefined,
	nowMs: number,
	isAlive: (pid: number, start: string) => boolean,
):
	| { valid: true; evidence: CarrierEvidenceEntry }
	| { valid: false; reason: string } {
	if (!rawClaim) return { valid: false, reason: "carrier_claim_missing" };
	let document: CarrierEvidenceDocument;
	try {
		document = JSON.parse(
			readFileSync(path, "utf8"),
		) as CarrierEvidenceDocument;
	} catch {
		return { valid: false, reason: "carrier_evidence_unavailable" };
	}
	const collectedAt = Date.parse(document.collectedAt);
	if (
		!Number.isFinite(collectedAt) ||
		collectedAt > nowMs + 5_000 ||
		nowMs - collectedAt > CARRIER_EVIDENCE_MAX_AGE_MS
	) {
		return { valid: false, reason: "carrier_evidence_stale" };
	}
	const evidence = document.leads?.[leadKey];
	if (
		!evidence ||
		evidence.leadKey !== leadKey ||
		evidence.backend !== "codex-app-server" ||
		!/^[a-f0-9]{64}$/.test(evidence.identityDigest ?? "")
	) {
		return { valid: false, reason: "carrier_evidence_mismatch" };
	}
	if (!safeDigestMatch(evidence.identityDigest, identityDigest)) {
		return { valid: false, reason: "identity_digest_mismatch" };
	}
	if (!isAlive(evidence.pid, evidence.lstart)) {
		return { valid: false, reason: "carrier_process_stale" };
	}
	if (
		!safeDigestMatch(hashCarrierInstanceId(rawClaim), evidence.instanceDigest)
	) {
		return { valid: false, reason: "carrier_claim_wrong" };
	}
	return { valid: true, evidence };
}

export type LeadCarrierValidation =
	| {
			valid: true;
			disposition: "carrier_passthrough";
			leadKey: string;
			carrier: CarrierEvidenceEntry;
	  }
	| { valid: false; reason: string };

/** Side-effect-free carrier check shared by runtime authorization and self-check. */
export function validateLeadCarrierAuthorization(
	input: { claimedLeadId: string; env?: NodeJS.ProcessEnv },
	deps: LeadWriteAuthorizationDeps = {},
): LeadCarrierValidation {
	const env = input.env ?? process.env;
	const projectName = env.FLYWHEEL_PROJECT_NAME;
	if (!projectName) {
		return { valid: false, reason: "identity_project_missing" };
	}
	let identity: CanonicalLeadIdentity;
	try {
		identity = resolveLeadIdentity({
			leadId: input.claimedLeadId,
			projectName,
			projectsPath:
				env.FLYWHEEL_PROJECTS_FILE ??
				join(homedir(), ".flywheel", "projects.json"),
		});
	} catch (error) {
		return {
			valid: false,
			reason:
				error instanceof LeadIdentityError
					? error.code
					: "identity_source_error",
		};
	}
	if (!env.FLYWHEEL_LEAD_IDENTITY_DIGEST) {
		return { valid: false, reason: "identity_digest_missing" };
	}
	if (
		!safeDigestMatch(env.FLYWHEEL_LEAD_IDENTITY_DIGEST, identity.identityDigest)
	) {
		return { valid: false, reason: "identity_digest_mismatch" };
	}
	if (identity.backend !== "codex-app-server") {
		return { valid: false, reason: "desired_backend_not_codex" };
	}
	const carrier = readCarrierEvidence(
		env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE ??
			join(homedir(), ".flywheel", "lead-carrier-evidence.json"),
		identity.leadKey,
		identity.identityDigest,
		env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID,
		deps.now?.() ?? Date.now(),
		deps.processAliveWithStart ?? processAliveWithStart,
	);
	if (!carrier.valid) return carrier;
	return {
		valid: true,
		disposition: "carrier_passthrough",
		leadKey: identity.leadKey,
		carrier: carrier.evidence,
	};
}

export const READINESS_SELF_CHECK_MAX_AGE_MS = 3_600_000;

export interface CarrierSelfCheckReceipt {
	schemaVersion: 1;
	contractVersion: 1;
	leadKey: string;
	identityDigest: string;
	instanceDigest: string;
	pid: number;
	lstart: string;
	checkedAt: string;
	cliDisposition: "carrier_passthrough";
	bridgeDisposition: "carrier_passthrough";
}

function carrierReceiptPath(receiptDir: string, leadKey: string): string {
	if (!leadKey || leadKey === "." || leadKey === "..") {
		throw new Error("carrier receipt leadKey is invalid");
	}
	return join(receiptDir, `${encodeURIComponent(leadKey)}.json`);
}

function isReceipt(value: unknown): value is CarrierSelfCheckReceipt {
	if (!value || typeof value !== "object") return false;
	const row = value as Partial<CarrierSelfCheckReceipt>;
	return (
		row.schemaVersion === 1 &&
		row.contractVersion === 1 &&
		typeof row.leadKey === "string" &&
		/^[a-f0-9]{64}$/.test(row.identityDigest ?? "") &&
		/^[a-f0-9]{64}$/i.test(row.instanceDigest ?? "") &&
		Number.isSafeInteger(row.pid) &&
		(row.pid ?? 0) > 0 &&
		typeof row.lstart === "string" &&
		row.lstart.length > 0 &&
		typeof row.checkedAt === "string" &&
		row.cliDisposition === "carrier_passthrough" &&
		row.bridgeDisposition === "carrier_passthrough"
	);
}

export function readCarrierReceipt(
	receiptDir: string,
	leadKey: string,
): CarrierSelfCheckReceipt | null {
	const path = carrierReceiptPath(receiptDir, leadKey);
	try {
		if (lstatSync(path).isSymbolicLink()) return null;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return isReceipt(parsed) && parsed.leadKey === leadKey ? parsed : null;
	} catch {
		return null;
	}
}

export function writeCarrierReceipt(
	receiptDir: string,
	receipt: CarrierSelfCheckReceipt,
): void {
	mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
	const path = carrierReceiptPath(receiptDir, receipt.leadKey);
	try {
		if (lstatSync(path).isSymbolicLink()) {
			throw new Error("refusing to replace symlink carrier receipt");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const tempPath = join(
		receiptDir,
		`.${encodeURIComponent(receipt.leadKey)}-${process.pid}-${randomUUID()}.tmp`,
	);
	let fd: number | undefined;
	try {
		fd = openSync(tempPath, "wx", 0o600);
		writeFileSync(fd, `${JSON.stringify(receipt)}\n`, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, path);
		const dirFd = openSync(receiptDir, "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(tempPath);
		} catch {
			// Preserve the original write error.
		}
		throw error;
	}
}

export type CarrierReceiptEvaluation = {
	ready: boolean;
	receiptAgeMs: number | null;
	maxAgeMs: number;
	expiryReason?:
		| "receipt_timestamp_invalid"
		| "receipt_from_future"
		| "receipt_expired"
		| "carrier_generation_mismatch"
		| "disposition_mismatch";
};

export function evaluateCarrierReceipt(
	receipt: CarrierSelfCheckReceipt,
	evidence: CarrierEvidenceEntry,
	nowMs = Date.now(),
): CarrierReceiptEvaluation {
	const checkedAt = Date.parse(receipt.checkedAt);
	if (!Number.isFinite(checkedAt) || !Number.isFinite(nowMs)) {
		return {
			ready: false,
			receiptAgeMs: null,
			maxAgeMs: READINESS_SELF_CHECK_MAX_AGE_MS,
			expiryReason: "receipt_timestamp_invalid",
		};
	}
	const age = nowMs - checkedAt;
	if (age < 0) {
		return {
			ready: false,
			receiptAgeMs: age,
			maxAgeMs: READINESS_SELF_CHECK_MAX_AGE_MS,
			expiryReason: "receipt_from_future",
		};
	}
	if (age >= READINESS_SELF_CHECK_MAX_AGE_MS) {
		return {
			ready: false,
			receiptAgeMs: age,
			maxAgeMs: READINESS_SELF_CHECK_MAX_AGE_MS,
			expiryReason: "receipt_expired",
		};
	}
	if (
		receipt.leadKey !== evidence.leadKey ||
		receipt.identityDigest !== evidence.identityDigest ||
		receipt.pid !== evidence.pid ||
		receipt.lstart !== evidence.lstart ||
		receipt.instanceDigest !== evidence.instanceDigest
	) {
		return {
			ready: false,
			receiptAgeMs: age,
			maxAgeMs: READINESS_SELF_CHECK_MAX_AGE_MS,
			expiryReason: "carrier_generation_mismatch",
		};
	}
	if (
		receipt.cliDisposition !== "carrier_passthrough" ||
		receipt.bridgeDisposition !== "carrier_passthrough"
	) {
		return {
			ready: false,
			receiptAgeMs: age,
			maxAgeMs: READINESS_SELF_CHECK_MAX_AGE_MS,
			expiryReason: "disposition_mismatch",
		};
	}
	return {
		ready: true,
		receiptAgeMs: age,
		maxAgeMs: READINESS_SELF_CHECK_MAX_AGE_MS,
	};
}

export const LEAD_LEASE_EPISODE_KINDS = [
	"lead_dual_active",
	"lead_dual_active_sensor_degraded",
	"lead_lease_store_broken",
	"lead_lease_control_broken",
	"lead_identity_source_broken",
	"lead_backend_drift",
] as const;

export type LeadLeaseEpisodeKind = (typeof LEAD_LEASE_EPISODE_KINDS)[number];
export type LeadLeaseEpisodeFaultState = "active" | "recovered";
export type LeadLeaseEpisodeDeliveryState =
	| "unmaterialized"
	| "queued"
	| "delivered"
	| "dead_lettered";

export interface LeadLeaseEpisode {
	episodeId: string;
	sourceFingerprint: string;
	kind: LeadLeaseEpisodeKind;
	faultState: LeadLeaseEpisodeFaultState;
	deliveryState: LeadLeaseEpisodeDeliveryState;
	payload: Record<string, unknown>;
	createdAt: string;
	recoveredAt: string | null;
	deliveryReason: string | null;
}

interface RawLeaseEpisode {
	episode_id: string;
	source_fingerprint: string;
	kind: string;
	fault_state: LeadLeaseEpisodeFaultState;
	delivery_state: LeadLeaseEpisodeDeliveryState;
	payload_json: string;
	created_at: string;
	recovered_at: string | null;
	delivery_reason: string | null;
}

const LEAD_LEASE_EPISODE_SCHEMA = `
CREATE TABLE IF NOT EXISTS episodes (
  episode_id TEXT PRIMARY KEY,
  source_fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  fault_state TEXT NOT NULL CHECK (fault_state IN ('active', 'recovered')),
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('unmaterialized', 'queued', 'delivered', 'dead_lettered')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  recovered_at TEXT,
  delivery_reason TEXT
);
CREATE TABLE IF NOT EXISTS episode_pointer (
  source_fingerprint TEXT PRIMARY KEY,
  active_episode_id TEXT NOT NULL,
  FOREIGN KEY(active_episode_id) REFERENCES episodes(episode_id)
);
CREATE INDEX IF NOT EXISTS idx_lease_episode_delivery
  ON episodes(delivery_state, created_at);
`;

function mapLeaseEpisode(row: RawLeaseEpisode): LeadLeaseEpisode {
	return {
		episodeId: row.episode_id,
		sourceFingerprint: row.source_fingerprint,
		kind: row.kind as LeadLeaseEpisodeKind,
		faultState: row.fault_state,
		deliveryState: row.delivery_state,
		payload: JSON.parse(row.payload_json) as Record<string, unknown>,
		createdAt: row.created_at,
		recoveredAt: row.recovered_at,
		deliveryReason: row.delivery_reason,
	};
}

/**
 * A separate durable store owns recurring lease-fault episode identity. Keeping
 * the active pointer and immutable episode row in one BEGIN IMMEDIATE prevents
 * a stale recovery from deleting a later recurrence (the E1/E2 ABA shape).
 */
export class LeadLeaseEpisodeStore {
	private readonly db: Database.Database;

	constructor(readonly path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db = new Database(path);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("busy_timeout = 5000");
		this.db.pragma("foreign_keys = ON");
		this.db.exec(LEAD_LEASE_EPISODE_SCHEMA);
	}

	ensure(input: {
		sourceFingerprint: string;
		kind: LeadLeaseEpisodeKind;
		payload: Record<string, unknown>;
		now?: string;
	}): { created: boolean; episode: LeadLeaseEpisode } {
		if (!input.sourceFingerprint.trim()) {
			throw new Error("lease episode source fingerprint must be non-empty");
		}
		if (!LEAD_LEASE_EPISODE_KINDS.includes(input.kind)) {
			throw new Error(`invalid lease episode kind: ${input.kind}`);
		}
		const transaction = this.db.transaction(() => {
			const pointer = this.db
				.prepare(
					"SELECT active_episode_id FROM episode_pointer WHERE source_fingerprint = ?",
				)
				.get(input.sourceFingerprint) as
				| { active_episode_id: string }
				| undefined;
			if (pointer) {
				const existing = this.readEpisode(pointer.active_episode_id);
				if (existing)
					return { created: false, episode: mapLeaseEpisode(existing) };
				// A manually damaged pointer must not permanently suppress the alert.
				this.db
					.prepare(
						"DELETE FROM episode_pointer WHERE source_fingerprint = ? AND active_episode_id = ?",
					)
					.run(input.sourceFingerprint, pointer.active_episode_id);
			}
			const episodeId = randomUUID();
			const createdAt = input.now ?? new Date().toISOString();
			this.db
				.prepare(
					`INSERT INTO episodes (
					  episode_id, source_fingerprint, kind, fault_state,
					  delivery_state, payload_json, created_at
					) VALUES (?, ?, ?, 'active', 'unmaterialized', ?, ?)`,
				)
				.run(
					episodeId,
					input.sourceFingerprint,
					input.kind,
					JSON.stringify(input.payload),
					createdAt,
				);
			this.db
				.prepare(
					"INSERT INTO episode_pointer (source_fingerprint, active_episode_id) VALUES (?, ?)",
				)
				.run(input.sourceFingerprint, episodeId);
			return {
				created: true,
				episode: mapLeaseEpisode(this.readEpisode(episodeId)!),
			};
		});
		return transaction.immediate();
	}

	recover(
		sourceFingerprint: string,
		expectedEpisodeId?: string,
		now = new Date().toISOString(),
	): boolean {
		const transaction = this.db.transaction(() => {
			const pointer = this.db
				.prepare(
					"SELECT active_episode_id FROM episode_pointer WHERE source_fingerprint = ?",
				)
				.get(sourceFingerprint) as { active_episode_id: string } | undefined;
			if (!pointer) return false;
			if (
				expectedEpisodeId &&
				pointer.active_episode_id !== expectedEpisodeId
			) {
				return false;
			}
			const deleted = this.db
				.prepare(
					"DELETE FROM episode_pointer WHERE source_fingerprint = ? AND active_episode_id = ?",
				)
				.run(sourceFingerprint, pointer.active_episode_id).changes;
			if (deleted !== 1) return false;
			this.db
				.prepare(
					"UPDATE episodes SET fault_state = 'recovered', recovered_at = ? WHERE episode_id = ? AND fault_state = 'active'",
				)
				.run(now, pointer.active_episode_id);
			return true;
		});
		return transaction.immediate();
	}

	markDelivery(
		episodeId: string,
		state: Exclude<LeadLeaseEpisodeDeliveryState, "unmaterialized">,
		reason?: string,
	): boolean {
		const terminal = state === "delivered" || state === "dead_lettered";
		const predicate = terminal
			? "delivery_state NOT IN ('delivered', 'dead_lettered')"
			: "delivery_state = 'unmaterialized'";
		return (
			this.db
				.prepare(
					`UPDATE episodes SET delivery_state = ?, delivery_reason = ? WHERE episode_id = ? AND ${predicate}`,
				)
				.run(state, reason ?? null, episodeId).changes === 1
		);
	}

	/** Rebuild the minimum audit row when the episode DB was lost after enqueue. */
	restoreQueued(input: {
		episodeId: string;
		sourceFingerprint: string;
		kind: LeadLeaseEpisodeKind;
		payload: Record<string, unknown>;
		createdAt: string;
	}): boolean {
		return (
			this.db
				.prepare(
					`INSERT OR IGNORE INTO episodes (
					  episode_id, source_fingerprint, kind, fault_state,
					  delivery_state, payload_json, created_at, recovered_at,
					  delivery_reason
					) VALUES (?, ?, ?, 'recovered', 'queued', ?, ?, ?, 'restored_from_queue')`,
				)
				.run(
					input.episodeId,
					input.sourceFingerprint,
					input.kind,
					JSON.stringify(input.payload),
					input.createdAt,
					new Date().toISOString(),
				).changes === 1
		);
	}

	getActive(sourceFingerprint: string): LeadLeaseEpisode | undefined {
		const row = this.db
			.prepare(
				`SELECT e.* FROM episode_pointer p
				 JOIN episodes e ON e.episode_id = p.active_episode_id
				 WHERE p.source_fingerprint = ?`,
			)
			.get(sourceFingerprint) as RawLeaseEpisode | undefined;
		return row ? mapLeaseEpisode(row) : undefined;
	}

	getEpisode(episodeId: string): LeadLeaseEpisode | undefined {
		const row = this.readEpisode(episodeId);
		return row ? mapLeaseEpisode(row) : undefined;
	}

	listPending(): LeadLeaseEpisode[] {
		return (
			this.db
				.prepare(
					"SELECT * FROM episodes WHERE delivery_state IN ('unmaterialized', 'queued') ORDER BY created_at, episode_id",
				)
				.all() as RawLeaseEpisode[]
		).map(mapLeaseEpisode);
	}

	counts(): Record<LeadLeaseEpisodeDeliveryState, number> {
		const counts: Record<LeadLeaseEpisodeDeliveryState, number> = {
			unmaterialized: 0,
			queued: 0,
			delivered: 0,
			dead_lettered: 0,
		};
		const rows = this.db
			.prepare(
				"SELECT delivery_state, COUNT(*) AS count FROM episodes GROUP BY delivery_state",
			)
			.all() as Array<{
			delivery_state: LeadLeaseEpisodeDeliveryState;
			count: number;
		}>;
		for (const row of rows) counts[row.delivery_state] = row.count;
		return counts;
	}

	activeCount(): number {
		return (
			this.db
				.prepare("SELECT COUNT(*) AS count FROM episode_pointer")
				.get() as { count: number }
		).count;
	}

	close(): void {
		this.db.close();
	}

	private readEpisode(episodeId: string): RawLeaseEpisode | undefined {
		return this.db
			.prepare("SELECT * FROM episodes WHERE episode_id = ?")
			.get(episodeId) as RawLeaseEpisode | undefined;
	}
}

function episodeDbPath(env: NodeJS.ProcessEnv): string {
	return (
		env.FLYWHEEL_LEAD_EPISODE_DB ??
		join(homedir(), ".flywheel", "state", "lease-episodes.db")
	);
}

function episodeQueuePath(queueDir: string, episode: LeadLeaseEpisode): string {
	const stamp = episode.createdAt.replace(/[:.]/g, "-");
	return join(queueDir, `${stamp}-lead-episode-${episode.episodeId}.json`);
}

function writeEpisodeQueueFile(
	queueDir: string,
	episode: LeadLeaseEpisode,
): boolean {
	mkdirSync(queueDir, { recursive: true, mode: 0o700 });
	const path = episodeQueuePath(queueDir, episode);
	if (existsSync(path)) {
		const existing = JSON.parse(readFileSync(path, "utf8")) as {
			episodeId?: unknown;
		};
		if (existing.episodeId !== episode.episodeId) {
			throw new Error(`lease episode queue collision: ${path}`);
		}
		return false;
	}
	const tempPath = join(queueDir, `.${episode.episodeId}-${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(tempPath, "wx", 0o600);
		const queued = {
			...episode.payload,
			eventType: episode.kind,
			eventId: `lead-lease-episode:${episode.episodeId}`,
			episodeId: episode.episodeId,
			sourceFingerprint: episode.sourceFingerprint,
			queuedAt: episode.createdAt,
			queueReason: "lead-lease-episode",
		};
		writeFileSync(fd, `${JSON.stringify(queued)}\n`, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, path);
		const dirFd = openSync(queueDir, "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
		return true;
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(tempPath);
		} catch {
			// Preserve the original write error.
		}
		throw error;
	}
}

function materializeEpisode(
	store: LeadLeaseEpisodeStore,
	queueDir: string,
	episode: LeadLeaseEpisode,
): boolean {
	if (
		episode.deliveryState === "delivered" ||
		episode.deliveryState === "dead_lettered"
	) {
		return false;
	}
	const wrote = writeEpisodeQueueFile(queueDir, episode);
	store.markDelivery(episode.episodeId, "queued");
	return wrote;
}

export function ensureLeaseEpisodeMaterialized(input: {
	env?: NodeJS.ProcessEnv;
	sourceFingerprint: string;
	kind: LeadLeaseEpisodeKind;
	payload: Record<string, unknown>;
	now?: string;
}): {
	episodeId: string;
	sourceFingerprint: string;
	created: boolean;
	materialized: boolean;
} {
	const env = input.env ?? process.env;
	const store = new LeadLeaseEpisodeStore(episodeDbPath(env));
	try {
		const ensured = store.ensure(input);
		return {
			episodeId: ensured.episode.episodeId,
			sourceFingerprint: ensured.episode.sourceFingerprint,
			created: ensured.created,
			materialized: materializeEpisode(
				store,
				env.FLYWHEEL_ALERT_QUEUE_DIR ??
					join(homedir(), ".flywheel", "alert-queue"),
				ensured.episode,
			),
		};
	} finally {
		store.close();
	}
}

export function recoverLeaseEpisode(input: {
	env?: NodeJS.ProcessEnv;
	sourceFingerprint: string;
	expectedEpisodeId?: string;
	now?: string;
}): boolean {
	const env = input.env ?? process.env;
	const store = new LeadLeaseEpisodeStore(episodeDbPath(env));
	try {
		return store.recover(
			input.sourceFingerprint,
			input.expectedEpisodeId,
			input.now,
		);
	} finally {
		store.close();
	}
}

/** Re-drive pending episodes even after their underlying fault recovered. */
export function reconcileLeaseEpisodeQueue(
	env: NodeJS.ProcessEnv = process.env,
): { pending: number; materialized: number } {
	const store = new LeadLeaseEpisodeStore(episodeDbPath(env));
	let materialized = 0;
	try {
		const pending = store.listPending();
		for (const episode of pending) {
			if (
				materializeEpisode(
					store,
					env.FLYWHEEL_ALERT_QUEUE_DIR ??
						join(homedir(), ".flywheel", "alert-queue"),
					episode,
				)
			) {
				materialized++;
			}
		}
		return { pending: pending.length, materialized };
	} finally {
		store.close();
	}
}

export interface LeadLeaseDiagnostics {
	schemaVersion: 1;
	healthy: boolean;
	paths: {
		leaseDb: string;
		modeFile: string;
		projectsFile: string;
		carrierAssertionDir: string;
		carrierEvidenceFile: string;
		receiptDir: string;
		queueDir: string;
		deadLetterDir: string;
		episodeDb: string;
	};
	mode: ReturnType<LeadLeaseModeStore["read"]>;
	modeOverridePresent: boolean;
	resolver:
		| {
				status: "ok";
				projectsDigest: string;
				ambiguousLeadIds: string[];
		  }
		| { status: "source_error"; error: string };
	audit: { pending: number; deadLettered: number; storeHealthy: boolean };
	episodes: {
		healthy: boolean;
		active: number;
		counts: Record<LeadLeaseEpisodeDeliveryState, number>;
		error?: string;
	};
	leads: Array<{
		leadKey: string;
		leadId: string;
		projectName: string;
		backend: "claude-code" | "codex-app-server";
		ready: boolean;
		processModeOverridePresent: boolean | null;
		backendDrift: {
			desiredBackend: "claude-code" | "codex-app-server";
			drifted: boolean;
			reason: string | null;
			evidenceSource: "fleet_poller";
			evidencePresent: boolean;
			evidenceFresh: boolean;
			evidencePidAlive: boolean;
		};
		lease?: {
			bound: boolean;
			holderAlive: boolean;
			generation: number | null;
			pid: number | null;
			lstart: string | null;
		};
		carrierInstanceReady?: CarrierReceiptEvaluation & {
			evidencePresent: boolean;
			evidenceFresh: boolean;
			evidencePidAlive: boolean;
		};
	}>;
}

function countLeaseAuditDeadLetters(path: string): number {
	try {
		return readdirSync(path)
			.filter((name) => name.endsWith(".json"))
			.filter((name) => {
				try {
					const payload = JSON.parse(
						readFileSync(join(path, name), "utf8"),
					) as { queueReason?: unknown };
					return payload.queueReason === "lease-audit";
				} catch {
					return name.includes("lease-audit");
				}
			}).length;
	} catch {
		return 0;
	}
}

/** Secret-free local diagnostics shared byte-for-byte by CLI and Bridge. */
export function collectLeadLeaseDiagnostics(
	env: NodeJS.ProcessEnv = process.env,
	deps: LeadWriteAuthorizationDeps = {},
): LeadLeaseDiagnostics {
	const paths = {
		leaseDb:
			env.FLYWHEEL_LEAD_LEASE_DB ??
			join(homedir(), ".flywheel", "lead-lease.db"),
		modeFile:
			env.FLYWHEEL_LEAD_LEASE_MODE_FILE ??
			join(homedir(), ".flywheel", "lead-lease-mode.json"),
		projectsFile:
			env.FLYWHEEL_PROJECTS_FILE ??
			join(homedir(), ".flywheel", "projects.json"),
		carrierAssertionDir:
			env.FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR ??
			join(homedir(), ".flywheel", "state", "carrier-assertions"),
		carrierEvidenceFile:
			env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE ??
			join(homedir(), ".flywheel", "lead-carrier-evidence.json"),
		receiptDir:
			env.FLYWHEEL_LEAD_RECEIPT_DIR ??
			join(homedir(), ".flywheel", "state", "carrier-receipts"),
		queueDir:
			env.FLYWHEEL_ALERT_QUEUE_DIR ??
			join(homedir(), ".flywheel", "alert-queue"),
		deadLetterDir:
			env.FLYWHEEL_ALERT_DEADLETTER_DIR ??
			join(homedir(), ".flywheel", "alert-deadletter"),
		episodeDb: episodeDbPath(env),
	};
	const mode = new LeadLeaseModeStore(paths.modeFile, env).read();
	const catalog = readCanonicalLeadCatalog(paths.projectsFile);
	let leaseStore: LeadLeaseStore | undefined;
	let auditPending = 0;
	let leaseStoreHealthy = true;
	try {
		leaseStore = new LeadLeaseStore(paths.leaseDb, deps);
		auditPending = leaseStore.listPendingAudit().length;
	} catch {
		leaseStoreHealthy = false;
	}
	let episodeStore: LeadLeaseEpisodeStore | undefined;
	let episodeHealth = true;
	let activeEpisodes = 0;
	let episodeError: string | undefined;
	let episodeCounts: Record<LeadLeaseEpisodeDeliveryState, number> = {
		unmaterialized: 0,
		queued: 0,
		delivered: 0,
		dead_lettered: 0,
	};
	try {
		episodeStore = new LeadLeaseEpisodeStore(paths.episodeDb);
		episodeCounts = episodeStore.counts();
		activeEpisodes = episodeStore.activeCount();
	} catch (error) {
		episodeHealth = false;
		episodeError = error instanceof Error ? error.message : String(error);
	}
	let carrierDocument: CarrierEvidenceDocument | undefined;
	try {
		carrierDocument = JSON.parse(
			readFileSync(paths.carrierEvidenceFile, "utf8"),
		) as CarrierEvidenceDocument;
	} catch {
		// Each configured Codex Lead below reports evidencePresent=false.
	}
	const nowMs = deps.now?.() ?? Date.now();
	const isAlive = deps.processAliveWithStart ?? processAliveWithStart;
	const hasProcessEnv = deps.processEnvHas ?? processEnvHas;
	const carrierCollectedAt = Date.parse(carrierDocument?.collectedAt ?? "");
	const carrierDocumentFresh =
		Number.isFinite(carrierCollectedAt) &&
		carrierCollectedAt <= nowMs + 5_000 &&
		nowMs - carrierCollectedAt <= CARRIER_EVIDENCE_MAX_AGE_MS;
	const leads =
		catalog.status === "ok"
			? catalog.projects.flatMap((project) =>
					project.leads.map((lead) => {
						const leadKey = `${project.projectName}-${lead.agentId}`;
						const backend = effectiveLeadBackend(
							lead.backend,
							env.FLYWHEEL_LEAD_BACKEND,
						).backend;
						if (backend === "claude-code") {
							const row = leaseStore?.getLease(leadKey);
							const bound = Boolean(
								row?.boundAt && row.holderPid && row.holderStart,
							);
							const holderAlive = Boolean(
								bound &&
									isAlive(row!.holderPid as number, row!.holderStart as string),
							);
							const processModeOverridePresent = holderAlive
								? hasProcessEnv(
										row!.holderPid as number,
										"FLYWHEEL_LEAD_LEASE_MODE",
									)
								: null;
							const unexpectedEvidence = carrierDocument?.leads?.[leadKey];
							const unexpectedEvidencePidAlive = Boolean(
								unexpectedEvidence &&
									isAlive(unexpectedEvidence.pid, unexpectedEvidence.lstart),
							);
							const drifted = Boolean(
								unexpectedEvidence &&
									carrierDocumentFresh &&
									unexpectedEvidencePidAlive,
							);
							return {
								leadKey,
								leadId: lead.agentId,
								projectName: project.projectName,
								backend,
								ready:
									bound &&
									holderAlive &&
									processModeOverridePresent === false &&
									!drifted,
								processModeOverridePresent,
								backendDrift: {
									desiredBackend: backend,
									drifted,
									reason: drifted ? "unexpected_codex_carrier" : null,
									evidenceSource: "fleet_poller" as const,
									evidencePresent: Boolean(unexpectedEvidence),
									evidenceFresh: carrierDocumentFresh,
									evidencePidAlive: unexpectedEvidencePidAlive,
								},
								lease: {
									bound,
									holderAlive,
									generation: row?.generation ?? null,
									pid: row?.holderPid ?? null,
									lstart: row?.holderStart ?? null,
								},
							};
						}
						const evidence = carrierDocument?.leads?.[leadKey];
						const evidenceFresh = carrierDocumentFresh;
						const evidencePidAlive = Boolean(
							evidence && isAlive(evidence.pid, evidence.lstart),
						);
						const processModeOverridePresent = evidencePidAlive
							? hasProcessEnv(evidence!.pid, "FLYWHEEL_LEAD_LEASE_MODE")
							: null;
						const backendDriftReason = !evidence
							? "carrier_evidence_missing"
							: !evidenceFresh
								? "carrier_evidence_stale"
								: !evidencePidAlive
									? "carrier_process_stale"
									: null;
						const receipt = readCarrierReceipt(paths.receiptDir, leadKey);
						const receiptEvaluation =
							receipt && evidence
								? evaluateCarrierReceipt(receipt, evidence, nowMs)
								: {
										ready: false,
										receiptAgeMs: null,
										maxAgeMs: READINESS_SELF_CHECK_MAX_AGE_MS,
										expiryReason: "carrier_generation_mismatch" as const,
									};
						const carrierInstanceReady = {
							...receiptEvaluation,
							ready:
								receiptEvaluation.ready &&
								evidenceFresh &&
								evidencePidAlive &&
								processModeOverridePresent === false,
							evidencePresent: Boolean(evidence),
							evidenceFresh,
							evidencePidAlive,
						};
						return {
							leadKey,
							leadId: lead.agentId,
							projectName: project.projectName,
							backend,
							ready: carrierInstanceReady.ready,
							processModeOverridePresent,
							backendDrift: {
								desiredBackend: backend,
								drifted: backendDriftReason !== null,
								reason: backendDriftReason,
								evidenceSource: "fleet_poller" as const,
								evidencePresent: Boolean(evidence),
								evidenceFresh,
								evidencePidAlive,
							},
							carrierInstanceReady,
						};
					}),
				)
			: [];
	leaseStore?.close();
	episodeStore?.close();
	const deadLettered = countLeaseAuditDeadLetters(paths.deadLetterDir);
	const resolver =
		catalog.status === "ok"
			? {
					status: "ok" as const,
					projectsDigest: catalog.projectsDigest,
					ambiguousLeadIds: catalog.ambiguousLeadIds,
				}
			: catalog;
	const modeOverridePresent = env.FLYWHEEL_LEAD_LEASE_MODE !== undefined;
	const healthy =
		mode.source !== "corrupt_file" &&
		!modeOverridePresent &&
		catalog.status === "ok" &&
		catalog.ambiguousLeadIds.length === 0 &&
		leaseStoreHealthy &&
		episodeHealth &&
		auditPending === 0 &&
		deadLettered === 0 &&
		episodeCounts.unmaterialized === 0 &&
		episodeCounts.queued === 0 &&
		episodeCounts.dead_lettered === 0 &&
		activeEpisodes === 0 &&
		leads.every((lead) => lead.ready);
	return {
		schemaVersion: 1,
		healthy,
		paths,
		mode,
		modeOverridePresent,
		resolver,
		audit: {
			pending: auditPending,
			deadLettered,
			storeHealthy: leaseStoreHealthy,
		},
		episodes: {
			healthy: episodeHealth,
			active: activeEpisodes,
			counts: episodeCounts,
			...(episodeError ? { error: episodeError } : {}),
		},
		leads,
	};
}

function emitIndependentLeaseAlert(
	env: NodeJS.ProcessEnv,
	eventType: string,
	detail: Record<string, unknown>,
): void {
	const now = new Date().toISOString();
	const safeDetail = { ...detail };
	const payload = {
		eventType,
		queuedAt: now,
		eventId: randomUUID(),
		...safeDetail,
	};
	const queueDir =
		env.FLYWHEEL_ALERT_QUEUE_DIR ?? join(homedir(), ".flywheel", "alert-queue");
	const logPath =
		env.FLYWHEEL_LEAD_LEASE_AUDIT_LOG ??
		join(homedir(), ".flywheel", "logs", "lead-lease-audit.log");
	try {
		mkdirSync(queueDir, { recursive: true });
		writeFileSync(
			join(queueDir, `${Date.now()}-lead-lease-${payload.eventId}.json`),
			`${JSON.stringify(payload)}\n`,
			{ encoding: "utf8", flag: "wx", mode: 0o600 },
		);
	} catch (error) {
		process.stderr.write(
			`[flywheel-comm] failed to queue ${eventType}: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendRotatedLogSync(logPath, `${JSON.stringify(payload)}\n`);
	} catch (error) {
		process.stderr.write(
			`[flywheel-comm] failed to append ${eventType} audit: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
}

function recurringLeaseFaultFingerprint(
	env: NodeJS.ProcessEnv,
	eventType: LeadLeaseEpisodeKind,
	detail: Record<string, unknown>,
): string {
	switch (eventType) {
		case "lead_lease_control_broken":
			return `${eventType}:${env.FLYWHEEL_LEAD_LEASE_MODE_FILE ?? join(homedir(), ".flywheel", "lead-lease-mode.json")}`;
		case "lead_identity_source_broken":
			return `${eventType}:${env.FLYWHEEL_PROJECTS_FILE ?? join(homedir(), ".flywheel", "projects.json")}`;
		case "lead_lease_store_broken":
			return `${eventType}:${env.FLYWHEEL_LEAD_LEASE_DB ?? join(homedir(), ".flywheel", "lead-lease.db")}`;
		case "lead_backend_drift":
			return `${eventType}:carrier:${String(detail.leadKey ?? detail.leadId ?? "unknown")}`;
		case "lead_dual_active":
		case "lead_dual_active_sensor_degraded":
			return `${eventType}:${String(detail.leadKey ?? detail.leadId ?? "unknown")}`;
	}
}

function leaseAlertPayload(
	eventType: LeadLeaseEpisodeKind,
	detail: Record<string, unknown>,
): Record<string, unknown> {
	const leadId =
		typeof detail.leadId === "string" && detail.leadId
			? detail.leadId
			: "bridge";
	const projectName =
		typeof detail.projectName === "string" && detail.projectName
			? detail.projectName
			: "flywheel";
	return {
		...detail,
		leadId,
		projectName,
		title: eventType.replaceAll("_", " "),
		body: `Recurring Lead identity fault ${eventType} (${String(detail.reason ?? "detected")}).`,
		severity: "severe",
	};
}

function ensureRecurringLeaseAlert(
	env: NodeJS.ProcessEnv,
	eventType: LeadLeaseEpisodeKind,
	detail: Record<string, unknown>,
): void {
	try {
		let sourceFingerprint = recurringLeaseFaultFingerprint(
			env,
			eventType,
			detail,
		);
		if (eventType === "lead_backend_drift" && detail.leadKey) {
			let episodeStore: LeadLeaseEpisodeStore | undefined;
			try {
				episodeStore = new LeadLeaseEpisodeStore(episodeDbPath(env));
				const intruderFingerprint = `lead_backend_drift:claude_intruder:${String(detail.leadKey)}`;
				if (episodeStore.getActive(intruderFingerprint)) {
					sourceFingerprint = intruderFingerprint;
				}
			} finally {
				episodeStore?.close();
			}
		}
		const result = ensureLeaseEpisodeMaterialized({
			env,
			sourceFingerprint,
			kind: eventType,
			payload: leaseAlertPayload(eventType, detail),
		});
		if (result.created) {
			const logPath =
				env.FLYWHEEL_LEAD_LEASE_AUDIT_LOG ??
				join(homedir(), ".flywheel", "logs", "lead-lease-audit.log");
			mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
			appendRotatedLogSync(
				logPath,
				`${JSON.stringify({ eventType, episodeId: result.episodeId, sourceFingerprint: result.sourceFingerprint, ...detail })}\n`,
			);
		}
	} catch (error) {
		// The episode store is an anti-spam/audit owner, never an authorization
		// dependency. Fall back loudly: duplicates are safer than silence.
		emitIndependentLeaseAlert(env, eventType, {
			...leaseAlertPayload(eventType, detail),
			episodeStoreDegraded: true,
			episodeStoreError: error instanceof Error ? error.message : String(error),
		});
	}
}

function recoverRecurringLeaseAlert(
	env: NodeJS.ProcessEnv,
	eventType: LeadLeaseEpisodeKind,
	detail: Record<string, unknown>,
): void {
	try {
		recoverLeaseEpisode({
			env,
			sourceFingerprint: recurringLeaseFaultFingerprint(env, eventType, detail),
		});
	} catch (error) {
		process.stderr.write(
			`[flywheel-comm] failed to recover ${eventType} episode: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
}

function writeFaultAudit(
	store: LeadLeaseStore | undefined,
	leadKey: string,
	event: "would_block" | "blocked" | "bypass_used",
	reason: string,
	claimedLeadId: string,
): void {
	store?.appendAudit({
		leadKey,
		event,
		detail: JSON.stringify({ reason, claimedLeadId }),
	});
}

function denyIdentityIntegrity(reason: string): never {
	throw new LeadLeaseDeniedError(
		`lead identity integrity denied: ${reason}`,
		reason,
	);
}

/**
 * Identity integrity is not a lease rollout control. It is evaluated before
 * mode or audit posture and therefore can never be converted into an allowed
 * Lead write.
 */
function assertLeadIdentityIntegrity(
	claimedLeadId: string,
	env: NodeJS.ProcessEnv,
	onDeny?: (
		reason: string,
		identity: CanonicalLeadIdentity | undefined,
	) => void,
): CanonicalLeadIdentity {
	let identity: CanonicalLeadIdentity | undefined;
	const deny = (reason: string): never => {
		onDeny?.(reason, identity);
		return denyIdentityIntegrity(reason);
	};
	const projectName = env.FLYWHEEL_PROJECT_NAME;
	if (!projectName) return deny("identity_project_missing");
	const projectsPath =
		env.FLYWHEEL_PROJECTS_FILE ?? join(homedir(), ".flywheel", "projects.json");
	try {
		identity = resolveLeadIdentity({
			projectsPath,
			projectName,
			leadId: claimedLeadId,
		});
	} catch (error) {
		return deny(
			error instanceof LeadIdentityError ? error.code : "identity_source_error",
		);
	}
	if (
		env.FLYWHEEL_LEAD_ID !== undefined &&
		env.FLYWHEEL_LEAD_ID !== claimedLeadId
	) {
		return deny("claimed_lead_mismatch");
	}
	if (env.LEAD_ID !== undefined && env.LEAD_ID !== identity.leadId) {
		return deny("identity_env_conflict");
	}
	if (
		env.PROJECT_NAME !== undefined &&
		env.PROJECT_NAME !== identity.projectName
	) {
		return deny("identity_env_conflict");
	}
	if (
		env.FLYWHEEL_LEAD_KEY !== identity.leadKey ||
		env.FLYWHEEL_LEAD_BACKEND !== identity.backend ||
		env.DISCORD_STATE_DIR !== identity.discordStateDir ||
		(env.DISCORD_EXPECTED_BOT_USER_ID ?? "") !== (identity.botUserId ?? "")
	) {
		return deny("identity_env_conflict");
	}
	if (!env.FLYWHEEL_LEAD_IDENTITY_DIGEST) {
		return deny("identity_digest_missing");
	}
	if (env.FLYWHEEL_LEAD_IDENTITY_DIGEST !== identity.identityDigest) {
		return deny("identity_digest_mismatch");
	}
	return identity;
}

function persistIdentityIntegrityAudit(
	env: NodeJS.ProcessEnv,
	claimedLeadId: string,
	reason: string,
	identity: CanonicalLeadIdentity | undefined,
): void {
	if (!identity) return;
	const leaseDbPath =
		env.FLYWHEEL_LEAD_LEASE_DB ?? join(homedir(), ".flywheel", "lead-lease.db");
	let store: LeadLeaseStore | undefined;
	try {
		store = new LeadLeaseStore(leaseDbPath);
		writeFaultAudit(store, identity.leadKey, "blocked", reason, claimedLeadId);
	} catch {
		ensureRecurringLeaseAlert(env, "lead_lease_store_broken", {
			leadKey: identity.leadKey,
			leadId: claimedLeadId,
			reason: "identity_fault_audit_store_error",
			originalReason: reason,
		});
	} finally {
		store?.close();
	}
}

/**
 * Reconstruct the canonical comparison tuple for a Lead request received by
 * the Bridge. The caller-provided digest remains the freshness proof; every
 * other identity field is projected from the current registry row.
 */
export function forwardedLeadAuthorizationEnv(
	input: {
		claimedLeadId: string;
		projectName: string;
		identityDigest: string;
		leaseClaim?: { leaseKey: string; generation: number };
		carrierClaim?: string;
	},
	base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const env = { ...base };
	const projectsPath =
		env.FLYWHEEL_PROJECTS_FILE ?? join(homedir(), ".flywheel", "projects.json");
	const identity = resolveLeadIdentity({
		projectsPath,
		projectName: input.projectName,
		leadId: input.claimedLeadId,
	});
	for (const name of [
		"FLYWHEEL_LEAD_LEASE_KEY",
		"FLYWHEEL_LEAD_GENERATION",
		"FLYWHEEL_LEAD_CARRIER_INSTANCE_ID",
		"FLYWHEEL_PROJECTS",
	]) {
		delete env[name];
	}
	Object.assign(env, {
		FLYWHEEL_PROJECTS_FILE: projectsPath,
		FLYWHEEL_LEAD_ID: identity.leadId,
		LEAD_ID: identity.leadId,
		FLYWHEEL_PROJECT_NAME: identity.projectName,
		PROJECT_NAME: identity.projectName,
		FLYWHEEL_LEAD_KEY: identity.leadKey,
		FLYWHEEL_LEAD_ROLE: identity.role,
		FLYWHEEL_LEAD_BACKEND: identity.backend,
		DISCORD_STATE_DIR: identity.discordStateDir,
		DISCORD_EXPECTED_BOT_USER_ID: identity.botUserId ?? "",
		FLYWHEEL_LEAD_IDENTITY_DIGEST: input.identityDigest,
		FLYWHEEL_LEAD_PROJECTS_DIGEST: identity.projectsDigest,
	});
	if (input.leaseClaim) {
		env.FLYWHEEL_LEAD_LEASE_KEY = input.leaseClaim.leaseKey;
		env.FLYWHEEL_LEAD_GENERATION = String(input.leaseClaim.generation);
	}
	if (input.carrierClaim) {
		env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID = input.carrierClaim;
	}
	return env;
}

/**
 * Authorize one Lead-originated write. This is the shared CLI/Bridge seam:
 * commands must call it before mutating CommDB. Audit mode records the denial
 * that enforce would make; enforce throws before the caller can write.
 */
export function authorizeLeadWrite(
	input: { claimedLeadId: string; env?: NodeJS.ProcessEnv },
	deps: LeadWriteAuthorizationDeps = {},
): LeadWriteAuthorization {
	const env = input.env ?? process.env;
	const identity = assertLeadIdentityIntegrity(
		input.claimedLeadId,
		env,
		(reason, resolvedIdentity) =>
			persistIdentityIntegrityAudit(
				env,
				input.claimedLeadId,
				reason,
				resolvedIdentity,
			),
	);
	const modePath =
		env.FLYWHEEL_LEAD_LEASE_MODE_FILE ??
		join(homedir(), ".flywheel", "lead-lease-mode.json");
	const modeState = new LeadLeaseModeStore(modePath, env).read();
	if (modeState.mode === "off") {
		return { disposition: "off", identityDigest: identity.identityDigest };
	}
	if (modeState.source === "corrupt_file") {
		ensureRecurringLeaseAlert(env, "lead_lease_control_broken", {
			reason: modeState.error,
		});
	} else {
		recoverRecurringLeaseAlert(env, "lead_lease_control_broken", {});
	}
	const writerStart = (() => {
		try {
			return (deps.processStart ?? getProcessStart)(process.pid);
		} catch {
			return null;
		}
	})();
	const writerProvenance: MessageProvenance = {
		writerPid: process.pid,
		writerStart,
	};

	recoverRecurringLeaseAlert(env, "lead_identity_source_broken", {});
	const leadKey = identity.leadKey;
	const leaseDbPath =
		env.FLYWHEEL_LEAD_LEASE_DB ?? join(homedir(), ".flywheel", "lead-lease.db");
	let store: LeadLeaseStore | undefined;
	let decisionProvenance = writerProvenance;
	const attachClaimedHolder = (leaseStore: LeadLeaseStore): void => {
		const generation = Number(env.FLYWHEEL_LEAD_GENERATION);
		if (
			env.FLYWHEEL_LEAD_LEASE_KEY !== leadKey ||
			!Number.isSafeInteger(generation) ||
			generation <= 0
		) {
			return;
		}
		const history = leaseStore.getGenerationHistory(leadKey, generation);
		if (!history) return;
		decisionProvenance = {
			senderLeaseKey: leadKey,
			senderGeneration: generation,
			senderHolderPid: history.holderPid,
			senderHolderStart: history.holderStart,
			...writerProvenance,
		};
	};
	const persistFault = (
		event: "would_block" | "blocked" | "bypass_used",
		reason: string,
	): void => {
		if (store) {
			try {
				writeFaultAudit(store, leadKey, event, reason, input.claimedLeadId);
				return;
			} catch {
				ensureRecurringLeaseAlert(env, "lead_lease_store_broken", {
					leadKey,
					leadId: input.claimedLeadId,
					reason: "fault_audit_write_error",
					originalReason: reason,
				});
				return;
			}
		}
		let auditStore: LeadLeaseStore | undefined;
		try {
			auditStore = new LeadLeaseStore(leaseDbPath);
			recoverRecurringLeaseAlert(env, "lead_lease_store_broken", {});
			writeFaultAudit(auditStore, leadKey, event, reason, input.claimedLeadId);
		} catch {
			if (reason !== "lease_store_error") {
				ensureRecurringLeaseAlert(env, "lead_lease_store_broken", {
					leadKey,
					leadId: input.claimedLeadId,
					reason: "fault_audit_store_error",
					originalReason: reason,
				});
			}
		} finally {
			auditStore?.close();
		}
	};
	const denyOrAudit = (
		reason: string,
		alertType?: string,
	): LeadWriteAuthorization => {
		if (alertType) {
			if (
				LEAD_LEASE_EPISODE_KINDS.includes(alertType as LeadLeaseEpisodeKind)
			) {
				ensureRecurringLeaseAlert(env, alertType as LeadLeaseEpisodeKind, {
					leadKey,
					leadId: input.claimedLeadId,
					reason,
				});
			} else {
				emitIndependentLeaseAlert(env, alertType, {
					leadKey,
					leadId: input.claimedLeadId,
					reason,
				});
			}
		}
		if (modeState.mode === "audit_only") {
			persistFault("would_block", reason);
			process.stderr.write(
				`[flywheel-comm] lead lease audit_only would block ${leadKey}: ${reason}\n`,
			);
			return {
				disposition: "audit_allowed",
				provenance: decisionProvenance,
				identityDigest: identity.identityDigest,
			};
		}
		persistFault("blocked", reason);
		throw new LeadLeaseDeniedError(
			`lead identity lease denied ${input.claimedLeadId}: ${reason}`,
			reason,
		);
	};

	const backend = identity.backend;
	if (backend === "codex-app-server") {
		const carrier = validateLeadCarrierAuthorization(
			{ claimedLeadId: input.claimedLeadId, env },
			deps,
		);
		if (!carrier.valid) {
			return denyOrAudit(
				`backend_drift:${carrier.reason}`,
				"lead_backend_drift",
			);
		}
		recoverRecurringLeaseAlert(env, "lead_backend_drift", { leadKey });
		return {
			disposition: "carrier_passthrough",
			provenance: writerProvenance,
			carrierClaim: env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID,
			identityDigest: identity.identityDigest,
		};
	}

	try {
		store = new LeadLeaseStore(leaseDbPath);
		recoverRecurringLeaseAlert(env, "lead_lease_store_broken", {});
		const generation = Number(env.FLYWHEEL_LEAD_GENERATION);
		attachClaimedHolder(store);
		if (
			env.FLYWHEEL_LEAD_LEASE_KEY !== leadKey ||
			!Number.isSafeInteger(generation) ||
			generation <= 0
		) {
			return denyOrAudit("missing_or_mismatched_claim");
		}
		const validation = store.validate({
			leaseKey: leadKey,
			generation,
			identityDigest: identity.identityDigest,
		});
		if (!validation.valid) return denyOrAudit(validation.reason);
		const history = store.getGenerationHistory(leadKey, generation);
		if (!history) return denyOrAudit("missing_history");
		return {
			disposition: "lease_validated",
			leaseClaim: {
				leaseKey: leadKey,
				generation,
				identityDigest: identity.identityDigest,
			},
			identityDigest: identity.identityDigest,
			provenance: {
				senderLeaseKey: leadKey,
				senderGeneration: generation,
				senderHolderPid: history.holderPid,
				senderHolderStart: history.holderStart,
				...writerProvenance,
			},
		};
	} catch (error) {
		if (error instanceof LeadLeaseDeniedError) throw error;
		return denyOrAudit("lease_store_error", "lead_lease_store_broken");
	} finally {
		store?.close();
	}
}
