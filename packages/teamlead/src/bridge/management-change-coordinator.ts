import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { canonicalJsonString } from "flywheel-config";
import type { ConfirmTokenStore } from "./fleet-admin.js";
import { newBatchId as defaultNewBatchId } from "./fleet-admin.js";
import type { FleetAdminAudit } from "./fleet-admin-audit.js";
import {
	coalesceManagementChangeRequests,
	type ManagementChangeRequest,
	type ManagementPreparedChange,
	type ManagementWriter,
	type ManagementWriterRegistry,
	type ManagementWriterResult,
} from "./management-writer.js";

const SCHEMA_VERSION = 1 as const;
const MAX_CHANGES = 100;
const MAX_STAGE_BYTES = 256 * 1024;
const SAFE_BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ManagementStageInput {
	changes: ManagementChangeRequest[];
	acknowledged?: boolean;
}

export interface ManagementCanonicalBatch {
	schemaVersion: typeof SCHEMA_VERSION;
	batchId: string;
	createdAt: string;
	origin: string;
	snapshotRevision: string;
	acknowledgementRequired: boolean;
	changes: ManagementPreparedChange[];
	noOps: ManagementPreparedChange[];
}

export interface ManagementApplyInput {
	batch: ManagementCanonicalBatch;
	confirmToken: string;
	acknowledged?: boolean;
}

export interface ManagementCoordinatorResult {
	code: number;
	body: Record<string, unknown>;
}

export type ManagementItemStatus =
	| "pending"
	| "applying"
	| ManagementWriterResult["status"];

export type ManagementBatchStatus =
	| "staged"
	| "running"
	| "applied"
	| "partially-applied"
	| "failed"
	| "rejected";

export interface ManagementJournalItem {
	targetId: string;
	oldValue: unknown;
	newValue: unknown;
	status: ManagementItemStatus;
	reason?: string;
	details?: unknown;
}

export interface ManagementBatchJournal {
	schemaVersion: typeof SCHEMA_VERSION;
	batchId: string;
	createdAt: string;
	updatedAt: string;
	status: ManagementBatchStatus;
	canonical: ManagementCanonicalBatch;
	items: ManagementJournalItem[];
}

export interface ManagementBatchProgress {
	batchId: string;
	createdAt: string;
	status: ManagementBatchStatus;
	terminal: boolean;
	items: ManagementJournalItem[];
}

interface CoordinatorAudit {
	record(record: Parameters<FleetAdminAudit["record"]>[0]): boolean;
}

interface CoordinatorOptions {
	registry: ManagementWriterRegistry;
	tokens: ConfirmTokenStore;
	audit: CoordinatorAudit;
	journalDir: string;
	snapshotRevision(): string;
	now?: () => Date;
	newBatchId?: () => string;
	reconcileAccepted?: (
		writerId: string,
		details: unknown,
	) => ManagementWriterResult | null;
}

class AsyncMutex {
	private tail: Promise<void> = Promise.resolve();

