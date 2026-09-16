import { createHash } from "node:crypto";
import type { CustomerReleaseDispatch } from "./dispatch.js";
import type { ReleaseWorkflowBinding } from "./github.js";
import type { ManualClaimAuthority } from "./manual.js";
import type { CustomerReleaseStore } from "./store.js";

const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Dispatch prepares a ready attempt; the existing pump alone can claim the
 * founder-go permit after its independent source/technical checks. */
export class ManualReleaseExecutor {
	private last = new Map<string, number>();
	constructor(
		private readonly options: {
			store: CustomerReleaseStore;
			authority: () => ManualClaimAuthority;
			workflow: ReleaseWorkflowBinding;
			dispatch: Pick<CustomerReleaseDispatch, "tick">;
			now: () => number;
		},
	) {}
	async tick(signal?: AbortSignal): Promise<void> {
		const store = this.options.store;
		if (store.unresolvedDecision("flywheel")) return;
		const entries = store.manual.acceptedExecutions(),
			active = new Set(entries.map((e) => e.request.card.requestId));
		for (const id of this.last.keys())
			if (!active.has(id)) this.last.delete(id);
		for (const { request, receipt } of entries) {
			const { card, binding, cycleId } = request,
				now = this.options.now();
			const cancel = () => {
				const cycle = store.get(cycleId);
				if (cycle?.state === "manual_ready")
					store.invalidate(
						cycleId,
						cycle.revision,
						"manual_execution_unavailable",
						this.options.now(),
					);
			};
			try {
				signal?.throwIfAborted();
				const authority = this.options.authority();
				if (
					authority.executionEnabled !== true ||
					authority.projectId !== "flywheel" ||
					authority.founderId !== card.founderId ||
					authority.activationEpoch !== card.activationEpoch ||
					authority.policyRevision !== card.policyRevision ||
					!Number.isSafeInteger(now) ||
					now >= card.expiresAt ||
					now < receipt.effectiveAt ||
					receipt.requestId !== card.requestId ||
					receipt.actorId !== authority.founderId
				) {
					cancel();
					continue;
				}
				const previous = this.last.get(card.requestId);
				if (previous !== undefined && now >= previous && now - previous < 30000)
					continue;
				this.last.set(card.requestId, now);
				const result = await this.options.dispatch.tick(
					cycleId,
					this.options.workflow,
					{
						dispatchId: hash([
							"manual-execute",
							card.requestId,
							receipt.interactionId,
						]),
						createdAt: receipt.effectiveAt,
						inputs: {
							operation: "execute",
							"cycle-id": cycleId,
							"release-id": binding.releaseId,
							"binding-digest": hash(binding),
						},
					},
					signal,
				);
				// A workflow failure is not no-write; only retire work still awaiting claim.
				if (result?.state === "failed") cancel();
			} catch {
				cancel();
			}
		}
	}
}
