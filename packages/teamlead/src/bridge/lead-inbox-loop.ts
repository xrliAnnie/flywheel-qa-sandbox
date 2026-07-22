/**
 * FLY-1373 — per-Lead at-least-once inbox consumption loop.
 *
 * Authority stays in comm.db until a backend adapter returns a durable receipt.
 * A failed handoff, lost reply, audit-mirror failure, or owner-fence loss leaves
 * the immutable batch pending for the next tick.
 */

import { randomUUID } from "node:crypto";
import type {
	LeadInboxQueue,
	LeadInboxRow,
	ReceiptPriorityWindowsMs,
} from "flywheel-comm/lead-inbox-queue";
import { receiptPriorityWindowsMs } from "flywheel-comm/lead-inbox-queue";
import { receiptFoundationEnabled as receiptFoundationFlagEnabled } from "flywheel-config";
import type {
	LeadDeliveryAdapter,
	LeadDeliveryBatch,
} from "./lead-delivery-adapter.js";

export const ACTIVE_LEAD_INBOX_INTERVAL_MS = 1_000;
export const IDLE_LEAD_INBOX_INTERVAL_MS = 30_000;

export interface LeadInboxTickResult {
	ok: boolean;
	protocolConsumed: number;
	modelConsumed: number;
	error?: string;
}

export interface LeadInboxLoopOptions {
	queue: LeadInboxQueue;
	leadId: string;
	ownerEpoch: string;
	adapter: LeadDeliveryAdapter;
	hasLiveSession: () => boolean;
	/** Materialize newly-arrived CommDB questions/protocol rows before claiming. */
	admit?: () => Promise<void>;
	/** Idempotent typed protocol effect. It must durably finish before returning. */
	handleProtocol: (row: LeadInboxRow) => Promise<{ disposition: string }>;
	maxProtocolAttempts?: number;
	maxModelAttempts?: number;
	retryBackoffBaseMs?: number;
	retryBackoffCapMs?: number;
	unprocessedWindowMs?: number;
	receiptWindowsMs?: ReceiptPriorityWindowsMs;
	receiptFoundationEnabled?: () => boolean;
	onProtocolQuarantine?: (
		row: LeadInboxRow,
		error: Error,
	) => Promise<void> | void;
	/** Fail-closed question/event dispatch revalidation. */
	revalidateModel?: (
		row: LeadInboxRow,
	) => Promise<{ deliver: true } | { deliver: false; disposition: string }>;
	/** Durable audit mirror update, called only after the adapter receipt. */
	markAuditDelivered?: (row: LeadInboxRow) => Promise<void> | void;
	renderModelBatch?: (rows: readonly LeadInboxRow[]) => string;
	now?: () => Date;
	batchIdFactory?: () => string;
	leaseTtlMs?: number;
	claimTtlMs?: number;
	activeIntervalMs?: number;
	idleIntervalMs?: number;
	maxBatchSize?: number;
	setTimer?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
	logger?: { warn: (message: string, context?: unknown) => void };
	/** FLY-1393 QA seam: stall after the heartbeat is durably started. */
	afterTickStarted?: () => Promise<void>;
}

export class LeadInboxLoop {
	private readonly activeIntervalMs: number;
	private readonly idleIntervalMs: number;
	private readonly leaseTtlMs: number;
	private readonly claimTtlMs: number;
	private readonly maxBatchSize: number;
	private readonly maxProtocolAttempts: number;
	private readonly maxModelAttempts: number;
	private readonly retryBackoffBaseMs: number;
	private readonly retryBackoffCapMs: number;
	private readonly receiptWindowsMs: ReceiptPriorityWindowsMs;
	private readonly receiptFoundationEnabled: () => boolean;
	private readonly now: () => Date;
	private readonly batchIdFactory: () => string;
	private readonly setTimer: NonNullable<LeadInboxLoopOptions["setTimer"]>;
	private readonly clearTimer: NonNullable<LeadInboxLoopOptions["clearTimer"]>;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	private stopped = true;
	private nudgePending = false;

