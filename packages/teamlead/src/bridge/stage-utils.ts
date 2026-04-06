/**
 * GEO-292: Session stage constants for pipeline tracking.
 * Shared between event-route.ts, actions.ts, and flywheel-comm.
 */

export const VALID_STAGES = new Set([
	"started",
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
	brainstorm: 1,
	research: 2,
	plan: 3,
	design_review: 4,
	implement: 5,
	test: 6,
	code_review: 7,
	pr_created: 8,
	approve: 9,
	ship: 10,
	completed: 11,
};
