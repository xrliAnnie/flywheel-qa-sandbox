import type { ExecutionContext, HardRuleResult } from "flywheel-core";

export interface HardRule {
	id: string;
	description: string;
	priority: number;
	evaluate: (ctx: ExecutionContext) => HardRuleResult;
}

const SENSITIVE_LABELS = [
	"security",
	"auth",
	"billing",
	"authentication",
	"authorization",
];
const SENSITIVE_FILE_PATTERNS = [
	/\.env/,
	/secret/i,
	/credential/i,
	/\.pem$/,
	/\.key$/,
];

const noTrigger = (ruleId: string): HardRuleResult => ({
	triggered: false,
	action: "escalate",
	reason: "",
	ruleId,
});

// HR-010: landing failed → block (highest priority — checked before timeout)
export const HR_010_LANDING_FAILED: HardRule = {
	id: "HR-010",
	description: "PR landing failed — block for review",
	priority: 0,
	evaluate: (ctx) =>
		ctx.landingStatus?.status === "failed"
			? {
					triggered: true,
					action: "block",
					reason: `Landing failed: ${ctx.landingStatus.failureReason ?? "unknown"}`,
					ruleId: "HR-010",
				}
			: noTrigger("HR-010"),
};

// HR-007: timeout → block (highest priority)
export const HR_007_TIMEOUT: HardRule = {
	id: "HR-007",
	description: "Session timed out — block",
	priority: 1,
	evaluate: (ctx) =>
		ctx.exitReason === "timeout"
			? {
					triggered: true,
					action: "block",
					reason: "Session timed out",
					ruleId: "HR-007",
				}
			: noTrigger("HR-007"),
};

// HR-009: zero commits → block (no work done, don't advance DAG)
export const HR_009_ZERO_COMMITS: HardRule = {
	id: "HR-009",
	description: "Zero commits — block (nothing was implemented)",
	priority: 2,
	evaluate: (ctx) =>
		ctx.commitCount === 0
			? {
					triggered: true,
					action: "block",
					reason: "Zero commits — no work was done",
					ruleId: "HR-009",
				}
			: noTrigger("HR-009"),
};

// HR-008: partial evidence → escalate
export const HR_008_PARTIAL: HardRule = {
	id: "HR-008",
	description: "Partial evidence — escalate for manual review",
	priority: 3,
	evaluate: (ctx) =>
		ctx.partial
			? {
					triggered: true,
					action: "escalate",
					reason: "Evidence is partial — some git commands failed",
					ruleId: "HR-008",
				}
			: noTrigger("HR-008"),
};

// HR-001: security/auth/billing labels → escalate
export const HR_001_SENSITIVE_LABELS: HardRule = {
	id: "HR-001",
	description: "Security/auth/billing labels require review",
	priority: 4,
	evaluate: (ctx) => {
		const match = ctx.labels.find((l) =>
			SENSITIVE_LABELS.includes(l.toLowerCase()),
		);
		return match
			? {
					triggered: true,
					action: "escalate",
					reason: `Sensitive label: ${match}`,
					ruleId: "HR-001",
				}
			: noTrigger("HR-001");
	},
};

// HR-002: consecutive failures ≥ 3 → escalate
export const HR_002_CONSECUTIVE_FAILURES: HardRule = {
	id: "HR-002",
	description: "3+ consecutive failures require review",
	priority: 5,
	evaluate: (ctx) =>
		ctx.consecutiveFailures >= 3
			? {
					triggered: true,
					action: "escalate",
					reason: `${ctx.consecutiveFailures} consecutive failures`,
					ruleId: "HR-002",
				}
			: noTrigger("HR-002"),
};

// HR-003: sensitive file patterns → escalate
export const HR_003_SENSITIVE_FILES: HardRule = {
	id: "HR-003",
	description: "Changes to sensitive files require review",
	priority: 6,
	evaluate: (ctx) => {
		const match = ctx.changedFilePaths.find((f) =>
			SENSITIVE_FILE_PATTERNS.some((p) => p.test(f)),
		);
		return match
			? {
					triggered: true,
					action: "escalate",
					reason: `Sensitive file changed: ${match}`,
					ruleId: "HR-003",
				}
			: noTrigger("HR-003");
	},
};

// HR-004: large change (>500 lines added) → escalate
export const HR_004_LARGE_CHANGE: HardRule = {
	id: "HR-004",
	description: "Large changes (>500 lines) require review",
	priority: 7,
	evaluate: (ctx) =>
		ctx.linesAdded > 500
			? {
					triggered: true,
					action: "escalate",
					reason: `${ctx.linesAdded} lines added (>500)`,
					ruleId: "HR-004",
				}
			: noTrigger("HR-004"),
};

// HR-005: breaking-change label → escalate
export const HR_005_BREAKING_CHANGE: HardRule = {
	id: "HR-005",
	description: "Breaking changes require review",
	priority: 8,
	evaluate: (ctx) => {
		const match = ctx.labels.find((l) => l.toLowerCase() === "breaking-change");
		return match
			? {
					triggered: true,
					action: "escalate",
					reason: "Breaking change label",
					ruleId: "HR-005",
				}
			: noTrigger("HR-005");
	},
};

// HR-006: trust score < 300 (Phase 5 — stub)
export const HR_006_TRUST_SCORE: HardRule = {
	id: "HR-006",
	description: "Low trust score (Phase 5 — stub)",
	priority: 9,
	evaluate: () => noTrigger("HR-006"),
};

export function defaultRules(): HardRule[] {
	return [
		HR_010_LANDING_FAILED,
		HR_007_TIMEOUT,
		HR_009_ZERO_COMMITS,
		HR_008_PARTIAL,
		HR_001_SENSITIVE_LABELS,
		HR_002_CONSECUTIVE_FAILURES,
		HR_003_SENSITIVE_FILES,
		HR_004_LARGE_CHANGE,
		HR_005_BREAKING_CHANGE,
		HR_006_TRUST_SCORE,
	];
}
