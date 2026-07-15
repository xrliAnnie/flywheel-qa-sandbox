/**
 * FLY-696 M1/③ — runner-side quota detection.
 *
 * Codex R1#1: a Claude runner can be the first process to hit the shared-account
 * cap while every Lead pane is idle. `detectRunnerQuotaCap` is the pure decision
 * a scan (piggybacking the runner idle poll) applies per runner pane:
 *   1. §3.3 hard boundary — a transient 529 / rate-limit short-circuits to null
 *      (retry in place, NEVER switch); the recognizer is injected (the same
 *      isTransientThrottlePane the Lead watchdog uses).
 *   2. otherwise defer to the shared metadata builder, so a runner cap produces
 *      the identical accountLimit metadata the Lead path does and flows through
 *      the same enqueue → watchdog → switch loop.
 *
 * Returns null when the pane is transient, has no gauge, or shows no real cap.
 */

import type { AccountLimitMeta } from "./account-limit.js";
import { deriveAccountLimitForAlert } from "./derive-account-limit.js";

export interface DetectRunnerQuotaInput {
	pane: string;
	now: Date;
	/** The isTransientThrottlePane recognizer (injected — the §3.3 short-circuit). */
	isTransient: (pane: string) => boolean;
	storePath?: string;
	provider?: "claude" | "codex";
}

export function detectRunnerQuotaCap(
	input: DetectRunnerQuotaInput,
): AccountLimitMeta | null {
	if (input.isTransient(input.pane)) return null;
	return deriveAccountLimitForAlert({
		pane: input.pane,
		now: input.now,
		provider: input.provider ?? "claude",
		storePath: input.storePath,
	});
}
