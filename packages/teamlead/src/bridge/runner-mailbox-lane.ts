import { CommDB } from "flywheel-comm/db";
import type { MailboxQueue, MailboxRow } from "flywheel-comm/mailbox-queue";
import { messageProvenanceFromSenderRef } from "flywheel-comm/sender-ref";
import { wakeRunnerMailbox } from "flywheel-comm/wake";

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
	| { status: "delivered" | "no_transport" }
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
			...(vendor === null || vendor === undefined ? {} : { backend: vendor }),
		});
		if (result.ok) return { status: "delivered" };
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
}

export class RunnerMailboxLane {
	private readonly now: () => Date;
	private readonly claimTtlMs: number;
	private readonly maxAttempts: number;
	private readonly retryBackoffBaseMs: number;
	private readonly retryBackoffCapMs: number;
	private readonly maxPerTick: number;

	constructor(private readonly opts: RunnerMailboxLaneOptions) {
		this.now = opts.now ?? (() => new Date());
		this.claimTtlMs = opts.claimTtlMs ?? 30 * 60_000;
		this.maxAttempts = opts.maxAttempts ?? 6;
		this.retryBackoffBaseMs = opts.retryBackoffBaseMs ?? 5_000;
		this.retryBackoffCapMs = opts.retryBackoffCapMs ?? 10 * 60_000;
		this.maxPerTick = opts.maxPerTick ?? 100;
	}

	async tick(): Promise<RunnerMailboxTickResult> {
		const result: RunnerMailboxTickResult = {
			delivered: 0,
			failed: 0,
			dead: 0,
		};
		for (let index = 0; index < this.maxPerTick; index++) {
			const row = this.opts.queue.claimRunner({
				ownerEpoch: this.opts.ownerEpoch,
				now: this.now().toISOString(),
				claimTtlMs: this.claimTtlMs,
			});
			if (!row) break;
			try {
				const envelope = renderRunnerMailboxEnvelope(
					row,
					row.ref_id ? this.opts.resolveQuestion?.(row.ref_id) : undefined,
				);
				const delivered = await this.opts.deliver(envelope);
				if (delivered.status === "failed") throw new Error(delivered.error);
				if (
					!this.opts.queue.recordRunnerDeliverySuccess({
						id: row.id,
						ownerEpoch: this.opts.ownerEpoch,
					})
				) {
					throw new Error("runner claim fence lost after delivery");
				}
				result.delivered++;
			} catch (error) {
				const failure = this.opts.queue.recordRunnerDeliveryFailure({
					id: row.id,
					ownerEpoch: this.opts.ownerEpoch,
					now: this.now().toISOString(),
					nextRetryAt: this.nextRetryAt(row.retry_count),
					error: error instanceof Error ? error.message : String(error),
					maxAttempts: this.maxAttempts,
				});
				result.failed++;
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
