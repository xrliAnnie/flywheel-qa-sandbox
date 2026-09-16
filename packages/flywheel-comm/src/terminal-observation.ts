import { Worker } from "node:worker_threads";
import { buildSafeRegex } from "./validate.js";
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

/** Recognize only a contiguous menu at the pane tail, never an old question
 * separated from its options by execution output. */
function currentTerminalPrompt(tail: string[]): string {
	for (let i = tail.length - 1; i >= 0; i--) {
		const question = tail[i]!;
		if (!WAITING_PATTERNS.some((pattern) => pattern.test(question))) continue;
		const boxed = /^\s*[╭┌]/.test(question);
		let hasOption = false,
			closed = false,
			continuationColumn = 0;
		const menu = tail.slice(i + 1).every((raw) => {
			if (/^[\s─━│┃┌┐└┘├┤┬┴┼╭╮╰╯]+$/.test(raw)) {
				if (/[╰└]/.test(raw)) closed = true;
				return true;
			}
			const line = raw.replace(/^\s*[│┃]/, "").replace(/[│┃]\s*$/, "");
			if (
				/^(?:\s*(?:Enter|Esc|Escape|Tab|Shift\+Tab|↑|↓|←|→) to [a-z]+(?: [a-z]+)*\s*)(?:·\s*(?:Enter|Esc|Escape|Tab|Shift\+Tab|↑|↓|←|→) to [a-z]+(?: [a-z]+)*\s*)*$/i.test(
					line,
				)
			) {
				closed = true;
				return hasOption;
			}
			if (closed) return false;
			const option = /^(\s*[❯>]?\s*\d+\.\s+)\S/.exec(line);
			if (option) {
				hasOption = true;
				continuationColumn = option[1]!.length;
				return true;
			}
			if (!hasOption) return boxed && /^\s*[│┃].*[│┃]\s*$/.test(raw);
			return (
				line.trim().length > 0 &&
				line.length - line.trimStart().length >= continuationColumn
			);
		});
		if (menu && (hasOption || i === tail.length - 1)) return question;
	}
	return tail.at(-1) ?? "";
}

export interface TerminalText {
	text: string;
	truncated: boolean;
}
const MAX_TERMINAL_BYTES = 262144;
function boundedText(text: string, alreadyTruncated = false): TerminalText {
	const bytes = Buffer.from(text);
	if (bytes.length <= MAX_TERMINAL_BYTES)
		return { text, truncated: alreadyTruncated };
	let end = MAX_TERMINAL_BYTES;
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
	return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}
export async function captureTerminalOutput(
	target: string,
	lines: number,
	capture: (target: string, lines: number) => Promise<string>,
): Promise<TerminalText> {
	if (
		!target ||
		target.length > 256 ||
		/[\r\n\0]/.test(target) ||
		!Number.isInteger(lines) ||
		lines < 1 ||
		lines > 1000
	)
		throw new Error("terminal_input_invalid");
	return boundedText(await capture(target, lines));
}
export async function searchTerminalOutput(
	output: TerminalText,
	pattern: string,
): Promise<TerminalText> {
	if (!pattern || pattern.length > 256)
		throw new Error("terminal_pattern_invalid");
	buildSafeRegex(pattern, "i", 256);
	const bounded = boundedText(output.text, output.truncated);
	// Static worker program; user text/pattern are data only. No inherited credentials.
	const worker = new Worker(
		'const {parentPort,workerData}=require("node:worker_threads");' +
			'const regex=new RegExp(workerData.pattern,"i");' +
			'parentPort.postMessage(workerData.text.split("\\n").flatMap((line,i)=>regex.test(line)?[(i+1)+": "+line]:[]).join("\\n"));',
		{
			eval: true,
			env: {},
			execArgv: [],
			workerData: { text: bounded.text, pattern },
		},
	);
	try {
		const text = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("terminal_search_timeout")),
				1000,
			);
			worker.once("message", (value) => {
				clearTimeout(timer);
				typeof value === "string"
					? resolve(value)
					: reject(new Error("terminal_search_failed"));
			});
			worker.once("error", () => {
				clearTimeout(timer);
				reject(new Error("terminal_search_failed"));
			});
			worker.once("exit", () => {
				clearTimeout(timer);
				reject(new Error("terminal_search_failed"));
			});
		});
		return boundedText(text, bounded.truncated);
	} finally {
		await worker.terminate();
	}
}

export interface TerminalSessionBinding {
	executionId: string;
	projectName: string;
	leadId: string | null;
	target: string;
	status: string;
}
export interface TerminalObservation {
	observedSessionId: string;
	alive: boolean;
}
export interface TerminalSessionCoreOptions {
	/** Only the existing Claude terminal MCP selects its backward-compatible contract. */
	legacyContract?: boolean;
	projectName: string;
	leadId: string;
	getSession(executionId: string): Promise<TerminalSessionBinding | undefined>;
	assertCurrent(): void | Promise<void>;
	inspect(target: string): Promise<TerminalObservation>;
	capture(target: string, lines: number): Promise<string>;
	send(
		target: string,
		text: string,
		beforeSend: () => Promise<void>,
	): Promise<void>;
}
/** Shared scope/observation/input policy for Claude MCP and the Codex broker.
 * Pane output is a status heuristic only; it never grants execution ownership. */
