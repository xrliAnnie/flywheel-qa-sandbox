import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	LeadLeaseEpisodeStore,
	LeadLeaseStore,
	type LeaseAuditRow,
} from "flywheel-comm/lead-lease";
import type { LeadBackendId } from "../lead-backends/lead-backend.js";

export interface LeadProcess {
	pid: number;
	lstart: string;
	command: string;
	leadId: string;
}

function commandLeadId(command: string): string | null {
	const tokens = command.trim().split(/\s+/);
	if (tokens.length === 0) return null;
	const executable = tokens[0]!.split("/").pop();
	if (executable !== "claude" && executable !== "claude-code") return null;
	for (let index = 1; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token === "--agent") return tokens[index + 1] ?? null;
		if (token.startsWith("--agent=")) return token.slice("--agent=".length);
	}
	return null;
}

/** Parse `LC_ALL=C ps -axo pid=,lstart=,command=` into exact Lead processes. */
export function parseLeadProcessTable(snapshot: string): LeadProcess[] {
	const rows: LeadProcess[] = [];
	for (const rawLine of snapshot.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const match = line.match(
			/^(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+([\s\S]+)$/,
		);
		if (!match) continue;
		const pid = Number(match[1]);
		const lstart = match[2]!;
		const command = match[3]!;
		const leadId = commandLeadId(command);
		if (!Number.isSafeInteger(pid) || pid <= 0 || !leadId) continue;
		rows.push({ pid, lstart, command, leadId });
	}
	return rows;
}

export interface LeadScanTarget {
	projectName: string;
	leadId: string;
	desiredBackend: LeadBackendId;
	carrierDisposition?: string;
}

export type LeadIdentityFindingKind =
	| "lead_dual_active"
	| "lead_backend_drift"
	| "lead_dual_active_sensor_degraded";

export interface LeadIdentityFinding {
	kind: LeadIdentityFindingKind;
	projectName: string;
	leadId: string;
	processes: LeadProcess[];
	laterPid: number | null;
	ambiguousOrder: boolean;
	carrierDisposition?: string;
}

interface MonitorState {
	presentTicks: number;
	absentTicks: number;
	active: boolean;
}

export interface LeadDualActiveMonitorDeps {
	readProcessTable?: () => Promise<string>;
	notify: (finding: LeadIdentityFinding) => Promise<void> | void;
	onRecovery?: (finding: LeadIdentityFinding) => Promise<void> | void;
	enabled?: boolean;
	confirmationTicks?: number;
	recoveryTicks?: number;
	sensorFailureThreshold?: number;
}

function defaultReadProcessTable(): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"ps",
			["-axo", "pid=,lstart=,command="],
			{ encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		);
	});
}

function orderFinding(processes: LeadProcess[]): {
	laterPid: number | null;
	ambiguousOrder: boolean;
} {
	if (processes.length === 1) {
		return { laterPid: processes[0]!.pid, ambiguousOrder: false };
	}
	const ordered = processes
		.map((process) => ({ process, startedAt: Date.parse(process.lstart) }))
		.sort((a, b) => a.startedAt - b.startedAt || a.process.pid - b.process.pid);
	if (
		ordered.some((row) => !Number.isFinite(row.startedAt)) ||
		ordered.at(-1)?.startedAt === ordered.at(-2)?.startedAt
	) {
		return { laterPid: null, ambiguousOrder: true };
	}
	return { laterPid: ordered.at(-1)!.process.pid, ambiguousOrder: false };
}

/** Stateful two-tick latch; scanning/parsing itself remains side-effect free. */
export class LeadDualActiveMonitor {
	private readonly states = new Map<string, MonitorState>();
	private sensorFailures = 0;
	private sensorEpisodeActive = false;

	constructor(private readonly deps: LeadDualActiveMonitorDeps) {}

