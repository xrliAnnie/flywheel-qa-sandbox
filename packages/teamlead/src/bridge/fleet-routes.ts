/**
 * FLY-247 inc2a (§2.2): the console's stage/apply handler LOGIC, written with
 * injected deps so it is unit-testable without a live Express app. plugin.ts
 * mounts these as `POST /api/fleet/stage` / `POST /api/fleet/apply` and
 * `GET /api/fleet/snapshot` (loopback + same-origin; NO Bearer — see §2.2).
 *
 * Flow:
 *   stage : validate same-origin → build canonical request (current models +
 *           config SHA) → audit `staged` (FAIL-CLOSED) → issue confirmToken →
 *           return { batchId, canonicalRequest, confirmToken }.
 *   apply : validate same-origin → verifyAndConsume token vs the apply-time
 *           canonical-request SHA (mismatch/expiry/replay → audit `denied`
 *           append-only, 401) → audit `apply-requested` (FAIL-CLOSED) →
 *           create the launching journal → spawn the detached engine → return
 *           { accepted, batchId }.
 */

import {
	buildCanonicalRequest,
	type CanonicalRequest,
	type ConfirmTokenStore,
	type ConsoleChange,
	canonicalRequestSha,
	newBatchId,
} from "./fleet-admin.js";
import type { FleetAdminAudit } from "./fleet-admin-audit.js";

export interface FleetRouteDeps {
	audit: FleetAdminAudit;
	tokens: ConfirmTokenStore;
	/** Current model per exact lead key (null = account default). */
	currentModels: () => Map<string, string | null>;
	/**
	 * Allowed `to.model` targets per exact lead key (server-computed
	 * `tierOptions ∪ {null}`; a Codex Lead's only target is `null`). The stage
	 * handler rejects any target outside this set so a forged client can't bypass
	 * the dropdown (§2.6 model-authorization gate).
	 */
	allowedTargets: () => Map<string, Array<string | null>>;
	/** SHA of the live projects.json (the engine's file_sha). */
	configSha: () => string;
	/** Create the launching journal before spawn; returns false on failure. */
	createLaunching: (batchId: string, req: CanonicalRequest) => boolean;
	/** Spawn the detached engine for a batch; returns false if spawn failed. */
	spawnEngine: (batchId: string, req: CanonicalRequest) => boolean;
	/** Fresh ids for append-only `denied` rows. */
	newAttemptId?: () => string;
}

export type HttpResult = {
	status: number;
	body: Record<string, unknown>;
};

/**
 * Anti-DNS-rebinding guard (Codex R1 HIGH-1): the `Host` header is
 * attacker-controllable, so before trusting it as the same-origin baseline we
 * require it to be a real loopback host. A rebinding domain (evil.com →
 * 127.0.0.1) carries a non-loopback Host and is rejected. Returns the validated
 * self-origin (`http://<host>`), or null when the host is not loopback.
 */
export function loopbackSelfOrigin(host: string | undefined): string | null {
	if (typeof host !== "string" || host.length === 0) return null;
	const hostname = host.replace(/:\d+$/, ""); // strip :port (IPv4 / host / [::1])
	if (
		hostname !== "127.0.0.1" &&
		hostname !== "localhost" &&
		hostname !== "[::1]"
	) {
		return null;
	}
	return `http://${host}`;
}

/** Same-origin guard: Origin/Referer must be the Bridge's own loopback origin. */
export function isSameOrigin(
	headers: Record<string, string | undefined>,
	selfOrigin: string,
): boolean {
	const origin = headers.origin ?? headers.Origin;
	if (origin) return origin === selfOrigin;
	const referer = headers.referer ?? headers.Referer;
	if (referer)
		return referer.startsWith(`${selfOrigin}/`) || referer === selfOrigin;
	// No Origin/Referer (e.g. a non-browser caller) — treated as same-origin is
	// NOT assumed; require one of them to be present and matching.
	return false;
}

export interface StageBody {
	changes: ConsoleChange[];
}

