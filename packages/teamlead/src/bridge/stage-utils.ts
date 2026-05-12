/**
 * GEO-292: Session stage constants for pipeline tracking.
 * Shared between event-route.ts, actions.ts, and flywheel-comm.
 *
 * FLY-137 v1.27.2: added `onboard` stage between `started` and `brainstorm`.
 * Semantics: "Runner attempted onboarding" (not "onboarding succeeded"). Runner
 * sets `onboard` BEFORE invoking the onboard skill so the dashboard reflects intent.
 * On success → `brainstorm`. On skill absent → `brainstorm` directly. On hard failure
 * → `flywheel-comm complete --route blocked --summary "onboard_failed: <reason>"`
 * (existing fail channel — no new error stage needed).
 */

export const VALID_STAGES = new Set([
	"started",
	"onboard",
	"brainstorm",
	"research",
	"plan",
	"design_review",
	"implement",
	"test",
	"code_review",
	"pr_created",
	"approve",
	"ship",
	"completed",
]);

export const STAGE_ORDER: Record<string, number> = {
	started: 0,
	onboard: 1,
	brainstorm: 2,
	research: 3,
	plan: 4,
	design_review: 5,
	implement: 6,
	test: 7,
	code_review: 8,
	pr_created: 9,
	approve: 10,
	ship: 11,
	completed: 12,
};
