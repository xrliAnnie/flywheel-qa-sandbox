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
import { isSameOrigin, loopbackSelfOrigin } from "./loopback-origin.js";

export interface FleetRouteDeps {
	audit: FleetAdminAudit;
	tokens: ConfirmTokenStore;
	/** Current model per exact lead key (null = account default). */
	currentModels: () => Map<string, string | null>;
	/** FLY-671: current effort per exact lead key (null = default). */
	currentEfforts: () => Map<string, string | null>;
	/**
	 * Allowed `to.model` targets per exact lead key (server-computed
	 * `tierOptions ∪ {null}`; a Codex Lead's only target is `null`). The stage
	 * handler rejects any target outside this set so a forged client can't bypass
	 * the dropdown (§2.6 model-authorization gate).
	 */
	allowedTargets: () => Map<string, Array<string | null>>;
	/**
	 * FLY-671: allowed `to.effort` targets per key (backend-aware:
	 * Claude = levels ∪ {null}, Codex = `[null]`). Same forged-client gate as
	 * model — an effort target outside this set is rejected before token issuance.
	 */
	allowedEffortTargets: () => Map<string, Array<string | null>>;
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

// FLY-286: loopbackSelfOrigin + isSameOrigin were moved to ./loopback-origin.js
// so the web-local review route can share ONE implementation. Imported above for
// internal use here; re-exported for back-compat (plugin.ts + fleet-routes tests
// import them from this module).
export { isSameOrigin, loopbackSelfOrigin };

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
			deps.currentEfforts(),
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
		// FLY-671: effort-authorization gate — only when the change touches effort.
		// Same forged-client defense as model + the Codex display-only reject.
		if ("effort" in c.to) {
			const effortTargets = deps.allowedEffortTargets().get(c.key);
			if (!effortTargets) {
				return { status: 400, body: { error: `unknown key: ${c.key}` } };
			}
			const toEffort = c.to.effort ?? null;
			if (toEffort !== null && typeof toEffort !== "string") {
				return {
					status: 400,
					body: { error: `to.effort must be string|null: ${c.key}` },
				};
			}
			if (!effortTargets.includes(toEffort)) {
				return {
					status: 403,
					body: { error: `effort not allowed for ${c.key}` },
				};
			}
			const effortDisplayOnly =
				effortTargets.length === 1 && effortTargets[0] === null;
			if (effortDisplayOnly && (c.from.effort ?? null) !== toEffort) {
				return {
					status: 403,
					body: {
						error: `effort change not allowed for ${c.key} (display-only)`,
					},
				};
			}
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
