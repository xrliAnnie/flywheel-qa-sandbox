/**
 * FLY-1373 — per-Lead at-least-once inbox consumption loop.
 *
 * Authority stays in comm.db until a backend adapter returns a durable receipt.
 * A failed handoff, lost reply, audit-mirror failure, or owner-fence loss leaves
 * the immutable batch pending for the next tick.
 */

import { randomUUID } from "node:crypto";
import {
	discordBatchPartitionKey,
	parseDiscordChatRoute,
} from "flywheel-comm/discord-chat-ingest";
import type {
	MailboxQueue,
	MailboxRecipientState,
	MailboxRow,
} from "flywheel-comm/mailbox-queue";
import type {
	LeadDeliveryAdapter,
	LeadDeliveryBatch,
} from "./lead-delivery-adapter.js";
import { LeadDeliveryUnavailableError } from "./lead-delivery-adapter.js";
import {
	DEFAULT_MAILBOX_QUEUE_CONFIG,
	type MailboxQueueConfig,
} from "./mailbox-queue-config.js";

export const ACTIVE_LEAD_INBOX_INTERVAL_MS = 1_000;
export const IDLE_LEAD_INBOX_INTERVAL_MS = 30_000;

export interface LeadInboxTickResult {
	ok: boolean;
	protocolConsumed: number;
	modelConsumed: number;
	error?: string;
}

export interface LeadInboxLoopOptions {
	queue: MailboxQueue;
	leadId: string;
	ownerEpoch: string;
	adapter: LeadDeliveryAdapter;
	hasLiveSession: () => boolean;
	hasAdditionalWork?: () => boolean;
	/** Materialize newly-arrived CommDB questions/protocol rows before claiming. */
	admit?: () => Promise<void>;
	/** Idempotent typed protocol effect. It must durably finish before returning. */
	handleProtocol: (row: MailboxRow) => Promise<{ disposition: string }>;
	maxProtocolAttempts?: number;
	maxModelAttempts?: number;
	retryBackoffBaseMs?: number;
	retryBackoffCapMs?: number;
	unprocessedWindowMs?: number;
	onProtocolQuarantine?: (
		row: MailboxRow,
		error: Error,
	) => Promise<void> | void;
	/** Fail-closed question/event dispatch revalidation. */
	revalidateModel?: (
		row: MailboxRow,
	) => Promise<
		{ deliver: true } | { deliver: false; disposition: string; retry?: boolean }
	>;
	/** Durable audit mirror update, called only after the adapter receipt. */
	markAuditDelivered?: (row: MailboxRow) => Promise<void> | void;
	renderModelBatch?: (rows: readonly MailboxRow[]) => string;
	/** FLY-1573: resolved exactly once at the beginning of a tick. */
	queueConfig?: () => MailboxQueueConfig;
	/** Process-incarnation liveness; unknown holds expired batches in place. */
	recipientState?: (leadId: string) => MailboxRecipientState;
	ackInstruction?: string;
	now?: () => Date;
	batchIdFactory?: () => string;
	leaseTtlMs?: number;
	claimTtlMs?: number;
	activeIntervalMs?: number;
	idleIntervalMs?: number;
	maxBatchBytes?: number;
	onModelTransportStall?: (context: {
		leadId: string;
		error: string;
		at: string;
	}) => Promise<void> | void;
	onModelTransportRecovered?: (context: {
		leadId: string;
		at: string;
	}) => Promise<void> | void;
	onModelTransportExhausted?: (context: {
		leadId: string;
		deliveryIds: string[];
		error: string;
		attempt: number;
		at: string;
	}) => Promise<void> | void;
	onDiscordUndeliverable?: (context: {
		leadId: string;
		deliveryIds: string[];
		reason: string;
		attempt: number;
		at: string;
	}) => Promise<void> | void;
	onDiscordDeliveryStall?: (context: {
		leadId: string;
		batchId: string;
		deliveryIds: string[];
		error: string;
		at: string;
	}) => Promise<void> | void;
	setTimer?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
	logger?: { warn: (message: string, context?: unknown) => void };
	/** FLY-1393 QA seam: stall after the heartbeat is durably started. */
	afterTickStarted?: () => Promise<void>;
}

