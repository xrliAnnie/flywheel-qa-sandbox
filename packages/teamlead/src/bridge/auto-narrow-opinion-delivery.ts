import { renderAutoNarrowOpinion } from "../auto-narrow/opinion.js";
import type {
	AutoNarrowOpinionDeliveryWork,
	StateStore,
} from "../StateStore.js";

const OPINION_DISCORD_TIMEOUT_MS = 10_000;

export interface AutoNarrowOpinionDeliveryDeps {
	store: StateStore;
	mode: "off" | "dry_run" | "auto";
	now?: () => string;
	post(input: {
		questionId: string;
		threadId: string;
		cardMessageId: string;
		content: string;
		signal: AbortSignal;
	}): Promise<
		| { kind: "posted"; messageId: string }
		| { kind: "uncertain" }
		| { kind: "failed" }
	>;
	edit(input: {
		questionId: string;
		threadId: string;
		messageId: string;
		content: string;
		signal: AbortSignal;
	}): Promise<{ ok: boolean }>;
	scan(input: {
		questionId: string;
		threadId: string;
		postedAt: string;
		correlationMarker: string;
	}): Promise<
		| { kind: "found"; messageId: string; frontier: string | null }
		| { kind: "none"; frontier: string | null }
		| { kind: "ambiguous"; frontier: string | null }
	>;
	setReaction(input: {
		questionId: string;
		threadId: string;
		cardMessageId: string;
		reaction: "eligible" | "ineligible";
	}): Promise<boolean>;
	markCard(input: {
		questionId: string;
		threadId: string;
		cardMessageId: string;
		banner: string;
		signal: AbortSignal;
	}): Promise<boolean>;
	log?: (message: string) => void;
}

export interface AutoNarrowOpinionDeliveryResult {
	scanned: number;
	delivered: number;
	recovered: number;
	deferred: number;
	skipped: number;
}

function render(
	work: AutoNarrowOpinionDeliveryWork,
	mode: "dry_run" | "auto",
	now: string,
): string {
	const { opinion, delivery } = work;
	return renderAutoNarrowOpinion({
		mode,
		eligible: opinion.eligible === 1,
		gate1: opinion.gate1 === 1,
		gate2: opinion.gate2 === 1,
		gate3: opinion.gate3 === 1,
		reasonCode: opinion.reasonCode,
		metrics: {
			sampleN: opinion.sampleN,
			agreeN: opinion.agreeN,
			precisionA: opinion.precisionA,
			precisionB: opinion.precisionB,
			confidenceLower: opinion.confidenceLower,
			sampleStartAt: opinion.sampleStartAt,
			sampleEndAt: opinion.sampleEndAt,
			lastEligibleHumanAt: opinion.lastEligibleHumanAt,
		},
		now,
		correlationMarker: delivery.correlationMarker,
	});
}

