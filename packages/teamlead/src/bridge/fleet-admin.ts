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

/** A draft change from the console: a lead key + the desired model (null = default). */
export interface ConsoleChange {
	key: string;
	toModel: string | null;
}

export interface CanonicalChange {
	key: string;
	from: { model: string | null };
	to: { model: string | null };
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
 * `fromModelByKey` supplies each key's CURRENT model (null = account default) so
 * the reviewed transition is the exact from→to. Rejects unsafe batchId/keys and
 * duplicate keys (defense in depth with the engine's own validation).
 */
export function buildCanonicalRequest(
	batchId: string,
	expectedConfigSha: string,
	fromModelByKey: Map<string, string | null>,
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
		return {
			key: c.key,
			from: { model: fromModelByKey.get(c.key) ?? null },
			to: { model: c.toModel },
		};
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
