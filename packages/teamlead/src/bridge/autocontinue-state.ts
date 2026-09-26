/**
 * FLY-818: auto-continue durable filesystem state (goal file + armed marker).
 *
 * Both live under the SAME per-execution runner-state dir that TmuxAdapter already
 * uses (`~/.flywheel/runner-state/<execId>/`, overridable via
 * `FLYWHEEL_RUNNER_STATE_ROOT` for QA-room isolation — Codex R2#3/R3#2). Using the
 * filesystem (not a StateStore column) keeps the armer self-contained AND makes
 * arming naturally durable + idempotent across a Bridge restart: the armed marker
 * survives, so a re-driven observe loop never sends a second `/loop`.
 *
 * Security posture mirrors TmuxAdapter's append-system-prompt handling: the goal
 * file carries issue/phase contract text (≈append prompt sensitivity), so the dir
 * is 0700 and the file 0600, and the path handed to `/loop` is a resolved ABSOLUTE
 * path (never a literal `~`).
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Resolve the runner-state root. Honors `FLYWHEEL_RUNNER_STATE_ROOT` (absolute
 * only — a relative override is ignored to avoid writing under an unexpected cwd,
 * e.g. a QA-room worktree); defaults to `~/.flywheel/runner-state` to match
 * TmuxAdapter (`TmuxAdapter.ts:326-349`).
 */
export function resolveRunnerStateRoot(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const override = env.FLYWHEEL_RUNNER_STATE_ROOT?.trim();
	if (override && isAbsolute(override)) return override;
	return join(homedir(), ".flywheel", "runner-state");
}

/** Absolute per-execution runner-state dir. */
export function runnerStateDir(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return join(resolveRunnerStateRoot(env), executionId);
}

/** Absolute path of the auto-continue goal file for an execution. */
export function autocontinueGoalPath(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return join(runnerStateDir(executionId, env), "autocontinue-goal.md");
}

/** Absolute path of the armed marker for an execution (presence ⇒ armed). */
export function autocontinueArmedMarkerPath(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return join(runnerStateDir(executionId, env), "autocontinue-armed");
}

/** True if this execution has already been armed (durable, restart-safe). */
export function isAutocontinueArmed(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return existsSync(autocontinueArmedMarkerPath(executionId, env));
}

/**
 * Write the goal contract to the durable goal file (0700 dir / 0600 file) and
 * return its resolved absolute path. Idempotent: overwriting is safe (a re-armed
 * execution just rewrites the same content). Throws on I/O failure so the caller
 * fails closed (no `/loop` sent without a goal file on disk).
 */
export function writeAutocontinueGoalFile(
	executionId: string,
	contract: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const dir = runnerStateDir(executionId, env);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const path = autocontinueGoalPath(executionId, env);
	writeFileSync(path, contract, { encoding: "utf-8", mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}

/**
 * Record that this execution has been armed (write the marker). Best-effort:
 * a marker-write failure is returned as false so the caller can log it — but the
 * `/loop` was already sent, so it must NOT be retried (that would double-arm). The
 * in-memory armed set is the belt; this marker is the restart-durable suspenders.
 */
export function markAutocontinueArmed(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	try {
		const dir = runnerStateDir(executionId, env);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(
			autocontinueArmedMarkerPath(executionId, env),
			new Date().toISOString(),
			{
				encoding: "utf-8",
				mode: 0o600,
			},
		);
		return true;
	} catch {
		return false;
	}
}
