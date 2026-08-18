import {
	checkReactionConfirmation,
	encodeReactionEmoji,
	type ReactionFetcher,
} from "../lead-backends/codex/gateway/founder-confirmation.js";
import type {
	StateStore,
	WorkflowEngineAlertIdentity,
	WorkflowGateHolderRow,
} from "../StateStore.js";
import { readCurrentGateMessageBinding } from "./approval-signal/gate-message-binding-store.js";
import {
	DISCORD_API,
	type EditDiscordResult,
	editDiscordMessageInChannel,
} from "./discord-utils.js";

type WorkflowRun = NonNullable<ReturnType<StateStore["getWorkflowRun"]>>;

export interface WorkflowGateCardDelivery {
	botToken: string;
	alertIdentity: WorkflowEngineAlertIdentity;
}

export interface WorkflowGateCardVoidDeps {
	store: StateStore;
	resolveAlertIdentity?(input: {
		holder: WorkflowGateHolderRow;
		run: WorkflowRun;
	}): WorkflowEngineAlertIdentity;
	resolveDelivery(input: {
		holder: WorkflowGateHolderRow;
		run: WorkflowRun;
	}): WorkflowGateCardDelivery | undefined;
	editCard?: (input: {
		threadId: string;
		messageId: string;
		text: string;
		botToken: string;
	}) => Promise<EditDiscordResult>;
	now?: () => string;
	limit?: number;
	requestTimeoutMs?: number;
	log?: (message: string) => void;
}

function withTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
	});
	return Promise.race([operation, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function exactCardThreadId(
	store: StateStore,
	holder: WorkflowGateHolderRow,
): string | undefined {
	if (!holder.card_message_id) return undefined;
	const binding = readCurrentGateMessageBinding(
		store,
		holder.source_execution_id,
		holder.question_id,
		holder.head_sha,
	);
	if (binding?.gateMessageId === holder.card_message_id) {
		return binding.threadId;
	}
	const matchingAudits: Record<string, unknown>[] = [];
	for (const event of store.getEventsByExecution(holder.source_execution_id)) {
		if (event.event_type !== "founder_thread_notified") continue;
		const payload = event.payload as Record<string, unknown> | undefined;
		if (
			payload?.questionId === holder.question_id &&
			payload.gateMessageId === holder.card_message_id &&
			typeof payload.threadId === "string" &&
			payload.threadId.length > 0
		) {
			matchingAudits.push(payload);
		}
	}
	const threadIds = new Set(
		matchingAudits.map((payload) => payload.threadId as string),
	);
	return threadIds.size === 1 ? [...threadIds][0] : undefined;
}

export function voidedWorkflowGateCardText(input: {
	holder: WorkflowGateHolderRow;
	issueId: string;
}): string {
	const head = input.holder.head_sha.slice(0, 8);
	const prior = `~~🚀 ${input.issueId} is ready to ship · head ${head}~~`;
	switch (input.holder.superseded_reason) {
		case "founder_feedback":
			return `⛔ 已打回作废 — 请勿在本卡操作\n${prior}\n返工完成后会自动出一张新的 ship 卡(绑新 head),请在新卡上批准。`;
		case "operator_rework":
			return `⛔ 已作废(工单已被 operator 重开返工)\n${prior}\n返工完成后会出新的 ship 卡。`;
		case "head_refresh_equivalent":
			return `✅ 已自动换到内容等价的新 head\n${prior}\n引擎已验证这只是机械 rebase,原批准继续有效,无需再次批准。`;
		case "land_rework":
			return `⛔ 已进入冲突返工 — 本卡批准已作废\n${prior}\n引擎会驱动 implement 解冲突并重新通过 QA；随后会出新 ship 卡,需要 founder 重新批准。`;
		default:
			return `⛔ 已作废(head 已换代)— 新的 ship 卡见下\n${prior}\n请在最新的 ship 卡上操作。`;
	}
}

export async function voidSupersededWorkflowGateCards(
	deps: WorkflowGateCardVoidDeps,
): Promise<{ attempted: number; done: number; failed: number }> {
	const result = { attempted: 0, done: 0, failed: 0 };
	const now = deps.now ?? (() => new Date().toISOString());
	const observedAt = now();
	const requestTimeoutMs = Math.max(
		1,
		Math.trunc(deps.requestTimeoutMs ?? 10_000),
	);
	const editCard =
		deps.editCard ??
		(async (input) => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
			try {
				return await editDiscordMessageInChannel(
					input.threadId,
					input.messageId,
					input.text,
					input.botToken,
					{ origin: "automation", signal: controller.signal },
				);
			} finally {
				clearTimeout(timer);
			}
		});
	const settle = (input: {
		holder: WorkflowGateHolderRow;
		outcome: "done" | "failed";
		alertIdentity: WorkflowEngineAlertIdentity;
		skipWatch?: boolean;
		at?: string;
	}): boolean => {
		try {
			const settled = deps.store.advanceWorkflowGateCardVoid({
				questionId: input.holder.question_id,
				outcome: input.outcome,
				now: input.at ?? observedAt,
				skipWatch: input.skipWatch,
				alertIdentity: input.alertIdentity,
			});
			if (!settled.ok) {
				deps.log?.(
					`[workflow-gate-card] settlement failed for ${input.holder.question_id}: ${settled.reason}`,
				);
			}
			return settled.ok;
		} catch (error) {
			deps.log?.(
				`[workflow-gate-card] settlement failed for ${input.holder.question_id}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	};
	const defer = (
		holder: WorkflowGateHolderRow,
		alertIdentity: WorkflowEngineAlertIdentity,
	): void => {
		const deferredAt = now();
		try {
			const deferred = deps.store.deferWorkflowGateCardVoid({
				questionId: holder.question_id,
				now: deferredAt,
				retryAt: new Date(Date.parse(deferredAt) + 60 * 1_000).toISOString(),
			});
			if (!deferred.ok) {
				deps.log?.(
					`[workflow-gate-card] defer failed for ${holder.question_id}: ${deferred.reason}`,
				);
				return;
			}
			if (deferred.budgetExhausted) {
				settle({
					holder,
					outcome: "failed",
					alertIdentity,
					at: deferredAt,
				});
			}
		} catch (error) {
			deps.log?.(
				`[workflow-gate-card] defer failed for ${holder.question_id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
	for (const holder of deps.store.listWorkflowGateHoldersForCardVoid(
		observedAt,
		deps.limit ?? 20,
	)) {
		result.attempted += 1;
		const run = deps.store.getWorkflowRun(holder.run_id);
		const fallbackIdentity: WorkflowEngineAlertIdentity = {
			leadId: "unassigned",
			projectName: run?.project_name ?? "unknown",
			leadResolution: "fallback",
		};
		let alertIdentity = fallbackIdentity;
		try {
			const delivery = run ? deps.resolveDelivery({ holder, run }) : undefined;
			alertIdentity =
				delivery?.alertIdentity ??
				(run ? deps.resolveAlertIdentity?.({ holder, run }) : undefined) ??
				fallbackIdentity;
			const threadId = exactCardThreadId(deps.store, holder);
			if (!run || !delivery?.botToken || !threadId || !holder.card_message_id) {
				settle({
					holder,
					outcome: "failed",
					alertIdentity,
				});
				result.failed += 1;
				continue;
			}
			let edited: EditDiscordResult;
			try {
				edited = await withTimeout(
					editCard({
						threadId,
						messageId: holder.card_message_id,
						text: voidedWorkflowGateCardText({ holder, issueId: run.issue_id }),
						botToken: delivery.botToken,
					}),
					requestTimeoutMs,
					"discord_card_void",
				);
			} catch (error) {
				deps.log?.(
					`[workflow-gate-card] transient void failure for ${holder.question_id}: ${error instanceof Error ? error.message : String(error)}`,
				);
				defer(holder, alertIdentity);
				result.failed += 1;
				continue;
			}
			if (edited.ok || edited.status === 404) {
				const settled = settle({
					holder,
					outcome: "done",
					skipWatch: !edited.ok && edited.status === 404,
					alertIdentity,
				});
				if (settled) result.done += 1;
				else result.failed += 1;
				continue;
			}
			if (
				edited.status === undefined ||
				edited.status === 429 ||
				edited.status >= 500
			) {
				defer(holder, alertIdentity);
				result.failed += 1;
				continue;
			}
			settle({
				holder,
				outcome: "failed",
				alertIdentity,
			});
			result.failed += 1;
		} catch (error) {
			deps.log?.(
				`[workflow-gate-card] void failed for ${holder.question_id}: ${error instanceof Error ? error.message : String(error)}`,
			);
			settle({
				holder,
				outcome: "failed",
				alertIdentity,
			});
			result.failed += 1;
		}
	}
	return result;
}

export interface WorkflowGateCardWatchDeps {
	store: StateStore;
	founderId: string;
	resolveDelivery(input: {
		holder: WorkflowGateHolderRow;
		run: WorkflowRun;
	}): WorkflowGateCardDelivery | undefined;
	makeReactionFetcher?: (botToken: string) => ReactionFetcher;
	fetchImpl?: typeof fetch;
	now?: () => string;
	limit?: number;
	requestTimeoutMs?: number;
	log?: (message: string) => void;
}

/** Observe only the canonical founder's ✅ on recently voided cards. */
export async function watchVoidedWorkflowGateCards(
	deps: WorkflowGateCardWatchDeps,
): Promise<{ checked: number; alerted: number; failed: number }> {
	const result = { checked: 0, alerted: 0, failed: 0 };
	const now = deps.now ?? (() => new Date().toISOString());
	const observedAt = now();
	const requestTimeoutMs = Math.max(
		1,
		Math.trunc(deps.requestTimeoutMs ?? 10_000),
	);
	for (const holder of deps.store.listWorkflowGateHoldersForCardWatch(
		observedAt,
		deps.limit ?? 10,
	)) {
		const escalationUid = `voided_card_input:${holder.question_id}`;
		const existing = deps.store.getWorkflowAlertOutbox(escalationUid);
		if (existing) {
			if (existing.run_id === holder.run_id) {
				deps.store.advanceWorkflowGateCardWatch({
					questionId: holder.question_id,
					now: observedAt,
					stop: true,
				});
				continue;
			}
			deps.log?.(
				`[workflow-gate-card] watch alert uid conflict for ${holder.question_id}: ${existing.run_id}`,
			);
			deps.store.advanceWorkflowGateCardWatch({
				questionId: holder.question_id,
				now: observedAt,
				stop: true,
			});
			result.failed += 1;
			continue;
		}
		const run = deps.store.getWorkflowRun(holder.run_id);
		const delivery = run ? deps.resolveDelivery({ holder, run }) : undefined;
		const threadId = exactCardThreadId(deps.store, holder);
		if (
			!run ||
			!delivery?.botToken ||
			!threadId ||
			!holder.card_message_id ||
			!deps.founderId
		) {
			deps.log?.(
				`[workflow-gate-card] watch binding unavailable for ${holder.question_id}`,
			);
			deps.store.advanceWorkflowGateCardWatch({
				questionId: holder.question_id,
				now: observedAt,
			});
			result.failed += 1;
			continue;
		}
		const reactionFetcher =
			deps.makeReactionFetcher?.(delivery.botToken) ??
			((async ({ channelId, messageId, emoji, after }) => {
				const afterQuery = after ? `&after=${encodeURIComponent(after)}` : "";
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
				try {
					const response = await (deps.fetchImpl ?? fetch)(
						`${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${encodeReactionEmoji(emoji)}?limit=100${afterQuery}`,
						{
							headers: { Authorization: `Bot ${delivery.botToken}` },
							signal: controller.signal,
						},
					);
					return {
						status: response.status,
						body: response.ok ? await response.json() : undefined,
					};
				} finally {
					clearTimeout(timer);
				}
			}) satisfies ReactionFetcher);
		result.checked += 1;
		let confirmation: Awaited<ReturnType<typeof checkReactionConfirmation>>;
		try {
			confirmation = await withTimeout(
				checkReactionConfirmation(reactionFetcher, {
					channelId: threadId,
					messageId: holder.card_message_id,
					founderId: deps.founderId,
					emoji: "✅",
				}),
				requestTimeoutMs,
				"discord_card_watch",
			);
		} catch (error) {
			deps.log?.(
				`[workflow-gate-card] watch failed for ${holder.question_id}: ${error instanceof Error ? error.message : String(error)}`,
			);
			deps.store.advanceWorkflowGateCardWatch({
				questionId: holder.question_id,
				now: observedAt,
			});
			result.failed += 1;
			continue;
		}
		if (confirmation.confirmed) {
			const recorded = deps.store.recordVoidedWorkflowGateInput({
				questionId: holder.question_id,
				alertIdentity: delivery.alertIdentity,
				now: observedAt,
			});
			if (recorded.ok) {
				deps.store.advanceWorkflowGateCardWatch({
					questionId: holder.question_id,
					now: observedAt,
					stop: true,
				});
				result.alerted += 1;
				continue;
			}
			deps.log?.(
				`[workflow-gate-card] watch alert failed for ${holder.question_id}: ${recorded.reason}`,
			);
			result.failed += 1;
		}
		deps.store.advanceWorkflowGateCardWatch({
			questionId: holder.question_id,
			now: observedAt,
		});
	}
	return result;
}