	constructor(private readonly opts: LeadInboxLoopOptions) {
		this.activeIntervalMs =
			opts.activeIntervalMs ?? ACTIVE_LEAD_INBOX_INTERVAL_MS;
		this.idleIntervalMs = opts.idleIntervalMs ?? IDLE_LEAD_INBOX_INTERVAL_MS;
		this.leaseTtlMs = opts.leaseTtlMs ?? 10_000;
		this.claimTtlMs = opts.claimTtlMs ?? 15_000;
		this.maxBatchSize = opts.maxBatchSize ?? 10_000;
		this.maxProtocolAttempts = opts.maxProtocolAttempts ?? 3;
		this.maxModelAttempts = opts.maxModelAttempts ?? 5;
		this.retryBackoffBaseMs = opts.retryBackoffBaseMs ?? 5_000;
		this.retryBackoffCapMs = opts.retryBackoffCapMs ?? 10 * 60_000;
		this.receiptWindowsMs =
			opts.receiptWindowsMs ??
			(opts.unprocessedWindowMs !== undefined
				? [
						opts.unprocessedWindowMs,
						opts.unprocessedWindowMs,
						opts.unprocessedWindowMs,
						opts.unprocessedWindowMs,
					]
				: receiptPriorityWindowsMs());
		this.receiptFoundationEnabled =
			opts.receiptFoundationEnabled ?? (() => receiptFoundationFlagEnabled());
		this.now = opts.now ?? (() => new Date());
		this.batchIdFactory = opts.batchIdFactory ?? randomUUID;
		this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer = opts.clearTimer ?? ((timer) => clearTimeout(timer));
	}

