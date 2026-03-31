/**
 * Terminal status detection — inspects recent terminal output to determine
 * whether the Runner is executing, waiting for input, or idle.
 *
 * Follows AgentsMesh Pod Binding model: observe → detect status → input.
 */
export type TerminalStatus = "executing" | "waiting" | "idle" | "dead";

// Patterns indicating the terminal is waiting for user input
const WAITING_PATTERNS = [
	/Do you want to proceed/i,
	/\[Y\/n\]/i,
	/\[y\/N\]/i,
	/\(yes\/no\)/i,
	/\? \(Y\/n\)/,
	/\? \(y\/N\)/,
	/Press Enter/i,
	/waiting for input/i,
	/approve or deny/i,
	// Claude Code specific prompts
	/Do you want to/i,
	/Would you like to/i,
	/Should I/i,
	// Permission prompts
	/Allow\?/,
	/\[Allow\]/i,
	/\[Deny\]/i,
];

// Patterns indicating idle shell (no agent running)
const IDLE_PATTERNS = [
	/^\s*[$❯>%#]\s*$/m, // bare shell prompt at end
	/^\s*\w+@[\w.-]+[:\s~].*[$#]\s*$/m, // user@host:~ $ prompt
];

export function detectTerminalStatus(output: string): {
	status: TerminalStatus;
	reason: string;
} {
	// Check the last 15 non-empty lines for signal patterns
	const lines = output.split("\n");
	const tail = lines.filter((l) => l.trim().length > 0).slice(-15);

	if (tail.length === 0) {
		return { status: "idle", reason: "terminal output is empty" };
	}

	// Check for waiting patterns (highest priority — actionable)
	for (let i = tail.length - 1; i >= 0; i--) {
		for (const pattern of WAITING_PATTERNS) {
			if (pattern.test(tail[i]!)) {
				return {
					status: "waiting",
					reason: `matched: ${tail[i]!.trim().slice(0, 80)}`,
				};
			}
		}
	}

	// Check last few lines for idle shell prompt
	const lastLines = tail.slice(-3);
	for (const line of lastLines) {
		for (const pattern of IDLE_PATTERNS) {
			if (pattern.test(line!)) {
				return {
					status: "idle",
					reason: `shell prompt detected: ${line!.trim().slice(0, 40)}`,
				};
			}
		}
	}

	// Default: if output has recent content but no prompt/wait signals, agent is executing
	return { status: "executing", reason: "no prompt or wait signal detected" };
}
