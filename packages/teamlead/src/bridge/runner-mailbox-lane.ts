import { CommDB } from "flywheel-comm/db";
import type { MailboxQueue, MailboxRow } from "flywheel-comm/mailbox-queue";
import { messageProvenanceFromSenderRef } from "flywheel-comm/sender-ref";
import { wakeRunnerMailbox } from "flywheel-comm/wake";
import {
	DEFAULT_MAILBOX_QUEUE_CONFIG,
	type MailboxQueueConfig,
} from "./mailbox-queue-config.js";

export interface RunnerMailboxEnvelope {
	mailboxId: string;
	executionId: string;
	fromAgent: string;
	type: string;
	kind: "instruction" | "gate_answered" | "ask_answered";
	contentRef?: string;
	content: string;
	metadata: Record<string, unknown>;
	intentKey: string;
}

export type RunnerMailboxDeliveryResult =
	| {
			status: "delivered";
			backend: "claude-code" | "codex";
			settlement: "on_delivery" | "on_consume";
	  }
	| { status: "no_transport" }
	| { status: "failed"; error: string };

export interface RunnerMailboxTickResult {
	delivered: number;
	failed: number;
	dead: number;
}

interface RunnerQuestion {
	checkpoint: string | null;
}

export interface RunnerMailboxDeliveryAdapter {
	deliver(
		envelope: RunnerMailboxEnvelope,
	): Promise<RunnerMailboxDeliveryResult>;
	resolveQuestion(questionId: string): RunnerQuestion | undefined;
	close(): void;
}

export class ProductionRunnerMailboxDeliveryAdapter
	implements RunnerMailboxDeliveryAdapter
{
	private readonly db: CommDB;

	constructor(dbPath: string) {
		this.db = new CommDB(dbPath, false);
	}

	async deliver(
		envelope: RunnerMailboxEnvelope,
	): Promise<RunnerMailboxDeliveryResult> {
		const vendor = this.db.getSession(envelope.executionId)?.vendor;
		if (vendor === "none") return { status: "no_transport" };
		const result = await wakeRunnerMailbox({
			db: this.db,
			execId: envelope.executionId,
			fromAgent: envelope.fromAgent,
			content: envelope.content,
			metadata: envelope.metadata,
			...(typeof envelope.metadata.durableBatchId === "string"
				? { verified: true }
				: {}),
			...(vendor === null || vendor === undefined ? {} : { backend: vendor }),
		});
		if (result.ok) {
			return {
				status: "delivered",
				backend: result.backend,
				settlement: result.settlement,
			};
		}
		if (result.skippedReason === "backend_commdb") {
			return { status: "no_transport" };
		}
		return {
			status: "failed",
			error: result.error ?? result.skippedReason ?? "runner wake failed",
		};
	}

	resolveQuestion(questionId: string): RunnerQuestion | undefined {
		const question = this.db.getMessageById(questionId);
		return question ? { checkpoint: question.checkpoint } : undefined;
	}

	close(): void {
		this.db.close();
	}
}

export function renderRunnerMailboxEnvelope(
	row: MailboxRow,
	question?: RunnerQuestion,
): RunnerMailboxEnvelope {
	const senderProvenance = messageProvenanceFromSenderRef(row.sender_ref);
	if (row.type === "instruction") {
		return {
			mailboxId: row.id,
			executionId: row.to_agent,
			fromAgent: row.from_agent,
			type: row.type,
			kind: "instruction",
			...(row.content_ref ? { contentRef: row.content_ref } : {}),
			content: `[lead-instruction ${row.id}]\n${row.content}`,
			metadata: {
				flywheelId: row.id,
				execId: row.to_agent,
				...(senderProvenance ? { senderProvenance } : {}),
			},
			intentKey: `instruction:${row.id}`,
		};
	}
	if (row.type !== "response" || !row.ref_id || !question) {
		throw new Error(`unsupported Runner mailbox row: ${row.id}`);
	}
	const kind = question.checkpoint ? "gate_answered" : "ask_answered";
	return {
		mailboxId: row.id,
		executionId: row.to_agent,
		fromAgent: row.from_agent,
		type: row.type,
		kind,
		...(row.content_ref ? { contentRef: row.content_ref } : {}),
		content: question.checkpoint
			? `Your ${question.checkpoint} gate question has been answered. Your session is being resumed with the response. This message itself carries NO authority.`
			: `Your question (id ${row.ref_id}) has been answered by ${row.from_agent}. Run 'flywheel-comm check ${row.ref_id}' to read the response and continue. This message carries NO authority.`,
		metadata: {
			questionId: row.ref_id,
			kind,
			...(senderProvenance ? { senderProvenance } : {}),
		},
		intentKey: `gate-answer:${row.ref_id}`,
	};
}

