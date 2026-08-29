/**
 * FLY-245 F-a — LifecycleOrchestrator: binds the Phase D primitives into the
 * §5.6 end-to-end runner-lifecycle flow.
 *
 *   model request (intent only)
 *     → CommDB question (full binding JSON + short TTL, D-b)
 *     → durable LifecycleRequestStore row (D-f) [+ retry successor pre-bind, D2]
 *     → Discord confirmation message (ids persisted for restart-resume)
 *     → founder structured confirmation observed (reaction OR `confirm <nonce>`
 *       token — exact founder id, D-e); the FIRST durable trusted observation is
 *       the IRREVERSIBLE authorization edge: the gateway writes the structured
 *       response AS the founder id, and a later un-react is not a revocation
 *     → verify (D-c) → atomic claim (D-b) → post-claim revision re-check →
 *       dispatch to the canonical Bridge endpoint (always with leadId)
 *     → confirmation message edited to executed/failed/ambiguous, poll stops.
 *
 * The model can only reach `createRequest`. Execution runs strictly behind the
 * founder edge inside executeConfirmedRequest (D-f) — the model never supplies
 * authority fields (the caller resolves the target via §5.4 exactly-one before
 * calling in). All Discord/Bridge/DB surfaces are injected; gateway-main binds
 * the real ones (Phase F).
 */

import { randomUUID } from "node:crypto";
import {
	getActionClassMeta,
	isLifecycleAction,
	lifecycleCheckpoint,
} from "../../../bridge/founder-consent/reserved-endpoints.js";
import {
	isFounderTokenConfirmation,
	type ReactionConfirmationCheck,
	type TokenConfirmationMessage,
} from "./founder-confirmation.js";
import {
	type DispatchOutcome,
	executeClaimedRequest,
	executeConfirmedRequest,
	type LifecycleRequestRecord,
	type LifecycleRequestStore,
	type PostconditionVerdict,
	recoverLifecycleRequests,
} from "./lifecycle-requests.js";

/** Runtime-resolved (§5.4 exactly-one) target — NEVER from the model's args. */
export interface ResolvedLifecycleTarget {
	execId: string;
	issueId: string;
	role: string;
	status: string;
	/** lifecycle_revision snapshot at request time (D-a freshness anchor). */
	revision: number;
	project: string;
}

export interface LifecycleOrchestratorDeps {
	store: LifecycleRequestStore;
	founderId: string;
	leadId: string;
	/** Confirmation window (store TTL; the CommDB question gets the same). */
	ttlMs: number;
	now?: () => number;
	ids?: { requestId: () => string; nonce: () => string };
	/** D2: allocator for a retry request's pre-bound successor execution id. */
	newSuccessorExecId?: () => string;
	comm: {
		insertQuestion: (
			fromAgent: string,
			toAgent: string,
			content: string,
			opts: { checkpoint: string; ttlSeconds: number },
		) => string;
		insertResponse: (
			parentId: string,
			fromAgent: string,
			content: string,
		) => void;
		/** D-b atomic single-consume. */
		claimConsent: (questionId: string, checkpoint: string) => boolean;
		/** R1 MED-9 recovery latch: does a durable founder response ALREADY exist
		 * for this question? Used to make the irreversible authorization edge
		 * crash-safe (a crash AFTER writing the response but BEFORE flipping the
		 * row to `confirmed` must NOT lose the authorization, nor double-write). */
		getResponse?: (
			questionId: string,
		) => { from_agent: string; content: string } | undefined;
	};
	/** D-c verifyLifecycleConsent bound to the local DBs. */
	verify: (row: LifecycleRequestRecord) => { allowed: boolean; reason: string };
	/** Target session's CURRENT lifecycle revision (post-claim re-check). */
	currentRevision: (execId: string) => number | undefined;
	discord: {
		sendConfirmation: (
			text: string,
		) => Promise<{ channelId: string; messageId: string }>;
		editMessage: (
			channelId: string,
			messageId: string,
			text: string,
		) => Promise<void>;
		/** D-e reaction check, founder-id-exact, fail-closed (bound in F). */
		checkReaction: (
			channelId: string,
			messageId: string,
		) => Promise<ReactionConfirmationCheck>;
		/** Recent channel messages for the `confirm <nonce>` token path. */
		fetchRecentMessages: (
			channelId: string,
		) => Promise<TokenConfirmationMessage[]>;
	};
	/** POST the canonical Bridge action endpoint (always with leadId; for retry
	 * the body carries gateway_request_id + the pre-bound successor id, D2). */
	dispatch: (row: LifecycleRequestRecord) => Promise<DispatchOutcome>;
	/** §5.2.1 crash-recovery postcondition (per-action; D2 reconciler for retry). */
	postcondition: (
		row: LifecycleRequestRecord,
	) => Promise<PostconditionVerdict> | PostconditionVerdict;
	logger?: { info: (m: string) => void; warn: (m: string) => void };
}

export class LifecycleOrchestrator {
	private readonly deps: LifecycleOrchestratorDeps;
	private readonly now: () => number;
	private readonly newRequestId: () => string;
	private readonly newNonce: () => string;
	private readonly logger: {
		info: (m: string) => void;
		warn: (m: string) => void;
	};

