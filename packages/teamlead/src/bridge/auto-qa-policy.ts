/**
 * FLY-579 P3 / FLY-752: the auto-QA enablement policy.
 *
 * Decides whether a main session entering awaiting_review should get auto-QA.
 * FLY-752 flipped the per-project default from OPT-IN to OPT-OUT (fleet-wide
 * default-on). The decision order is deliberately fail-safe and tamper-resistant:
 *
 *   1. FLYWHEEL_AUTO_QA=0    → OFF (global hard kill-switch).
 *   2. Linear `no-qa` label  → OFF (per-issue founder/Lead override).
 *   3. qaConfig MALFORMED    → OFF (fail-closed — a broken/fat-fingered opt-out
 *                              must NEVER accidentally enable QA under default-on).
 *   4. qaConfig `auto: false`→ OFF (explicit per-project opt-out).
 *   5. issue label ∈ skip_labels → OFF (docs/chore/etc.).
 *   6. otherwise (absent config / no `qa` block / `auto` absent / `auto: true`)
 *                            → ON (opt-out default).
 *
 * SECURITY: `qaConfig` MUST be loaded from the project's canonical / mainline
 * root, NEVER an implementation PR's worktree — otherwise a runner could set
 * `qa.auto: false` in its own PR to skip its own QA. The caller (plugin.ts via
 * run-infra) is responsible for that; the issue labels are the Linear snapshot
 * taken at run start (also trusted, not worktree-derived).
 */

import type { QaConfigResult } from "./auto-qa-config-source.js";
import type { QaPolicyDecision } from "./auto-qa-coordinator.js";

export interface AutoQaPolicyInput {
	/** Tri-state qa config, loaded from the CANONICAL root (never a PR worktree). */
	qaConfig: QaConfigResult | undefined;
	/** The issue's labels (snapshotted from Linear at run start). */
	issueLabels: string[];
	/** Env source for the kill-switch (defaults to process.env). */
	env?: Record<string, string | undefined>;
}

const NO_QA_LABEL = "no-qa";

export function resolveAutoQaPolicy(
	input: AutoQaPolicyInput,
): QaPolicyDecision {
	const env = input.env ?? process.env;
	if (env.FLYWHEEL_AUTO_QA === "0") {
		return { enabled: false, reason: "FLYWHEEL_AUTO_QA=0 global kill-switch" };
	}

	const labels = input.issueLabels.map((l) => l.toLowerCase());
	if (labels.includes(NO_QA_LABEL)) {
		return { enabled: false, reason: "issue labelled no-qa" };
	}

	const cfg = input.qaConfig;

	// Malformed config → fail CLOSED (never accidentally on under default-on).
	if (cfg?.kind === "malformed") {
		return {
			enabled: false,
			reason: `qa config malformed (fail-closed): ${cfg.reason}`,
		};
	}

	// Explicit per-project opt-out.
	if (cfg?.kind === "config" && cfg.auto === false) {
		return { enabled: false, reason: "qa.auto: false (explicit opt-out)" };
	}

	// skip_labels only apply when a config block supplied them.
	if (cfg?.kind === "config") {
		const skip = (cfg.skip_labels ?? []).map((l) => l.toLowerCase());
		const hit = labels.find((l) => skip.includes(l));
		if (hit) {
			return {
				enabled: false,
				reason: `issue label "${hit}" in qa.skip_labels`,
			};
		}
	}

	// Default-on (FLY-752): absent config / no qa block / auto absent / auto: true.
	return { enabled: true };
}
