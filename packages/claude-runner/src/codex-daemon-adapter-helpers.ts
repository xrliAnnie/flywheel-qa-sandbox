/**
 * FLY-1188 M4d — pure helpers the daemon-mode CodexTmuxAdapter.execute() composes:
 * building the /goal objective, the sandbox writable roots, extracting the thread
 * id from a goal notification, and classifying a goal outcome/failure into the
 * adapter's success/timeout result. Kept pure + exported so the tricky mapping
 * is unit-testable independent of the (real-daemon) execute() wiring.
 */

import type { GoalRunResult } from "./codex-daemon-client.js";
import { GoalRunError } from "./codex-daemon-client.js";

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
 * Fold the persistent system layer + the per-execution prompt into a single
 * `/goal` objective. In daemon mode the goal is the durable objective the
 * resident /goal autonomously drives across turns (the daemon's codex reads its
 * persistent contract from `$CODEX_HOME/AGENTS.md`; this is the dynamic layer,
 * exactly as the exec-cycle folded the system layer into the per-cycle prompt —
 * codex has no `--append-system-prompt-file`).
 */
export function buildGoalObjective(input: {
	prompt: string;
	systemLayer?: string;
}): string {
	return input.systemLayer
		? `${input.systemLayer}\n\n---\n\n${input.prompt}`
		: input.prompt;
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