export function createTerminalSessionCore(options: TerminalSessionCoreOptions) {
	const session = async (executionId: string, write = false) => {
		await options.assertCurrent();
		const row = await options.getSession(executionId);
		await options.assertCurrent();
		if (
			!row ||
			row.executionId !== executionId ||
			row.projectName !== options.projectName ||
			(row.leadId !== options.leadId && (write || row.leadId !== null))
		)
			throw new Error("terminal_scope_denied");
		if (write && row.status !== "running")
			throw new Error("terminal_not_running");
		return { ...row };
	};
	const pin = (row: TerminalSessionBinding) => JSON.stringify(row);
	const unchanged = async (row: TerminalSessionBinding, write = false) => {
		if (pin(await session(row.executionId, write)) !== pin(row))
			throw new Error("terminal_session_changed");
	};
	const inspect = async (row: TerminalSessionBinding, write = false) => {
		const observed = await options.inspect(row.target);
		await unchanged(row, write);
		if (!observed.alive || !/^\$\d+:%\d+$/.test(observed.observedSessionId))
			throw new Error("terminal_unavailable");
		return observed.observedSessionId;
	};
	const observe = async (executionId: string, write = false) => {
		const row = await session(executionId, write),
			observedSessionId = await inspect(row, write);
		const output = await captureTerminalOutput(
			observedSessionId.split(":")[1]!,
			30,
			options.capture,
		);
		await unchanged(row, write);
		if ((await inspect(row, write)) !== observedSessionId)
			throw new Error("terminal_session_changed");
		const tail = output.text
			.split("\n")
			.filter((line) => line.trim())
			.slice(-15);
		return {
			row,
			observedSessionId,
			...detectTerminalStatus(
				options.legacyContract ? output.text : currentTerminalPrompt(tail),
			),
		};
	};
	const capture = async (executionId: string, lines: number) => {
		const row = await session(executionId),
			observed = await inspect(row);
		const result = await captureTerminalOutput(
			observed.split(":")[1]!,
			lines,
			options.capture,
		);
		await unchanged(row);
		if ((await inspect(row)) !== observed)
			throw new Error("terminal_session_changed");
		return result;
	};
	return {
		capture,
		search: async (executionId: string, lines: number, pattern: string) => {
			const row = await session(executionId);
			const result = await searchTerminalOutput(
				await capture(executionId, lines),
				pattern,
			);
			await unchanged(row);
			return result;
		},
		status: async (executionId: string) => {
			if (options.legacyContract) {
				const row = await session(executionId);
				const observation = await options.inspect(row.target);
				await unchanged(row);
				if (!observation.alive)
					return {
						status: "dead" as const,
						reason: "tmux session not running",
						observedSessionId: "",
					};
			}
			const result = await observe(executionId);
			return {
				status: result.status,
				reason: result.reason,
				observedSessionId: result.observedSessionId,
			};
		},
		input: async (
			executionId: string,
			expectedSessionId: string | undefined,
			text: string,
		) => {
			if (
				(!(options.legacyContract && expectedSessionId === undefined) &&
					(typeof expectedSessionId !== "string" ||
						!/^\$\d+:%\d+$/.test(expectedSessionId))) ||
				typeof text !== "string" ||
				!text ||
				text.length > 2000 ||
				/^\/(?:exit|quit)(?:\s|$)/i.test(text.trim()) ||
				/[\r\n]/.test(text) ||
				[...text].some(
					(char) =>
						(char.charCodeAt(0) < 32 && !"\n\r\t".includes(char)) ||
						char.charCodeAt(0) === 127,
				)
			)
				throw new Error("terminal_input_invalid");
			const initial = await observe(executionId, true);
			const pinnedSessionId = expectedSessionId ?? initial.observedSessionId;
			if (initial.observedSessionId !== pinnedSessionId)
				throw new Error("terminal_session_changed");
			if (!options.legacyContract && initial.status !== "waiting")
				throw new Error("terminal_not_waiting");
			const guard = async () => {
				await unchanged(initial.row, true);
				const latest = await observe(executionId, true);
				if (latest.observedSessionId !== pinnedSessionId)
					throw new Error("terminal_session_changed");
				if (!options.legacyContract && latest.status !== "waiting")
					throw new Error("terminal_not_waiting");
				await unchanged(initial.row, true);
			};
			await guard();
			await options.send(pinnedSessionId.split(":")[1]!, text, guard);
		},
	};
}
