/**
 * GEO-151 ProofShot — session_params helpers.
 *
 * `StateStore.setSessionParams()` is **overwrite-only** (it does
 * `JSON.stringify(params)` over the whole `session_params` column). Anything
 * that wants to add/update a single key must do read-modify-write first.
 *
 * These helpers centralize that pattern so:
 *   1. DirectEventSink.emitStarted (replay-safe config persistence)
 *   2. handleProofShotAutoTrigger (state machine writes)
 *   3. handleArtifactEvent (completion writes)
 *
 * all use the same typed accessors. Doing `params.proofshot.config` directly
 * on `Record<string, unknown>` would fail `tsc --noEmit` in strict mode.
 */

import type { ProofShotConfig } from "flywheel-config";
import type { StateStore } from "../StateStore.js";

/**
 * State machine for a single ProofShot capture run.
 *
 * One record per `(execution_id, stage, captureKind)` key, stored under
 * `session_params.proofshot.runs[dedupKey]`.
 *
 * Lifecycle: `pending` → `completed` (artifact delivered) | `failed` (mailbox
 * write or Lead delivery exhausted). Stale `pending`/`running` older than
 * `PROOFSHOT_TTL_MS` is treated as recoverable so a new stage_changed event
 * can retry with `attempt = prior.attempt + 1`.
 */
export interface ProofShotRunRecord {
	state: "pending" | "running" | "completed" | "failed";
	/** `${execId}|${stage}|${captureKind}` — used as the runs map key. */
	dedupKey: string;
	/** 1-based, incremented on every retry of the same dedupKey. */
	attempt: number;
	/** Epoch ms of last state transition. Used for TTL stale recovery. */
	updatedAt: number;
	/** Last error string when state='failed', null otherwise. */
	lastError: string | null;
}

/** Schema for `session_params.proofshot`. All fields optional. */
export interface ProofShotSessionParams {
	/** Effective ProofShotConfig persisted by DirectEventSink.emitStarted. */
	config?: ProofShotConfig;
	/** Per-dedupKey run records. */
	runs?: Record<string, ProofShotRunRecord>;
}

/** Schema for `session_params.last_artifact` (Runner-provided via set-artifact). */
export interface LastArtifactParams {
	model_path?: string;
}

/** Typed accessor — returns empty object if params or proofshot block missing. */
export function getProofShotParams(
	params: Record<string, unknown> | undefined,
): ProofShotSessionParams {
	if (!params) return {};
	const proofshot = params.proofshot;
	if (!proofshot || typeof proofshot !== "object" || Array.isArray(proofshot)) {
		return {};
	}
	return proofshot as ProofShotSessionParams;
}

/** Typed accessor — returns empty object if params or last_artifact missing. */
export function getLastArtifact(
	params: Record<string, unknown> | undefined,
): LastArtifactParams {
	if (!params) return {};
	const la = params.last_artifact;
	if (!la || typeof la !== "object" || Array.isArray(la)) {
		return {};
	}
	return la as LastArtifactParams;
}

/**
 * Read-modify-write helper for `session_params`. Workaround for the fact that
 * `StateStore.setSessionParams()` overwrites the entire JSON blob.
 *
 * `patchFn` receives the current params (or `{}` if none) and must return the
 * complete new params object. Always spread `...cur` to preserve unrelated
 * fields (e.g., `last_artifact`, `bootstrap_*`).
 */
export function patchSessionParams(
	store: StateStore,
	executionId: string,
	patchFn: (cur: Record<string, unknown>) => Record<string, unknown>,
): void {
	const cur = store.getSessionParams(executionId) ?? {};
	store.setSessionParams(executionId, patchFn(cur));
}

/** Convenience: mark a single run as failed without clobbering other state. */
export function markProofShotRunFailed(
	store: StateStore,
	executionId: string,
	dedupKey: string,
	errorMsg: string,
): void {
	patchSessionParams(store, executionId, (cur) => {
		const proofshot = getProofShotParams(cur);
		const runs = proofshot.runs ?? {};
		const prev = runs[dedupKey];
		if (!prev) return cur;
		return {
			...cur,
			proofshot: {
				...proofshot,
				runs: {
					...runs,
					[dedupKey]: {
						...prev,
						state: "failed",
						updatedAt: Date.now(),
						lastError: errorMsg,
					},
				},
			},
		};
	});
}
