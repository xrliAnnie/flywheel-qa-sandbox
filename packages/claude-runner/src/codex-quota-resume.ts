/**
 * FLY-2900 — the runner half of the Codex quota standby resume.
 *
 * A relaunched process resumes the parked thread and sends one short
 * continue turn. The continue carries a Bridge-minted durable id twice — as
 * the `clientUserMessageId` (echoed back as the user item's `clientId`) and
 * as a fixed text marker — so a crash anywhere around `turn/start` can be
 * reconciled from `thread/read` instead of blindly sending a second turn.
 */

import type {
	CodexQuotaContinueReconciliation,
	CodexQuotaResumeLifecycle,
} from "flywheel-core";

/** The only variable part of the continue text is the system-generated id. */
export function quotaContinueMarker(continueAttemptId: string): string {
	return `[flywheel quota-resume ${continueAttemptId}]`;
}

export function quotaContinueText(continueAttemptId: string): string {
	return `${quotaContinueMarker(continueAttemptId)} Codex 额度已恢复（已换号或已回血）。上一回合因额度中断。请从中断处继续原任务：先 \`git status\` 并读进度账本核对现场，不要重复已完成的步骤。`;
}

/** Items the user (or a hook) authored — everything else is model output. */
const NON_MODEL_ITEM_TYPES = new Set(["userMessage", "hookPrompt"]);

export function isQuotaModelOutputItemType(type: unknown): type is string {
	return typeof type === "string" && !NON_MODEL_ITEM_TYPES.has(type);
}

const TURN_STATUSES = new Set([
	"completed",
	"interrupted",
	"failed",
	"inProgress",
]);

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userItemCarriesId(item: Record<string, unknown>, id: string): boolean {
	if (item.type !== "userMessage") return false;
	if (item.clientId === id) return true;
	const marker = quotaContinueMarker(id);
	return (
		Array.isArray(item.content) &&
		item.content.some(
			(part) =>
				record(part) &&
				part.type === "text" &&
				typeof part.text === "string" &&
				part.text.includes(marker),
		)
	);
}

function isUsageLimitError(error: unknown): boolean {
	if (!record(error)) return false;
	const info = error.codexErrorInfo ?? error.codex_error_info;
	return info === "usageLimitExceeded";
}

/**
 * Classify a `thread/read(includeTurns:true)` result for one continue id:
 * proven (its turn produced model output), failed before output (its turn
 * ended without any), absent (every turn is fully loaded and none carries
 * the id), or unavailable (still running, malformed, foreign, or not
 * provable either way).
 */
export function reconcileQuotaContinue(
	result: unknown,
	threadId: string,
	continueAttemptId: string,
): CodexQuotaContinueReconciliation {
	const unavailable = { kind: "unavailable" } as const;
	if (!record(result) || !record(result.thread)) return unavailable;
	if (result.thread.id !== threadId) return unavailable;
	const turns = result.thread.turns;
	if (!Array.isArray(turns)) return unavailable;
	let everyTurnLoaded = true;
	for (const turn of turns) {
		if (
			!record(turn) ||
			typeof turn.id !== "string" ||
			!TURN_STATUSES.has(turn.status as string) ||
			!Array.isArray(turn.items)
		)
			return unavailable;
		const view = turn.itemsView ?? "full";
		if (view !== "full") everyTurnLoaded = false;
		const items = turn.items.filter(record);
		if (!items.some((item) => userItemCarriesId(item, continueAttemptId)))
			continue;
		if (view !== "full") return unavailable;
		if (items.some((item) => isQuotaModelOutputItemType(item.type)))
			return { kind: "proven" };
		// Still running (e.g. accepted before the transport died): it may yet
		// produce output, so it is neither failed nor safe to send again.
		if (turn.status === "inProgress") return unavailable;
		return {
			kind: "failed_before_output",
			usageLimited: isUsageLimitError(turn.error),
		};
	}
	return everyTurnLoaded ? { kind: "absent" } : unavailable;
}

/**
 * FLY-2900: one quota resume spans every daemon restart of a launch. Until
 * the resume is settled each session gets the lifecycle; once a continue was
 * started its id may already be in history, so later sessions reconcile it
 * (never treat it as fresh). After settlement a restart is ordinary work.
 */
export function trackQuotaResumeAcrossRestarts(
	lifecycle: CodexQuotaResumeLifecycle,
): { current(): CodexQuotaResumeLifecycle | undefined } {
	let started = false;
	let settled = false;
	let continueAttemptId = lifecycle.continueAttemptId;
	const tracked: CodexQuotaResumeLifecycle = {
		authorization: lifecycle.authorization,
		get continueAttemptId() {
			return continueAttemptId;
		},
		get continueAttemptFresh() {
			return started ? false : lifecycle.continueAttemptFresh;
		},
		onContinueReconciled(outcome) {
			const decision = lifecycle.onContinueReconciled(outcome);
			if (decision.action === "send") {
				continueAttemptId = decision.continueAttemptId;
				if (decision.settled) settled = true;
			}
			return decision;
		},
		onContinueStarted(input) {
			return lifecycle.onContinueStarted(input);
		},
		onContinueProgress(input) {
			settled = true;
			lifecycle.onContinueProgress(input);
		},
		onContinueFailed(input) {
			lifecycle.onContinueFailed(input);
		},
	};
	let handedOut = false;
	return {
		// Call once per daemon session: a later session may be following a
		// turn/start the server accepted before the transport died.
		current: () => {
			if (settled) return undefined;
			if (handedOut) started = true;
			handedOut = true;
			return tracked;
		},
	};
}
