/**
 * FLY-2688 / FLY-2807 / FLY-2864 — the on-demand account-page refresh.
 *
 * Single-flight and never scheduled. The Codex and Claude branches run side by
 * side under one hard ceiling. Inside the Codex branch the subscription read
 * runs strictly after the quota store is written, so it uses the tokens that
 * round just refreshed; a subscription failure is only a warning and never
 * fails the refresh.
 */

import type { ClaudeAccountDetailStore } from "../claude-quota/account-detail-store.js";
import type { CodexAccountQuotaStore } from "../codex-quota/codex-account-quota-store.js";
import type { CodexSubscriptionStore } from "../codex-quota/codex-subscription-store.js";

export interface AccountQuotaRefreshResult {
	generatedAt: string;
	accountCount: number;
}

export interface AccountQuotaRefreshDeps {
	/** Hard ceiling above every observer's own round deadline. */
	ceilingMs: number;
	observeCodexAccounts: (
		signal: AbortSignal,
	) => Promise<CodexAccountQuotaStore>;
	writeCodexAccountQuotaStore: (store: CodexAccountQuotaStore) => void;
	observeCodexSubscriptions: (
		signal: AbortSignal,
	) => Promise<CodexSubscriptionStore>;
	writeCodexSubscriptionStore: (store: CodexSubscriptionStore) => void;
	observeClaudeAccountDetails: (
		signal: AbortSignal,
	) => Promise<ClaudeAccountDetailStore>;
	writeClaudeAccountDetailStore: (store: ClaudeAccountDetailStore) => void;
	warn?: (message: string, detail: string) => void;
}

export function createAccountQuotaRefresh(
	deps: AccountQuotaRefreshDeps,
): () => Promise<AccountQuotaRefreshResult> {
	let inflight: Promise<AccountQuotaRefreshResult> | undefined;
	const warn =
		deps.warn ?? ((message, detail) => console.warn(message, detail));
	const run = async (): Promise<AccountQuotaRefreshResult> => {
		const abort = new AbortController();
		const ceiling = setTimeout(() => abort.abort(), deps.ceilingMs);
		try {
			const [codexResult, claudeResult] = await Promise.allSettled([
				(async () => {
					const store = await deps.observeCodexAccounts(abort.signal);
					deps.writeCodexAccountQuotaStore(store);
					try {
						deps.writeCodexSubscriptionStore(
							await deps.observeCodexSubscriptions(abort.signal),
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
				})(),
				(async () => {
					deps.writeClaudeAccountDetailStore(
						await deps.observeClaudeAccountDetails(abort.signal),
					);
				})(),
			]);
			if (codexResult.status === "rejected") throw codexResult.reason;
			if (claudeResult.status === "rejected") throw claudeResult.reason;
			return codexResult.value;
		} finally {
			clearTimeout(ceiling);
			inflight = undefined;
		}
	};
	return () => {
		inflight ??= run();
		return inflight;
	};
}
