/**
 * FLY-247 inc2a (§2.2): the founder-admin console surface — canonical request
 * building + the single-use confirmToken store.
 *
 * The console is the founder operating locally. There is NO issue-thread
 * FounderConsentEvaluator here (that's issue-scoped and would deny everything);
 * the stage→confirm→apply flow IS the consent. Authorization correctness rests
 * on:
 *   1. confirmToken bound to the FULL canonical request SHA (not just targets),
 *      single-use, short-TTL — so a stage-time review can't be replayed or have
 *      its from→to swapped (R2 #1 / R12 deterministic boundary), and
 *   2. the engine re-verifying expectedConfigSha + per-key `from` under the
 *      config-write lock before any mutation (WI-2 baseline gate).
 *
 * `denied` (auth-layer reject) is an audit event only, never a BatchStatus.
 */

import { createHash, randomBytes } from "node:crypto";

/**
 * A draft change from the console — sparse: only the dimensions the founder
 * actually changed are present (FLY-671). `toModel`/`toEffort` keys are present
 * iff that dimension was edited; `null` means "back to the default". A change
 * must carry at least one of the two.
 */
export interface ConsoleChange {
	key: string;
	/** Present iff model was changed; null = account default. */
	toModel?: string | null;
	/** FLY-671: present iff effort was changed; null = back to default. */
	toEffort?: string | null;
}

/**
 * The full canonical change the engine re-verifies. `to.model` is ALWAYS present
 * (filled from the current model when the founder didn't touch it) — idempotent
 * for the engine's model-required contract. The `effort` key (on BOTH from/to) is
 * present ONLY when the change touches effort (FLY-671 three-state: absent =
 * don't touch effort). A model-only change therefore has NO effort key and is
 * byte-identical to the pre-FLY-671 shape (same confirmToken SHA — reverse-compat).
 */
export interface CanonicalChange {
	key: string;
	from: { model: string | null; effort?: string | null };
	to: { model: string | null; effort?: string | null };
}

export interface CanonicalRequest {
	batchId: string;
	expectedConfigSha: string;
	changes: CanonicalChange[];
}

/** Safe txn-id grammar shared with the engine (no path traversal). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Generate a fresh, grammar-safe batchId. */
export function newBatchId(): string {
	return `b-${randomBytes(12).toString("hex")}`;
}

/**
 * Build the canonical request the founder confirms and the engine re-verifies.
 * `fromModelByKey` / `fromEffortByKey` supply each key's CURRENT model/effort
 * (null = default) so the reviewed transition is the exact from→to.
 *
 * Sparse → full normalization (FLY-671, Codex design review R2 HIGH-1):
 *   - `to.model` is ALWAYS present — filled from the current model when the
 *     console didn't change it (idempotent for the engine).
 *   - The `effort` key (from+to) is added ONLY when the console changed effort
 *     (`"toEffort" in c`). A model-only change therefore has NO effort key and is
 *     byte-identical to the pre-FLY-671 canonical shape (same SHA).
 *
 * Rejects unsafe batchId/keys, duplicate keys, and a change that touches neither
 * dimension (defense in depth with the engine's own validation).
 */
export function buildCanonicalRequest(
	batchId: string,
	expectedConfigSha: string,
	fromModelByKey: Map<string, string | null>,
	fromEffortByKey: Map<string, string | null>,
	changes: ConsoleChange[],
): CanonicalRequest {
	if (!SAFE_ID.test(batchId)) throw new Error(`unsafe batchId: ${batchId}`);
	if (!expectedConfigSha) throw new Error("expectedConfigSha required");
	if (changes.length === 0) throw new Error("no changes");
	const seen = new Set<string>();
	const out: CanonicalChange[] = changes.map((c) => {
		if (!SAFE_ID.test(c.key)) throw new Error(`unsafe key: ${c.key}`);
		if (seen.has(c.key)) throw new Error(`duplicate key: ${c.key}`);
		seen.add(c.key);
		if (!fromModelByKey.has(c.key)) throw new Error(`unknown key: ${c.key}`);
		const touchesModel = "toModel" in c;
		const touchesEffort = "toEffort" in c;
		if (!touchesModel && !touchesEffort) {
			throw new Error(`empty change (no model/effort): ${c.key}`);
		}
		const fromModel = fromModelByKey.get(c.key) ?? null;
		const change: CanonicalChange = {
			key: c.key,
			// `to.model` always present: the founder's value, or the current model
			// when model was not touched (idempotent for the model-required engine).
			from: { model: fromModel },
			to: { model: touchesModel ? (c.toModel ?? null) : fromModel },
		};
		if (touchesEffort) {
			// Three-state effort: include the key on BOTH from (fresh baseline) and
			// to (the founder's value, null = delete). Absent ⇒ engine leaves effort.
			change.from.effort = fromEffortByKey.get(c.key) ?? null;
			change.to.effort = c.toEffort ?? null;
		}
		return change;
	});
	return { batchId, expectedConfigSha, changes: out };
}

/** Stable SHA-256 of the canonical request (sorted keys) — the token binding. */
export function canonicalRequestSha(req: CanonicalRequest): string {
	return createHash("sha256").update(stableStringify(req)).digest("hex");
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>).sort();
		return `{${keys
			.map(
				(k) =>
					`${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export type TokenVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Single-use, SHA-bound, short-TTL confirmToken store (in-memory; Bridge restart
 * invalidates all — the intended safety direction). A token is consumed on the
 * first verify attempt regardless of outcome, so it can never be replayed.
 */
export class ConfirmTokenStore {
	private readonly tokens = new Map<
		string,
		{ requestSha: string; expiresAt: number }
	>();

	constructor(
		private readonly ttlMs = 60_000,
		private readonly now: () => number = () => Date.now(),
	) {}

	/** Issue a token bound to a canonical-request SHA. */
	issue(requestSha: string): string {
		const token = randomBytes(32).toString("hex");
		this.tokens.set(token, { requestSha, expiresAt: this.now() + this.ttlMs });
		return token;
	}

	/**
	 * Verify a token against the apply-time canonical-request SHA. Consumes the
	 * token (single-use) before checking expiry/match so replays always fail.
	 */
	verifyAndConsume(token: string, requestSha: string): TokenVerdict {
		const entry = this.tokens.get(token);
		if (!entry) return { ok: false, reason: "unknown or already-used token" };
		this.tokens.delete(token); // single-use — consume regardless of outcome
		if (this.now() > entry.expiresAt)
			return { ok: false, reason: "token expired" };
		if (entry.requestSha !== requestSha) {
			return { ok: false, reason: "token does not match this request" };
		}
		return { ok: true };
	}

	/** Drop expired tokens (optional housekeeping). */
	prune(): void {
		const t = this.now();
		for (const [k, v] of this.tokens)
			if (t > v.expiresAt) this.tokens.delete(k);
	}

	get size(): number {
		return this.tokens.size;
	}
}
