import type { AdapterExecutionContext } from "flywheel-core";

export const DEFAULT_PROCESS_RETIREMENT_GRACE_MS = 60_000;

export type TmuxWindowPresence = "present" | "absent" | "unknown";

type TmuxInventoryExec = (
	command: string,
	args: string[],
	options?: { timeoutMs?: number },
) => { stdout: string };

export function tmuxWindowPresence(
	execFile: TmuxInventoryExec,
	sessionName: string,
	identity: { windowId?: string; windowName?: string },
): TmuxWindowPresence {
	if (identity.windowId && !/^@\d+$/.test(identity.windowId)) return "unknown";
	if (!identity.windowId && !identity.windowName) return "unknown";
	try {
		const rows = execFile(
			"tmux",
			[
				"list-windows",
				"-t",
				`=${sessionName}`,
				"-F",
				"#{window_id}|#{window_name}",
			],
			{ timeoutMs: 10_000 },
		)
			.stdout.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		for (const row of rows) {
			const separator = row.indexOf("|");
			if (separator < 1) return "unknown";
			const observedId = row.slice(0, separator);
			const observedName = row.slice(separator + 1);
			if (
				identity.windowId
					? observedId === identity.windowId
					: observedName === identity.windowName
			) {
				return "present";
			}
		}
		return "absent";
	} catch (error) {
		// FLY-2808: killing a session's last window makes tmux destroy the
		// session. tmux answering that the session is missing proves the owned
		// window is gone; any other failure stays indeterminate.
		return tmuxReportedSessionMissing(error) ? "absent" : "unknown";
	}
}

function tmuxReportedSessionMissing(error: unknown): boolean {
	const stderr =
		typeof error === "object" && error !== null && "stderr" in error
			? String((error as { stderr?: unknown }).stderr ?? "")
			: "";
	const message = error instanceof Error ? error.message : String(error);
	return /can't find session: /.test(`${message}\n${stderr}`);
}

export function processRetirementGraceMs(
	lifecycle: NonNullable<AdapterExecutionContext["processLifecycle"]>,
): number {
	const raw = lifecycle.retirementGraceMs;
	return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
		? raw
		: DEFAULT_PROCESS_RETIREMENT_GRACE_MS;
}