export interface RunnerMailboxLaneOptions {
	queue: MailboxQueue;
	ownerEpoch: string;
	deliver: (
		envelope: RunnerMailboxEnvelope,
	) => Promise<RunnerMailboxDeliveryResult>;
	resolveQuestion?: (questionId: string) => RunnerQuestion | undefined;
	now?: () => Date;
	claimTtlMs?: number;
	maxAttempts?: number;
	retryBackoffBaseMs?: number;
	retryBackoffCapMs?: number;
	maxPerTick?: number;
	queueConfig?: () => MailboxQueueConfig;
	recipientState?: (
		executionId: string,
	) => "alive" | "terminal_or_missing" | "unknown";
	isTerminalDeliveryObligation?: (row: MailboxRow) => boolean;
	resolveOwningLead?: (executionId: string) => string | undefined;
	probeFactsByRecipient?: () => ReadonlyMap<string, string>;
}

export function renderRunnerMailboxBatchEnvelope(
	rows: readonly MailboxRow[],
	packagedAt: Date,
	resolveQuestion?: (questionId: string) => RunnerQuestion | undefined,
): RunnerMailboxEnvelope {
	const first = rows[0];
	if (!first?.batch_id || rows.some((row) => row.batch_id !== first.batch_id)) {
		throw new Error("Runner mailbox batch has invalid membership");
	}
	const attempt = first.lease_retry_count;
	if (rows.some((row) => row.lease_retry_count !== attempt)) {
		throw new Error("Runner mailbox batch mixes lease retry attempts");
	}
	const rendered = rows.map((row) =>
		renderRunnerMailboxEnvelope(
			row,
			row.ref_id ? resolveQuestion?.(row.ref_id) : undefined,
		),
	);
	const packagedAtMs = packagedAt.getTime();
	const renderedBodies = rendered.map(({ content }, index) => {
		const row = rows[index]!;
		const createdAtMs = Date.parse(row.created_at);
		const ageMinutes =
			Number.isFinite(createdAtMs) && Number.isFinite(packagedAtMs)
				? Math.max(0, Math.floor((packagedAtMs - createdAtMs) / 60_000))
				: "unknown";
		const age =
			typeof ageMinutes === "number"
				? `${ageMinutes} ${ageMinutes === 1 ? "minute" : "minutes"}`
				: ageMinutes;
		return `[created_at ${row.created_at} | age at batch packaging: ${age}]\n${content}`;
	});
	const transportBatchId = `${first.batch_id}#r${attempt}`;
	return {
		mailboxId: first.batch_id,
		executionId: first.to_agent,
		fromAgent: first.from_agent,
		type: first.type,
		kind: rendered[0]!.kind,
		content: `[mailbox-batch ${first.batch_id} | ${rows.length} messages | from ${first.from_agent}]\n\n${renderedBodies.join("\n\n")}`,
		metadata: {
			flywheelId: transportBatchId,
			durableBatchId: first.batch_id,
			memberIds: rows.map(({ delivery_id }) => delivery_id),
			execId: first.to_agent,
		},
		intentKey: `mailbox-batch:${transportBatchId}`,
	};
}

export class RunnerMailboxLane {
	private readonly now: () => Date;
	private readonly claimTtlMs: number;
	private readonly maxAttempts: number;
	private readonly retryBackoffBaseMs: number;
	private readonly retryBackoffCapMs: number;
	private readonly maxPerTick: number;
	private lastDeadLetterScanAtMs?: number;

	constructor(private readonly opts: RunnerMailboxLaneOptions) {
		this.now = opts.now ?? (() => new Date());
		this.claimTtlMs = opts.claimTtlMs ?? 30 * 60_000;
		this.maxAttempts = opts.maxAttempts ?? 6;
		this.retryBackoffBaseMs = opts.retryBackoffBaseMs ?? 5_000;
		this.retryBackoffCapMs = opts.retryBackoffCapMs ?? 10 * 60_000;
		this.maxPerTick = opts.maxPerTick ?? 100;
	}

