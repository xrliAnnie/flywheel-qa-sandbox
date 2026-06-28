/**
 * FLY-579 P3: the auto-QA enablement policy.
 *
 * Decides whether a main session entering awaiting_review should get auto-QA.
 * The decision order is deliberately fail-safe and tamper-resistant:
 *
 *   1. FLYWHEEL_AUTO_QA=0  → OFF (global hard kill-switch; default = allowed).
 *   2. Linear `no-qa` label → OFF (per-issue founder/Lead override).
 *   3. qa.auto !== true     → OFF (per-project opt-in; default OFF = byte-compat).
 *   4. issue label ∈ qa.skip_labels → OFF (docs/chore/etc.).
 *   5. otherwise            → ON.
 *
 * SECURITY: the `qaConfig` MUST be loaded from the project's canonical / mainline
 * root, NEVER from an implementation PR's worktree — otherwise a runner could add
 * `skip_labels` or set `qa.auto: false` in its own PR to skip its own QA. The
 * caller (plugin.ts via run-infra) is responsible for that; the issue labels are
 * the Linear snapshot taken at run start (also trusted, not worktree-derived).
 */

import type { QaPolicyDecision } from "./auto-qa-coordinator.js";

/** Minimal shape of the project qa config (matches config.QaConfig structurally). */
export interface AutoQaPolicyConfig {
	auto: boolean;
	skip_labels?: string[];
}

export interface AutoQaPolicyInput {
	/** The project qa config, loaded from the CANONICAL root (never a PR worktree). */
	qaConfig: AutoQaPolicyConfig | undefined;
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
	if (!cfg || cfg.auto !== true) {
		return { enabled: false, reason: "qa.auto not enabled for project" };
	}

	const skip = (cfg.skip_labels ?? []).map((l) => l.toLowerCase());
	const hit = labels.find((l) => skip.includes(l));
	if (hit) {
		return { enabled: false, reason: `issue label "${hit}" in qa.skip_labels` };
	}

	return { enabled: true };
}
