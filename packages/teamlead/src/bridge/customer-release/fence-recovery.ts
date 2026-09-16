import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CustomerReleaseDispatch } from "./dispatch.js";
import type { CustomerReleaseMailbox } from "./executor.js";
import type { ReleaseWorkflowBinding } from "./github.js";
import type { CustomerReleaseStore } from "./store.js";
import type { CustomerReleasePermit } from "./types.js";

const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** The decision writer requests a fence; only the narrow workflow executor can
 * perform it. Workflow success is never an endpoint no-write/result receipt. */
export class CustomerReleaseFenceRecovery {
	private last: {
		decisionId: string;
		reason: string;
		at: number;
		result: Promise<void>;
	} | null = null;
	constructor(
		private readonly options: {
			store: Pick<CustomerReleaseStore, "unresolvedDecision">;
			mailbox: Pick<CustomerReleaseMailbox, "requestFence">;
			dispatch: Pick<CustomerReleaseDispatch, "tick">;
			workflow: ReleaseWorkflowBinding;
			now: () => number;
		},
	) {}
	async requestFence(
		permit: CustomerReleasePermit,
		reason: string,
	): Promise<void> {
		const current = this.options.store.unresolvedDecision("flywheel"),
			now = this.options.now();
		if (!current) return;
		if (
			!isDeepStrictEqual(current, permit) ||
			!Number.isSafeInteger(now) ||
			now < permit.claimedAt
		)
			throw new Error("fence recovery identity invalid");
		if (
			this.last?.decisionId === permit.decisionId &&
			this.last.reason === reason &&
			now >= this.last.at &&
			now - this.last.at < 30000
		)
			return this.last.result;
		const result = this.run(permit, reason);
		this.last = { decisionId: permit.decisionId, reason, at: now, result };
		return result;
	}
	private async run(
		permit: CustomerReleasePermit,
		reason: string,
	): Promise<void> {
		await this.options.mailbox.requestFence(permit, reason);
		// A concurrently reconciled result wins; there is nothing left to fence.
		const current = this.options.store.unresolvedDecision("flywheel");
		if (!current) return;
		if (!isDeepStrictEqual(current, permit))
			throw new Error("fence recovery changed");
		await this.options.dispatch.tick(permit.cycleId, this.options.workflow, {
			dispatchId: hash(["fence", permit.decisionId]),
			createdAt: permit.claimedAt,
			inputs: {
				operation: "fence",
				"cycle-id": permit.cycleId,
				"release-id": permit.fullBinding.releaseId,
				"binding-digest": hash(permit.fullBinding),
				"attempt-id": permit.attemptId,
			},
		});
	}
}
