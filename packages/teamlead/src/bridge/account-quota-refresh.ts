/**
 * FLY-2688 / FLY-2807 / FLY-2864 / FLY-2869 — account quota refreshes.
 *
 * The Codex branch is its own single-flight round so the account page and the
 * FLY-2869 reading scheduler never run two Codex reads at once. Inside it the
 * subscription read runs strictly after the quota store is written, so it uses
 * the tokens that round just refreshed; a subscription failure is only a
 * warning and never fails the refresh. The Claude branch runs only on demand.
 */

import type { ClaudeAccountDetailStore } from "../claude-quota/account-detail-store.js";
import type { CodexAccountQuotaStore } from "../codex-quota/codex-account-quota-store.js";
import type { CodexSubscriptionStore } from "../codex-quota/codex-subscription-store.js";

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

export function createAccountQuotaRefresh(
	deps: AccountQuotaRefreshDeps,
): () => Promise<AccountQuotaRefreshResult> {
	return singleFlight(async () => {
		const [codexResult, claudeResult] = await Promise.allSettled([
			deps.refreshCodex(),
			withCeiling(deps.ceilingMs, async (signal) => {
				deps.writeClaudeAccountDetailStore(
					await deps.observeClaudeAccountDetails(signal),
				);
			}),
		]);
		if (codexResult.status === "rejected") throw codexResult.reason;
		if (claudeResult.status === "rejected") throw claudeResult.reason;
		return codexResult.value;
	});
}