	/** Mount-time first pull, matching the stock Claude inbox poller. */
	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		void this.runAndSchedule();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) this.clearTimer(this.timer);
		this.timer = undefined;
	}

	/** Doorbell hint: pull now; comm.db remains authority if this hint is lost. */
	nudge(): void {
		if (this.stopped) return;
		if (this.timer) this.clearTimer(this.timer);
		this.timer = undefined;
		if (this.running) {
			this.nudgePending = true;
			return;
		}
		void this.runAndSchedule();
	}

	nextDelayMs(): number {
		return this.opts.hasLiveSession() ||
			this.opts.queue.countPending(this.opts.leadId) > 0
			? this.activeIntervalMs
			: this.idleIntervalMs;
	}

	async tick(): Promise<LeadInboxTickResult> {
		const startedAt = this.isoNow();
		this.opts.queue.recordTickStarted(this.opts.leadId, startedAt);
		await this.opts.afterTickStarted?.();
		let protocolConsumed = 0;
		let modelConsumed = 0;
		try {
			const receiptsEnabled = this.receiptFoundationEnabled();
			if (
				!this.opts.queue.acquireOrRenewOwner({
					ownerEpoch: this.opts.ownerEpoch,
					now: startedAt,
					leaseTtlMs: this.leaseTtlMs,
				})
			) {
				throw new Error("owner lease unavailable");
			}
			await this.opts.admit?.();

			for (;;) {
				const now = this.isoNow();
				const row = this.opts.queue.claimProtocol({
					toLead: this.opts.leadId,
					ownerEpoch: this.opts.ownerEpoch,
					now,
					claimTtlMs: this.claimTtlMs,
					respectRetryAt: true,
				});
				if (!row) break;
				if (
					!this.opts.queue.isCurrentOwner(this.opts.ownerEpoch, this.isoNow())
				) {
					throw new Error("owner fence lost before protocol effect");
				}
				try {
					const result = await this.opts.handleProtocol(row);
					const consumed = this.opts.queue.markConsumed([row.id], {
						ownerEpoch: this.opts.ownerEpoch,
						disposition: result.disposition,
						now: this.isoNow(),
					});
					if (consumed !== 1)
						throw new Error("owner fence lost after protocol effect");
					protocolConsumed++;
				} catch (error) {
					const failure = this.opts.queue.recordProtocolDeliveryFailure(
						row.id,
						{
							ownerEpoch: this.opts.ownerEpoch,
							error: (error as Error).message,
							now: this.isoNow(),
							maxAttempts: this.maxProtocolAttempts,
							backoffBaseMs: this.retryBackoffBaseMs,
							backoffCapMs: this.retryBackoffCapMs,
						},
					);
					const terminal = failure.deadLettered;
					if (terminal) {
						await this.opts.onProtocolQuarantine?.(row, error as Error);
						protocolConsumed++;
						continue;
					}
					throw error;
				}
			}

			const claimed = this.opts.queue.claimModelBatch({
				toLead: this.opts.leadId,
				ownerEpoch: this.opts.ownerEpoch,
				batchId: this.batchIdFactory(),
				now: this.isoNow(),
				claimTtlMs: this.claimTtlMs,
				limit: this.maxBatchSize,
				respectRetryAt: true,
			});
			if (claimed.length > 0) {
				const deliverable: LeadInboxRow[] = [];
				for (const row of claimed) {
					// attempts>0 means this immutable membership may already exist at the
					// adapter; never mutate it during a retry.
					const verdict =
						row.attempts === 0 && this.opts.revalidateModel
							? await this.opts.revalidateModel(row)
							: ({ deliver: true } as const);
					if (!verdict.deliver) {
						const consumed = this.opts.queue.markConsumed([row.id], {
							ownerEpoch: this.opts.ownerEpoch,
							disposition: verdict.disposition,
							now: this.isoNow(),
						});
						if (consumed !== 1) {
							throw new Error("owner fence lost while revoking model row");
						}
						continue;
					}
					deliverable.push(row);
				}

				if (deliverable.length > 0) {
					await this.deliverModelBatch(deliverable, receiptsEnabled);
					modelConsumed = deliverable.length;
				}
			}
			this.opts.queue.recordTickSuccess(this.opts.leadId, this.isoNow());
			return { ok: true, protocolConsumed, modelConsumed };
		} catch (error) {
			this.opts.logger?.warn("Lead inbox tick failed", {
				leadId: this.opts.leadId,
				error: (error as Error).message,
			});
			return {
				ok: false,
				protocolConsumed,
				modelConsumed,
				error: (error as Error).message,
			};
		}
	}

	private async deliverModelBatch(
		rows: LeadInboxRow[],
		receiptsEnabled: boolean,
	): Promise<void> {
		const batchId = rows[0]?.batch_id;
		if (!batchId || rows.some((row) => row.batch_id !== batchId)) {
			throw new Error("claimed model batch has invalid membership");
		}
		if (!this.opts.queue.isCurrentOwner(this.opts.ownerEpoch, this.isoNow())) {
			throw new Error("owner fence lost before transport handoff");
		}
		const batch: LeadDeliveryBatch = {
			batchId,
			leadId: this.opts.leadId,
			ownerEpoch: this.opts.ownerEpoch,
			members: rows.map((row) => ({
				deliveryId: row.id,
				content: row.content,
				priority: row.priority,
				seq: row.seq,
			})),
			modelPayload:
				this.opts.renderModelBatch?.(rows) ??
				rows
					.map(({ id, content }) => `[receipt:${id}]\n${content}`)
					.join("\n\n"),
		};
		try {
			const receipt = await this.opts.adapter.deliverBatch(batch);
			if (receipt.status === "membership_conflict") {
				const quarantined = this.opts.queue.quarantineModelBatch(
					rows.map(({ id }) => id),
					{
						ownerEpoch: this.opts.ownerEpoch,
						batchId,
						toLead: this.opts.leadId,
						error: `adapter reported membership_conflict for ${batchId}`,
						now: this.isoNow(),
					},
				);
				if (quarantined !== rows.length) {
					throw new Error("owner fence lost while quarantining conflict");
				}
				return;
			}
			if (
				receipt.batchId !== batchId ||
				receipt.memberIds.length !== rows.length ||
				receipt.memberIds.some((id, index) => id !== rows[index]?.id)
			) {
				throw new Error("adapter receipt does not match frozen membership");
			}
			if (
				!this.opts.queue.isCurrentOwner(this.opts.ownerEpoch, this.isoNow())
			) {
				throw new Error("owner fence lost after transport receipt");
			}
			// Cross-store order is deliberate: adapter receipt → audit mirror → queue
			// consume. Any crash before the last step retries through adapter dedupe.
			for (const row of rows) await this.opts.markAuditDelivered?.(row);
			const consumed = this.opts.queue.markConsumed(
				rows.map(({ id }) => id),
				{
					ownerEpoch: this.opts.ownerEpoch,
					disposition: "delivered",
					now: this.isoNow(),
					...(receiptsEnabled
						? { receiptWindowsMs: this.receiptWindowsMs }
						: {}),
				},
			);
			if (consumed !== rows.length) {
				throw new Error("owner fence lost before queue consume");
			}
		} catch (error) {
			this.opts.queue.recordModelDeliveryFailure(
				rows.map(({ id }) => id),
				{
					ownerEpoch: this.opts.ownerEpoch,
					batchId,
					toLead: this.opts.leadId,
					error: (error as Error).message,
					now: this.isoNow(),
					maxAttempts: this.maxModelAttempts,
					backoffBaseMs: this.retryBackoffBaseMs,
					backoffCapMs: this.retryBackoffCapMs,
				},
			);
			throw error;
		}
	}

	private async runAndSchedule(): Promise<void> {
		if (this.running || this.stopped) return;
		this.running = true;
		try {
			await this.tick();
		} finally {
			this.running = false;
			if (!this.stopped && this.nudgePending) {
				this.nudgePending = false;
				void this.runAndSchedule();
			} else if (!this.stopped) {
				this.timer = this.setTimer(() => {
					this.timer = undefined;
					void this.runAndSchedule();
				}, this.nextDelayMs());
			}
		}
	}

	private isoNow(): string {
		return this.now().toISOString();
	}
}