export function handleStage(
	deps: FleetRouteDeps,
	body: StageBody,
	headers: Record<string, string | undefined>,
	selfOrigin: string,
): HttpResult {
	if (!isSameOrigin(headers, selfOrigin)) {
		return { status: 403, body: { error: "cross-origin" } };
	}
	if (!Array.isArray(body?.changes) || body.changes.length === 0) {
		return { status: 400, body: { error: "no changes" } };
	}
	const batchId = newBatchId();
	let req: CanonicalRequest;
	try {
		req = buildCanonicalRequest(
			batchId,
			deps.configSha(),
			deps.currentModels(),
			body.changes,
		);
	} catch (err) {
		return { status: 400, body: { error: (err as Error).message } };
	}
	// Model-authorization gate (§2.6, Codex R2 HIGH-1): every `to.model` must be
	// in the lead's server-computed allowed targets. Closes the forged-client
	// path — arbitrary model strings, non-string values, and Codex-Lead model
	// changes (allowed = [null]) are rejected BEFORE a token is issued.
	const allowed = deps.allowedTargets();
	for (const c of req.changes) {
		const targets = allowed.get(c.key);
		if (!targets) {
			return { status: 400, body: { error: `unknown key: ${c.key}` } };
		}
		const to = c.to.model;
		if (to !== null && typeof to !== "string") {
			return {
				status: 400,
				body: { error: `to.model must be string|null: ${c.key}` },
			};
		}
		if (!targets.includes(to)) {
			return {
				status: 403,
				body: { error: `model not allowed for ${c.key}` },
			};
		}
		// Display-only (Codex) Lead: the only allowed target is `null`, so an
		// explicit-model→null transition would slip through `[null].includes(null)`
		// (Codex R3 HIGH-1). Reject ANY actual model transition on such a Lead.
		const displayOnly = targets.length === 1 && targets[0] === null;
		if (displayOnly && c.from.model !== c.to.model) {
			return {
				status: 403,
				body: { error: `model change not allowed for ${c.key} (display-only)` },
			};
		}
	}
	const sha = canonicalRequestSha(req);
	// Pre-issuance audit, FAIL-CLOSED — no token if we can't record intent.
	if (
		!deps.audit.record({
			batchId,
			event: "staged",
			canonicalRequest: JSON.stringify(req),
		})
	) {
		return {
			status: 503,
			body: { error: "audit unavailable — refusing to stage" },
		};
	}
	const confirmToken = deps.tokens.issue(sha);
	return {
		status: 200,
		body: { batchId, canonicalRequest: req, confirmToken },
	};
}

export interface ApplyBody {
	batch: CanonicalRequest;
	confirmToken: string;
}

export function handleApply(
	deps: FleetRouteDeps,
	body: ApplyBody,
	headers: Record<string, string | undefined>,
	selfOrigin: string,
): HttpResult {
	if (!isSameOrigin(headers, selfOrigin)) {
		return { status: 403, body: { error: "cross-origin" } };
	}
	const req = body?.batch;
	if (!req || typeof body.confirmToken !== "string") {
		return { status: 400, body: { error: "missing batch / confirmToken" } };
	}
	const sha = canonicalRequestSha(req);
	const verdict = deps.tokens.verifyAndConsume(body.confirmToken, sha);
	if (!verdict.ok) {
		// Auth-layer rejection → append-only `denied`, never a BatchStatus.
		const attemptId = (deps.newAttemptId ?? newBatchId)();
		deps.audit.record({
			batchId: req.batchId ?? "unknown",
			event: "denied",
			attemptId,
			reason: verdict.reason,
		});
		return { status: 401, body: { error: verdict.reason } };
	}
	// Pre-spawn audit, FAIL-CLOSED.
	if (
		!deps.audit.record({
			batchId: req.batchId,
			event: "apply-requested",
			canonicalRequest: JSON.stringify(req),
		})
	) {
		return {
			status: 503,
			body: { error: "audit unavailable — refusing to apply" },
		};
	}
	// Launching record BEFORE spawn (no pre-journal window, R6 #4).
	if (!deps.createLaunching(req.batchId, req)) {
		deps.audit.record({
			batchId: req.batchId,
			event: "apply-result",
			result: "rejected",
			reason: "could not create launching journal",
		});
		return { status: 409, body: { error: "could not create batch journal" } };
	}
	if (!deps.spawnEngine(req.batchId, req)) {
		deps.audit.record({
			batchId: req.batchId,
			event: "apply-result",
			result: "rejected",
			reason: "engine spawn failed before launching advanced",
		});
		return { status: 500, body: { error: "engine spawn failed" } };
	}
	return { status: 202, body: { accepted: true, batchId: req.batchId } };
}
