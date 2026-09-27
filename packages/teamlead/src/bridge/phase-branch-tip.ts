import {
	type AsyncExecFileFn,
	defaultAsyncExecFile,
} from "flywheel-claude-runner";
import type { PhaseRetryStartPoint } from "./run-dispatcher.js";

/**
 * Bridge-side git probes shared by the run infrastructure (FLY-1257 phase
 * retry start point) and the workflow engine dispatcher (FLY-2901 §4.6
 * predecessor head fallback). Dependency-light on purpose: no child_process
 * import, only the shared async execFile seam.
 */

export const BRIDGE_GIT_PROBE_TIMEOUT_MS = 20_000;

function describeProbeFailure(error: unknown): string {
	const failure = error as {
		code?: unknown;
		status?: unknown;
		signal?: unknown;
		message?: unknown;
		stderr?: unknown;
	};
	return [
		`exit=${String(failure.status ?? failure.code ?? "spawn-error")}`,
		failure.signal ? `signal=${String(failure.signal)}` : "",
		failure.message ? String(failure.message) : "",
	]
		.filter(Boolean)
		.join(" ");
}

/**
 * FLY-1257 M3: inspect one fully-qualified local branch ref with a
 * machine-readable three-state exit contract. Exit 1 from `--verify --quiet`
 * is the only confirmed-missing result; every other failure is indeterminate.
 */
export async function probePhaseRetryBranchTip(
	projectRoot: string,
	branch: string,
	execFile: AsyncExecFileFn = defaultAsyncExecFile,
): Promise<PhaseRetryStartPoint> {
	try {
		const { stdout } = await execFile(
			"git",
			[
				"-C",
				projectRoot,
				"rev-parse",
				"--verify",
				"--quiet",
				`refs/heads/${branch}^{commit}`,
			],
			{
				cwd: projectRoot,
				timeoutMs: BRIDGE_GIT_PROBE_TIMEOUT_MS,
			},
		);
		const sha = stdout.trim();
		if (!sha) {
			return {
				kind: "indeterminate",
				error: `git rev-parse returned an empty sha for refs/heads/${branch}`,
			};
		}
		return { kind: "found", sha };
	} catch (error) {
		const failure = error as { code?: unknown; status?: unknown };
		if ((failure.status ?? failure.code) === 1) return { kind: "missing" };
		return { kind: "indeterminate", error: describeProbeFailure(error) };
	}
}

/**
 * FLY-2901 §4.6: read the commit at HEAD of a worktree directory with the same
 * three-state contract. A path that git cannot enter (missing directory, not a
 * repository) is indeterminate for the caller, which simply falls through to
 * the next fallback level; nothing here ever writes.
 */
export async function probeWorktreeHead(
	worktreePath: string,
	execFile: AsyncExecFileFn = defaultAsyncExecFile,
): Promise<PhaseRetryStartPoint> {
	try {
		const { stdout } = await execFile(
			"git",
			["-C", worktreePath, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
			{
				cwd: worktreePath,
				timeoutMs: BRIDGE_GIT_PROBE_TIMEOUT_MS,
			},
		);
		const sha = stdout.trim();
		if (!sha) {
			return {
				kind: "indeterminate",
				error: `git rev-parse returned an empty sha for HEAD of ${worktreePath}`,
			};
		}
		return { kind: "found", sha };
	} catch (error) {
		const failure = error as { code?: unknown; status?: unknown };
		if ((failure.status ?? failure.code) === 1) return { kind: "missing" };
		return { kind: "indeterminate", error: describeProbeFailure(error) };
	}
}
