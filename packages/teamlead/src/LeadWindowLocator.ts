/** Locate and validate the canonical body pane on a Lead's private v2 socket. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	type LeadRuntimeManifest,
	leadAddressFromManifest,
} from "./lead-address.js";

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
	stateDir?: string;
	manifest?: LeadRuntimeManifest;
}

export interface LeadWindowRef {
	windowId: "%0";
	windowName: "main";
	carrier: "v2";
	socketPath: string;
	sessionTarget: "=main";
	bodyPaneTarget: "%0";
}

export type V2LeadPaneProbeStrength = "capture" | "send";

/**
 * The one typed private-pane predicate used by locate/capture/send consumers.
 * `%0` is only authority while both tmux metadata and the wait-parent process
 * still prove the reviewed lead-body shape. Sending additionally requires the
 * foreground command to be Claude, never an assembly shell or arbitrary TUI.
 */
export async function probeV2LeadPane(
	window: LeadWindowRef,
	runner: ExecFn = defaultExec as unknown as ExecFn,
	strength: V2LeadPaneProbeStrength = "capture",
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
	try {
		const { stdout } = await runner(
			"tmux",
			[
				"-S",
				window.socketPath,
				"list-panes",
				"-t",
				window.bodyPaneTarget,
				"-F",
				"#{pane_id}\t#{session_name}\t#{pane_start_command}\t#{pane_current_command}\t#{pane_dead}\t#{pane_pid}",
			],
			{ timeout: timeoutMs },
		);
		const lines = stdout.trimEnd().split("\n");
		if (lines.length !== 1) return false;
		const [
			paneId,
			sessionName,
			startCommand,
			currentCommand,
			dead,
			panePid,
			...extra
		] = (lines[0] ?? "").split("\t");
		if (
			extra.length > 0 ||
			paneId !== window.bodyPaneTarget ||
			sessionName !== "main" ||
			dead !== "0" ||
			!startCommand ||
			!/(^|[\s"'])\/?[^\s"']*lead-body\.sh(?:[\s"']|$)/.test(startCommand) ||
			!panePid ||
			!/^\d+$/.test(panePid)
		) {
			return false;
		}
		const process = await runner("ps", ["-p", panePid, "-o", "command="], {
			timeout: timeoutMs,
		});
		if (
			!/(^|\s)(?:\/bin\/)?bash\s+[^\n]*lead-body\.sh(?:\s|$)/.test(
				process.stdout.trim(),
			)
		) {
			return false;
		}
		return (
			strength === "capture" ||
			/^(?:claude|\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/i.test(
				currentCommand ?? "",
			)
		);
	} catch {
		return false;
	}
}

/** Kernel process name of a Claude Code binary (`claude` or its version). */
const CLAUDE_COMM_RE = /^(?:claude|\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/i;

export type V2LeadClaudeProcess =
	| { state: "running"; pid: string }
	| { state: "absent" }
	| { state: "indeterminate" };

/**
 * FLY-2882 (design-correction C2): read-only liveness of the Claude process
 * under the private body pane. `capture` strength only proves the parent
 * `bash lead-body.sh`; after Claude exits, the old screen (done line + input
 * box) stays up until the wrapper kills tmux. This reads only pid / ppid /
 * kernel name — never command lines — and answers `running` only for exactly
 * one direct Claude child of the pane's bash.
 */
export async function readV2LeadClaudePid(
	window: LeadWindowRef,
	runner: ExecFn = defaultExec as unknown as ExecFn,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<V2LeadClaudeProcess> {
	try {
		const pane = await runner(
			"tmux",
			[
				"-S",
				window.socketPath,
				"list-panes",
				"-t",
				window.bodyPaneTarget,
				"-F",
				"#{pane_id}\t#{pane_dead}\t#{pane_pid}",
			],
			{ timeout: timeoutMs },
		);
		const lines = pane.stdout.trimEnd().split("\n");
		const [paneId, dead, panePid, ...extra] = (lines[0] ?? "").split("\t");
		if (
			lines.length !== 1 ||
			extra.length > 0 ||
			paneId !== window.bodyPaneTarget ||
			dead !== "0" ||
			!panePid ||
			!/^\d+$/.test(panePid)
		)
			return { state: "indeterminate" };
		const table = await runner("ps", ["-A", "-o", "pid=,ppid=,ucomm="], {
			timeout: timeoutMs,
		});
		let shell: string | undefined;
		const claude: string[] = [];
		for (const row of table.stdout.split("\n")) {
			const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(row);
			if (!match) continue;
			const [, pid, ppid, comm] = match;
			if (pid === panePid) shell = comm;
			else if (ppid === panePid && CLAUDE_COMM_RE.test(comm!))
				claude.push(pid!);
		}
		if (shell !== "bash" || claude.length > 1)
			return { state: "indeterminate" };
		return claude.length === 1
			? { state: "running", pid: claude[0]! }
			: { state: "absent" };
	} catch {
		return { state: "indeterminate" };
	}
}

export async function locateLeadWindow(
	projectName: string,
	leadId: string,
	options: LocateOptions = {},
): Promise<LeadWindowRef | null> {
	const runner = options.execFn ?? (defaultExec as unknown as ExecFn);
	const stateDir = options.stateDir;
	if (!stateDir || !options.manifest) return null;
	const address = leadAddressFromManifest(
		projectName,
		leadId,
		stateDir,
		options.manifest,
	);
	if (!address) return null;
	try {
		const candidate: LeadWindowRef = {
			windowId: address.bodyPaneTarget,
			windowName: "main",
			carrier: "v2",
			...address,
		};
		if (
			!(await probeV2LeadPane(candidate, runner, "capture", options.timeoutMs))
		) {
			return null;
		}
		return candidate;
	} catch {
		return null;
	}
}
