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
 *
 * FLY-2897: an optional on-demand Claude charge-receipt leg (see
 * createClaudeChargeRefresh) that, like Vercel, never fails the refresh.
 */

import type { ClaudeAccountDetailStore } from "../claude-quota/account-detail-store.js";
import type { ClaudeChargeSummary } from "../claude-quota/charge-receipt-observer.js";
import type { ClaudeChargeStore } from "../claude-quota/charge-receipt-store.js";
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
	/** FLY-2897: the shared single-flight receipt round; never fails the refresh. */
	refreshClaudeCharges?: () => Promise<unknown>;
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

const FAILURE_CODE = /^[a-z0-9_:.-]{1,60}$/;

/** A bounded, path-free failure code: the message only when it already is one. */
function failureCode(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	return FAILURE_CODE.test(message) ? message : "error";
}

/** Past the cooperative ceiling, how long a hung round may still take. */
const CHARGE_HARD_GRACE_MS = 5_000;

export interface ClaudeChargeRefreshDeps {
	/** Cooperative ceiling: the observer's signal aborts here. */
	ceilingMs: number;
	observe: (
		signal: AbortSignal,
	) => Promise<{ store: ClaudeChargeStore; summary: ClaudeChargeSummary }>;
	write: (store: ClaudeChargeStore) => void;
	log?: (line: string) => void;
}

/**
 * FLY-2897: one receipt round shared by the daily scheduler, the post-switch
 * refresh and the on-demand page refresh. A round that outlives its ceiling
 * by the hard grace is abandoned unwritten. Failures surface as bare codes.
 */
export function createClaudeChargeRefresh(
	deps: ClaudeChargeRefreshDeps,
): () => Promise<ClaudeChargeSummary> {
	const log = deps.log ?? ((line: string) => console.warn(line));
	return singleFlight(async () => {
		let hard: ReturnType<typeof setTimeout> | undefined;
		try {
			const { store, summary } = await Promise.race([
				withCeiling(deps.ceilingMs, deps.observe),
				new Promise<never>((_resolve, reject) => {
					hard = setTimeout(
						() => reject(new Error("timeout")),
						deps.ceilingMs + CHARGE_HARD_GRACE_MS,
					);
				}),
			]);
			deps.write(store);
			const failures =
				summary.failed.length === 0
					? ""
					: ` failures=${summary.failed.join(",")}`;
			log(
				`[claude-charge] accounts=${summary.accounts} ok=${summary.ok} canceled=${summary.canceled} failed=${summary.failed.length}${failures}`,
			);
			return summary;
		} catch (error) {
			throw new Error(failureCode(error));
		} finally {
			clearTimeout(hard);
		}
	});
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
			deps.refreshClaudeCharges?.().catch((error: unknown) => {
				warn("[Bridge] Claude charge refresh failed", failureCode(error));
			}),
		]);
		if (codexResult.status === "rejected") throw codexResult.reason;
		if (claudeResult.status === "rejected") throw claudeResult.reason;
		return codexResult.value;
	});
}

export type AccountReadingsLeg = { ok: true } | { ok: false; error: unknown };

export interface AccountReadingsRefreshOutcome {
	codex: AccountReadingsLeg;
	claude: AccountReadingsLeg;
}

export interface AccountReadingsRefreshDeps {
	ceilingMs: number;
	/** The shared single-flight Codex round. */
	refreshCodex: () => Promise<AccountQuotaRefreshResult>;
	observeClaudeAccountDetails: (
		signal: AbortSignal,
	) => Promise<ClaudeAccountDetailStore>;
	writeClaudeAccountDetailStore: (store: ClaudeAccountDetailStore) => void;
}

/**
 * FLY-2830: Codex readings plus Claude cards/subscriptions — never Vercel —
 * for the reading scheduler and the post-switch refresh. The two legs are
 * independent; each outcome is reported, neither hides the other.
 */
export function createAccountReadingsRefresh(
	deps: AccountReadingsRefreshDeps,
): () => Promise<AccountReadingsRefreshOutcome> {
	const leg = (result: PromiseSettledResult<unknown>): AccountReadingsLeg =>
		result.status === "fulfilled"
			? { ok: true }
			: { ok: false, error: result.reason };
	return singleFlight(async () => {
		const [codex, claude] = await Promise.allSettled([
			deps.refreshCodex(),
			withCeiling(deps.ceilingMs, async (signal) => {
				deps.writeClaudeAccountDetailStore(
					await deps.observeClaudeAccountDetails(signal),
				);
			}),
		]);
		return { codex: leg(codex), claude: leg(claude) };
	});
}

const LEG_CODE = /^[a-z0-9_:.-]{1,60}$/;

export function accountReadingsFailureCode(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	return LEG_CODE.test(message) ? message : "error";
}

/**
 * The reading scheduler's view: only the Codex leg can fail the round (it
 * drives the FLY-2869 reading_stale episode); a Claude failure is a log line.
 */
export function scheduledReadingsRefresh(
	refresh: () => Promise<AccountReadingsRefreshOutcome>,
	log: (line: string) => void = (line) => console.warn(line),
): () => Promise<void> {
	return async () => {
		const outcome = await refresh();
		if (!outcome.claude.ok)
			log(
				`[reading-scheduler] claude_details_failed:${accountReadingsFailureCode(outcome.claude.error)}`,
			);
		if (!outcome.codex.ok) throw outcome.codex.error;
	};
}
