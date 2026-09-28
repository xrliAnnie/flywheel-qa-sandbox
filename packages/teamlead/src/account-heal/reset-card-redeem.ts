/**
 * FLY-2896 — the only module in the repository that redeems a Claude reset
 * card. A redeem is irreversible, so the single entry point accepts nothing
 * but an `ApprovedRedeem`, which only `bindApproval()` can mint: the founder's
 * consent must be bound to this exact proposal (id + digest), be `approved`,
 * carry her id, and have been decided before the proposal expired.
 *
 * Trust anchor, stated plainly: the daemon cannot re-derive the founder's
 * Discord id. It trusts the same-uid 0600 consent file, whose only writer is
 * the Bridge, and the Bridge checks the reaction against her exact id.
 */

import {
	GRANT_ID,
	parseRedeemResponse,
	type RedeemOutcome,
} from "./reset-card-contract.js";
import type {
	ResetCardConsent,
	ResetCardProposal,
} from "./reset-card-files.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ORG_UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLI_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

declare const approvedBrand: unique symbol;

/** Minted only by `bindApproval`; also checked at runtime against a WeakSet. */
export interface ApprovedRedeem {
	readonly [approvedBrand]: true;
	readonly proposalId: string;
	readonly target: string;
	readonly grantId: string;
	readonly founderId: string;
	readonly decidedAt: string;
}

const minted = new WeakSet<object>();

export type BindRefusal =
	| "proposal_mismatch"
	| "digest_mismatch"
	| "not_approved"
	| "founder_missing"
	| "decided_after_expiry";

export function bindApproval(
	proposal: ResetCardProposal,
	consent: ResetCardConsent,
): { ok: ApprovedRedeem } | { refused: BindRefusal } {
	if (consent.proposalId !== proposal.proposalId) {
		return { refused: "proposal_mismatch" };
	}
	if (consent.digest !== proposal.digest) return { refused: "digest_mismatch" };
	if (consent.state !== "approved") return { refused: "not_approved" };
	if (consent.founderId === null || consent.founderId.length === 0) {
		return { refused: "founder_missing" };
	}
	if (
		consent.decidedAt === null ||
		!(Date.parse(consent.decidedAt) <= Date.parse(proposal.expiresAt))
	) {
		return { refused: "decided_after_expiry" };
	}
	const approved = Object.freeze({
		proposalId: proposal.proposalId,
		target: proposal.target.name,
		grantId: proposal.grant.id,
		founderId: consent.founderId,
		decidedAt: consent.decidedAt,
	}) as unknown as ApprovedRedeem;
	minted.add(approved);
	return { ok: approved };
}

export interface RedeemRequest {
	accessToken: string;
	orgUuid: string;
	cliVersion: string;
	/** Idempotency key persisted to the audit before this call (I2). */
	requestId: string;
	/** Test-only: must be injected together with `fetchFn`. */
	baseUrl?: string;
	fetchFn?: typeof fetch;
	timeoutMs?: number;
}

async function readBoundedJson(response: Response): Promise<unknown> {
	const reader = response.body?.getReader();
	if (reader === undefined) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_RESPONSE_BYTES) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return null;
	}
}

/**
 * Issue exactly one redeem POST. Never retries (not even on 401): an
 * unconfirmed result is handed back for read-only reconciliation.
 */
export async function redeemResetCard(
	approved: ApprovedRedeem,
	request: RedeemRequest,
): Promise<RedeemOutcome> {
	if (!minted.has(approved)) {
		throw new Error(
			"reset-card redeem requires an ApprovedRedeem from bindApproval",
		);
	}
	if (request.baseUrl !== undefined && request.fetchFn === undefined) {
		throw new Error("reset_card_test_origin_requires_fetch_injection");
	}
	if (
		!GRANT_ID.test(approved.grantId) ||
		!REQUEST_ID.test(request.requestId) ||
		!ORG_UUID.test(request.orgUuid) ||
		!CLI_VERSION.test(request.cliVersion) ||
		request.accessToken.length === 0
	) {
		throw new Error("reset-card redeem input failed validation");
	}
	const baseUrl = (request.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	const url = `${baseUrl}/api/organizations/${request.orgUuid}/reset_rate_limits`;
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const response = await (request.fetchFn ?? fetch)(url, {
			method: "POST",
			redirect: "error",
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${request.accessToken}`,
				"anthropic-beta": "oauth-2025-04-20",
				"Content-Type": "application/json",
				Accept: "application/json",
				"User-Agent": `claude-cli/${request.cliVersion} (external, cli)`,
			},
			body: JSON.stringify({
				program: "cedar_ember",
				grant_id: approved.grantId,
				request_id: request.requestId,
			}),
		});
		let raw: unknown = null;
		try {
			raw = await readBoundedJson(response);
		} catch {
			raw = null;
		}
		return parseRedeemResponse(response.status, raw);
	} catch {
		return {
			kind: "unconfirmed",
			cause: timedOut ? "timeout" : "network",
		};
	} finally {
		clearTimeout(timer);
	}
}
