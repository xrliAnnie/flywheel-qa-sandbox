import { template as flywheelContext } from "./flywheel-context.js";
import { template as flywheelEscalation } from "./flywheel-escalation.js";
import { template as flywheelGitWorkflow } from "./flywheel-git-workflow.js";
import { template as flywheelLand } from "./flywheel-land.js";
import { template as flywheelTdd } from "./flywheel-tdd.js";
import { template as linearIssueContext } from "./linear-issue-context.js";

export const SKILL_TEMPLATES: Record<string, string> = {
	"flywheel-context": flywheelContext,
	"linear-issue-context": linearIssueContext,
	"flywheel-git-workflow": flywheelGitWorkflow,
	"flywheel-escalation": flywheelEscalation,
	"flywheel-tdd": flywheelTdd,
	"flywheel-land": flywheelLand,
};
