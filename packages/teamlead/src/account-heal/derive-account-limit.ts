/**
 * FLY-696 M1/C3 — compose a capped pane + the pool state into the
 * AlertMetadata.accountLimit object at the alert producer (LeadWatchdog /
 * RunnerQuotaDetector).
 *
 * observedAccount/observedGeneration come from the pool's active-account
 * snapshot (the CAS key that stops a duplicate trigger from double-switching).
 * The timezone is read from the pane's own "reset at … (Zone)" message so reset
 * instants are absolute. Pure/isolated so the LeadWatchdog wiring is a tiny
 * flag-gated call.
 */

import {
	type AccountLimitMeta,
	buildAccountLimitMetadata,
} from "./account-limit.js";
import { readStore } from "./account-store.js";

/** IANA-ish zone in the pane's "(America/Chicago)" reset message, else `fallback`. */
export function extractTimezone(pane: string, fallback: string): string {
	const m = pane.match(/\(([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)\)/);
	return m?.[1] ?? fallback;
}

function hostTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

export interface DeriveAccountLimitInput {
	pane: string;
	now: Date;
	provider?: "claude" | "codex";
	/** Override the account-state path (tests); defaults to the store default. */
	storePath?: string;
}

export function deriveAccountLimitForAlert(
	input: DeriveAccountLimitInput,
): AccountLimitMeta | null {
	const store = readStore(input.storePath);
	// No active account yet → the pool isn't provisioned; nothing to switch from.
	if (store.activeAccount === null) return null;

	return buildAccountLimitMetadata({
		pane: input.pane,
		now: input.now,
		timeZone: extractTimezone(input.pane, hostTimezone()),
		provider: input.provider ?? "claude",
		observedAccount: store.activeAccount,
		observedGeneration: store.generation,
	});
}
