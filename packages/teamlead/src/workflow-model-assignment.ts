import {
	parsePercentageModelSplit,
	resolvePercentageModelSplit,
} from "flywheel-config";
import type { WorkflowModelAssignmentReceipt } from "./workflow-menu.js";

/** Validate the frozen percentage basis at both materialization and dispatch replay. */
export function assertPercentageModelAssignment(
	assignment: WorkflowModelAssignmentReceipt,
): void {
	if (assignment.basis.rule !== "issue_number_percentage")
		throw new Error("percentage assignment required");
	const basis = assignment.basis;
	const policy = parsePercentageModelSplit({
		enabled: true,
		rule: basis.rule,
		codexPercent: basis.codexPercent,
		codex: basis.codex,
		fable: basis.fable,
	});
	const choice = resolvePercentageModelSplit(policy, basis.issueNumber);
	const suffix = /-(\d+)$/.exec(basis.issueIdentifier);
	if (
		!suffix ||
		Number(suffix[1]) !== basis.issueNumber ||
		policy.version !== basis.ruleVersion ||
		choice.bucket !== basis.bucket ||
		choice.arm.arm !== assignment.arm ||
		choice.arm.model !== assignment.modelAlias
	)
		throw new Error("invalid basis");
}