export async function reconcileAutoNarrowOpinionDeliveries(
	deps: AutoNarrowOpinionDeliveryDeps,
): Promise<AutoNarrowOpinionDeliveryResult> {
	const result: AutoNarrowOpinionDeliveryResult = {
		scanned: 0,
		delivered: 0,
		recovered: 0,
		deferred: 0,
		skipped: 0,
	};
	const sweepNow = deps.now?.() ?? new Date().toISOString();
	for (const work of deps.store.listAutoNarrowOpinionDeliveryWork(
		20,
		sweepNow,
	)) {
		result.scanned += 1;
		const { delivery, opinion } = work;
		if (deps.mode === "off" && delivery.automaticLabelPending === 0) {
			result.skipped += 1;
			continue;
		}
		const now = deps.now?.() ?? new Date().toISOString();
		if (delivery.state === "posting" || delivery.state === "uncertain") {
			const scan = await deps.scan({
				questionId: delivery.questionId,
				threadId: delivery.issueThreadId,
				postedAt: delivery.postingAt ?? now,
				correlationMarker: delivery.correlationMarker,
			});
			const recovery = deps.store.recordAutoNarrowOpinionRecovery({
				questionId: delivery.questionId,
				kind: scan.kind,
				now,
				frontier: scan.frontier,
				...(scan.kind === "found" ? { messageId: scan.messageId } : {}),
			});
			if (recovery === "recovered") result.recovered += 1;
			else result.deferred += 1;
			continue;
		}
		const claimed = deps.store.beginAutoNarrowOpinionDelivery(
			delivery.questionId,
			now,
		);
		if (!claimed) {
			result.skipped += 1;
			continue;
		}
		const generation = claimed.generation;
		if (deps.mode === "off") {
			if (!work.openingAt) {
				deps.store.deferAutoNarrowOpinionDelivery({
					questionId: claimed.questionId,
					generation,
					state: "pending",
					errorCode: "opening_missing",
					now,
				});
				result.deferred += 1;
				continue;
			}
			const marked = await deps.markCard({
				questionId: claimed.questionId,
				threadId: claimed.issueThreadId,
				cardMessageId: claimed.cardMessageId,
				banner: `窄口自动批（开关由 founder 于 ${work.openingAt} 打开）`,
				signal: AbortSignal.timeout(OPINION_DISCORD_TIMEOUT_MS),
			});
			if (
				!marked ||
				!deps.store.markAutoNarrowAutomaticLabelDelivered({
					questionId: claimed.questionId,
					generation,
				})
			) {
				deps.store.deferAutoNarrowOpinionDelivery({
					questionId: claimed.questionId,
					generation,
					state: "pending",
					errorCode: "card_label_failed",
					now,
				});
				result.deferred += 1;
				continue;
			}
			const expectedReaction =
				opinion.eligible === 1 ? "eligible" : "ineligible";
			if (
				deps.store.finishAutoNarrowOpinionDelivery({
					questionId: claimed.questionId,
					generation,
					expectedReaction,
				})
			) {
				result.delivered += 1;
			} else {
				deps.store.deferAutoNarrowOpinionDelivery({
					questionId: claimed.questionId,
					generation,
					state: "pending",
					errorCode: "off_opinion_paused",
					now,
				});
				result.deferred += 1;
			}
			continue;
		}
		const content = render(work, deps.mode, now);
		let messageId = claimed.followupMessageId;
		if (messageId) {
			const edited = await deps.edit({
				questionId: claimed.questionId,
				threadId: claimed.issueThreadId,
				messageId,
				content,
				signal: AbortSignal.timeout(OPINION_DISCORD_TIMEOUT_MS),
			});
			if (!edited.ok) {
				deps.store.deferAutoNarrowOpinionDelivery({
					questionId: claimed.questionId,
					generation,
					state: "pending",
					errorCode: "patch_failed",
					now,
				});
				result.deferred += 1;
				continue;
			}
		} else {
			const posted = await deps.post({
				questionId: claimed.questionId,
				threadId: claimed.issueThreadId,
				cardMessageId: claimed.cardMessageId,
				content,
				signal: AbortSignal.timeout(OPINION_DISCORD_TIMEOUT_MS),
			});
			if (posted.kind !== "posted") {
				deps.store.deferAutoNarrowOpinionDelivery({
					questionId: claimed.questionId,
					generation,
					state: posted.kind === "uncertain" ? "uncertain" : "pending",
					errorCode:
						posted.kind === "uncertain" ? "post_uncertain" : "post_failed",
					now,
				});
				result.deferred += 1;
				continue;
			}
			messageId = posted.messageId;
		}
		if (
			!deps.store.bindAutoNarrowOpinionMessage({
				questionId: claimed.questionId,
				generation,
				messageId,
				opinionId: opinion.opinionId,
			})
		) {
			result.deferred += 1;
			continue;
		}
		const expectedReaction = opinion.eligible === 1 ? "eligible" : "ineligible";
		if (claimed.reactionApplied !== expectedReaction) {
			const reacted = await deps.setReaction({
				questionId: claimed.questionId,
				threadId: claimed.issueThreadId,
				cardMessageId: claimed.cardMessageId,
				reaction: expectedReaction,
			});
			if (
				!reacted ||
				!deps.store.markAutoNarrowOpinionReaction({
					questionId: claimed.questionId,
					generation,
					reaction: expectedReaction,
				})
			) {
				deps.store.deferAutoNarrowOpinionDelivery({
					questionId: claimed.questionId,
					generation,
					state: "pending",
					errorCode: "reaction_failed",
					now,
				});
				result.deferred += 1;
				continue;
			}
		}
		if (claimed.automaticLabelPending === 1) {
			if (!work.openingAt) {
				deps.store.deferAutoNarrowOpinionDelivery({
					questionId: claimed.questionId,
					generation,
					state: "pending",
					errorCode: "opening_missing",
					now,
				});
				result.deferred += 1;
				continue;
			}
			const marked = await deps.markCard({
				questionId: claimed.questionId,
				threadId: claimed.issueThreadId,
				cardMessageId: claimed.cardMessageId,
				banner: `窄口自动批（开关由 founder 于 ${work.openingAt} 打开）`,
				signal: AbortSignal.timeout(OPINION_DISCORD_TIMEOUT_MS),
			});
			if (
				!marked ||
				!deps.store.markAutoNarrowAutomaticLabelDelivered({
					questionId: claimed.questionId,
					generation,
				})
			) {
				deps.store.deferAutoNarrowOpinionDelivery({
					questionId: claimed.questionId,
					generation,
					state: "pending",
					errorCode: "card_label_failed",
					now,
				});
				result.deferred += 1;
				continue;
			}
		}
		if (
			deps.store.finishAutoNarrowOpinionDelivery({
				questionId: claimed.questionId,
				generation,
				expectedReaction,
			})
		) {
			result.delivered += 1;
		} else {
			result.deferred += 1;
			deps.log?.(`[auto-narrow-opinion] ${claimed.questionId}: finish raced`);
		}
	}
	return result;
}