/**
 * FLY-1599 (codex review HIGH): error serialization must be TOTAL. `throw null`
 * / `throw "string"` are valid JavaScript rejection values, and
 * `(error as Error).message` on them throws a TypeError INSIDE the catch block
 * — escaping the very boundary the catch exists to seal.
 */
function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class LeadInboxLoop {
	private readonly activeIntervalMs: number;
	private readonly idleIntervalMs: number;
	private readonly leaseTtlMs: number;
	private readonly claimTtlMs: number;
	private readonly maxBatchBytes: number;
	private readonly maxProtocolAttempts: number;
	private readonly maxModelAttempts: number;
	private readonly retryBackoffBaseMs: number;
	private readonly retryBackoffCapMs: number;
	private readonly now: () => Date;
	private readonly batchIdFactory: () => string;
	private readonly setTimer: NonNullable<LeadInboxLoopOptions["setTimer"]>;
	private readonly clearTimer: NonNullable<LeadInboxLoopOptions["clearTimer"]>;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	private stopped = true;
	private nudgePending = false;
	private transportStalled = false;
	private lastTransportAlertMs = 0;
	private discordStalled = false;
	private lastDiscordStallAlertMs = 0;
	private unknownRecipientHoldActive = false;

	constructor(private readonly opts: LeadInboxLoopOptions) {
		this.activeIntervalMs =
			opts.activeIntervalMs ?? ACTIVE_LEAD_INBOX_INTERVAL_MS;
		this.idleIntervalMs = opts.idleIntervalMs ?? IDLE_LEAD_INBOX_INTERVAL_MS;
		this.leaseTtlMs = opts.leaseTtlMs ?? 10_000;
		this.claimTtlMs = opts.claimTtlMs ?? 15_000;
		this.maxBatchBytes = opts.maxBatchBytes ?? 4 * 1024 * 1024;
		this.maxProtocolAttempts = opts.maxProtocolAttempts ?? 3;
		this.maxModelAttempts = opts.maxModelAttempts ?? 5;
		this.retryBackoffBaseMs = opts.retryBackoffBaseMs ?? 5_000;
		this.retryBackoffCapMs = opts.retryBackoffCapMs ?? 10 * 60_000;
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
		// FLY-1599: countPending is synchronous SQL and this method is evaluated
		// inside runAndSchedule's finally block. A SQLITE_BUSY here escaped through
		// the finally and killed the process the same way a tick throw did. A wrong
		// (idle) delay is recoverable; a dead Bridge is not.
		try {
			return this.opts.hasLiveSession() ||
				this.opts.hasAdditionalWork?.() ||
				this.opts.queue.countDeliverable(this.opts.leadId) > 0
				? this.activeIntervalMs
				: this.idleIntervalMs;
		} catch (error) {
			this.opts.logger?.warn(
				"Lead inbox nextDelayMs failed; using idle delay",
				{
					leadId: this.opts.leadId,
					error: describeError(error),
				},
			);
			return this.idleIntervalMs;
		}
	}

	async tick(): Promise<LeadInboxTickResult> {
		const startedAt = this.isoNow();
		let protocolConsumed = 0;
		let modelConsumed = 0;
		try {
			const queueConfig =
				this.opts.queueConfig?.() ?? DEFAULT_MAILBOX_QUEUE_CONFIG;
			const recipientStates = new Map<string, MailboxRecipientState>();
			const recipientState = (recipient: string): MailboxRecipientState => {
				const cached = recipientStates.get(recipient);
				if (cached) return cached;
				const resolved = this.opts.recipientState?.(recipient) ?? "alive";
				recipientStates.set(recipient, resolved);
				return resolved;
			};
			// FLY-1599: recordTickStarted is synchronous SQL. It used to run BEFORE
			// this try block, so a SQLITE_BUSY during a lead-restart herd escaped
			// tick() entirely, became an unhandled rejection on the floating
			// runAndSchedule() promise, and killed the whole Bridge (captured stack:
			// lead-inbox-queue.ts:2376 ← lead-inbox-loop.ts:158 ← Timeout._onTimeout,
			// exit 1, 2026-08-02). Everything the tick does — including its own
			// bookkeeping — must stay inside the tick boundary.
			this.opts.queue.recordTickStarted(this.opts.leadId, startedAt);
			await this.opts.afterTickStarted?.();
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
			const reconciliation = this.opts.queue.reconcileExpiredLeases({
				ownerEpoch: this.opts.ownerEpoch,
				now: this.isoNow(),
				recipientKind: "lead",
				toAgent: this.opts.leadId,
				leaseRetryMax: queueConfig.leaseRetryMax,
				recipientState,
				maxBatches: 100,
				maxTerminalRows: 0,
			});
			if (reconciliation.skippedUnknown > 0) {
				if (!this.unknownRecipientHoldActive) {
					this.opts.logger?.warn(
						"Lead inbox held expired batches for an unknown recipient incarnation",
						{
							leadId: this.opts.leadId,
							skippedUnknown: reconciliation.skippedUnknown,
						},
					);
				}
				this.unknownRecipientHoldActive = true;
			} else {
				this.unknownRecipientHoldActive = false;
			}
			this.opts.queue.releaseExpiredLegacyPushClaims({
				toAgent: this.opts.leadId,
				ownerEpoch: this.opts.ownerEpoch,
				now: this.isoNow(),
				maxRows: 100,
			});

			for (;;) {
				const now = this.isoNow();
				const row = this.opts.queue.claimBridgeProtocol({
					fromAgent: this.opts.leadId,
					ownerEpoch: this.opts.ownerEpoch,
					now,
					claimTtlMs: this.claimTtlMs,
				});
				if (!row) break;
				if (
					!this.opts.queue.isCurrentOwner(this.opts.ownerEpoch, this.isoNow())
				) {
					throw new Error("owner fence lost before protocol effect");
				}
				try {
					await this.opts.handleProtocol(row);
					if (!this.opts.queue.ack(row.id, this.isoNow()))
						throw new Error("owner fence lost after protocol effect");
					protocolConsumed++;
				} catch (error) {
					const failure = this.opts.queue.recordBridgeDeliveryFailure({
						id: row.id,
						ownerEpoch: this.opts.ownerEpoch,
						error: describeError(error),
						now: this.isoNow(),
						nextRetryAt: this.nextRetryAt(row.retry_count),
						maxAttempts: this.maxProtocolAttempts,
					});
					const terminal = failure.deadLettered;
					if (terminal) {
						await this.opts.onProtocolQuarantine?.(row, error as Error);
						protocolConsumed++;
						continue;
					}
					throw error;
				}
			}

			const candidateBatchId = this.batchIdFactory();
			const claimed = this.opts.queue.claimLeadBatchQueue({
				toAgent: this.opts.leadId,
				msgClass: "model",
				ownerEpoch: this.opts.ownerEpoch,
				batchId: candidateBatchId,
				now: this.isoNow(),
				transportClaimTtlMs: this.claimTtlMs,
				batchWindowMs: queueConfig.batchWindowMs,
				batchMaxSize: queueConfig.batchMaxSize,
				inflightMaxBatches: queueConfig.inflightMaxBatches,
				maxBatchBytes: this.maxBatchBytes,
				partitionKey: discordBatchPartitionKey,
			});
			if (claimed.length > 0) {
				const freshBatch = claimed[0]?.batch_id === candidateBatchId;
				const deliverable: MailboxRow[] = [];
				for (const row of claimed) {
					// A frozen membership may already exist at the adapter even when a
					// crash left retry_count at zero. Revalidate only a new batch, unless
					// a question proves the crash happened before materialization and
					// therefore before the adapter handoff.
					const needsQuestionMaterialization =
						row.type === "question" &&
						row.source_ref === null &&
						row.delivery_content === null;
					const verdict =
						(freshBatch || needsQuestionMaterialization) &&
						row.state === "LEASED" &&
						row.retry_count === 0 &&
						this.opts.revalidateModel
							? await this.opts.revalidateModel(row)
							: ({ deliver: true } as const);
					if (!verdict.deliver) {
						const changed = verdict.retry
							? this.opts.queue.releaseClaimForRetry({
									id: row.id,
									ownerEpoch: this.opts.ownerEpoch,
									batchId: row.batch_id!,
									nextRetryAt: new Date(
										this.now().getTime() + 30_000,
									).toISOString(),
									reason: verdict.disposition,
								})
							: this.opts.queue.markDead(
									row.id,
									this.isoNow(),
									verdict.disposition,
								);
						if (!changed) {
							throw new Error("owner fence lost while revoking model row");
						}
						continue;
					}
					const materialized = this.opts.queue.getById(row.id);
					if (!materialized)
						throw new Error(`mailbox row disappeared: ${row.id}`);
					deliverable.push(materialized);
				}

				if (deliverable.length > 0) {
					await this.deliverModelBatch(deliverable, queueConfig);
					modelConsumed = deliverable.length;
				}
			}
			this.opts.queue.recordTickSuccess(this.opts.leadId, this.isoNow());
			return { ok: true, protocolConsumed, modelConsumed };
		} catch (error) {
			const message = describeError(error);
			this.opts.logger?.warn("Lead inbox tick failed", {
				leadId: this.opts.leadId,
				error: message,
			});
			return {
				ok: false,
				protocolConsumed,
				modelConsumed,
				error: message,
			};
		}
	}

	private async deliverModelBatch(
		rows: MailboxRow[],
		queueConfig: MailboxQueueConfig,
	): Promise<void> {
		const batchId = rows[0]?.batch_id;
		if (!batchId || rows.some((row) => row.batch_id !== batchId)) {
			throw new Error("claimed model batch has invalid membership");
		}
		if (!this.opts.queue.isCurrentOwner(this.opts.ownerEpoch, this.isoNow())) {
			throw new Error("owner fence lost before transport handoff");
		}
		const discord = rows[0]?.type === "discord_chat";
		if (discord !== rows.every((row) => row.type === "discord_chat")) {
			throw new Error("claimed model batch mixes Discord and regular rows");
		}
		let route: ReturnType<typeof parseDiscordChatRoute> = {};
		if (discord) {
			try {
				const routes = rows.map((row) => parseDiscordChatRoute(row.content));
				route = routes[0] ?? {};
				if (
					routes.some(
						(candidate) => JSON.stringify(candidate) !== JSON.stringify(route),
					)
				) {
					throw new Error("Discord batch route mismatch");
				}
			} catch (error) {
				await this.quarantineDiscord(
					rows,
					`route_parse:${describeError(error)}`,
				);
				return;
			}
		}
		const attempt = rows[0]?.lease_retry_count ?? 0;
		if (rows.some((row) => row.lease_retry_count !== attempt)) {
			throw new Error("claimed model batch mixes lease retry attempts");
		}
		const transportBatchId = `${batchId}#r${attempt}`;
		const transportMemberIds = rows.map(
			(row) => `${row.delivery_id}#r${attempt}`,
		);
		const header = `[mailbox-batch ${batchId} | ${rows.length} messages | from ${rows[0]?.from_agent}]\nYou must ack this batch with ${this.opts.ackInstruction ?? "flywheel_inbox_ack_batch or lead_actions.ack_batch"} promptly so the sender can see you received it; unacked batches are redelivered and eventually dead-lettered.`;
		const batch: LeadDeliveryBatch = {
			batchId: transportBatchId,
			leadId: this.opts.leadId,
			ownerEpoch: this.opts.ownerEpoch,
			kind: discord ? "discord_chat" : "model",
			members: rows.map((row, index) => {
				const content = row.delivery_content ?? row.content;
				const modelContent = `${index === 0 ? `${header}\n\n` : ""}${content}`;
				return {
					deliveryId: transportMemberIds[index]!,
					content: modelContent,
					priority: row.priority,
					seq: row.seq,
				};
			}),
			modelPayload: `${header}\n\n${
				this.opts.renderModelBatch?.(rows) ??
				rows.map((row) => row.delivery_content ?? row.content).join("\n\n")
			}`,
			...route,
		};
		try {
			const receipt = await this.opts.adapter.deliverBatch(batch);
			if (receipt.status === "membership_conflict") {
				if (discord) {
					await this.quarantineDiscord(rows, `membership_conflict:${batchId}`);
					return;
				}
				const quarantined = rows.filter((row) =>
					this.opts.queue.markDead(
						row.id,
						this.isoNow(),
						`membership_conflict:${batchId}`,
					),
				).length;
				if (quarantined !== rows.length) {
					throw new Error("owner fence lost while quarantining conflict");
				}
				return;
			}
			if (
				receipt.batchId !== transportBatchId ||
				receipt.memberIds.length !== rows.length ||
				receipt.memberIds.some((id, index) => id !== transportMemberIds[index])
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
			if (
				this.opts.queue.recordLeadBatchDelivered({
					batchId,
					ownerEpoch: this.opts.ownerEpoch,
					now: this.isoNow(),
					ackLeaseTtlMs: queueConfig.ackLeaseMs,
				}) === "lost_race"
			) {
				throw new Error("owner fence lost before queue delivery receipt");
			}
			if (this.transportStalled) {
				this.transportStalled = false;
				this.lastTransportAlertMs = 0;
				await this.opts.onModelTransportRecovered?.({
					leadId: this.opts.leadId,
					at: this.isoNow(),
				});
			}
			if (discord && this.discordStalled) {
				this.discordStalled = false;
				this.lastDiscordStallAlertMs = 0;
				this.opts.logger?.warn("discord_mailbox_delivery_recovered", {
					leadId: this.opts.leadId,
				});
			}
		} catch (error) {
			const unavailable = error instanceof LeadDeliveryUnavailableError;
			const leadUnavailable = unavailable && error.scope === "lead";
			const attempt = (rows[0]?.retry_count ?? 0) + 1;
			const unavailableExhausted =
				unavailable && attempt >= queueConfig.unavailableRetryMax;
			let terminalLeadAlerted = false;
			if (discord && unavailableExhausted) {
				await this.quarantineDiscord(
					rows,
					`transport_unavailable_exhausted:${describeError(error)}`,
					{
						error: describeError(error),
						maxAttempts: queueConfig.unavailableRetryMax,
						deadReason: "transport_unavailable_exhausted",
					},
				);
			} else if (discord && !unavailable && attempt >= this.maxModelAttempts) {
				await this.quarantineDiscord(
					rows,
					`delivery_attempts_exhausted:${describeError(error)}`,
				);
			} else {
				if (
					leadUnavailable &&
					unavailableExhausted &&
					this.opts.onModelTransportExhausted
				) {
					try {
						await this.opts.onModelTransportExhausted({
							leadId: this.opts.leadId,
							deliveryIds: rows.map(({ delivery_id }) => delivery_id),
							error: describeError(error),
							attempt,
							at: this.isoNow(),
						});
						terminalLeadAlerted = true;
					} catch (alertError) {
						this.opts.logger?.warn(
							"codex_model_transport_exhausted_alert_failed",
							{
								leadId: this.opts.leadId,
								deliveryIds: rows.map(({ delivery_id }) => delivery_id),
								error: describeError(alertError),
							},
						);
						const changed = this.opts.queue.recordLeadDeliveryFailure({
							ownerEpoch: this.opts.ownerEpoch,
							batchId,
							error: `transport_exhausted_alert_failed:${describeError(alertError)}`,
							now: this.isoNow(),
							nextRetryAt: this.nextRetryAt(rows[0]?.retry_count ?? 0),
							maxAttempts: Number.MAX_SAFE_INTEGER,
						});
						if (changed !== rows.length) {
							throw new Error(
								"owner fence lost while backing off terminal transport alert",
							);
						}
						throw alertError;
					}
				}
				this.opts.queue.recordLeadDeliveryFailure({
					ownerEpoch: this.opts.ownerEpoch,
					batchId,
					error: describeError(error),
					now: this.isoNow(),
					nextRetryAt: this.nextRetryAt(rows[0]?.retry_count ?? 0),
					maxAttempts: unavailable
						? queueConfig.unavailableRetryMax
						: this.maxModelAttempts,
					...(unavailable
						? { deadReason: "transport_unavailable_exhausted" }
						: {}),
				});
			}
			if (leadUnavailable && !terminalLeadAlerted)
				await this.noteTransportStall(describeError(error));
			if (
				discord &&
				unavailable &&
				!unavailableExhausted &&
				attempt >= 5 &&
				(this.lastDiscordStallAlertMs === 0 ||
					this.now().getTime() - this.lastDiscordStallAlertMs >= 30 * 60_000)
			) {
				this.discordStalled = true;
				this.lastDiscordStallAlertMs = this.now().getTime();
				this.opts.logger?.warn("discord_mailbox_delivery_stalled", {
					leadId: this.opts.leadId,
					batchId,
					deliveryIds: rows.map(({ delivery_id }) => delivery_id),
					error: describeError(error),
				});
				await this.opts.onDiscordDeliveryStall?.({
					leadId: this.opts.leadId,
					batchId,
					deliveryIds: rows.map(({ delivery_id }) => delivery_id),
					error: describeError(error),
					at: this.isoNow(),
				});
			}
			throw error;
		}
	}

	private async quarantineDiscord(
		rows: MailboxRow[],
		reason: string,
		terminalFailure?: {
			error: string;
			maxAttempts: number;
			deadReason: string;
		},
	): Promise<void> {
		const at = this.isoNow();
		const deliveryIds = rows.map(({ delivery_id }) => delivery_id);
		const batchId = rows[0]?.batch_id;
		if (!batchId) throw new Error("Discord quarantine batch id is missing");
		const attempt = (rows[0]?.retry_count ?? 0) + 1;
		try {
			await this.opts.onDiscordUndeliverable?.({
				leadId: this.opts.leadId,
				deliveryIds,
				reason,
				attempt,
				at,
			});
		} catch (error) {
			this.opts.logger?.warn("discord_mailbox_alert_failed", {
				leadId: this.opts.leadId,
				deliveryIds,
				error: describeError(error),
			});
			const changed = this.opts.queue.recordLeadDeliveryFailure({
				ownerEpoch: this.opts.ownerEpoch,
				batchId,
				error: `quarantine_alert_failed:${describeError(error)}`,
				now: at,
				nextRetryAt: this.nextRetryAt(rows[0]?.retry_count ?? 0),
				maxAttempts: Number.MAX_SAFE_INTEGER,
			});
			if (changed !== rows.length) {
				throw new Error(
					"owner fence lost while backing off Discord quarantine alert",
				);
			}
			return;
		}
		this.opts.logger?.warn("discord_mailbox_undeliverable", {
			leadId: this.opts.leadId,
			deliveryIds,
			reason,
		});
		const changed = terminalFailure
			? this.opts.queue.recordLeadDeliveryFailure({
					ownerEpoch: this.opts.ownerEpoch,
					batchId,
					error: terminalFailure.error,
					now: at,
					nextRetryAt: this.nextRetryAt(rows[0]?.retry_count ?? 0),
					maxAttempts: terminalFailure.maxAttempts,
					deadReason: terminalFailure.deadReason,
				})
			: rows.filter((row) =>
					this.opts.queue.markDead(
						row.id,
						at,
						`discord_undeliverable:${reason}`,
					),
				).length;
		if (changed !== rows.length) {
			throw new Error("owner fence lost while quarantining Discord batch");
		}
	}

	private async noteTransportStall(error: string): Promise<void> {
		const now = this.now().getTime();
		if (
			this.lastTransportAlertMs !== 0 &&
			now - this.lastTransportAlertMs < 30 * 60_000
		)
			return;
		this.transportStalled = true;
		this.lastTransportAlertMs = now;
		this.opts.logger?.warn("codex_model_transport_unavailable", {
			leadId: this.opts.leadId,
			error,
		});
		await this.opts.onModelTransportStall?.({
			leadId: this.opts.leadId,
			error,
			at: this.isoNow(),
		});
	}

	private async runAndSchedule(): Promise<void> {
		if (this.running || this.stopped) return;
		this.running = true;
		try {
			await this.tick();
		} catch (error) {
			// FLY-1599: belt-and-suspenders. tick() catches its own failures today,
			// but this method runs as a floating promise (`void this.runAndSchedule()`
			// from a timer), so ANY escape here is an unhandledRejection that takes
			// down the entire Bridge — one lead's bad tick must never kill delivery
			// for the whole fleet. Log and let the finally block reschedule.
			this.opts.logger?.warn("Lead inbox tick escaped its boundary", {
				leadId: this.opts.leadId,
				error: describeError(error),
			});
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

	private nextRetryAt(retryCount: number): string {
		const delay = Math.min(
			this.retryBackoffCapMs,
			this.retryBackoffBaseMs * 2 ** retryCount,
		);
		return new Date(this.now().getTime() + delay).toISOString();
	}
}
