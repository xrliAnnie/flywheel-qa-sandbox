/**
 * FLY-1062 broker PR · PublishBroker — the ONLY execution point for the two
 * outward publishes (plan §3): customer-release promote-commit and thin-shell
 * npm publish.
 *
 * Trust model (plan §3 ①/①b/②):
 *  - the two outward tokens live ONLY in this object's memory, in the Bridge
 *    parent process — never on disk, never in CI, never in any child process;
 *  - a caller (unix socket) carries NO authority: it can only REQUEST a tuple;
 *  - authority = an in-memory founder approval bound to the exact
 *    (action, releaseId, sha256) tuple, observed by THIS process from the
 *    founder's ✅ reaction on the broker's own request card (zero-AI,
 *    deterministic — the FLY-799 reaction primitive);
 *  - single consumption, consumed only AFTER the (idempotent) publish
 *    succeeded — a crash between execute and consume re-converges through the
 *    executors' idempotency (B0-9 / registry 409 re-hash), never a double
 *    publish and never a burned approval on failure;
 *  - every decision appends an audit entry (releaseId / sha / approverRef /
 *    outcome). Tokens never appear in any response, audit line, or error.
 */

import {
	checkReactionConfirmation,
	type ReactionFetcher,
} from "../../lead-backends/codex/gateway/founder-confirmation.js";
import { ApprovalRegistry } from "./approval-registry.js";
import type { PublishRequest, PublishResponse, PublishTuple } from "./types.js";
import { tupleKey, validatePublishRequest } from "./types.js";

export interface PublishExecutors {
	/** promote-commit (ZERO BUILD — B0-9 idempotent). Resolves executor detail. */
	publishRelease: (
		req: { releaseId: string; sha256: string },
		customerReleaseToken: string,
	) => Promise<Record<string, string>>;
	/** staged-tarball npm publish (broker re-verifies content + hash inside). */
	publishShell: (
		req: { releaseId: string; sha256: string; stagedPath: string },
		npmGatToken: string,
	) => Promise<Record<string, string>>;
}

/** The founder-facing request-card surface (absent → requests stay pending
 * with an explicit reason; nothing executes). */
export interface ApprovalCardSurface {
	post: (text: string) => Promise<{ channelId: string; messageId: string }>;
	fetcher: ReactionFetcher;
	founderId: string;
}

export interface PublishBrokerOptions {
	tokens: { customerRelease?: string; npmGat?: string };
	executors: PublishExecutors;
	audit: (entry: Record<string, unknown>) => void;
	card?: ApprovalCardSurface | null;
	now?: () => Date;
	log?: (line: string) => void;
}

interface PendingRequest extends PublishRequest {
	cardChannelId?: string;
	cardMessageId?: string;
	requestedAt: string;
}

function requestCardText(req: PublishRequest): string {
	const what =
		req.action === "publish-release"
			? "对外发布(promote to customer-release)"
			: "薄壳 npm 发布(publish @flywheel/onboard)";
	return [
		`🔐 发布审批请求 — ${what}`,
		`action: ${req.action}`,
		`releaseId: ${req.releaseId}`,
		`sha256: ${req.sha256}`,
		"Annie 在本条消息上点 ✅ 即批准这个确切 artifact(单次有效);不理会 = 不发布。",
	].join("\n");
}

export class PublishBroker {
	private readonly approvals = new ApprovalRegistry();
	private readonly pending = new Map<string, PendingRequest>();
	/** tuples currently executing — the atomic in-flight claim (Codex code R1
	 * MEDIUM): two concurrent requests both passing the approval lookup before
	 * either consumes must not BOTH reach the executor. The claim is taken
	 * synchronously before the first await in execute(). */
	private readonly inflight = new Set<string>();
	private readonly opts: PublishBrokerOptions;
	private readonly now: () => Date;
	private polling = false;

	constructor(opts: PublishBrokerOptions) {
		this.opts = opts;
		this.now = opts.now ?? (() => new Date());
	}

	/** TRUSTED ingress only (Bridge parent process): record a founder approval.
	 * Never call with data read from a runner-writable store. */
	registerFounderApproval(tuple: PublishTuple, approverRef: string): boolean {
		const fresh = this.approvals.register(tuple, approverRef, this.now);
		if (fresh) {
			this.audit({ outcome: "approval_registered", ...tuple, approverRef });
		}
		return fresh;
	}