	async tick(targets: readonly LeadScanTarget[]): Promise<void> {
		if (this.deps.enabled === false) return;
		let snapshot: string;
		try {
			snapshot = await (
				this.deps.readProcessTable ?? defaultReadProcessTable
			)();
			this.sensorFailures = 0;
			if (this.sensorEpisodeActive) {
				this.sensorEpisodeActive = false;
				await this.deps.onRecovery?.({
					kind: "lead_dual_active_sensor_degraded",
					projectName: "flywheel",
					leadId: "bridge",
					processes: [],
					laterPid: null,
					ambiguousOrder: false,
				});
			}
		} catch {
			this.sensorFailures++;
			const threshold = this.deps.sensorFailureThreshold ?? 10;
			if (this.sensorFailures >= threshold && !this.sensorEpisodeActive) {
				this.sensorEpisodeActive = true;
				await this.deps.notify({
					kind: "lead_dual_active_sensor_degraded",
					projectName: "flywheel",
					leadId: "bridge",
					processes: [],
					laterPid: null,
					ambiguousOrder: true,
				});
			}
			return;
		}

		const processes = parseLeadProcessTable(snapshot);
		const liveKeys = new Set<string>();
		for (const target of targets) {
			const key = `${target.projectName}:${target.leadId}`;
			liveKeys.add(key);
			const matches = processes.filter((row) => row.leadId === target.leadId);
			const threshold = target.desiredBackend === "codex-app-server" ? 1 : 2;
			const present = matches.length >= threshold;
			const state = this.states.get(key) ?? {
				presentTicks: 0,
				absentTicks: 0,
				active: false,
			};
			this.states.set(key, state);
			if (present) {
				state.presentTicks++;
				state.absentTicks = 0;
				if (
					!state.active &&
					state.presentTicks >= (this.deps.confirmationTicks ?? 2)
				) {
					state.active = true;
					const order = orderFinding(matches);
					await this.deps.notify({
						kind:
							target.desiredBackend === "codex-app-server"
								? "lead_backend_drift"
								: "lead_dual_active",
						projectName: target.projectName,
						leadId: target.leadId,
						processes: matches,
						...order,
						...(target.carrierDisposition
							? { carrierDisposition: target.carrierDisposition }
							: {}),
					});
				}
			} else {
				state.presentTicks = 0;
				state.absentTicks++;
				if (
					state.active &&
					state.absentTicks >= (this.deps.recoveryTicks ?? 2)
				) {
					state.active = false;
					await this.deps.onRecovery?.({
						kind:
							target.desiredBackend === "codex-app-server"
								? "lead_backend_drift"
								: "lead_dual_active",
						projectName: target.projectName,
						leadId: target.leadId,
						processes: [],
						laterPid: null,
						ambiguousOrder: false,
					});
				}
			}
		}
		for (const key of this.states.keys()) {
			if (!liveKeys.has(key)) this.states.delete(key);
		}
	}
}

interface LeaseAuditQueuePayload {
	leadId: string;
	projectName: string;
	eventId: string;
	eventType: "lead_lease_would_block" | "lead_lease_bypass_used";
	title: string;
	body: string;
	severity: "warning" | "severe";
	queuedAt: string;
	queueReason: "lease-audit";
	leaseAudit: {
		batchId: string;
		payloadDigest: string;
		storeInstanceId: string;
		leadKey: string;
		event: string;
		rowIds: number[];
	};
}

export interface LeaseAuditOutboxOptions {
	dbPath: string;
	queueDir: string;
	afterFileCommit?: (path: string) => void;
	now?: () => Date;
	retentionMs?: number;
	episodeDbPath?: string;
}

const DEFAULT_MATERIALIZED_AUDIT_RETENTION_MS = 7 * 24 * 60 * 60_000;

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function auditEventType(event: string): LeaseAuditQueuePayload["eventType"] {
	return event === "bypass_used"
		? "lead_lease_bypass_used"
		: "lead_lease_would_block";
}

function identityFromRows(
	leadKey: string,
	rows: readonly LeaseAuditRow[],
): { projectName: string; leadId: string } {
	for (const row of rows) {
		try {
			const detail = JSON.parse(row.detail ?? "{}") as {
				claimedLeadId?: unknown;
			};
			if (
				typeof detail.claimedLeadId === "string" &&
				leadKey.endsWith(`-${detail.claimedLeadId}`)
			) {
				return {
					leadId: detail.claimedLeadId,
					projectName: leadKey.slice(0, -(detail.claimedLeadId.length + 1)),
				};
			}
		} catch {
			// Keep looking; malformed detail is audit content, never control flow.
		}
	}
	const separator = leadKey.lastIndexOf("-");
	return separator > 0
		? {
				projectName: leadKey.slice(0, separator),
				leadId: leadKey.slice(separator + 1),
			}
		: { projectName: "unknown", leadId: leadKey };
}

