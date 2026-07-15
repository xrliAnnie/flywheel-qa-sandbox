/**
 * FLY-1062 broker PR · shared types for the publish broker (plan §3).
 *
 * The broker is the ONLY executor of the two outward publishes
 * (customer-release promote-commit / thin-shell npm publish). Authority is
 * NEVER the caller's identity — it is an in-memory founder approval bound to
 * the exact (action, releaseId, artifact-sha256) tuple, single-consumption,
 * consumed only AFTER a successful execution.
 */

export type PublishAction = "publish-release" | "publish-shell";

export const PUBLISH_ACTIONS: readonly PublishAction[] = [
	"publish-release",
	"publish-shell",
];

/** The tuple a founder approval binds — nothing less specific is honored. */
export interface PublishTuple {
	action: PublishAction;
	releaseId: string;
	/** sha256 hex of the exact artifact being published. */
	sha256: string;
}

export interface PublishApproval extends PublishTuple {
	/** Where the approval was observed (e.g. `reaction:<messageId>`) — audit. */
	approverRef: string;
	approvedAt: string;
	consumed: boolean;
	consumedAt?: string;
}

/** A caller's request for a broker action. The caller carries NO authority —
 * the request only names the tuple (plus, for the shell, where the staged
 * artifact lives; the sha256 still binds the content). */
export interface PublishRequest extends PublishTuple {
	/** publish-shell only: absolute path of the staged tarball. */
	stagedPath?: string;
}

export type PublishResponseStatus = "executed" | "pending_approval" | "refused";

export interface PublishResponse {
	status: PublishResponseStatus;
	action?: PublishAction;
	releaseId?: string;
	sha256?: string;
	/** Terse machine-readable reason for pending/refused. Never carries a token. */
	reason?: string;
	/** Executor detail on success (e.g. { ver } / { name, version }). */
	detail?: Record<string, string>;
}

export function tupleKey(t: PublishTuple): string {
	return `${t.action}\n${t.releaseId}\n${t.sha256}`;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const RELEASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Boundary validation for an untrusted (socket) request. Returns a typed
 * request or a refusal reason — never throws. */
export function validatePublishRequest(
	raw: unknown,
): { ok: true; request: PublishRequest } | { ok: false; reason: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, reason: "malformed_request" };
	}
	const r = raw as Record<string, unknown>;
	const action = r.action;
	if (action !== "publish-release" && action !== "publish-shell") {
		return { ok: false, reason: "unknown_action" };
	}
	if (typeof r.releaseId !== "string" || !RELEASE_ID_RE.test(r.releaseId)) {
		return { ok: false, reason: "invalid_release_id" };
	}
	if (typeof r.sha256 !== "string" || !SHA256_RE.test(r.sha256)) {
		return { ok: false, reason: "invalid_sha256" };
	}
	let stagedPath: string | undefined;
	if (action === "publish-shell") {
		if (typeof r.stagedPath !== "string" || !r.stagedPath.startsWith("/")) {
			return { ok: false, reason: "invalid_staged_path" };
		}
		stagedPath = r.stagedPath;
	}
	return {
		ok: true,
		request: { action, releaseId: r.releaseId, sha256: r.sha256, stagedPath },
	};
}