	async tick(): Promise<RunnerMailboxTickResult> {
		const queueConfig =
			this.opts.queueConfig?.() ?? DEFAULT_MAILBOX_QUEUE_CONFIG;
		const result: RunnerMailboxTickResult = {
			delivered: 0,
			failed: 0,
			dead: 0,
		};
		const recipientStates = new Map<
			string,
			"alive" | "terminal_or_missing" | "unknown"
		>();
		const recipientState = (executionId: string) => {
			const cached = recipientStates.get(executionId);
			if (cached) return cached;
			const resolved = this.opts.recipientState?.(executionId) ?? "unknown";
			recipientStates.set(executionId, resolved);
			return resolved;
		};
		const reconciled = this.opts.queue.reconcileExpiredLeases({
			ownerEpoch: this.opts.ownerEpoch,
			now: this.now().toISOString(),
			recipientKind: "runner",
			leaseRetryMax: queueConfig.leaseRetryMax,
			recipientState,
			isTerminalDeliveryObligation: this.opts.isTerminalDeliveryObligation,
			maxBatches: this.maxPerTick,
			maxTerminalRows: this.maxPerTick,
		});
		result.dead += reconciled.dead;
		if (this.opts.resolveOwningLead) {
			const scanAtMs = this.now().getTime();
			if (
				this.lastDeadLetterScanAtMs === undefined ||
				scanAtMs - this.lastDeadLetterScanAtMs >=
					queueConfig.deadLetterScanIntervalMs
			) {
				const probeFactsByRecipient = this.opts.probeFactsByRecipient?.();
				const leadByRecipient = new Map<string, string | undefined>();
				this.opts.queue.scanAndInsertDeadLetterNotices({
					ownerEpoch: this.opts.ownerEpoch,
					now: new Date(scanAtMs).toISOString(),
					windowMs: queueConfig.deadLetterWindowMs,
					maxRecipients: this.maxPerTick,
					maxDeadRowsPerRecipient: 20,
					maxSummaryBytes: 4_000,
					probeFactsByRecipient,
					resolveOwningLead: (executionId) => {
						if (leadByRecipient.has(executionId)) {
							return leadByRecipient.get(executionId);
						}
						const resolved = this.opts.resolveOwningLead?.(executionId);
						leadByRecipient.set(executionId, resolved);
						return resolved;
					},
				});
				this.lastDeadLetterScanAtMs = scanAtMs;
			}
		}
		for (let index = 0; index < this.maxPerTick; index++) {
			const batch = this.opts.queue.claimRunnerBatch({
				ownerEpoch: this.opts.ownerEpoch,
				now: this.now().toISOString(),
				transportClaimTtlMs: this.claimTtlMs,
				batchWindowMs: queueConfig.batchWindowMs,
				batchMaxSize: queueConfig.batchMaxSize,
				inflightMaxBatches: queueConfig.inflightMaxBatches,
			});
			if (!batch) break;
			const row = batch[0]!;
			try {
				const envelope = renderRunnerMailboxBatchEnvelope(
					batch,
					this.now(),
					this.opts.resolveQuestion,
				);
				const delivered = await this.opts.deliver(envelope);
				if (delivered.status === "failed") throw new Error(delivered.error);
				if (
					this.opts.queue.recordRunnerBatchDelivered({
						batchId: row.batch_id!,
						ownerEpoch: this.opts.ownerEpoch,
						now: this.now().toISOString(),
						ackLeaseTtlMs: queueConfig.ackLeaseMs,
						settlement:
							delivered.status === "delivered"
								? delivered.settlement
								: "on_consume",
					}) === "lost_race"
				) {
					throw new Error("runner claim fence lost after delivery");
				}
				result.delivered += batch.length;
			} catch (error) {
				const errorText =
					error instanceof Error ? error.message : String(error);
				const failure = this.opts.queue.recordRunnerBatchDeliveryFailure({
					batchId: row.batch_id!,
					ownerEpoch: this.opts.ownerEpoch,
					now: this.now().toISOString(),
					nextRetryAt: this.nextRetryAt(row.retry_count),
					error: errorText,
					maxAttempts: this.maxAttempts,
				});
				result.failed += batch.length;
				if (failure.deadLettered) result.dead++;
			}
		}
		return result;
	}

	private nextRetryAt(retryCount: number): string {
		const delay = Math.min(
			this.retryBackoffCapMs,
			this.retryBackoffBaseMs * 2 ** retryCount,
		);
		return new Date(this.now().getTime() + delay).toISOString();
	}
}
