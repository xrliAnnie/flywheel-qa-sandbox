/**
 * FLY-795 c4: Blueprint resume-mode instructions.
 *
 * When teamlead computes a `progressResume` for a re-dispatched DEAD runner
 * (explicit terminate / reboot), the Blueprint prepends a RESUME directive so the
 * new runner CONTINUES from the real `progress.md` cursor instead of re-running
 * explore/research/plan — and, when the StateStore-authoritative `effectiveStage`
 * proves an earlier phase is complete, suppresses the from-scratch
 * onboard/brainstorm/design-review gates (Codex R1 #6). The founder ship-gate is
 * ALWAYS preserved (never auto-ship). Fail-closed (Codex R2 #4): a missing
 * `effectiveStage` (StateStore/ledger mismatch) suppresses NOTHING.
 */

export interface ResumeModeInput {
	progressPath: string;
	priorExecutionId: string;
	resumeKind: "restart" | "terminate" | "reboot" | "handoff";
	/** phase proven complete by the StateStore authority; undefined ⇒ suppress nothing. */
	effectiveStage?: string;
}

export interface ResumeModeInstructions {
	/** lines to prepend at the TOP of the runner system prompt. */
	lines: string[];
	/** when true, the from-scratch onboard/brainstorm preamble is omitted. */
	suppressOnboardBrainstorm: boolean;
}

export function resumeModeInstructions(
	pr: ResumeModeInput,
): ResumeModeInstructions {
	// Design is complete once we are in implement or qa → safe to skip re-brainstorm.
	// Anything else (design / undefined-mismatch) keeps the gates (fail-closed).
	const suppressOnboardBrainstorm =
		pr.effectiveStage === "implement" || pr.effectiveStage === "qa";

	const lines = [
		"## RESUME — this issue was interrupted; CONTINUE from real progress, do NOT start over.",
		`A prior runner (${pr.priorExecutionId}) made progress on THIS branch (reason: ${pr.resumeKind}).`,
		`FIRST: read \`${pr.progressPath}\` for the cursor (current phase, chunk statuses, next step),`,
		"and read the committed exploration.md / research.md / plan.md on this branch for the approach",
		"and the decisions already locked.",
		"Then CONTINUE from that cursor: do NOT re-run explore/research/plan, do NOT re-brainstorm",
		"decisions already made, do NOT redo work the chunk statuses mark done.",
		"Keep `progress.md` current with `flywheel-comm progress` as you complete each meaningful step.",
		"The founder ship-gate / approval STILL APPLIES — never auto-ship.",
		"",
	];

	return { lines, suppressOnboardBrainstorm };
}
