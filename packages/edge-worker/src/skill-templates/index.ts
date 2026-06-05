import { template as flywheelContext } from "./flywheel-context.js";
import { template as flywheelEscalation } from "./flywheel-escalation.js";
import { template as flywheelGitWorkflow } from "./flywheel-git-workflow.js";
import { template as flywheelTdd } from "./flywheel-tdd.js";
import { template as linearIssueContext } from "./linear-issue-context.js";

// FLY-214: "flywheel-land" migrated to the flywheel-skills capability library
// (user-level, machine-wide). It was the only zero-variable template; the
// remaining 5 carry per-issue/per-project values and stay injected until
// they are de-templated (v2). NOTE: Blueprint's landing prompt enablement
// still keys off skillInjectionSucceeded (these 5 templates) — rework that
// gate before migrating further templates (see plan v1.35.0 FLY-216/214).
export const SKILL_TEMPLATES: Record<string, string> = {
	"flywheel-context": flywheelContext,
	"linear-issue-context": linearIssueContext,
	"flywheel-git-workflow": flywheelGitWorkflow,
	"flywheel-escalation": flywheelEscalation,
	"flywheel-tdd": flywheelTdd,
};
