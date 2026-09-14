import type { LearningScanReceipt } from "./discord-scan.js";
import type { LearningClaim, LearningDelivery } from "./learning-delivery.js";
import type { LearningSendReceipt } from "./learning-transport.js";

type View = NonNullable<ReturnType<LearningDelivery["view"]>>;
export interface LearningSenderDependencies {
	delivery: LearningDelivery;
	guildId: string;
	now(): number;
	signal: AbortSignal;
	post(
		claim: LearningClaim,
		view: View,
		signal: AbortSignal,
	): Promise<LearningSendReceipt>;
	scan(
		claim: LearningClaim,
		view: View,
		signal: AbortSignal,
	): Promise<LearningScanReceipt>;
}
/** One bounded attempt; storage owns rates, leases, replay and retry scheduling. */
export async function sendLearningMessage(
	purpose: "clarification" | "ack",
	subjectId: string,
	owner: string,
	deps: LearningSenderDependencies,
): Promise<string> {
	if (deps.signal.aborted) return "inactive";
	const claim = deps.delivery.claim(purpose, subjectId, owner, deps.now());
	if (claim.status !== "claimed") return claim.status;
	const view = deps.delivery.view(purpose, subjectId, deps.guildId);
	if (!view) {
		deps.delivery.unavailable(claim, "learning_view_missing", deps.now());
		return "unavailable";
	}
	const controller = new AbortController();
	let rejectAbort: (reason: Error) => void = () => {};
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = reject;
	});
	const abort = () => {
		controller.abort();
		rejectAbort(new Error("learning_send_aborted"));
	};
	deps.signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, 10_000);
	try {
		if (deps.signal.aborted) abort();
		const receipt = await Promise.race([
			Promise.resolve().then<LearningSendReceipt | LearningScanReceipt>(() => {
				controller.signal.throwIfAborted();
				return claim.action === "scan"
					? deps.scan(claim, view, controller.signal)
					: deps.post(claim, view, controller.signal);
			}),
			aborted,
		]);
		if (receipt.kind === "posted" || receipt.kind === "found") {
			if (receipt.kind === "found" && receipt.subjectId !== claim.desiredId) {
				deps.delivery.fail(claim, deps.now(), "scan_subject_mismatch", true);
				return "uncertain";
			}
			return deps.delivery.confirm(
				claim,
				receipt.messageId,
				receipt.visibleAt,
				deps.now(),
			)
				? "delivered"
				: "stale";
		}
		if (receipt.kind === "none")
			return deps.delivery.emptyScan(claim, receipt.frontier, deps.now())
				? "scan_empty"
				: "stale";
		if (receipt.kind === "unavailable")
			return deps.delivery.unavailable(claim, receipt.code, deps.now())
				? "unavailable"
				: "stale";
		const uncertain =
			receipt.kind === "uncertain" || receipt.kind === "ambiguous";
		deps.delivery.fail(
			claim,
			deps.now(),
			uncertain ? "learning_send_uncertain" : "learning_send_failed",
			uncertain,
			receipt.kind === "failed" ? receipt.retryAt : undefined,
		);
		return uncertain ? "uncertain" : "failed";
	} catch {
		deps.delivery.fail(
			claim,
			deps.now(),
			"learning_send_aborted_or_failed",
			true,
		);
		return "uncertain";
	} finally {
		clearTimeout(timer);
		deps.signal.removeEventListener("abort", abort);
	}
}