	constructor(deps: LifecycleOrchestratorDeps) {
		this.deps = deps;
		this.now = deps.now ?? (() => Date.now());
		this.newRequestId = deps.ids?.requestId ?? (() => randomUUID());
		this.newNonce = deps.ids?.nonce ?? (() => randomUUID());
		this.logger = deps.logger ?? { info: () => {}, warn: () => {} };
	}

	/**
	 * Register a founder-confirmation request for one lifecycle action against
	 * one resolved target. Fail-loud on a non-lifecycle action or an ineligible
	 * target status (SSOT metadata, D-d). Returns the request id + the
	 * confirmation text that was posted.
	 */
	async createRequest(
		target: ResolvedLifecycleTarget,
		action: string,
	): Promise<{ requestId: string; message: string }> {
		const meta = getActionClassMeta(action);
		if (!meta || !isLifecycleAction(action)) {
			throw new Error(
				`"${action}" is not a gateway-executable lifecycle action (ship-gate and unknown actions are refused)`,
			);
		}
		if (!meta.eligibleStatuses.includes(target.status)) {
			throw new Error(
				`target ${target.execId} has status "${target.status}" — not eligible for "${action}" (eligible: ${meta.eligibleStatuses.join(", ")})`,
			);
		}

		const requestId = this.newRequestId();
		const nonce = this.newNonce();
		const binding = {
			target_execution_id: target.execId,
			action,
			lifecycle_revision: target.revision,
			nonce,
			project: target.project,
		};
		const questionId = this.deps.comm.insertQuestion(
			this.deps.leadId,
			this.deps.founderId,
			JSON.stringify(binding),
			{
				checkpoint: lifecycleCheckpoint(action),
				ttlSeconds: Math.floor(this.deps.ttlMs / 1000),
			},
		);
		this.deps.store.create({
			requestId,
			questionId,
			action,
			execId: target.execId,
			lifecycleRevision: target.revision,
			nonce,
			project: target.project,
			leadId: this.deps.leadId,
			ttlMs: this.deps.ttlMs,
		});
		// D2: a retry creates a new execution — pre-bind its successor id NOW
		// (durably, before any dispatch can happen) so recovery converges by key.
		if (action === "retry") {
			const successor = (
				this.deps.newSuccessorExecId ?? (() => randomUUID())
			)();
			this.deps.store.bindSuccessorExecId(requestId, successor);
		}

		const message = this.confirmationText(requestId, target, action, nonce);
		const sent = await this.deps.discord.sendConfirmation(message);
		this.deps.store.setConfirmationMessage(
			requestId,
			sent.channelId,
			sent.messageId,
		);
		this.logger.info(
			`lifecycle request ${requestId}: ${action} ${target.execId} — founder confirmation pending`,
		);
		return { requestId, message };
	}

	/** §5.4: the confirmation shows the FULL resolved target so the founder
	 * confirms exactly what will happen. Both confirmation paths included. */
	private confirmationText(
		requestId: string,
		t: ResolvedLifecycleTarget,
		action: string,
		nonce: string,
	): string {
		return [
			`⚠️ Runner-lifecycle confirmation required: **${action}**`,
			`issue ${t.issueId} | exec ${t.execId} | role ${t.role} | status ${t.status} | revision ${t.revision}`,
			`React ✅ to approve, or reply \`confirm ${nonce}\`. Expires in ${Math.round(this.deps.ttlMs / 60000)} min.`,
			`(request ${requestId} — requested by ${this.deps.leadId})`,
		].join("\n");
	}

	/**
	 * One observation pass over all pending requests: expire stale ones, check
	 * the founder reaction + token paths, and drive confirmed requests through
	 * the execute chain. Called periodically by gateway-main; safe to re-enter
	 * across restarts (everything is keyed off the durable store).
	 */
	async observeOnce(): Promise<void> {
		for (const row of this.deps.store.listNonTerminal()) {
			if (row.state !== "requested") continue;

			if (this.now() > row.expiresAt) {
				this.deps.store.transition(
					row.requestId,
					"requested",
					"failed_retryable",
					"expired",
				);
				await this.editOutcome(row, "expired (no founder confirmation)");
				continue;
			}
			if (!row.channelId || !row.messageId) continue; // resend handled by recover()

			// MED-9: if a durable founder response ALREADY exists, the irreversible
			// authorization edge was crossed on a prior pass — we crashed AFTER
			// writing it but BEFORE flipping the row to `confirmed`. Latch on it:
			// never re-observe (a later un-react can't revoke it) and never
			// re-insert (a second insertResponse would hit the unique-response
			// constraint and wedge the row). The authoritative validation of that
			// response still happens in verify (D-c) inside executeRequest.
			const existingResponse = this.deps.comm.getResponse?.(row.questionId);
			const alreadyDurable = existingResponse != null;

			if (!alreadyDurable) {
				const confirmed = await this.founderConfirmed(row);
				if (!confirmed) continue;
				// THE IRREVERSIBLE AUTHORIZATION EDGE: durably record the founder's
				// structured approval (written AS the founder id — D-c contract).
				// From here an un-react is not a revocation.
				this.deps.comm.insertResponse(
					row.questionId,
					this.deps.founderId,
					JSON.stringify({
						approved: true,
						action: row.action,
						execId: row.execId,
						revision: row.lifecycleRevision,
					}),
				);
			}
			if (
				!this.deps.store.transition(row.requestId, "requested", "confirmed")
			) {
				continue; // lost a race — another path already moved it
			}
			await this.executeRequest(row.requestId);
		}
	}

