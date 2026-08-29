/**
 * FLY-871 R2/C7 — `flywheel-account-summary`: print the daily account-state
 * summary. The Codex Infra Bot invokes this once a day (its "看" job) and posts
 * the output to Alerts. Read-only: reads the account-state ledger + the account
 * store (both local files) and prints `formatAccountSummary`.
 *
 * Injectable deps (paths / clock / sink) keep it unit-testable without touching
 * the real ~/.flywheel files; the direct-exec guard runs it with the defaults.
 */

import { fileURLToPath } from "node:url";
import {
	buildAccountSummary,
	formatAccountSummary,
	readLedger,
} from "./account-ledger.js";
import { readStore } from "./account-store.js";

export interface AccountSummaryCliDeps {
	ledgerPath?: string;
	storePath?: string;
	now?: () => string;
	log?: (msg: string) => void;
}

export function runAccountSummaryCli(deps: AccountSummaryCliDeps = {}): number {
	const ledger = readLedger(deps.ledgerPath);
	const store = readStore(deps.storePath);
	const nowIso = (deps.now ?? (() => new Date().toISOString()))();
	const text = formatAccountSummary(buildAccountSummary(ledger, store, nowIso));
	(deps.log ?? console.log)(text);
	return 0;
}

// Direct-exec guard (matches freshness-cli): run with defaults when invoked as a bin.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exit(runAccountSummaryCli());
}
