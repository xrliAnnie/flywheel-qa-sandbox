/**
 * FLY-83: locate a Lead's tmux window inside the `flywheel` session.
 *
 * Windows are named `${projectName}-${leadId}` by `claude-lead.sh` at creation
 * (claude-lead.sh:604). We query tmux for `window_id window_name` pairs via
 * `execFile` (shell-free; same pattern as `bridge/tmux-lookup.ts`) and return
 * the first exact match. Callers use this for `capture-pane` reads in
 * `LeadWatchdog`; stable `@window_id` is preferred over window name so renames
 * mid-flight don't invalidate a previously resolved reference.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const defaultExec = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5000;

export interface ExecResult {
	stdout: string;
	stderr: string;
}

export type ExecFn = (
	file: string,
	args: readonly string[],
	options?: { timeout?: number },
) => Promise<ExecResult>;

export interface LocateOptions {
	execFn?: ExecFn;
	timeoutMs?: number;
	sessionName?: string;
}

export interface LeadWindowRef {
	windowId: string;
	windowName: string;
}

export async function locateLeadWindow(
	projectName: string,
	leadId: string,
	options: LocateOptions = {},
): Promise<LeadWindowRef | null> {
	const runner = options.execFn ?? (defaultExec as unknown as ExecFn);
	const session = options.sessionName ?? "flywheel";
	const target = `${projectName}-${leadId}`;

	let stdout: string;
	try {
		const result = await runner(
			"tmux",
			["list-windows", "-t", session, "-F", "#{window_id} #{window_name}"],
			{ timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
		);
		stdout = result.stdout;
	} catch {
		return null;
	}

	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const spaceAt = line.indexOf(" ");
		if (spaceAt <= 0) continue;
		const windowId = line.slice(0, spaceAt);
		const windowName = line.slice(spaceAt + 1).trim();
		if (windowName === target) {
			return { windowId, windowName };
		}
	}
	return null;
}
