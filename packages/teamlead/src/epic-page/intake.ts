import type { Cell, EpicIntakeValue } from "./model.js";

export function epicIntakeStatus(root: {
	has_child_issues?: boolean;
	intake?: Cell<EpicIntakeValue>;
}): string | null {
	const intake = root.intake?.value;
	if (!intake || intake.work_state === "superseded") return null;
	if (intake.work_state === "needs_founder") return "已回帖，待 founder 回答";
	if (root.has_child_issues === false)
		return `待拆解（intake 于 ${intake.intake_at}）`;
	if (root.has_child_issues === true && intake.work_state === "pending")
		return `待核依赖（intake 于 ${intake.intake_at}）`;
	return null;
}
