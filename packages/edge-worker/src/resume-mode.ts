/**
 * FLY-795 c4: Blueprint resume-mode instructions.
 *
 * When teamlead computes a `progressResume` for a re-dispatched DEAD runner
 * (explicit terminate / reboot), the Blueprint prepends a RESUME directive so the
 * new runner CONTINUES from the real `progress.md` cursor instead of re-running
 * explore/research/plan — and, when the StateStore-authoritative `effectiveStage`
 * proves an earlier phase is complete, suppresses the from-scratch
 * onboard/brainstorm/design-review gates (Codex R1 #6). The founder ship-gate is
 * ALWAYS preserved (never auto-ship).
 *
 * Fail-closed (Codex R2 #4 + code-review HIGH-2): the resume text has TWO distinct
 * layers — a WEAK layer (worktree carries prior progress.md; read it for context)
 * that is always safe, and an AUTHORITATIVE "skip earlier phases / do NOT
 * re-brainstorm" layer that is emitted ONLY when `effectiveStage` (the StateStore
 * authority) AGREES with the ledger phase (⇒ `suppressOnboardBrainstorm`). On a
 * StateStore/ledger mismatch (`effectiveStage` undefined) the skip layer is
 * withheld and the from-scratch gate preamble is kept — so a stale / tampered
 * `progress.md` can never steer the runner PAST a mandatory brainstorm/design gate
 * (the earlier code emitted the skip layer unconditionally, contradicting the kept
 * preamble). Worktree reuse still preserves the committed work either way.
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

	// WEAK layer — always safe: the worktree carries the prior progress.md + docs;
	// read them for context. Never tells the runner to skip a gate.
	const lines = [
		"## RESUME — this issue was interrupted; a prior runner left real progress on THIS branch.",
		`The prior runner (${pr.priorExecutionId}) committed work here (reason: ${pr.resumeKind}).`,
		`FIRST: read \`${pr.progressPath}\` for the cursor (current phase, chunk statuses, next step),`,
		"and read the committed exploration.md / research.md / plan.md on this branch for the approach",
		"and the decisions already locked. Do NOT redo work the chunk statuses mark done.",
		"Keep `progress.md` current with `flywheel-comm progress` as you complete each meaningful step.",
	];

	if (suppressOnboardBrainstorm) {
		// AUTHORITATIVE layer — only when the StateStore stage AGREES with the ledger
		// phase (design proven complete). Safe to skip the from-scratch phases.
		lines.push(
			"The design is already complete and committed on this branch: CONTINUE from the cursor,",
			"do NOT re-run explore/research/plan, do NOT re-brainstorm decisions already made.",
		);
	} else {
		// Mismatch / design phase — the ledger's stage is NOT authority-confirmed, so
		// do NOT tell the runner to skip anything. It must re-verify the real stage and
		// run every mandatory gate (the from-scratch onboard/brainstorm preamble is kept).
		lines.push(
			"NOTE: the recorded stage is not authority-confirmed for this resume, so treat the",
			"prior progress.md as REFERENCE only — re-verify the current stage and run every",
			"mandatory gate (onboard / brainstorm / design review) that has not been completed.",
		);
	}

	lines.push(
		"The founder ship-gate / approval STILL APPLIES — never auto-ship.",
		"",
	);

	return { lines, suppressOnboardBrainstorm };
}