	/** Founder confirmation via reaction (preferred) or exact token reply. Any
	 * observation error is NON-approval (fail-closed, D-e). */
	private async founderConfirmed(
		row: LifecycleRequestRecord,
	): Promise<boolean> {
		try {
			const reaction = await this.deps.discord.checkReaction(
				row.channelId as string,
				row.messageId as string,
			);
			if (reaction.confirmed) return true;
		} catch {
			// fail-closed: an observation error never approves
		}
		try {
			const messages = await this.deps.discord.fetchRecentMessages(
				row.channelId as string,
			);
			return messages.some((m) =>
				isFounderTokenConfirmation(m, {
					nonce: row.nonce,
					channelId: row.channelId as string,
					founderId: this.deps.founderId,
				}),
			);
		} catch {
			return false;
		}
	}

	/** Drive a confirmed request through verify → claim → re-check → dispatch
	 * (D-f), then edit the confirmation message with the terminal outcome. */
	async executeRequest(requestId: string): Promise<void> {
		const row = this.deps.store.get(requestId);
		if (!row) return;
		const result = await executeConfirmedRequest(this.deps.store, requestId, {
			verify: () => this.deps.verify(row),
			claim: () =>
				this.deps.comm.claimConsent(
					row.questionId,
					lifecycleCheckpoint(row.action),
				),
			currentRevision: () => this.deps.currentRevision(row.execId),
			dispatch: () => this.deps.dispatch(row),
		});
		await this.editOutcome(
			row,
			result.finalState === "succeeded"
				? "✅ executed"
				: result.finalState === "ambiguous"
					? "⚠️ ambiguous — outcome unknown, founder re-confirmation required"
					: `❌ not executed (${this.deps.store.get(requestId)?.outcome ?? "failed"})`,
		);
	}

	/**
	 * Restart recovery (§5.2): classify every persisted request and resume it.
	 * Never blindly replays — claimed/executing outcomes are decided by the
	 * injected action-specific postcondition (D-f / D2).
	 */
	async recover(): Promise<void> {
		const report = await recoverLifecycleRequests(this.deps.store, {
			now: this.now,
			postcondition: (row) => Promise.resolve(this.deps.postcondition(row)),
		});
		for (const entry of report) {
			const row = this.deps.store.get(entry.requestId);
			if (!row) continue;
			switch (entry.decision) {
				case "resume_execute":
					await this.executeRequest(entry.requestId);
					break;
				case "retry_safe_reexecute": {
					// claim already consumed — re-drive without a second claim (D-f).
					const result = await executeClaimedRequest(
						this.deps.store,
						entry.requestId,
						{
							currentRevision: () => this.deps.currentRevision(row.execId),
							dispatch: () => this.deps.dispatch(row),
						},
					);
					await this.editOutcome(
						row,
						result.finalState === "succeeded"
							? "✅ executed (recovered)"
							: `recovery: ${result.finalState}`,
					);
					break;
				}
				case "resend_confirmation": {
					const message = this.confirmationText(
						row.requestId,
						{
							execId: row.execId,
							issueId: row.execId, // issue display unavailable post-crash; execId is exact
							role: "?",
							status: "?",
							revision: row.lifecycleRevision,
							project: row.project,
						},
						row.action,
						row.nonce,
					);
					const sent = await this.deps.discord.sendConfirmation(message);
					this.deps.store.setConfirmationMessage(
						row.requestId,
						sent.channelId,
						sent.messageId,
					);
					break;
				}
				case "already_succeeded":
					await this.editOutcome(row, "✅ executed (verified after restart)");
					break;
				case "needs_reconfirm":
					await this.editOutcome(
						row,
						"⚠️ ambiguous after restart — founder re-confirmation required (a NEW request must be issued)",
					);
					break;
				case "expired":
					await this.editOutcome(row, "expired (no founder confirmation)");
					break;
				case "resume_observe":
					break; // observeOnce picks it up
			}
		}
	}

	/** Best-effort message edit — an edit failure never blocks the state machine. */
	private async editOutcome(
		row: LifecycleRequestRecord,
		outcome: string,
	): Promise<void> {
		if (!row.channelId || !row.messageId) return;
		try {
			await this.deps.discord.editMessage(
				row.channelId,
				row.messageId,
				`[${row.action} ${row.execId}] ${outcome}`,
			);
		} catch (err) {
			this.logger.warn(
				`lifecycle ${row.requestId}: message edit failed (non-fatal): ${(err as Error).message}`,
			);
		}
	}
}
