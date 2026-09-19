import { canonicalDigest, type ShipJudgmentBinding } from "./contract.js";
import type { DeliveryView, ShipJudgmentDelivery } from "./delivery.js";
import { renderJudgmentMessage } from "./render.js";

export type SendReceipt =
	| { kind: "posted"; messageId: string; visibleAt: string }
	| { kind: "uncertain" }
	| { kind: "failed"; retryAt?: number };
export type ScanReceipt =
	| { kind: "found"; messageId: string; opinionId: string; visibleAt: string }
	| { kind: "none"; frontier: string }
	| { kind: "ambiguous" };
export interface SenderDeps {
	delivery: ShipJudgmentDelivery;
	enabled(): boolean;
	current(): ShipJudgmentBinding | undefined;
	now(): number;
	signal?: AbortSignal;
	post(
		view: DeliveryView,
		content: string,
		signal: AbortSignal,
	): Promise<SendReceipt>;
	patch(
		view: DeliveryView,
		messageId: string,
		content: string,
		signal: AbortSignal,
	): Promise<SendReceipt>;
	/** Adapter must verify the owning bot, complete scan boundary, marker and opinion ID. */
	scan(view: DeliveryView, signal: AbortSignal): Promise<ScanReceipt>;
}

/** One bounded transport attempt. Persistent leases/rate limits remain the authority across restarts. */
export async function sendJudgmentOpinion(
	questionId: string,
	channelId: string,
	owner: string,
	deps: SenderDeps,
): Promise<string> {
	if (!deps.enabled() || deps.signal?.aborted) return "inactive";
	const binding = deps.current();
	if (!binding) return "inactive";
	const claim = deps.delivery.claim(questionId, channelId, owner, deps.now());
	if (claim.status !== "claimed") return claim.status;
	const view = deps.delivery.view(questionId, claim.opinionId);
	if (!view) return "invalidated";
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let rejectAbort: (reason: Error) => void = () => {};
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = reject;
	});
	const abort = () => {
		controller.abort();
		rejectAbort(new Error("judgment_send_aborted"));
	};
	deps.signal?.addEventListener("abort", abort, { once: true });
	timer = setTimeout(abort, 10_000);
	try {
		if (deps.signal?.aborted) abort();
		const receipt = await Promise.race([
			Promise.resolve().then<SendReceipt | ScanReceipt>(() => {
				controller.signal.throwIfAborted();
				if (claim.action === "scan") return deps.scan(view, controller.signal);
				const content = renderJudgmentMessage(view);
				return claim.action === "post"
					? deps.post(view, content, controller.signal)
					: deps.patch(view, claim.messageId!, content, controller.signal);
			}),
			aborted,
		]);
		const current = deps.current();
		if (
			!deps.enabled() ||
			!current ||
			canonicalDigest(binding) !== canonicalDigest(current)
		) {
			deps.delivery.failed(claim, "binding_or_mode_changed", deps.now(), true);
			return "invalidated";
		}
		if (receipt.kind === "found" || receipt.kind === "posted") {
			return deps.delivery.confirm(
				claim,
				receipt.messageId,
				receipt.visibleAt,
				deps.now(),
				receipt.kind === "found" ? receipt.opinionId : claim.opinionId,
			)
				? "delivered"
				: "invalidated";
		}
		if (receipt.kind === "none") {
			deps.delivery.emptyScan(claim, receipt.frontier, deps.now());
		} else {
			deps.delivery.failed(
				claim,
				receipt.kind === "failed" ? "discord_failed" : "discord_uncertain",
				deps.now(),
				receipt.kind !== "failed",
				receipt.kind === "failed" ? receipt.retryAt : undefined,
			);
		}
		return "deferred";
	} catch {
		// A rejected or timed-out POST may have reached Discord; never assume it is safe to repost.
		deps.delivery.failed(claim, "discord_transport_error", deps.now(), true);
		return "deferred";
	} finally {
		if (timer) clearTimeout(timer);
		deps.signal?.removeEventListener("abort", abort);
	}
}
