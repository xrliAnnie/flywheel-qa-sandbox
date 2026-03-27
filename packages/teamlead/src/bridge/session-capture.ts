import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CommDB } from "flywheel-comm/db";

const execFileAsync = promisify(execFile);

export interface CaptureResult {
	output: string;
	tmux_target: string;
	lines: number;
	captured_at: string;
}

export interface CaptureError {
	error: string;
	status: number;
}

export type ExecCaptureFn = (
	tmuxTarget: string,
	lines: number,
) => Promise<string>;

/**
 * Default async tmux capture-pane implementation.
 * Non-blocking — does not stall Bridge's event loop.
 * Extracted for testability — tests inject a mock.
 */
export async function defaultExecCapture(
	tmuxTarget: string,
	lines: number,
): Promise<string> {
	const { stdout } = await execFileAsync(
		"tmux",
		["capture-pane", "-t", tmuxTarget, "-p", "-S", `-${lines}`],
		{ encoding: "utf-8", timeout: 5000 },
	);
	return stdout;
}

/**
 * Derive CommDB path from project name.
 * Default: ~/.flywheel/comm/{projectName}/comm.db
 * Extracted as a parameter for testability (Codex R1 #1).
 */
export function defaultGetCommDbPath(projectName: string): string {
	return join(homedir(), ".flywheel", "comm", projectName, "comm.db");
}

/**
 * Capture a Runner's tmux terminal output.
 *
 * Async to avoid blocking Bridge event loop (Codex R1 #2).
 * dbPath resolution is injectable for testability (Codex R1 #1).
 *
 * @param executionId - execution_id from StateStore
 * @param projectName - project_name from StateStore, used to derive CommDB path
 * @param lines - number of terminal lines to capture (1-500)
 * @param execCapture - tmux capture function (injectable for tests)
 * @param getCommDbPath - path resolver (injectable for tests)
 */
export async function captureSession(
	executionId: string,
	projectName: string,
	lines: number,
	execCapture: ExecCaptureFn = defaultExecCapture,
	getCommDbPath: (name: string) => string = defaultGetCommDbPath,
): Promise<CaptureResult | CaptureError> {
	// Path traversal guard (Codex R3 #1): reject project names with path separators
	if (/[/\\]|\.\./.test(projectName)) {
		return {
			error: `Invalid project name: '${projectName}'`,
			status: 400,
		};
	}

	const dbPath = getCommDbPath(projectName);

	if (!existsSync(dbPath)) {
		return {
			error: `Communication database not found for project '${projectName}'`,
			status: 404,
		};
	}

	let tmuxTarget: string;
	try {
		const db = CommDB.openReadonly(dbPath);
		try {
			const session = db.getSession(executionId);
			if (!session) {
				return {
					error: `No tmux window registered for execution ${executionId}`,
					status: 404,
				};
			}
			tmuxTarget = session.tmux_window;
		} finally {
			db.close();
		}
	} catch (err) {
		console.error(
			`[capture] Failed to read CommDB for project '${projectName}', execution ${executionId}:`,
			(err as Error).message,
		);
		return {
			error: `Failed to read communication database for project '${projectName}'`,
			status: 502,
		};
	}

	try {
		const output = await execCapture(tmuxTarget, lines);
		return {
			output,
			tmux_target: tmuxTarget,
			lines,
			captured_at: new Date().toISOString(),
		};
	} catch (err) {
		console.error(
			`[capture] tmux capture-pane failed for ${tmuxTarget} (execution ${executionId}):`,
			(err as Error).message,
		);
		return {
			error: `tmux window not found: ${tmuxTarget}`,
			status: 502,
		};
	}
}

export function isCaptureError(
	result: CaptureResult | CaptureError,
): result is CaptureError {
	return "error" in result;
}