	/** Handle one (untrusted) caller request. */
	async handleRequest(raw: unknown): Promise<PublishResponse> {
		const v = validatePublishRequest(raw);
		if (!v.ok) return { status: "refused", reason: v.reason };
		const req = v.request;

		const approval = this.approvals.find(req);
		if (approval) {
			return this.execute(req, approval.approverRef);
		}

		// No approval yet — park the request and surface a card to the founder.
		const key = tupleKey(req);
		let entry = this.pending.get(key);
		if (!entry) {
			entry = { ...req, requestedAt: this.now().toISOString() };
			this.pending.set(key, entry);
			this.audit({ outcome: "request_pending", ...tupleOf(req) });
		} else if (req.stagedPath) {
			entry.stagedPath = req.stagedPath; // a re-request may restage
		}
		if (!this.opts.card) {
			return {
				status: "pending_approval",
				...tupleOf(req),
				reason: "approval_surface_unconfigured",
			};
		}
		if (!entry.cardMessageId) {
			try {
				const posted = await this.opts.card.post(requestCardText(req));
				entry.cardChannelId = posted.channelId;
				entry.cardMessageId = posted.messageId;
				this.audit({
					outcome: "approval_card_posted",
					...tupleOf(req),
					cardMessageId: posted.messageId,
				});
			} catch {
				return {
					status: "pending_approval",
					...tupleOf(req),
					reason: "approval_card_post_failed",
				};
			}
		}
		return {
			status: "pending_approval",
			...tupleOf(req),
			reason: "awaiting_founder_approval",
		};
	}

	/** Observation pass (parent-owned timer): for each pending request with a
	 * posted card, check the founder's ✅; on confirmation register + execute.
	 * Fail-closed: any fetch error / non-confirmation just waits. */
	async pollApprovals(): Promise<void> {
		if (this.polling) return; // no overlapping passes
		const card = this.opts.card;
		if (!card || this.pending.size === 0) return;
		this.polling = true;
		try {
			for (const entry of [...this.pending.values()]) {
				if (!entry.cardMessageId || !entry.cardChannelId) continue;
				const check = await checkReactionConfirmation(card.fetcher, {
					channelId: entry.cardChannelId,
					messageId: entry.cardMessageId,
					founderId: card.founderId,
				});
				if (!check.confirmed) continue;
				this.registerFounderApproval(
					tupleOf(entry),
					`reaction:${entry.cardMessageId}`,
				);
				const result = await this.execute(
					entry,
					`reaction:${entry.cardMessageId}`,
				);
				if (result.status === "executed") {
					await this.postResult(
						card,
						`✅ 已执行 ${entry.action} — releaseId ${entry.releaseId}(sha256 ${entry.sha256.slice(0, 12)}…);审批已单次消费。`,
					);
				} else {
					await this.postResult(
						card,
						`⚠️ ${entry.action} 执行未成功(${result.reason ?? "unknown"});审批未消费,修复后可重试。`,
					);
				}
			}
		} finally {
			this.polling = false;
		}
	}

	/** Guarded execution: approval must exist unconsumed; token must be
	 * provisioned; ONE in-flight execution per tuple (the claim below is taken
	 * before any await); consume only after success. */
	private async execute(
		req: PublishRequest,
		approverRef: string,
	): Promise<PublishResponse> {
		const key = tupleKey(req);
		if (this.inflight.has(key)) {
			return {
				status: "refused",
				...tupleOf(req),
				reason: "execution_in_flight",
			};
		}
		const approval = this.approvals.find(req);
		if (!approval) {
			return { status: "refused", ...tupleOf(req), reason: "no_approval" };
		}
		const token =
			req.action === "publish-release"
				? this.opts.tokens.customerRelease
				: this.opts.tokens.npmGat;
		if (!token) {
			return {
				status: "refused",
				...tupleOf(req),
				reason: "token_not_provisioned",
			};
		}
		this.inflight.add(key); // atomic claim — no await between check and add
		try {
			const detail =
				req.action === "publish-release"
					? await this.opts.executors.publishRelease(
							{ releaseId: req.releaseId, sha256: req.sha256 },
							token,
						)
					: await this.opts.executors.publishShell(
							{
								releaseId: req.releaseId,
								sha256: req.sha256,
								// validated at the boundary for shell requests
								stagedPath: req.stagedPath as string,
							},
							token,
						);
			// consume-after-success (plan §3 ②)
			this.approvals.consume(req, this.now);
			this.pending.delete(tupleKey(req));
			this.audit({
				outcome: "executed",
				...tupleOf(req),
				approverRef,
				...detail,
			});
			return { status: "executed", ...tupleOf(req), detail };
		} catch (err) {
			const reason = (err as Error).message ?? "execution_failed";
			this.audit({
				outcome: "execution_failed",
				...tupleOf(req),
				approverRef,
				reason,
			});
			return { status: "refused", ...tupleOf(req), reason };
		} finally {
			this.inflight.delete(key);
		}
	}

	private async postResult(card: ApprovalCardSurface, text: string) {
		try {
			await card.post(text);
		} catch {
			// best-effort result note; the audit line is the durable record
		}
	}

	private audit(entry: Record<string, unknown>) {
		try {
			this.opts.audit({ ts: this.now().toISOString(), ...entry });
		} catch {
			this.opts.log?.("[publish-broker] audit append failed");
		}
	}

	/** test/introspection: number of pending requests (no secrets). */
	pendingCount(): number {
		return this.pending.size;
	}
}

function tupleOf(req: PublishTuple): PublishTuple {
	return { action: req.action, releaseId: req.releaseId, sha256: req.sha256 };
}
