import type { DeliveryView, ShipJudgmentDelivery } from "./delivery.js";
import type { ScanReceipt, SendReceipt } from "./sender.js";

export async function sendJudgmentHistory(
	questionId: string,
	owner: string,
	deps: {
		delivery: ShipJudgmentDelivery;
		signal: AbortSignal;
		enabled(): boolean;
		owns(view: DeliveryView): boolean;
		now(): number;
		patch(
			view: DeliveryView,
			messageId: string,
			content: string,
			signal: AbortSignal,
		): Promise<SendReceipt>;
		scan(view: DeliveryView, signal: AbortSignal): Promise<ScanReceipt>;
	},
): Promise<void> {
	if (!deps.enabled() || deps.signal.aborted) return;
	const view = deps.delivery.view(questionId);
	if (!view || !deps.owns(view)) return;
	const claim = deps.delivery.claimHistory(questionId, owner, deps.now());
	if (claim.status !== "claimed") return;
	const controller = new AbortController();
	let rejectAbort: (error: Error) => void = () => {};
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = reject;
	});
	const abort = () => {
		controller.abort();
		rejectAbort(new Error("history_send_aborted"));
	};
	deps.signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, 10_000);
	try {
		if (deps.signal.aborted) abort();
		const result = await Promise.race([
			Promise.resolve().then<SendReceipt | ScanReceipt>(() => {
				controller.signal.throwIfAborted();
				return claim.action === "scan"
					? deps.scan(view, controller.signal)
					: deps.patch(
							view,
							claim.messageId!,
							`历史试判，模式已变；仍由 founder 批准。\n\`${view.marker} history\``,
							controller.signal,
						);
			}),
			aborted,
		]);
		if (!deps.enabled() || !deps.owns(view)) return;
		if (result.kind === "found")
			deps.delivery.confirm(
				claim,
				result.messageId,
				result.visibleAt,
				deps.now(),
				result.opinionId,
			);
		else if (result.kind === "posted")
			deps.delivery.confirmHistory(claim, deps.now());
		else if (result.kind === "none")
			deps.delivery.emptyScan(claim, result.frontier, deps.now());
		else
			deps.delivery.failed(
				claim,
				"history_delivery_failed",
				deps.now(),
				true,
				result.kind === "failed" ? result.retryAt : undefined,
			);
	} catch {
		deps.delivery.failed(claim, "history_transport_error", deps.now(), true);
	} finally {
		clearTimeout(timer);
		deps.signal.removeEventListener("abort", abort);
	}
}