	async run<T>(fn: () => Promise<T>): Promise<T> {
		let release: () => void = () => {};
		const previous = this.tail;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

function canonicalSha(batch: ManagementCanonicalBatch): string {
	return createHash("sha256").update(canonicalJsonString(batch)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function validateRequests(
	input: unknown,
): { ok: true; value: ManagementStageInput } | { ok: false; reason: string } {
	if (!isRecord(input) || !exactKeys(input, ["changes", "acknowledged"])) {
		return { ok: false, reason: "stage body contains unknown fields" };
	}
	try {
		if (
			Buffer.byteLength(canonicalJsonString(input), "utf8") > MAX_STAGE_BYTES
		) {
			return { ok: false, reason: "stage body is too large" };
		}
	} catch {
		return { ok: false, reason: "stage body is not JSON-safe" };
	}
	if (
		!Array.isArray(input.changes) ||
		input.changes.length === 0 ||
		input.changes.length > MAX_CHANGES
	) {
		return {
			ok: false,
			reason: `changes must contain 1..${MAX_CHANGES} items`,
		};
	}
	if (
		"acknowledged" in input &&
		input.acknowledged !== undefined &&
		typeof input.acknowledged !== "boolean"
	) {
		return { ok: false, reason: "acknowledged must be boolean" };
	}
	const changes: ManagementChangeRequest[] = [];
	for (const raw of input.changes) {
		if (
			!isRecord(raw) ||
			!exactKeys(raw, ["targetId", "desiredValue", "observedRevision"]) ||
			typeof raw.targetId !== "string" ||
			!("desiredValue" in raw) ||
			raw.desiredValue === undefined ||
			typeof raw.observedRevision !== "string" ||
			!raw.observedRevision
		) {
			return {
				ok: false,
				reason:
					"each change accepts only targetId, desiredValue, observedRevision",
			};
		}
		changes.push({
			targetId: raw.targetId,
			desiredValue: raw.desiredValue,
			observedRevision: raw.observedRevision,
		});
	}
	return {
		ok: true,
		value: { changes, acknowledged: input.acknowledged as boolean | undefined },
	};
}

function sameCanonicalChange(
	a: ManagementPreparedChange,
	b: ManagementPreparedChange,
): boolean {
	return canonicalJsonString(a) === canonicalJsonString(b);
}

function terminal(status: ManagementBatchStatus): boolean {
	return !["staged", "running"].includes(status);
}

export class ManagementChangeCoordinator {
	private readonly mutex = new AsyncMutex();
	private readonly now: () => Date;
	private readonly makeBatchId: () => string;

	constructor(private readonly options: CoordinatorOptions) {
		this.now = options.now ?? (() => new Date());
		this.makeBatchId = options.newBatchId ?? defaultNewBatchId;
	}

	private path(batchId: string): string {
		if (!SAFE_BATCH_ID.test(batchId)) throw new Error("unsafe batch id");
		return join(this.options.journalDir, `management-batch-${batchId}.json`);
	}

	private writeJournal(journal: ManagementBatchJournal, create = false): void {
		mkdirSync(this.options.journalDir, { recursive: true });
		const path = this.path(journal.batchId);
		if (create && existsSync(path))
			throw new Error("batch journal already exists");
		const temp = `${path}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
		try {
			writeFileSync(temp, `${JSON.stringify(journal)}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			renameSync(temp, path);
		} finally {
			try {
				unlinkSync(temp);
			} catch {
				// Temp was renamed or never created.
			}
		}
	}

	private readJournal(batchId: string): ManagementBatchJournal | null {
		try {
			return JSON.parse(
				readFileSync(this.path(batchId), "utf8"),
			) as ManagementBatchJournal;
		} catch {
			return null;
		}
	}

	private deny(
		batchId: string,
		origin: string,
		reason: string,
		code = 401,
	): ManagementCoordinatorResult {
		this.options.audit.record({
			batchId,
			event: "denied",
			attemptId: defaultNewBatchId(),
			origin,
			reason,
		});
		return { code, body: { error: reason } };
	}

	private rejectJournal(
		journal: ManagementBatchJournal,
		origin: string,
		reason: string,
		code = 409,
	): ManagementCoordinatorResult {
		journal.status = "rejected";
		journal.updatedAt = this.now().toISOString();
		this.writeJournal(journal);
		return this.deny(journal.batchId, origin, reason, code);
	}

	private async validateGroups(
		changes: readonly ManagementPreparedChange[],
	): Promise<{ ok: true } | { ok: false; code: number; reason: string }> {
		const grouped = new Map<
			string,
			{ writer: ManagementWriter; changes: ManagementPreparedChange[] }
		>();
		for (const change of changes) {
			const writer = this.options.registry.writerForTarget(change.targetId);
			const group = grouped.get(writer.id) ?? { writer, changes: [] };
			group.changes.push(change);
			grouped.set(writer.id, group);
		}
		for (const { writer, changes: group } of grouped.values()) {
			if (!writer.validateGroup) continue;
			const result = await writer.validateGroup(group);
			if (!result.ok) {
				return {
					ok: false,
					code: result.code === "stale_source" ? 409 : 400,
					reason: result.reason,
				};
			}
		}
		return { ok: true };
	}

	async stage(
		input: ManagementStageInput,
		origin: string,
	): Promise<ManagementCoordinatorResult> {
		const validated = validateRequests(input);
		if (!validated.ok) {
			return { code: 400, body: { error: validated.reason } };
		}
		return this.mutex.run(async () => {
			let requests: ManagementChangeRequest[];
			try {
				requests = coalesceManagementChangeRequests(validated.value.changes);
			} catch (error) {
				return {
					code: 400,
					body: {
						error: error instanceof Error ? error.message : String(error),
					},
				};
			}
			const changes: ManagementPreparedChange[] = [];
			const noOps: ManagementPreparedChange[] = [];
			for (const request of requests) {
				let writer: ManagementWriter;
				try {
					writer = this.options.registry.writerForTarget(request.targetId);
				} catch (error) {
					return {
						code: 400,
						body: {
							error: error instanceof Error ? error.message : String(error),
						},
					};
				}
				const target = await writer.resolve(request.targetId);
				if (!target) {
					return {
						code: 400,
						body: { error: `unknown target: ${request.targetId}` },
					};
				}
				const preflight = await writer.preflight(
					target,
					request.desiredValue,
					request.observedRevision,
				);
				if (!preflight.ok) {
					return {
						code: preflight.code === "stale_source" ? 409 : 400,
						body: { error: preflight.reason, rejectCode: preflight.code },
					};
				}
				(preflight.status === "no_op" ? noOps : changes).push(preflight.change);
			}
			const groupValidation = await this.validateGroups(changes);
			if (!groupValidation.ok) {
				return {
					code: groupValidation.code,
					body: { error: groupValidation.reason },
				};
			}
			changes.sort(
				(a, b) =>
					a.consequence.localeCompare(b.consequence) ||
					a.targetId.localeCompare(b.targetId),
			);
			noOps.sort((a, b) => a.targetId.localeCompare(b.targetId));
			const batchId = this.makeBatchId();
			if (!SAFE_BATCH_ID.test(batchId)) {
				return { code: 500, body: { error: "generated unsafe batch id" } };
			}
			const batch: ManagementCanonicalBatch = {
				schemaVersion: SCHEMA_VERSION,
				batchId,
				createdAt: this.now().toISOString(),
				origin,
				snapshotRevision: this.options.snapshotRevision(),
				acknowledgementRequired: changes.some(
					(change) => change.requiresAcknowledgement,
				),
				changes,
				noOps,
			};
			if (
				batch.acknowledgementRequired &&
				validated.value.acknowledged !== true
			) {
				return {
					code: 200,
					body: { batch, confirmationRequired: true },
				};
			}
			const canonicalRequest = canonicalJsonString(batch);
			if (
				!this.options.audit.record({
					batchId,
					event: "staged",
					canonicalRequest,
					origin,
				})
			) {
				return {
					code: 503,
					body: { error: "audit unavailable — refusing to stage" },
				};
			}
			const at = this.now().toISOString();
			try {
				this.writeJournal(
					{
						schemaVersion: SCHEMA_VERSION,
						batchId,
						createdAt: batch.createdAt,
						updatedAt: at,
						status: "staged",
						canonical: batch,
						items: changes.map((change) => ({
							targetId: change.targetId,
							oldValue: change.oldValue,
							newValue: change.newValue,
							status: "pending",
						})),
					},
					true,
				);
			} catch (error) {
				return {
					code: 503,
					body: {
						error: `journal unavailable — refusing token: ${error instanceof Error ? error.message : String(error)}`,
					},
				};
			}
			const confirmToken = this.options.tokens.issue(canonicalSha(batch));
			return { code: 200, body: { batch, confirmToken } };
		});
	}

	async apply(
		input: ManagementApplyInput,
		origin: string,
	): Promise<ManagementCoordinatorResult> {
		if (
			!isRecord(input) ||
			!exactKeys(input, ["batch", "confirmToken", "acknowledged"]) ||
			!isRecord(input.batch) ||
			typeof input.confirmToken !== "string"
		) {
			return { code: 400, body: { error: "missing batch / confirmToken" } };
		}
		const batch = input.batch as unknown as ManagementCanonicalBatch;
		if (
			batch.schemaVersion !== SCHEMA_VERSION ||
			!SAFE_BATCH_ID.test(batch.batchId ?? "") ||
			!Array.isArray(batch.changes) ||
			!Array.isArray(batch.noOps)
		) {
			return { code: 400, body: { error: "invalid canonical batch" } };
		}
		const verdict = this.options.tokens.verifyAndConsume(
			input.confirmToken,
			canonicalSha(batch),
		);
		if (!verdict.ok) return this.deny(batch.batchId, origin, verdict.reason);
		if (batch.origin !== origin) {
			return this.deny(
				batch.batchId,
				origin,
				"origin does not match staged batch",
			);
		}
		if (batch.acknowledgementRequired && input.acknowledged !== true) {
			return this.deny(
				batch.batchId,
				origin,
				"required consequence acknowledgement is missing",
				409,
			);
		}
		return this.mutex.run(async () => {
			const journal = this.readJournal(batch.batchId);
			if (
				!journal ||
				canonicalJsonString(journal.canonical) !== canonicalJsonString(batch)
			) {
				return this.deny(
					batch.batchId,
					origin,
					"canonical batch journal is missing or mismatched",
					409,
				);
			}
			const ready: Array<{
				writer: ReturnType<ManagementWriterRegistry["writerForTarget"]>;
				change: ManagementPreparedChange;
			}> = [];
			for (const staged of batch.changes) {
				let writer: ManagementWriter;
				try {
					writer = this.options.registry.writerForTarget(staged.targetId);
				} catch (error) {
					return this.rejectJournal(
						journal,
						origin,
						error instanceof Error ? error.message : String(error),
					);
				}
				if (writer.id !== staged.writerId) {
					return this.rejectJournal(
						journal,
						origin,
						"writer registration changed since stage",
					);
				}
				const target = await writer.resolve(staged.targetId);
				if (!target) {
					return this.rejectJournal(
						journal,
						origin,
						`target disappeared: ${staged.targetId}`,
					);
				}
				const checked = await writer.preflight(
					target,
					staged.newValue,
					staged.sourceRevision,
				);
				if (
					!checked.ok ||
					checked.status === "no_op" ||
					!sameCanonicalChange(checked.change, staged)
				) {
					return this.rejectJournal(
						journal,
						origin,
						checked.ok
							? `target canonical changed: ${staged.targetId}`
							: checked.reason,
					);
				}
				ready.push({ writer, change: checked.change });
			}
			const groupValidation = await this.validateGroups(
				ready.map((entry) => entry.change),
			);
			if (!groupValidation.ok) {
				return this.rejectJournal(
					journal,
					origin,
					groupValidation.reason,
					groupValidation.code,
				);
			}
			if (
				!this.options.audit.record({
					batchId: batch.batchId,
					event: "apply-requested",
					canonicalRequest: canonicalJsonString(batch),
					origin,
				})
			) {
				journal.status = "rejected";
				journal.updatedAt = this.now().toISOString();
				this.writeJournal(journal);
				return {
					code: 503,
					body: { error: "audit unavailable — refusing to apply" },
				};
			}
			journal.status = "running";
			journal.updatedAt = this.now().toISOString();
			this.writeJournal(journal);
			const groups = new Map<
				string,
				{
					writer: ReturnType<ManagementWriterRegistry["writerForTarget"]>;
					changes: ManagementPreparedChange[];
				}
			>();
			for (const entry of ready) {
				const group = groups.get(entry.writer.id) ?? {
					writer: entry.writer,
					changes: [],
				};
				group.changes.push(entry.change);
				groups.set(entry.writer.id, group);
			}
			for (const { writer, changes } of groups.values()) {
				for (const change of changes) {
					const item = journal.items.find(
						(candidate) => candidate.targetId === change.targetId,
					)!;
					item.status = "applying";
				}
				journal.updatedAt = this.now().toISOString();
				this.writeJournal(journal);
				let results: ManagementWriterResult[];
				try {
					if (writer.applyGroup) {
						results = await writer.applyGroup(changes);
					} else {
						results = [];
						for (const change of changes) {
							results.push(await writer.apply(change));
						}
					}
					if (results.length !== changes.length) {
						throw new Error("writer group result count mismatch");
					}
				} catch (error) {
					results = changes.map(() => ({
						status: "rejected",
						reason: error instanceof Error ? error.message : String(error),
					}));
				}
				for (const [index, change] of changes.entries()) {
					const result = results[index]!;
					const item = journal.items.find(
						(candidate) => candidate.targetId === change.targetId,
					)!;
					item.status = result.status;
					item.reason = result.reason;
					item.details = result.details;
					journal.updatedAt = this.now().toISOString();
					this.writeJournal(journal);
				}
			}
			const statuses = journal.items.map((item) => item.status);
			const accepted = statuses.includes("accepted");
			const successful = statuses.some((status) =>
				["applied", "no_op", "accepted"].includes(status),
			);
			const unsuccessful = statuses.some((status) =>
				["rejected", "rolled_back", "partial"].includes(status),
			);
			journal.status = accepted
				? "running"
				: unsuccessful
					? successful
						? "partially-applied"
						: "failed"
					: "applied";
			journal.updatedAt = this.now().toISOString();
			this.writeJournal(journal);
			this.options.audit.record({
				batchId: batch.batchId,
				event: "apply-result",
				result: journal.status,
				origin,
			});
			return {
				code: accepted ? 202 : 200,
				body: {
					batchId: batch.batchId,
					status: journal.status,
					items: journal.items,
				},
			};
		});
	}

	private reconcile(journal: ManagementBatchJournal): ManagementBatchJournal {
		if (!this.options.reconcileAccepted || journal.status !== "running") {
			return journal;
		}
		let changed = false;
		for (const item of journal.items) {
			if (item.status !== "accepted") continue;
			const staged = journal.canonical.changes.find(
				(change) => change.targetId === item.targetId,
			);
			if (!staged) continue;
			const result = this.options.reconcileAccepted(
				staged.writerId,
				item.details,
			);
			if (!result || result.status === "accepted") continue;
			item.status = result.status;
			item.reason = result.reason;
			item.details = result.details;
			changed = true;
		}
		if (changed) {
			const statuses = journal.items.map((item) => item.status);
			if (!statuses.includes("accepted")) {
				const failed = statuses.some((status) =>
					["rejected", "rolled_back", "partial"].includes(status),
				);
				const succeeded = statuses.some((status) =>
					["applied", "no_op"].includes(status),
				);
				journal.status = failed
					? succeeded
						? "partially-applied"
						: "failed"
					: "applied";
			}
			journal.updatedAt = this.now().toISOString();
			this.writeJournal(journal);
			if (terminal(journal.status)) {
				this.options.audit.record({
					batchId: journal.batchId,
					event: "apply-result",
					result: journal.status,
					origin: journal.canonical.origin,
				});
			}
		}
		return journal;
	}

	/**
	 * Reconcile accepted child writes under the same mutex as apply(). The
	 * journal read and conditional write are one serialized operation, so a
	 * progress poll cannot overwrite newer per-item apply results.
	 */
	async reconcileProgress(): Promise<void> {
		await this.mutex.run(async () => {
			let files: string[];
			try {
				files = readdirSync(this.options.journalDir).filter(
					(file) =>
						file.startsWith("management-batch-") && file.endsWith(".json"),
				);
			} catch {
				return;
			}
			for (const file of files) {
				try {
					this.reconcile(
						JSON.parse(
							readFileSync(join(this.options.journalDir, file), "utf8"),
						) as ManagementBatchJournal,
					);
				} catch {
					// Leave malformed journals on disk for diagnosis.
				}
			}
		});
	}

	listProgress(): ManagementBatchProgress[] {
		let files: string[];
		try {
			files = readdirSync(this.options.journalDir).filter(
				(file) =>
					file.startsWith("management-batch-") && file.endsWith(".json"),
			);
		} catch {
			return [];
		}
		const progress: ManagementBatchProgress[] = [];
		for (const file of files) {
			try {
				const journal = JSON.parse(
					readFileSync(join(this.options.journalDir, file), "utf8"),
				) as ManagementBatchJournal;
				progress.push({
					batchId: journal.batchId,
					createdAt: journal.createdAt,
					status: journal.status,
					terminal: terminal(journal.status),
					items: journal.items,
				});
			} catch {
				// A malformed journal is ignored here and remains on disk for diagnosis.
			}
		}
		return progress.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}
}
