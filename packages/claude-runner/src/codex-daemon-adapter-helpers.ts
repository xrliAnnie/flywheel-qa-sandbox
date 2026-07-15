/**
 * FLY-1188 M4d — pure helpers the daemon-mode CodexTmuxAdapter.execute() composes:
 * building the /goal objective, the sandbox writable roots, extracting the thread
 * id from a goal notification, and classifying a goal outcome/failure into the
 * adapter's success/timeout result. Kept pure + exported so the tricky mapping
 * is unit-testable independent of the (real-daemon) execute() wiring.
 */

import type { GoalRunResult } from "./codex-daemon-client.js";
import {
	GOAL_OBJECTIVE_MAX_CHARS,
	GoalRunError,
} from "./codex-daemon-client.js";

/**
 * The sandbox writable roots for the daemon's workspace-write threads — the
 * SAME set the exec-cycle granted (flywheel state root + gate-marker dir +
 * CommDB dir + the realpath'd worktree + its linked-worktree git metadata
 * dirs), deduped. A linked worktree's commit/index/locks live under the MAIN
 * repo's `.git`, outside the thread's implicit cwd root, so these are what let
 * `git add/commit` (the progress ledger!) survive the Seatbelt sandbox.
 */
export function buildDaemonSandboxWritableRoots(input: {
	flywheelRoot: string;
	gateMarkerDir: string;
	commDbDir?: string;
	sandboxCwd: string;
	gitWritableDirs: string[];
}): string[] {
	return [
		...new Set([
			input.flywheelRoot,
			input.gateMarkerDir,
			...(input.commDbDir ? [input.commDbDir] : []),
			input.sandboxCwd,
			...input.gitWritableDirs,
		]),
	];
}

/**
 * FLY-1236: fold the persistent system layer + the per-execution prompt into the
 * FIRST turn's kick text (`turn/start` input) — NOT the `/goal` objective. The
 * daemon's `thread/goal/set` rejects an objective longer than
 * {@link GOAL_OBJECTIVE_MAX_CHARS}; a real three-stage `implement` prompt (issue
 * body + design handoff, Blueprint cap 40000 chars) blows past that, so the full
 * working instructions ride the kick turn instead — which is NOT subject to the
 * goal objective's char cap and is where codex actually reads its work. This is
 * byte-identical to the old `buildGoalObjective` body (the `\n\n---\n\n`
 * separator is preserved), just relocated to the kick channel.
 *
 * Reconstructed from `ctx` on every `execute()`, so a genuinely new thread (a
 * crash → new executionId → fresh thread) is kicked with the full instructions
 * again — never left with only the north-star `/goal` and no working copy.
 */
export function buildGoalKickText(input: {
	prompt: string;
	systemLayer?: string;
}): string {
	return input.systemLayer
		? `${input.systemLayer}\n\n---\n\n${input.prompt}`
		: input.prompt;
}

/**
 * FLY-1236: build the durable `/goal` objective — a bounded, PHASE-NEUTRAL
 * north-star pointer, never the working copy. Codex runs three-stage phase
 * prompts (Design = do not implement; QA = the implementation + PR already
 * exist), so the objective must NOT hardcode "implement / open a PR" or it would
 * contradict the authoritative phase instructions. It only names the task and
 * defers to the instructions delivered as a user turn in the thread; the full
 * body rides {@link buildGoalKickText}. The persistent runner contract lives in
 * `$CODEX_HOME/AGENTS.md` (NOT the dynamic task body — that is the kick turn).
 *
 * Derived from `issueId`/`label` (both bounded, deterministic per execution) so
 * it is stable across an in-run restart and short by construction.
 */
export function buildGoalObjective(input: {
	issueId?: string;
	label?: string;
}): string {
	const head =
		input.label?.trim() || input.issueId?.trim() || "the assigned runner task";
	return (
		`[${head}] Complete the assigned runner task per the instructions delivered ` +
		`as a user turn in this thread. Follow that task's stated workflow, honor its ` +
		`gates, and take its required handoff/completion route. The persistent runner ` +
		`contract lives in $CODEX_HOME/AGENTS.md.`
	);
}

/**
 * FLY-1236 graceful degradation (adapter-side, where the full kick + log context
 * exist). The objective is bounded by construction, but a pathologically long
 * `label` could still push {@link buildGoalObjective} over
 * {@link GOAL_OBJECTIVE_MAX_CHARS}. Rather than silently truncate (the task body
 * is safe in the kick turn regardless), degrade to a fixed short pointer with a
 * code-point-safe issueId cap (never a `slice(0, N)` that can split a UTF-16
 * surrogate pair). The client's `setGoal` guard is the hard fail-closed boundary;
 * this keeps the normal path succeeding with a clean, in-limit pointer.
 */
export function enforceObjectiveLimit(
	objective: string,
	issueId: string,
): { objective: string; degraded: boolean } {
	if (objective.length <= GOAL_OBJECTIVE_MAX_CHARS) {
		return { objective, degraded: false };
	}
	// Code-point-safe cap on the (untrusted) issueId; the fixed wrapper text keeps
	// the fallback far below the limit, so no post-hoc truncation is needed.
	const safeId = Array.from(issueId).slice(0, 80).join("") || "runner task";
	const fallback =
		`[${safeId}] Complete the assigned runner task per the instructions delivered ` +
		`as a user turn in this thread; honor its gates and completion route.`;
	return { objective: fallback, degraded: true };
}

export interface GoalClassification {
	success: boolean;
	timedOut: boolean;
	failureReason?: string;
	resultText?: string;
}

/**
 * Classify a resident-/goal run into the adapter's terminal result. A `complete`
 * status that succeeded is the ONLY success; every other terminal status
 * (blocked / usageLimited / budgetLimited / paused) is a non-success the
 * DecisionLayer routes on. A caught GoalRunError maps by kind: `timeout` →
 * timedOut (FLY-159-parity active-budget expiry), everything else → a plain
 * failure reason. `caughtError` takes precedence over `outcome` (a run that
 * threw has no trustworthy outcome).
 */
export function classifyGoalOutcome(input: {
	outcome?: { result: GoalRunResult } | null;
	caughtError?: unknown;
	lastMessage?: string;
}): GoalClassification {
	const { caughtError, outcome, lastMessage } = input;
	if (caughtError !== undefined && caughtError !== null) {
		if (caughtError instanceof GoalRunError) {
			return {
				success: false,
				timedOut: caughtError.kind === "timeout",
				failureReason: `goal run ${caughtError.kind}: ${caughtError.message}`,
			};
		}
		return {
			success: false,
			timedOut: false,
			failureReason:
				caughtError instanceof Error
					? caughtError.message
					: String(caughtError),
		};
	}
	if (!outcome) {
		return {
			success: false,
			timedOut: false,
			failureReason: "goal run produced no outcome",
		};
	}
	const { status, succeeded } = outcome.result;
	const success = status === "complete" && succeeded;
	const classification: GoalClassification = { success, timedOut: false };
	if (!success) {
		classification.failureReason = `goal ended non-complete: ${status}`;
	}
	if (lastMessage !== undefined) classification.resultText = lastMessage;
	return classification;
}