function atomicWrite(path: string, payload: string): void {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	const temp = join(parent, `.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(temp, "wx", 0o600);
		writeFileSync(fd, payload, "utf8");
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

export class LeaseAuditOutbox {
	constructor(private readonly options: LeaseAuditOutboxOptions) {}

	materialize(): { materialized: number; rows: number } {
		const store = new LeadLeaseStore(this.options.dbPath);
		let episodeStore: LeadLeaseEpisodeStore | undefined;
		let materialized = 0;
		let rowsWritten = 0;
		try {
			if (this.options.episodeDbPath) {
				try {
					episodeStore = new LeadLeaseEpisodeStore(this.options.episodeDbPath);
				} catch {
					// No suppression when episode evidence is unavailable: duplicate is
					// safer than silently acknowledging the audit batch.
				}
			}
			const storeInstanceId = store.getStoreInstanceId();
			const grouped = new Map<string, LeaseAuditRow[]>();
			for (const row of store.listPendingAudit()) {
				const key = `${row.leadKey}\u0000${row.event}`;
				const rows = grouped.get(key) ?? [];
				rows.push(row);
				grouped.set(key, rows);
			}
			for (const group of grouped.values()) {
				group.sort((a, b) => a.id - b.id);
				const first = group[0]!;
				const backendDrift = group.some((row) => {
					try {
						const detail = JSON.parse(row.detail ?? "{}") as {
							reason?: unknown;
						};
						return (
							typeof detail.reason === "string" &&
							detail.reason.startsWith("backend_drift:")
						);
					} catch {
						return false;
					}
				});
				if (backendDrift && episodeStore) {
					const carrier = `lead_backend_drift:carrier:${first.leadKey}`;
					const intruder = `lead_backend_drift:claude_intruder:${first.leadKey}`;
					if (
						episodeStore.getActive(carrier) ||
						episodeStore.getActive(intruder)
					) {
						store.markAuditMaterialized(group.map((row) => row.id));
						materialized++;
						rowsWritten += group.length;
						continue;
					}
				}
				const canonicalRows = group.map((row) => ({
					id: row.id,
					leadKey: row.leadKey,
					event: row.event,
					detail: row.detail,
					createdAt: row.createdAt,
				}));
				const payloadDigest = digest(JSON.stringify(canonicalRows));
				const batchId = digest(
					`${storeInstanceId}|${first.leadKey}|${first.event}|${JSON.stringify(canonicalRows)}`,
				);
				const identity = identityFromRows(first.leadKey, group);
				const queuedAt = group.map((row) => row.createdAt).sort()[0]!;
				const eventType = auditEventType(first.event);
				const payload: LeaseAuditQueuePayload = {
					...identity,
					eventId: `lease-audit:${batchId}`,
					eventType,
					title:
						eventType === "lead_lease_bypass_used"
							? "Lead lease bypass used"
							: "Lead write would be blocked by identity lease",
					body: `${group.length} Lead lease audit event(s) for ${first.leadKey} (${first.event}).`,
					severity:
						eventType === "lead_lease_bypass_used" ? "severe" : "warning",
					queuedAt,
					queueReason: "lease-audit",
					leaseAudit: {
						batchId,
						payloadDigest,
						storeInstanceId,
						leadKey: first.leadKey,
						event: first.event,
						rowIds: group.map((row) => row.id),
					},
				};
				const filename = `${queuedAt}-lease-audit-${batchId.slice(0, 16)}.json`;
				const path = join(this.options.queueDir, filename);
				if (existsSync(path)) {
					let existing: LeaseAuditQueuePayload;
					try {
						existing = JSON.parse(readFileSync(path, "utf8"));
					} catch {
						throw new Error(
							`existing lease audit batch is invalid: ${filename}`,
						);
					}
					if (
						existing.leaseAudit?.batchId !== batchId ||
						existing.leaseAudit.payloadDigest !== payloadDigest
					) {
						throw new Error(`existing lease audit batch mismatch: ${filename}`);
					}
				} else {
					atomicWrite(path, `${JSON.stringify(payload)}\n`);
				}
				this.options.afterFileCommit?.(path);
				store.markAuditMaterialized(group.map((row) => row.id));
				materialized++;
				rowsWritten += group.length;
			}
			store.pruneMaterializedAudit(
				this.options.retentionMs ?? DEFAULT_MATERIALIZED_AUDIT_RETENTION_MS,
				(this.options.now ?? (() => new Date()))().getTime(),
			);
			return { materialized, rows: rowsWritten };
		} finally {
			episodeStore?.close();
			store.close();
		}
	}
}
