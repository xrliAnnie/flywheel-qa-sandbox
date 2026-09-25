/**
 * FLY-2688 / FLY-2807 / FLY-2864 / FLY-2869 — account quota refreshes.
 *
 * The Codex branch is its own single-flight round so the account page and the
 * FLY-2869 reading scheduler never run two Codex reads at once. Inside it the
 * subscription read runs strictly after the quota store is written, so it uses
 * the tokens that round just refreshed; a subscription failure is only a
 * warning and never fails the refresh. The Claude branch runs only on demand.
 *
 * FLY-2875: an optional on-demand Vercel branch reads the report-hosting
 * account. Its attempt is published to Bridge memory before it is written, so
 * a failed write can never leave an older success on the page; it never fails
 * the refresh and logs only fixed text (the token must not reach any log).
 */

import type { ClaudeAccountDetailStore } from "../claude-quota/account-detail-store.js";
import type { CodexAccountQuotaStore } from "../codex-quota/codex-account-quota-store.js";
import type { CodexSubscriptionStore } from "../codex-quota/codex-subscription-store.js";
import {
	type VercelAccountStore,
	vercelAccountFailure,
} from "../vercel-quota/vercel-account-store.js";

export interface AccountQuotaRefreshResult {
	generatedAt: string;
	accountCount: number;
}

export interface CodexAccountQuotaRefreshDeps {
	/** Hard ceiling above the observer's own round deadline. */
	ceilingMs: number;
	observeCodexAccounts: (
		signal: AbortSignal,
	) => Promise<CodexAccountQuotaStore>;
	writeCodexAccountQuotaStore: (store: CodexAccountQuotaStore) => void;
	observeCodexSubscriptions: (
		signal: AbortSignal,
	) => Promise<CodexSubscriptionStore>;
	writeCodexSubscriptionStore: (store: CodexSubscriptionStore) => void;
	warn?: (message: string, detail: string) => void;
}

export interface AccountQuotaRefreshDeps {
	/** Hard ceiling above the Claude observer's own round deadline. */
	ceilingMs: number;
	/** The shared Codex round (see createCodexAccountQuotaRefresh). */
	refreshCodex: () => Promise<AccountQuotaRefreshResult>;
	observeClaudeAccountDetails: (
		signal: AbortSignal,
	) => Promise<ClaudeAccountDetailStore>;
	writeClaudeAccountDetailStore: (store: ClaudeAccountDetailStore) => void;
	vercel?: {
		observe: (signal: AbortSignal) => Promise<VercelAccountStore>;
		/** In-memory latest attempt; the page prefers it over the file. */
		publish: (store: VercelAccountStore) => void;
		write: (store: VercelAccountStore) => void;
		/** Best-effort removal of the file after a failed write. */
		discardStale: () => void;
		now: () => Date;
	};
	/** Used by the Vercel branch; the Codex round has its own. */
	warn?: (message: string, detail: string) => void;
}

function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
	let inflight: Promise<T> | undefined;
	return () => {
		inflight ??= run().finally(() => {
			inflight = undefined;
		});
		return inflight;
	};
}

async function withCeiling<T>(
	ceilingMs: number,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const abort = new AbortController();
	const ceiling = setTimeout(() => abort.abort(), ceilingMs);
	try {
		return await run(abort.signal);
	} finally {
		clearTimeout(ceiling);
	}
}

export function createCodexAccountQuotaRefresh(
	deps: CodexAccountQuotaRefreshDeps,
): () => Promise<AccountQuotaRefreshResult> {
	const warn =
		deps.warn ?? ((message, detail) => console.warn(message, detail));
	return singleFlight(() =>
		withCeiling(deps.ceilingMs, async (signal) => {
			const store = await deps.observeCodexAccounts(signal);
			deps.writeCodexAccountQuotaStore(store);
			try {
				deps.writeCodexSubscriptionStore(
					await deps.observeCodexSubscriptions(signal),
				);
			} catch (error) {
				warn(
					"[Bridge] Codex subscription refresh failed",
					error instanceof Error ? error.message : String(error),
				);
			}
			return {
				generatedAt: store.generatedAt,
				accountCount: store.accounts.length,
			};
		}),
	);
}

async function refreshVercel(
	vercel: NonNullable<AccountQuotaRefreshDeps["vercel"]>,
	signal: AbortSignal,
	warn: (message: string, detail: string) => void,
): Promise<void> {
	let reading: VercelAccountStore;
	try {
		reading = await vercel.observe(signal);
	} catch {
		// Fixed text only: whatever was thrown may carry the credential.
		warn("[Bridge] Vercel account refresh failed", "");
		reading = vercelAccountFailure("refresh_failed", vercel.now());
	}
	vercel.publish(reading);
	try {
		vercel.write(reading);
	} catch {
		warn("[Bridge] Vercel account store write failed", "");
		try {
			vercel.discardStale();
		} catch {
			/* the in-memory attempt still wins for this process */
		}
	}
}

export function createAccountQuotaRefresh(
	deps: AccountQuotaRefreshDeps,
): () => Promise<AccountQuotaRefreshResult> {
	const warn =
		deps.warn ?? ((message, detail) => console.warn(message, detail));
	return singleFlight(async () => {
		const vercel = deps.vercel;
		const [codexResult, claudeResult] = await Promise.allSettled([
			deps.refreshCodex(),
			withCeiling(deps.ceilingMs, async (signal) => {
				deps.writeClaudeAccountDetailStore(
					await deps.observeClaudeAccountDetails(signal),
				);
			}),
			vercel
				? withCeiling(deps.ceilingMs, (signal) =>
						refreshVercel(vercel, signal, warn),
					)
				: undefined,
		]);
		if (codexResult.status === "rejected") throw codexResult.reason;
		if (claudeResult.status === "rejected") throw claudeResult.reason;
		return codexResult.value;
	});
}
