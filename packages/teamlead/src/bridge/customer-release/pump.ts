import type { CustomerReleaseMailbox } from "./executor.js";
import type { ManualClaimAuthority, ManualReleaseRequest } from "./manual.js";
import type { CustomerReleaseStore } from "./store.js";
import type {
	CustomerClaimActivation,
	CustomerDeliveryReceipt,
	CustomerReadyAttempt,
	CustomerReleaseCycle,
	CustomerReleasePermit,
} from "./types.js";

interface DecisionPumpOptions {
	store: Pick<
		CustomerReleaseStore,
		| "unresolvedDecision"
		| "hasPostClaimIntervention"
		| "get"
		| "claimAuto"
		| "recordAttemptResult"
		| "manual"
	>;
	mailbox: Pick<
		CustomerReleaseMailbox,
		"pending" | "observe" | "deliverPermit" | "requestFence"
	>;
	now: () => number;
	probe: (
		attempt: CustomerReadyAttempt,
	) => Promise<{ manifest: unknown; receipt: CustomerDeliveryReceipt }>;
	readActivation: () => CustomerClaimActivation;
	evaluate: (cycle: CustomerReleaseCycle) => string;
	manual?: {
		probe: (
			attempt: CustomerReadyAttempt,
			request: ManualReleaseRequest,
		) => Promise<unknown>;
		readAuthority: () => ManualClaimAuthority;
		evaluate: (request: ManualReleaseRequest) => string;
	};
}
export type DecisionPumpOutcome =
	| "busy"
	| "idle"
	| "claimed"
	| "observed"
	| "reconciling"
	| "fencing"
	| "unavailable";

/** One bounded tick. The lifecycle owns cadence/backoff; StateStore owns all
 * decisions. Durable unresolved work always precedes polling for a new claim. */
export class CustomerReleaseDecisionPump {
	private busy = false;
	private claimsPaused = false;
	pauseClaims(): void {
		this.claimsPaused = true;
	}
	resumeClaims(): void {
		this.claimsPaused = false;
	}
	private cursor: string | undefined;
	constructor(private readonly options: DecisionPumpOptions) {}
	private needsFence(permit: CustomerReleasePermit, now: number): boolean {
		if (
			this.claimsPaused ||
			now < permit.claimedAt ||
			now >= permit.notAfter ||
			this.options.store.hasPostClaimIntervention(permit)
		)
			return true;
		if (permit.trigger !== "silence_auto") {
			try {
				const adapter = this.options.manual;
				if (!adapter) return true;
				const authority = adapter.readAuthority();
				const request = permit.manualRequestId
					? this.options.store.manual.get(permit.manualRequestId)
					: null;
				return (
					!request ||
					authority.executionEnabled !== true ||
					authority.founderId !== permit.actor ||
					authority.projectId !== permit.projectId ||
					authority.audience !== permit.audience ||
					authority.activationEpoch !== permit.activationEpoch ||
					authority.policyRevision !== request.card.policyRevision
				);
			} catch {
				return true;
			}
		}
		try {
			const activation = this.options.readActivation();
			return (
				activation.enabled !== true ||
				activation.mode !== "canary" ||
				activation.activationEpoch !== permit.activationEpoch ||
				activation.sourcesHealthy !== true
			);
		} catch {
			return true;
		}
	}
	async tick(): Promise<DecisionPumpOutcome> {
		if (this.busy) return "busy";
		this.busy = true;
		try {
			const { store, mailbox } = this.options;
			const unresolved = store.unresolvedDecision("flywheel");
			if (unresolved) {
				const result = await mailbox.observe(unresolved);
				const now = this.options.now();
				if (!Number.isSafeInteger(now) || now < 0) return "unavailable";
				if (result) {
					store.recordAttemptResult(unresolved.cycleId, result, now);
					if (result.kind !== "unknown") return "observed";
				}
				if (this.needsFence(unresolved, now)) {
					// The intent reason is stable across retries, even if more negative
					// evidence arrives. The immutable intent must never be rewritten.
					await mailbox.requestFence(unresolved, "release_intervention");
					return "fencing";
				}
				if (result === null) await mailbox.deliverPermit(unresolved);
				return "reconciling";
			}
			if (this.claimsPaused) return "idle";
			const page = await mailbox.pending(this.cursor);
			this.cursor = page.cursor ?? undefined;
			const attempt = page.attempts[0];
			if (!attempt) return "idle";
			const cycle = store.get(attempt.cycleId);
			if (!cycle) return "idle";
			if (cycle.state === "manual_ready") {
				const adapter = this.options.manual;
				if (!adapter) return "unavailable";
				const request = store.manual.acceptedForCycle(cycle.cycleId);
				if (!request) return "idle";
				const manifest = await adapter.probe(attempt, request);
				if (this.claimsPaused) return "idle";
				const permit = store.manual.claim(
					request.card.requestId,
					attempt,
					manifest,
					this.options.now(),
					adapter.readAuthority,
					() => adapter.evaluate(request),
				);
				if (!permit) return "idle";
				await mailbox.deliverPermit(permit);
				return "claimed";
			}
			if (cycle.state !== "awaiting_attempt") return "idle";
			const { manifest, receipt } = await this.options.probe(attempt);
			if (this.claimsPaused) return "idle";
			// No await inside claim: it rereads revision, veto, epoch, clock and
			// readiness from their current authoritative sources in one transaction.
			const permit = store.claimAuto(
				cycle.cycleId,
				cycle.revision,
				attempt,
				manifest,
				receipt,
				this.options.now(),
				this.options.readActivation,
				() => this.options.evaluate(cycle),
			);
			if (!permit) return "idle";
			await mailbox.deliverPermit(permit);
			return "claimed";
		} catch {
			// No synthetic no_write, no new nonce, no new decision on transport failure.
			return "unavailable";
		} finally {
			this.busy = false;
		}
	}
}
