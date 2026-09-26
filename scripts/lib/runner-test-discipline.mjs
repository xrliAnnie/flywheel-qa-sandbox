import { createHash } from "node:crypto";

const TEST_FILE_PATTERN = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const GLOB_PATTERN = /[*?{}[\]]/;
const SHELL_EXECUTABLES = new Set([
	"ash",
	"bash",
	"csh",
	"dash",
	"fish",
	"ksh",
	"sh",
	"tcsh",
	"zsh",
]);
// npm/pnpm commands that install and then run the package's whole `test` script.
const INSTALL_TEST_ALIASES = new Set([
	"install-test",
	"it",
	"install-ci-test",
	"cit",
	"clean-install-test",
	"sit",
]);
// Options accepted between `run`/`run-script` and the script name by
// npm, pnpm, yarn and bun. Unknown options keep the script name ambiguous.
const RUN_SCRIPT_OPTIONS = {
	noValue: new Set([
		"-q",
		"-r",
		"-s",
		"-ws",
		"--aggregate-output",
		"--bail",
		"--bun",
		"--color",
		"--foreground-scripts",
		"--if-present",
		"--ignore-scripts",
		"--include-workspace-root",
		"--json",
		"--no-bail",
		"--no-color",
		"--no-sort",
		"--no-workspaces",
		"--parallel",
		"--quiet",
		"--recursive",
		"--report-summary",
		"--reporter-hide-prefix",
		"--reverse",
		"--sequential",
		"--shell-mode",
		"--silent",
		"--sort",
		"--stream",
		"--use-stderr",
		"--verbose",
		"--workspace-root",
		"--workspaces",
	]),
	withValue: new Set([
		"-C",
		"-F",
		"-w",
		"--changed-files-ignore-pattern",
		"--cwd",
		"--dir",
		"--filter",
		"--filter-prod",
		"--loglevel",
		"--prefix",
		"--reporter",
		"--resume-from",
		"--script-shell",
		"--test-pattern",
		"--workspace",
		"--workspace-concurrency",
	]),
	attachedValue: ["-C", "-F", "-w"],
};
// `-w` differs by manager: npm's is `--workspace <name>`, pnpm's is
// `--workspace-root` (no value), and yarn/bun give it no shared meaning, so
// there it stays an unknown option and fails closed.
const RUN_SCRIPT_OPTIONS_WITHOUT_W = {
	noValue: RUN_SCRIPT_OPTIONS.noValue,
	withValue: new Set(
		[...RUN_SCRIPT_OPTIONS.withValue].filter((option) => option !== "-w"),
	),
	attachedValue: RUN_SCRIPT_OPTIONS.attachedValue.filter(
		(option) => option !== "-w",
	),
};
// Package-manager commands that forward the rest of the line to another
// command: pnpm recursive/multi/m, yarn workspace(s) (and berry foreach),
// npm/bun x, npm explore.
const FORWARDING_COMMANDS = new Set([
	"explore",
	"foreach",
	"m",
	"multi",
	"recursive",
	"workspace",
	"workspaces",
	"x",
]);
// A pnpm filter that selects many packages: a glob, a dependency/dependent
// selector (`pkg...`, `...pkg`) or an exclusion (`!pkg`, everything else).
const FAN_OUT_FILTER = /[*]|\.\.\.|^!/;

// Options that run the command in every (or many) workspace packages.
function isFanOutOption(item, next) {
	if (
		item === "-r" ||
		item === "--recursive" ||
		item === "--workspaces" ||
		item === "-ws"
	)
		return true;
	if (item === "--filter" || item === "-F")
		return FAN_OUT_FILTER.test(next ?? "");
	const attached = /^(?:--filter=|-F)(.+)$/.exec(item);
	return attached !== null && FAN_OUT_FILTER.test(attached[1]);
}

const PNPM_RUN_SCRIPT_OPTIONS = {
	...RUN_SCRIPT_OPTIONS_WITHOUT_W,
	noValue: new Set([...RUN_SCRIPT_OPTIONS.noValue, "-w"]),
};

// Options accepted between `run` and the script name, and (for global
// options such as `npm --prefix pkg test` or `pnpm -s test`) before the
// command word.
function packageManagerOptions(manager) {
	if (manager === "npm") return RUN_SCRIPT_OPTIONS;
	if (manager === "pnpm") return PNPM_RUN_SCRIPT_OPTIONS;
	return RUN_SCRIPT_OPTIONS_WITHOUT_W;
}
const OPTION_WITH_VALUE = new Set([
	"-c",
	"-t",
	"--config",
	"--dir",
	"--environment",
	"--exclude",
	"--maxWorkers",
	"--minWorkers",
	"--outputFile",
	"--pool",
	"--project",
	"--reporter",
	"--root",
	"--sequence",
	"--shard",
	"--testNamePattern",
	"--testTimeout",
]);

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function parseJsonLines(jsonl) {
	const records = [];
	let byteOffset = 0;
	for (const raw of jsonl.split(/\n/)) {
		const lineBytes = Buffer.byteLength(raw) + 1;
		if (raw.trim()) {
			try {
				records.push({ record: JSON.parse(raw), byteOffset });
			} catch (error) {
				records.push({
					record: null,
					byteOffset,
					parseError: error instanceof Error ? error.message : String(error),
				});
			}
		}
		byteOffset += lineBytes;
	}
	return records;
}

function decodeQuotedJsString(source, start) {
	const quote = source[start];
	if (!['"', "'", "`"].includes(quote)) return null;
	let escaped = false;
	for (let index = start + 1; index < source.length; index += 1) {
		const character = source[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character !== quote) continue;
		const literal = source.slice(start, index + 1);
		if (quote === "`") {
			if (literal.includes("${")) return null;
			return {
				value: literal
					.slice(1, -1)
					.replace(/\\`/g, "`")
					.replace(/\\n/g, "\n")
					.replace(/\\\\/g, "\\"),
				end: index + 1,
			};
		}
		if (quote === '"') {
			try {
				return { value: JSON.parse(literal), end: index + 1 };
			} catch {
				return null;
			}
		}
		return {
			value: literal
				.slice(1, -1)
				.replace(/\\'/g, "'")
				.replace(/\\n/g, "\n")
				.replace(/\\\\/g, "\\"),
			end: index + 1,
		};
	}
	return null;
}

function extractStaticExecCommands(source) {
	const commands = [];
	let hasDynamicCommand = false;
	const property = /(?:^|[{,]\s*)(?:cmd|["']cmd["'])\s*:\s*/g;
	for (const match of source.matchAll(property)) {
		const start = (match.index ?? 0) + match[0].length;
		const decoded = decodeQuotedJsString(source, start);
		if (decoded) commands.push(decoded.value);
		else hasDynamicCommand = true;
	}
	return { commands, hasDynamicCommand };
}

const CODEX_NON_SHELL_TOOLS = new Set([
	"apply_patch",
	"create_goal",
	"get_goal",
	"list_mcp_resource_templates",
	"list_mcp_resources",
	"read_mcp_resource",
	"update_goal",
	"view_image",
	"web__run",
]);

function codexCommandInputs(payload) {
	if (payload?.type === "custom_tool_call" && payload.name === "exec") {
		if (typeof payload.input !== "string") return [];
		const { commands, hasDynamicCommand } = extractStaticExecCommands(
			payload.input,
		);
		if (hasDynamicCommand) return [];
		if (commands.length) return commands;
		const invoked = [
			...payload.input.matchAll(/\btools\.([A-Za-z0-9_]+)\s*\(/g),
		].map((match) => match[1]);
		if (
			invoked.length > 0 &&
			invoked.every((name) => CODEX_NON_SHELL_TOOLS.has(name))
		)
			return null;
		return [];
	}
	if (payload?.type !== "function_call") return [];
	if (!new Set(["exec_command", "functions.exec_command"]).has(payload.name))
		return [];
	try {
		const args =
			typeof payload.arguments === "string"
				? JSON.parse(payload.arguments)
				: payload.arguments;
		return typeof args?.cmd === "string" ? [args.cmd] : [];
	} catch {
		return [];
	}
}

function textContent(value) {
	if (typeof value === "string") return value;
	if (Array.isArray(value))
		return value.map((item) => textContent(item)).join("\n");
	if (value && typeof value === "object") {
		if (typeof value.text === "string") return value.text;
		try {
			return JSON.stringify(value);
		} catch {
			return "";
		}
	}
	return "";
}

function structuredExitCode(value, seen = new Set()) {
	if (!value || typeof value !== "object" || seen.has(value)) return null;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = structuredExitCode(item, seen);
			if (found !== null) return found;
		}
		return null;
	}
	for (const key of ["exit_code", "exitCode"]) {
		if (Number.isInteger(value[key])) return value[key];
	}
	for (const child of Object.values(value)) {
		const found = structuredExitCode(child, seen);
		if (found !== null) return found;
	}
	return null;
}

function codexOutputSucceeded(output) {
	const exitCode = structuredExitCode(output);
	if (exitCode !== null) return exitCode === 0;
	const text = textContent(output);
	if (
		/\b(?:[1-9]\d*) failed\b/i.test(text) ||
		/\b(?:exit[_ ]?code\s*["'=:\s]+|Process exited with code |Script (?:failed|exited)(?: with)?(?: exit)? code )[1-9]\d*\b/i.test(
			text,
		)
	) {
		return false;
	}
	return (
		/\bexit[_ ]?code\s*["'=:\s]+0\b/i.test(text) ||
		/\bProcess exited with code 0\b/i.test(text) ||
		/\bTest Files\s+\d+ passed\b/i.test(text) ||
		/\bTests?\s+\d+ passed\b/i.test(text)
	);
}

function codexCommandExecutionEvents(rows, sourcePath, sourceHash) {
	const executions = new Map();
	for (const { record, byteOffset } of rows) {
		const payload = record?.payload;
		if (payload?.type !== "item_started" && payload?.type !== "item_completed")
			continue;
		const item = payload.item;
		if (item?.type !== "CommandExecution" || typeof item.id !== "string")
			continue;
		let command = item.command;
		if (Array.isArray(command)) {
			const shellOption = command.findLastIndex((value) =>
				new Set(["-c", "-lc"]).has(value),
			);
			command =
				shellOption >= 0 && typeof command[shellOption + 1] === "string"
					? command[shellOption + 1]
					: null;
		}
		const completed =
			payload.type === "item_completed" || item.status === "completed";
		executions.set(item.id, {
			toolCallId: item.id,
			...(typeof command === "string"
				? { command, parseStatus: "parsed" }
				: { parseStatus: "unknown" }),
			cwd:
				typeof item.cwd === "string"
					? item.cwd.replace(/^file:\/\//, "")
					: null,
			sessionId: payload.thread_id ?? null,
			completed,
			succeeded: completed && item.exit_code === 0,
			sourcePath,
			sourceHash,
			byteOffset,
		});
	}
	return [...executions.values()];
}

/**
 * Extract only executable shell tool calls from supported Claude and Codex
 * JSONL envelopes. Assistant prose and tool output text are never searched.
 */
export function extractCommandEvents(
	jsonl,
	{ sourcePath = "transcript.jsonl" } = {},
) {
	const rows = parseJsonLines(jsonl);
	const sourceHash = sha256(jsonl);
	const resolvedCodexCommands = codexCommandExecutionEvents(
		rows,
		sourcePath,
		sourceHash,
	);
	if (resolvedCodexCommands.length) {
		return [
			...rows
				.filter(({ parseError }) => parseError)
				.map(({ byteOffset }) => ({
					toolCallId: `parse-error:${byteOffset}`,
					parseStatus: "unknown",
					completed: false,
					sourcePath,
					sourceHash,
					byteOffset,
				})),
			...resolvedCodexCommands,
		];
	}
	const completed = new Set();
	const succeeded = new Set();
	for (const { record } of rows) {
		if (!record) continue;
		for (const content of record.message?.content ?? []) {
			if (content?.type === "tool_result" && content.tool_use_id) {
				completed.add(content.tool_use_id);
				if (
					content.is_error === false &&
					record.toolUseResult?.interrupted !== true
				) {
					succeeded.add(content.tool_use_id);
				}
			}
		}
		const payload = record.payload;
		if (
			payload?.type === "custom_tool_call_output" ||
			payload?.type === "function_call_output"
		) {
			if (payload.call_id) {
				completed.add(payload.call_id);
				if (codexOutputSucceeded(payload.output))
					succeeded.add(payload.call_id);
			}
		}
	}

	const events = [];
	for (const { record, byteOffset, parseError } of rows) {
		if (parseError) {
			events.push({
				toolCallId: `parse-error:${byteOffset}`,
				parseStatus: "unknown",
				completed: false,
				sourcePath,
				sourceHash,
				byteOffset,
			});
			continue;
		}
		if (!record) continue;
		for (const content of record.message?.content ?? []) {
			if (content?.type !== "tool_use" || content.name !== "Bash") continue;
			if (typeof content.input?.command !== "string") continue;
			const toolCallId = content.id;
			events.push({
				toolCallId,
				command: content.input.command,
				cwd: record.wireIngestContext?.[toolCallId]?.cwd ?? record.cwd ?? null,
				sessionId: record.sessionId ?? record.session_id ?? null,
				parseStatus: "parsed",
				completed: completed.has(toolCallId),
				succeeded: succeeded.has(toolCallId),
				sourcePath,
				sourceHash,
				byteOffset,
			});
		}

		const payload = record.payload;
		if (
			payload?.type !== "custom_tool_call" &&
			payload?.type !== "function_call"
		)
			continue;
		if (
			payload.name !== "exec" &&
			payload.name !== "exec_command" &&
			payload.name !== "functions.exec_command"
		)
			continue;
		const commands = codexCommandInputs(payload);
		if (commands === null) continue;
		const toolCallId = payload.call_id ?? payload.id ?? `codex:${byteOffset}`;
		if (commands.length === 0) {
			events.push({
				toolCallId,
				parseStatus: "unknown",
				completed: completed.has(toolCallId),
				succeeded: succeeded.has(toolCallId),
				sourcePath,
				sourceHash,
				byteOffset,
			});
			continue;
		}
		commands.forEach((command, index) => {
			events.push({
				toolCallId:
					commands.length === 1 ? toolCallId : `${toolCallId}#${index + 1}`,
				parentToolCallId: toolCallId,
				command,
				cwd: record.cwd ?? null,
				sessionId:
					record.sessionId ?? record.session_id ?? record.thread_id ?? null,
				parseStatus: "parsed",
				completed: completed.has(toolCallId),
				succeeded: succeeded.has(toolCallId),
				sourcePath,
				sourceHash,
				byteOffset,
			});
		});
	}
	return events;
}

function heredocOpeners(line) {
	const openers = [];
	const quotes = [null];
	let escaped = false;
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index];
		const quote = quotes.at(-1);
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (quote === '"' && character === "$" && line[index + 1] === "(") {
				quotes.push(null);
				index += 1;
			} else if (character === quote) quotes[quotes.length - 1] = null;
			continue;
		}
		if (["'", '"', "`"].includes(character)) {
			quotes[quotes.length - 1] = character;
			continue;
		}
		if (character === "$" && line[index + 1] === "(") {
			quotes.push(null);
			index += 1;
			continue;
		}
		if (character === "(" && quotes.length > 1) {
			quotes.push(null);
			continue;
		}
		if (character === ")" && quotes.length > 1) {
			quotes.pop();
			continue;
		}
		if (
			character === "#" &&
			(index === 0 || /\s|[;&|()]/.test(line[index - 1]))
		)
			break;
		if (
			character === "<" &&
			line[index + 1] === "<" &&
			line[index + 2] === "<"
		) {
			index += 2;
			continue;
		}
		if (character !== "<" || line[index + 1] !== "<") continue;
		let cursor = index + 2;
		const stripTabs = line[cursor] === "-";
		if (stripTabs) cursor += 1;
		while (/\s/.test(line[cursor] ?? "")) cursor += 1;
		let delimiter = "";
		const delimiterQuote = line[cursor];
		let quoted = false;
		if (delimiterQuote === "'" || delimiterQuote === '"') {
			quoted = true;
			cursor += 1;
			while (cursor < line.length && line[cursor] !== delimiterQuote) {
				delimiter += line[cursor];
				cursor += 1;
			}
		} else if (delimiterQuote === "\\") {
			quoted = true;
			cursor += 1;
			while (/[A-Za-z0-9_]/.test(line[cursor] ?? "")) {
				delimiter += line[cursor];
				cursor += 1;
			}
		} else {
			while (/[A-Za-z0-9_]/.test(line[cursor] ?? "")) {
				delimiter += line[cursor];
				cursor += 1;
			}
		}
		if (delimiter) openers.push({ delimiter, stripTabs, quoted });
		index = cursor;
	}
	return openers;
}

function stripHeredocBodies(command, { preserveDelimiters = false } = {}) {
	const output = [];
	const pending = [];
	const expandableBodies = [];
	for (const line of command.split("\n")) {
		if (pending.length) {
			const current = pending[0];
			const candidate = current.stripTabs ? line.replace(/^\t+/, "") : line;
			if (candidate === current.delimiter) {
				pending.shift();
				if (preserveDelimiters) output.push(line);
				if (!current.quoted) expandableBodies.push(current.body.join("\n"));
			} else current.body.push(candidate);
			continue;
		}
		output.push(line);
		pending.push(
			...heredocOpeners(line).map((opener) => ({ ...opener, body: [] })),
		);
	}
	for (const current of pending) {
		if (!current.quoted) expandableBodies.push(current.body.join("\n"));
	}
	return {
		command: output.join("\n"),
		expandableBodies,
		incomplete: pending.length > 0,
	};
}

function closingBacktick(command, start) {
	let escaped = false;
	for (let index = start + 1; index < command.length; index += 1) {
		const character = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "`") return index;
	}
	return -1;
}

function dollarCommandSubstitution(command, start) {
	const quotes = [null];
	let escaped = false;
	for (let index = start + 2; index < command.length; index += 1) {
		const character = command[index];
		const quote = quotes.at(-1);
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote === "'") {
			if (character === "'") quotes[quotes.length - 1] = null;
			continue;
		}
		if (character === "'" && quote === null) {
			quotes[quotes.length - 1] = "'";
			continue;
		}
		if (character === '"') {
			quotes[quotes.length - 1] = quote === '"' ? null : '"';
			continue;
		}
		if (character === "`") {
			const closing = closingBacktick(command, index);
			if (closing < 0) return null;
			index = closing;
			continue;
		}
		if (character === "$" && command[index + 1] === "(") {
			quotes.push(null);
			index += 1;
			continue;
		}
		if (quote === '"') continue;
		if (character === "(") {
			quotes.push(null);
			continue;
		}
		if (character !== ")") continue;
		quotes.pop();
		if (quotes.length === 0) {
			return { body: command.slice(start + 2, index), end: index };
		}
	}
	return null;
}

function shellCommandSubstitutions(
	command,
	{ quoteCharactersAreLiteral = false } = {},
) {
	const bodies = [];
	let quote = null;
	let escaped = false;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && (quoteCharactersAreLiteral || quote !== "'")) {
			escaped = true;
			continue;
		}
		if (!quoteCharactersAreLiteral && quote === "'") {
			if (character === "'") quote = null;
			continue;
		}
		if (!quoteCharactersAreLiteral && character === "'" && quote === null) {
			quote = "'";
			continue;
		}
		if (!quoteCharactersAreLiteral && character === '"') {
			quote = quote === '"' ? null : '"';
			continue;
		}
		if (character === "`") {
			const closing = closingBacktick(command, index);
			if (closing < 0) return { bodies, incomplete: true };
			bodies.push(command.slice(index + 1, closing));
			index = closing;
			continue;
		}
		if (character !== "$" || command[index + 1] !== "(") continue;
		const substitution = dollarCommandSubstitution(command, index);
		if (!substitution) return { bodies, incomplete: true };
		bodies.push(substitution.body);
		index = substitution.end;
	}
	return { bodies, incomplete: false };
}

function shellProcessSubstitutions(command) {
	const bodies = [];
	const output = [];
	let quote = null;
	let escaped = false;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (escaped) {
			output.push(character);
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			output.push(character);
			escaped = true;
			continue;
		}
		if (quote) {
			output.push(character);
			if (character === quote) quote = null;
			continue;
		}
		if (["'", '"', "`"].includes(character)) {
			quote = character;
			output.push(character);
			continue;
		}
		if (
			(character === "<" || character === ">") &&
			command[index + 1] === "("
		) {
			const substitution = dollarCommandSubstitution(command, index);
			if (!substitution) {
				return { command: output.join(""), bodies, incomplete: true };
			}
			bodies.push(substitution.body);
			output.push(" process-substitution ");
			index = substitution.end;
			continue;
		}
		output.push(character);
	}
	return { command: output.join(""), bodies, incomplete: false };
}

function shellWordSegments(command) {
	const stripped = stripHeredocBodies(command);
	command = stripped.command;
	const segments = [];
	let words = [];
	let word = "";
	let quote = null;
	let escaped = false;
	const push = () => {
		if (word) words.push(word);
		word = "";
	};
	const finish = () => {
		push();
		if (words.length) segments.push(words);
		words = [];
	};
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (escaped) {
			word += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = null;
			else word += character;
			continue;
		}
		if (["'", '"', "`"].includes(character)) {
			quote = character;
			continue;
		}
		if (
			character === "#" &&
			word === "" &&
			(index === 0 || /\s|[;&|()]/.test(command[index - 1]))
		) {
			while (index < command.length && command[index] !== "\n") index += 1;
			finish();
			continue;
		}
		if (
			character === "&" &&
			(word.endsWith(">") || word.endsWith("<") || command[index + 1] === ">")
		) {
			word += character;
			continue;
		}
		if (/[;&|()\n]/.test(character)) {
			finish();
			continue;
		}
		if (/\s/.test(character)) {
			push();
			continue;
		}
		word += character;
	}
	finish();
	return { segments, incompleteHeredoc: stripped.incomplete };
}

function removeShellLineContinuations(command) {
	let output = "";
	let quote = null;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (character === "\\" && quote !== "'") {
			if (command[index + 1] === "\n") {
				index += 1;
				continue;
			}
			if (command[index + 1] === "\r" && command[index + 2] === "\n") {
				index += 2;
				continue;
			}
			output += character;
			if (index + 1 < command.length) output += command[++index];
			continue;
		}
		if (quote) {
			output += character;
			if (character === quote) quote = null;
			continue;
		}
		if (["'", '"', "`"].includes(character)) quote = character;
		output += character;
	}
	return output;
}

function hasDynamicExecutable(command) {
	return shellWordSegments(command).segments.some((words) => {
		words = withoutRedirects(words);
		const resolved = resolveCommandPrefix(words);
		if (resolved.unknown) return true;
		return /[$`]/.test(words[resolved.index] ?? "");
	});
}

function withoutRedirects(words) {
	const result = [];
	const operator = "(?:<<<|<<|<|>>|>)";
	const duplicate = new RegExp(`^(?:\\d*|&)${operator}&(?:\\d+|-)$`);
	const standalone = new RegExp(`^(?:\\d*|&)${operator}$`);
	const attached = new RegExp(`^(?:\\d*|&)${operator}.+$`);
	for (let index = 0; index < words.length; index += 1) {
		const word = words[index];
		if (duplicate.test(word) || attached.test(word)) continue;
		if (standalone.test(word)) {
			index += 1;
			continue;
		}
		result.push(word);
	}
	return result;
}

function normalizePath(value) {
	return value.replace(/^\.\//, "").replace(/\\/g, "/");
}

function normalizeSelectionPath(value, packageRoot = "") {
	const normalized = normalizePath(value);
	const root = normalizePath(packageRoot).replace(/^\/+|\/+$/g, "");
	if (!root) return normalized;
	const marker = `${root}/`;
	const index = normalized.indexOf(marker);
	return index >= 0 ? normalized.slice(index + marker.length) : normalized;
}

function positionalVitestArgs(args) {
	const positionals = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (OPTION_WITH_VALUE.has(arg)) {
			index += 1;
			continue;
		}
		if (arg.startsWith("-")) continue;
		positionals.push(arg);
	}
	return positionals;
}

function commandBasename(value) {
	return value?.split("/").pop() ?? "";
}

function isLocalScriptPath(value) {
	return (
		/^(?:\.\.?\/|scripts\/)/.test(value ?? "") ||
		/\.(?:bash|cjs|js|mjs|sh|ts|zsh)$/.test(value ?? "")
	);
}

function consumeOptions(
	words,
	index,
	{ noValue = new Set(), withValue = new Set(), attachedValue = [] },
) {
	while (index < words.length) {
		const word = words[index];
		if (word === "--") return { index: index + 1 };
		if (word === "-" || !word.startsWith("-")) return { index };
		if (noValue.has(word)) {
			index += 1;
			continue;
		}
		if (withValue.has(word)) {
			if (index + 1 >= words.length) return { unknown: true };
			index += 2;
			continue;
		}
		if (
			[...withValue].some(
				(option) => option.startsWith("--") && word.startsWith(`${option}=`),
			) ||
			attachedValue.some(
				(option) => word.startsWith(option) && word.length > option.length,
			)
		) {
			index += 1;
			continue;
		}
		return { unknown: true };
	}
	return { index };
}

function resolveCommandPrefix(words) {
	let index = 0;
	for (let depth = 0; depth < 16; depth += 1) {
		while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index += 1;
		const command = commandBasename(words[index]);
		if (!command) return { index };
		if (command === "command") {
			index += 1;
			if (words[index] === "-v" || words[index] === "-V")
				return { index: words.length };
			if (words[index] === "--" || words[index] === "-p") index += 1;
			continue;
		}
		if (command === "env") {
			index += 1;
			while (index < words.length) {
				const word = words[index];
				if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
					index += 1;
					continue;
				}
				if (word === "--") {
					index += 1;
					break;
				}
				if (
					new Set(["-i", "--ignore-environment", "-0", "--null"]).has(word) ||
					word.startsWith("--unset=") ||
					word.startsWith("--chdir=")
				) {
					index += 1;
					continue;
				}
				if (new Set(["-u", "--unset", "-C", "--chdir"]).has(word)) {
					if (index + 1 >= words.length) return { unknown: true };
					index += 2;
					continue;
				}
				if (word.startsWith("-")) return { unknown: true };
				break;
			}
			continue;
		}
		if (command === "timeout" || command === "gtimeout") {
			const parsed = consumeOptions(words, index + 1, {
				noValue: new Set(["--foreground", "--preserve-status", "--verbose"]),
				withValue: new Set(["-k", "--kill-after", "-s", "--signal"]),
				attachedValue: ["-k", "-s"],
			});
			if (parsed.unknown) return parsed;
			index = parsed.index;
			if (!/^\d+(?:\.\d+)?[smhd]?$/.test(words[index] ?? ""))
				return { unknown: true };
			index += 1;
			continue;
		}
		if (command === "sudo") {
			const parsed = consumeOptions(words, index + 1, {
				noValue: new Set([
					"-A",
					"-b",
					"-E",
					"-e",
					"-H",
					"-K",
					"-k",
					"-l",
					"-n",
					"-P",
					"-S",
					"-V",
					"-v",
					"--askpass",
					"--background",
					"--edit",
					"--login",
					"--non-interactive",
					"--preserve-env",
					"--stdin",
					"--validate",
				]),
				withValue: new Set([
					"-C",
					"-D",
					"-g",
					"-h",
					"-p",
					"-R",
					"-r",
					"-T",
					"-t",
					"-U",
					"-u",
					"--chdir",
					"--close-from",
					"--command-timeout",
					"--group",
					"--host",
					"--other-user",
					"--prompt",
					"--role",
					"--type",
					"--user",
				]),
				attachedValue: [
					"-C",
					"-D",
					"-g",
					"-h",
					"-p",
					"-R",
					"-r",
					"-T",
					"-t",
					"-U",
					"-u",
				],
			});
			if (parsed.unknown) return parsed;
			index = parsed.index;
			continue;
		}
		if (command === "nice") {
			if (/^-\d+$/.test(words[index + 1] ?? "")) index += 2;
			else {
				const parsed = consumeOptions(words, index + 1, {
					withValue: new Set(["-n", "--adjustment"]),
					attachedValue: ["-n"],
				});
				if (parsed.unknown) return parsed;
				index = parsed.index;
			}
			continue;
		}
		if (command === "time") {
			const parsed = consumeOptions(words, index + 1, {
				noValue: new Set([
					"-a",
					"-p",
					"-v",
					"--append",
					"--portability",
					"--verbose",
				]),
				withValue: new Set(["-f", "--format", "-o", "--output"]),
				attachedValue: ["-f", "-o"],
			});
			if (parsed.unknown) return parsed;
			index = parsed.index;
			continue;
		}
		if (command === "stdbuf") {
			const parsed = consumeOptions(words, index + 1, {
				withValue: new Set([
					"-e",
					"-i",
					"-o",
					"--error",
					"--input",
					"--output",
				]),
				attachedValue: ["-e", "-i", "-o"],
			});
			if (parsed.unknown) return parsed;
			index = parsed.index;
			continue;
		}
		if (command === "xargs") {
			const parsed = consumeOptions(words, index + 1, {
				noValue: new Set([
					"-0",
					"-o",
					"-p",
					"-r",
					"-t",
					"-x",
					"--null",
					"--open-tty",
					"--interactive",
					"--no-run-if-empty",
					"--verbose",
					"--exit",
				]),
				withValue: new Set([
					"-a",
					"-d",
					"-E",
					"-I",
					"-L",
					"-n",
					"-P",
					"-s",
					"--arg-file",
					"--delimiter",
					"--eof",
					"--replace",
					"--max-lines",
					"--max-args",
					"--max-procs",
					"--max-chars",
				]),
				attachedValue: ["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s"],
			});
			if (parsed.unknown) return parsed;
			index = parsed.index;
			continue;
		}
		if (command === "caffeinate") {
			const parsed = consumeOptions(words, index + 1, {
				noValue: new Set(["-d", "-i", "-m", "-s", "-u"]),
				withValue: new Set(["-t", "-w"]),
				attachedValue: ["-t", "-w"],
			});
			if (parsed.unknown) return parsed;
			index = parsed.index;
			continue;
		}
		if (command === "script") {
			let cursor = index + 1;
			let nestedCommand = null;
			while (cursor < words.length && words[cursor].startsWith("-")) {
				const word = words[cursor];
				if (word === "--") {
					cursor += 1;
					break;
				}
				if (word === "-c" || word === "--command") {
					if (cursor + 1 >= words.length) return { unknown: true };
					nestedCommand = words[cursor + 1];
					cursor += 2;
					continue;
				}
				if (word.startsWith("--command=")) {
					nestedCommand = word.slice("--command=".length);
					cursor += 1;
					continue;
				}
				if (
					new Set(["-q", "-a", "-f", "--quiet", "--append", "--flush"]).has(
						word,
					)
				) {
					cursor += 1;
					continue;
				}
				return { unknown: true };
			}
			if (nestedCommand !== null) return { nestedCommand };
			if (cursor >= words.length) return { index: cursor };
			index = cursor + 1;
			continue;
		}
		return { index };
	}
	return { unknown: true };
}

function hasPotentialTestInvocation(words, executableIndex) {
	const tail = words.slice(executableIndex + 1);
	return tail.some((word) => {
		const command = commandBasename(word);
		return (
			command === "vitest" ||
			command === "jest" ||
			command === "test" ||
			command.startsWith("test:")
		);
	});
}

const CLEAR_NON_TEST_EXECUTABLES = new Set([
	"[",
	"[[",
	"cd",
	"cat",
	"cmp",
	"diff",
	"echo",
	"false",
	"find",
	"git",
	"grep",
	"head",
	"jq",
	"ls",
	"mkdir",
	"perl",
	"printf",
	"pwd",
	"rg",
	"sed",
	"tail",
	"test",
	"tr",
	"true",
	"type",
	"wc",
	"which",
]);

function isClearlyNonTestCommand(words, executableIndex) {
	const executableName = commandBasename(words[executableIndex]);
	const args = words.slice(executableIndex + 1);
	if (CLEAR_NON_TEST_EXECUTABLES.has(executableName)) return true;
	if (executableName === "biome" || executableName.startsWith("biome@"))
		return args[0] === "check";
	if (executableName === "tsc")
		return args.some(
			(argument) => argument === "--noEmit" || argument.startsWith("--noEmit="),
		);
	if (executableName === "eslint") return true;
	if (executableName === "prettier") return args.includes("--check");
	if (new Set(["pnpm", "npm", "yarn", "bun"]).has(executableName))
		return new Set([
			"add",
			"ci",
			"info",
			"install",
			"list",
			"outdated",
			"pack",
			"remove",
			"update",
			"view",
			"why",
		]).has(args[0]);
	return false;
}

function isTrustedNonTestScript(value, options) {
	const normalized = normalizePath(value ?? "");
	const trustedScripts = [
		"packages/flywheel-comm/dist/index.js",
		"packages/runner-test-discipline-fixture/verify.mjs",
		...(options.trustedNonTestScripts ?? []),
	];
	if (
		/^\$(?:FLYWHEEL_COMM_CLI|\{FLYWHEEL_COMM_CLI\})$/.test(normalized) &&
		trustedScripts.some((candidate) =>
			normalizePath(candidate).endsWith("packages/flywheel-comm/dist/index.js"),
		)
	)
		return true;
	return trustedScripts.some((candidate) => {
		const trusted = normalizePath(candidate);
		return normalized === trusted || normalized.endsWith(`/${trusted}`);
	});
}

function isStaticNonExecutingNodeEval(words, executableIndex) {
	const option = words[executableIndex + 1];
	if (!new Set(["-e", "--eval", "-p", "--print"]).has(option)) return false;
	const source = words[executableIndex + 2];
	return (
		typeof source === "string" &&
		!/\b(?:child_process|execFile|execSync|spawn|spawnSync|fork)\b|\bvitest\b|\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b/.test(
			source,
		)
	);
}

function analyzeDelegatedCommand(words, index, options, depth) {
	if (index >= words.length || depth > 8)
		return { kind: "unknown", reason: "unresolved_test_wrapper" };
	const delegatedWords = words.slice(index);
	delegatedWords[0] = stripDelegatedPackageVersion(delegatedWords[0]);
	const nested = analyzeSegment(delegatedWords, options, depth + 1);
	return nested.kind === "not_test"
		? nested.reason === "vitest_capability_probe" ||
			isClearlyNonTestCommand(delegatedWords, 0)
			? nested
			: { kind: "unknown", reason: "unresolved_test_wrapper" }
		: nested;
}

function stripDelegatedPackageVersion(value) {
	if (typeof value !== "string") return value;
	if (value.startsWith("@")) {
		const slash = value.indexOf("/");
		const version = value.lastIndexOf("@");
		return slash > 1 && version > slash ? value.slice(0, version) : value;
	}
	const version = value.lastIndexOf("@");
	return version > 0 && !value.slice(0, version).includes("/")
		? value.slice(0, version)
		: value;
}

function explicitTestFileAnalysis(files, options, reason) {
	const allowed = new Set(
		(options.allowedTestFiles ?? []).map((file) =>
			normalizeSelectionPath(file, options.packageRoot),
		),
	);
	const unrelated = allowed.size
		? files.filter((file) => !allowed.has(file))
		: [];
	return {
		kind: "allowed",
		reason,
		mode: "run",
		selectedFiles: files,
		...(unrelated.length
			? {
					advisory:
						files.length === 1
							? "unrelated_single_file"
							: "unrelated_test_files",
				}
			: {}),
	};
}

function analyzeSegment(words, options, depth = 0) {
	words = withoutRedirects(words);
	while (new Set(["if", "then", "elif", "else", "do"]).has(words[0]))
		words = words.slice(1);
	if (
		words.length === 0 ||
		(words.length === 1 && new Set(["fi", "done"]).has(words[0]))
	)
		return { kind: "not_test", reason: "no_test_command" };
	const resolved = resolveCommandPrefix(words);
	if (resolved.unknown)
		return { kind: "unknown", reason: "unresolved_test_wrapper" };
	if (resolved.nestedCommand !== undefined)
		return analyzeTestCommand(resolved.nestedCommand, options, depth + 1);
	const executableIndex = resolved.index;
	const executable = words[executableIndex];
	if (!executable) return { kind: "not_test", reason: "no_test_command" };
	const executableName = commandBasename(executable);
	if (executableName === "source" || executableName === ".")
		return { kind: "unknown", reason: "unresolved_test_wrapper" };
	if (executableName === "eval") {
		const nestedCommand = words.slice(executableIndex + 1).join(" ");
		if (!nestedCommand || /[$`]/.test(nestedCommand))
			return { kind: "unknown", reason: "unresolved_test_wrapper" };
		return analyzeTestCommand(nestedCommand, options, depth + 1);
	}
	if (executableName === "find") {
		const execIndex = words.findIndex(
			(word, index) =>
				index > executableIndex && new Set(["-exec", "-execdir"]).has(word),
		);
		if (execIndex >= 0) {
			const end = words.findIndex(
				(word, index) => index > execIndex && new Set([";", "+"]).has(word),
			);
			const delegated = words.slice(execIndex + 1, end < 0 ? undefined : end);
			if (!delegated.length || /[$`]/.test(delegated[0]))
				return { kind: "unknown", reason: "unresolved_test_wrapper" };
			return analyzeSegment(delegated, options, depth + 1);
		}
	}
	const managers = new Set(["pnpm", "npm", "yarn", "bun"]);
	let managerCommandIndex = -1;
	let managerOptionsUnknown = false;
	if (managers.has(executableName)) {
		const tail = words.slice(executableIndex + 1);
		const parsedManagerOptions = consumeOptions(
			words,
			executableIndex + 1,
			packageManagerOptions(executableName),
		);
		managerOptionsUnknown = parsedManagerOptions.unknown === true;
		if (!managerOptionsUnknown)
			managerCommandIndex = parsedManagerOptions.index;
		const managerCommand = words[managerCommandIndex];
		// Workspace fan-out (`pnpm -r`, `npm --workspaces`, a multi-package
		// filter) turns any test execution into a recursive test command,
		// including a single-file run delegated through exec or `run vitest`.
		const spanFansOut = (from, to) =>
			words
				.slice(from, to)
				.some((item, index, span) => isFanOutOption(item, span[index + 1]));
		let fanOut =
			!managerOptionsUnknown &&
			spanFansOut(executableIndex + 1, managerCommandIndex);
		const underFanOut = (result) =>
			fanOut && result.kind === "allowed"
				? { kind: "forbidden", reason: "recursive_test_script" }
				: result;
		// `npm x` and `bun x` are the exec/bunx aliases.
		if (
			managerCommand === "exec" ||
			managerCommand === "dlx" ||
			(managerCommand === "x" &&
				(executableName === "npm" || executableName === "bun"))
		) {
			const delegated = consumeOptions(words, managerCommandIndex + 1, {
				noValue: new Set(["-y", "--yes", "--silent"]),
				withValue: new Set(["-p", "--package"]),
				attachedValue: ["-p"],
			});
			if (delegated.unknown)
				return { kind: "unknown", reason: "unresolved_test_wrapper" };
			return underFanOut(
				analyzeDelegatedCommand(words, delegated.index, options, depth),
			);
		}
		const hasShortTestAliases =
			executableName === "pnpm" || executableName === "npm";
		const isTestAlias = (item) =>
			item === "test" ||
			(hasShortTestAliases && (item === "t" || item === "tst"));
		const isTestScript = (item) =>
			isTestAlias(item) || item.startsWith("test:");
		const isTestLike = (item) => isTestScript(item) || /test/i.test(item);
		const isForwardedTestLike = (item) =>
			isTestLike(item) || INSTALL_TEST_ALIASES.has(item);
		if (managerOptionsUnknown) {
			// An unrecognized global option may or may not consume the next word,
			// so the command position is unknown: `run`, `exec` and script names
			// cannot be located, and anything test-like or delegating stays
			// fail-closed.
			if (
				tail.some(
					(item) =>
						isTestLike(item) ||
						INSTALL_TEST_ALIASES.has(item) ||
						item === "exec" ||
						item === "dlx" ||
						item === "x",
				)
			)
				return { kind: "unknown", reason: "unresolved_test_wrapper" };
		} else if (managerCommand !== undefined) {
			const rest = words.slice(managerCommandIndex + 1);
			// Commands that forward the rest of the line to another package
			// manager command.
			if (
				executableName === "pnpm" &&
				new Set(["recursive", "multi", "m"]).has(managerCommand)
			)
				return analyzeSegment(["pnpm", "-r", ...rest], options, depth + 1);
			if (executableName === "yarn" && managerCommand === "workspace")
				return rest.length > 1
					? analyzeSegment(["yarn", ...rest.slice(1)], options, depth + 1)
					: { kind: "not_test", reason: "no_test_command" };
			if (executableName === "yarn" && managerCommand === "workspaces") {
				if (rest[0] === "run")
					return analyzeSegment(["yarn", "-r", ...rest], options, depth + 1);
				if (rest.some(isForwardedTestLike))
					return { kind: "unknown", reason: "unresolved_test_wrapper" };
			}
			// `npm explore <pkg> [--] <command>` runs the command in one package.
			if (executableName === "npm" && managerCommand === "explore") {
				const explored = rest.slice(1);
				const command = explored[0] === "--" ? explored.slice(1) : explored;
				return command.length
					? analyzeSegment(command, options, depth + 1)
					: { kind: "not_test", reason: "no_test_command" };
			}
			// Any other forwarding command (yarn workspaces foreach, or one
			// manager's forwarding word used with another manager) hides the
			// forwarded command, so anything test-like after it fails closed.
			if (
				(FORWARDING_COMMANDS.has(managerCommand) ||
					(executableName !== "npm" &&
						(managerCommand === "rum" || managerCommand === "urn"))) &&
				rest.some(isForwardedTestLike)
			)
				return { kind: "unknown", reason: "unresolved_test_wrapper" };
			// The package script this command runs, if any. `npm it` / `npm cit`
			// and friends run `install` followed by the whole `test` script;
			// pnpm/yarn/bun run a script named by the command word directly
			// (`pnpm test:unit`), while npm rejects unknown commands.
			let script;
			if (
				isTestAlias(managerCommand) ||
				(hasShortTestAliases && INSTALL_TEST_ALIASES.has(managerCommand))
			) {
				script = "test";
			} else if (
				managerCommand === "run" ||
				managerCommand === "run-script" ||
				(executableName === "npm" &&
					(managerCommand === "rum" || managerCommand === "urn"))
			) {
				// Run options sit between `run` and the script name
				// (`npm run -s test`, `pnpm run --filter pkg test`). An option this
				// parser does not know may or may not take a value, so the script
				// name is ambiguous and any test-looking word stays fail-closed.
				const runOptions = consumeOptions(
					words,
					managerCommandIndex + 1,
					packageManagerOptions(executableName),
				);
				if (runOptions.unknown) {
					if (rest.some(isTestLike))
						return { kind: "unknown", reason: "unresolved_test_wrapper" };
				} else {
					fanOut ||= spanFansOut(managerCommandIndex + 1, runOptions.index);
					// Without a script name, `run` only lists the scripts.
					script = words[runOptions.index];
					// yarn/bun (and pnpm's fallback) run a package binary when no
					// script has that name, so `run vitest` is analyzed as Vitest.
					if (commandBasename(script) === "vitest")
						return underFanOut(
							analyzeSegment(words.slice(runOptions.index), options, depth + 1),
						);
				}
			} else if (commandBasename(managerCommand) === "vitest") {
				// A `vitest` binary shortcut is classified by the Vitest analysis
				// below unless fan-out makes any run of it recursive.
				if (fanOut)
					return underFanOut(
						analyzeSegment(
							words.slice(managerCommandIndex),
							options,
							depth + 1,
						),
					);
			} else {
				// npm rejects unknown commands, but a test-looking one is still not
				// proven harmless.
				if (executableName !== "npm") script = managerCommand;
				else if (isTestLike(managerCommand))
					return { kind: "unknown", reason: "unresolved_test_wrapper" };
			}
			if (script !== undefined) {
				if (fanOut && isTestScript(script))
					return { kind: "forbidden", reason: "recursive_test_script" };
				if (isTestScript(script))
					return { kind: "forbidden", reason: "broad_test_script" };
				if (/test/i.test(script))
					return { kind: "unknown", reason: "unresolved_test_wrapper" };
			}
		}
	}
	if (executableName === "npx" || executableName === "bunx") {
		const delegated = consumeOptions(words, executableIndex + 1, {
			noValue: new Set([
				"-y",
				"--yes",
				"--ignore-existing",
				"--no-install",
				"--quiet",
			]),
			withValue: new Set(["-p", "--package"]),
			attachedValue: ["-p"],
		});
		if (delegated.unknown)
			return { kind: "unknown", reason: "unresolved_test_wrapper" };
		return analyzeDelegatedCommand(words, delegated.index, options, depth);
	}
	if (SHELL_EXECUTABLES.has(executableName)) {
		const tail = words.slice(executableIndex + 1);
		const isCommandOption = (word) =>
			word === "--command" || /^-[^-]*c[^-]*$/.test(word);
		let commandOption = -1;
		let firstOperand = tail.length;
		for (let index = 0; index < tail.length; index += 1) {
			const word = tail[index];
			if (word === "--" || !word.startsWith("-") || word === "-") {
				firstOperand = index;
				break;
			}
			if (isCommandOption(word)) {
				commandOption = index;
				break;
			}
		}
		if (commandOption >= 0) {
			const nestedCommand = tail[commandOption + 1];
			if (!nestedCommand)
				return { kind: "unknown", reason: "unresolved_test_wrapper" };
			const nested = analyzeTestCommand(nestedCommand, options, depth + 1);
			if (nested.kind === "not_test" && hasDynamicExecutable(nestedCommand))
				return { kind: "unknown", reason: "unresolved_test_wrapper" };
			return nested;
		}
		if (tail.slice(firstOperand + 1).some(isCommandOption))
			return { kind: "unknown", reason: "unresolved_test_wrapper" };
		if (isLocalScriptPath(tail[firstOperand]))
			return { kind: "unknown", reason: "unresolved_test_wrapper" };
		// Without -c, a shell reads executable input from a file or stdin. The
		// tokenizer intentionally removes redirects and heredoc bodies, so no
		// remaining argv can prove that this invocation is non-test code.
		return { kind: "unknown", reason: "unresolved_test_wrapper" };
	}
	const vitestModuleIndex = words.findIndex(
		(word, index) =>
			index === executableIndex + 1 &&
			executableName === "node" &&
			/(?:^|\/)vitest\/vitest\.mjs$/.test(word),
	);
	if (
		executableName === "node" &&
		vitestModuleIndex < 0 &&
		(isTrustedNonTestScript(words[executableIndex + 1], options) ||
			isStaticNonExecutingNodeEval(words, executableIndex))
	)
		return { kind: "not_test", reason: "no_test_command" };
	if (executableName === "node" && vitestModuleIndex < 0) {
		const script = normalizeSelectionPath(
			words[executableIndex + 1],
			options.packageRoot,
		);
		if (
			script &&
			!GLOB_PATTERN.test(script) &&
			!/[`$]/.test(script) &&
			TEST_FILE_PATTERN.test(script)
		) {
			return explicitTestFileAnalysis(
				[script],
				options,
				"node_explicit_test_files",
			);
		}
	}
	if (
		(executableName === "node" &&
			vitestModuleIndex < 0 &&
			isLocalScriptPath(words[executableIndex + 1])) ||
		executableName === "make" ||
		(isLocalScriptPath(executable) && executableName !== "vitest")
	)
		return { kind: "unknown", reason: "unresolved_test_wrapper" };
	if (
		(SHELL_EXECUTABLES.has(executableName) || executableName === "node") &&
		vitestModuleIndex < 0 &&
		words
			.slice(executableIndex + 1)
			.some((word) => /(?:^|[/_.-])test(?:s|ing)?(?:[/_.-]|$)/i.test(word))
	)
		return { kind: "unknown", reason: "unresolved_test_wrapper" };

	const vitestIndex = words.findIndex((word, index) => {
		if (index === vitestModuleIndex) return true;
		if (word !== "vitest" && !word.endsWith("/vitest")) return false;
		if (index === executableIndex) return true;
		if (new Set(["npx", "bunx"]).has(executableName)) return true;
		if (!managers.has(executableName)) return false;
		// `exec` delegation was analyzed above; only the parsed command word
		// can be a Vitest binary shortcut here.
		return index === managerCommandIndex;
	});
	if (vitestIndex < 0) {
		if (
			managerOptionsUnknown &&
			words.slice(executableIndex + 1).some((word) => word === "vitest")
		)
			return { kind: "unknown", reason: "unresolved_test_wrapper" };
		if (
			!isClearlyNonTestCommand(words, executableIndex) &&
			!managers.has(executableName) &&
			hasPotentialTestInvocation(words, executableIndex)
		)
			return { kind: "unknown", reason: "unresolved_test_wrapper" };
		return { kind: "not_test", reason: "no_test_command" };
	}
	let args = words.slice(vitestIndex + 1);
	if (args.some((arg) => arg === "--version" || arg === "--help"))
		return { kind: "not_test", reason: "vitest_capability_probe" };
	let mode = "run";
	if (args[0] === "related") {
		mode = "related";
		args = args.slice(1);
	} else if (args[0] === "run") {
		args = args.slice(1);
	}
	const positionals = positionalVitestArgs(args).map((file) =>
		normalizeSelectionPath(file, options.packageRoot),
	);
	if (mode === "related") {
		if (!args.includes("--run"))
			return { kind: "forbidden", reason: "related_missing_run" };
		if (positionals.length === 0)
			return { kind: "forbidden", reason: "related_empty_selection" };
		if (positionals.some((file) => /[$`]/.test(file)))
			return { kind: "unknown", reason: "dynamic_test_selection" };
		const changed = new Set(
			[
				...(options.changedFiles ?? []),
				...(options.allowedTestFiles ?? []),
			].map((file) => normalizeSelectionPath(file, options.packageRoot)),
		);
		if (positionals.some((file) => !changed.has(file)))
			return { kind: "unknown", reason: "related_input_not_declared" };
		return {
			kind: "allowed",
			reason: "vitest_related_changed_files",
			mode,
			selectedFiles: positionals,
		};
	}
	if (positionals.length === 0)
		return {
			kind: "forbidden",
			reason: "vitest_without_positive_file_selection",
		};
	if (positionals.some((file) => /[$`]/.test(file)))
		return { kind: "unknown", reason: "dynamic_test_selection" };
	if (
		positionals.some(
			(file) =>
				file === "." ||
				file.endsWith("/") ||
				GLOB_PATTERN.test(file) ||
				/(?:^|\/)(?:__tests__|tests?)$/.test(file),
		)
	)
		return { kind: "forbidden", reason: "directory_or_glob_selection" };
	if (positionals.some((file) => !TEST_FILE_PATTERN.test(file)))
		return { kind: "unknown", reason: "unrecognized_vitest_argument" };
	return explicitTestFileAnalysis(
		positionals,
		options,
		"vitest_explicit_test_files",
	);
}

function stripStaticArrayAssignments(command) {
	for (let count = 0; count < 16; count += 1) {
		const pattern =
			/(^|[;\n])\s*[A-Za-z_][A-Za-z0-9_]*=\(\s*([\s\S]*?)\)\s*(?=[;\n]|$)/g;
		let removed = false;
		for (const match of command.matchAll(pattern)) {
			const assignmentStart = match.index + match[1].length;
			if (
				!shellSyntaxIsUnquoted(command, assignmentStart) ||
				/\$\(|`/.test(match[2])
			)
				continue;
			command =
				command.slice(0, match.index) +
				match[1] +
				command.slice(match.index + match[0].length);
			removed = true;
			break;
		}
		if (!removed) return command;
	}
	return command;
}

function expandLeadingStaticScalarAssignments(command) {
	for (let count = 0; count < 16; count += 1) {
		const match = command.match(
			/^\s*([A-Za-z_][A-Za-z0-9_]*)=(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9_./@:+-]+))\s*;\s*/,
		);
		if (!match) return command;
		const [, variable, singleQuoted, doubleQuoted, bare] = match;
		const value = singleQuoted ?? doubleQuoted ?? bare ?? "";
		if (/[$`]/.test(value)) return command;
		const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const reference = new RegExp(
			`\\$\\{${escapedVariable}\\}|\\$${escapedVariable}\\b`,
			"g",
		);
		command = command.slice(match[0].length).replace(reference, value);
	}
	return command;
}

function expandDeclaredChangedFileDiscovery(command, options, depth) {
	const changedFiles = options.changedFiles ?? [];
	if (!changedFiles.length) return command;
	const assignment = /(?:^|;)\s*CHANGED=\$\(/g.exec(command);
	if (!assignment || !shellSyntaxIsUnquoted(command, assignment.index))
		return command;
	const dollar = command.indexOf("$(", assignment.index);
	const substitution = dollarCommandSubstitution(command, dollar);
	if (
		!substitution ||
		!/\bgit\s+(?:show|diff)\b/.test(substitution.body) ||
		!/(?:^|\s)--name-only(?:\s|$)/.test(substitution.body) ||
		analyzeTestCommand(substitution.body, options, depth + 1).kind !==
			"not_test"
	)
		return command;
	const assignmentStart =
		assignment.index + (assignment[0].startsWith(";") ? 1 : 0);
	const withoutAssignment =
		command.slice(0, assignmentStart) + command.slice(substitution.end + 1);
	return withoutAssignment.replace(
		/\$\{CHANGED\}|\$CHANGED\b/g,
		changedFiles.join(" "),
	);
}

function shellSyntaxIsUnquoted(command, target) {
	let quote = null;
	let escaped = false;
	for (let index = 0; index < target; index += 1) {
		const character = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = null;
			continue;
		}
		if (["'", '"', "`"].includes(character)) quote = character;
	}
	return quote === null;
}

function composedStaticForLoop(command) {
	const startPattern = /\bfor\s+[A-Za-z_][A-Za-z0-9_]*\s+in\s+/g;
	for (const candidate of command.matchAll(startPattern)) {
		const start = candidate.index;
		if (!shellSyntaxIsUnquoted(command, start)) continue;
		const prefix = command.slice(0, start);
		if (prefix.trim() && !/(?:;|&&|\|\||\n)\s*$/.test(prefix)) continue;
		const tail = command.slice(start);
		const loop = tail.match(
			/^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;]+);\s*do\s+([\s\S]*?)(?:;|\n)\s*done\b/,
		);
		if (!loop) continue;
		const suffix = tail.slice(loop[0].length);
		if (!prefix.trim() && !suffix.trim()) return null;
		return { prefix, loop: loop[0], suffix };
	}
	return null;
}

function combineCommandAnalyses(analyses) {
	const forbidden = analyses.find(({ kind }) => kind === "forbidden");
	if (forbidden) return forbidden;
	const unknown = analyses.find(({ kind }) => kind === "unknown");
	if (unknown) return unknown;
	const allowed = analyses.filter(({ kind }) => kind === "allowed");
	if (!allowed.length) return { kind: "not_test", reason: "no_test_command" };
	return {
		...allowed[0],
		selectedFiles: [
			...new Set(allowed.flatMap(({ selectedFiles = [] }) => selectedFiles)),
		],
	};
}

function analyzeTestCommand(command, options = {}, depth = 0) {
	if (depth > 8) return { kind: "unknown", reason: "unresolved_test_wrapper" };
	command = removeShellLineContinuations(command);
	command = stripStaticArrayAssignments(command);
	command = expandDeclaredChangedFileDiscovery(command, options, depth);
	command = expandLeadingStaticScalarAssignments(command);
	const composedLoop = composedStaticForLoop(command);
	if (composedLoop) {
		return combineCommandAnalyses(
			[composedLoop.prefix, composedLoop.loop, composedLoop.suffix]
				.filter((part) => part.trim())
				.map((part) => analyzeTestCommand(part, options, depth + 1)),
		);
	}
	const loop = command
		.trim()
		.match(
			/^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;]+);\s*do\s+([\s\S]*?)(?:;|\n)\s*done\s*$/,
		);
	if (loop) {
		const [, variable, rawItems, body] = loop;
		const itemSubstitutions = shellCommandSubstitutions(rawItems);
		const itemAnalyses = itemSubstitutions.bodies.map((substitution) => {
			const nested = analyzeTestCommand(substitution, options, depth + 1);
			return nested.kind === "not_test" && hasDynamicExecutable(substitution)
				? { kind: "unknown", reason: "unresolved_test_wrapper" }
				: nested;
		});
		const itemForbidden = itemAnalyses.find(({ kind }) => kind === "forbidden");
		if (itemForbidden) return itemForbidden;
		if (
			itemSubstitutions.incomplete ||
			itemAnalyses.some(({ kind }) => kind === "unknown")
		)
			return { kind: "unknown", reason: "unresolved_test_wrapper" };
		const parsedItems = shellWordSegments(rawItems);
		const items = parsedItems.segments.flat();
		const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const reference = new RegExp(
			`\\$\\{${escapedVariable}\\}|\\$${escapedVariable}\\b`,
			"g",
		);
		if (
			parsedItems.incompleteHeredoc ||
			items.length === 0 ||
			items.some(
				(item) =>
					!/^[A-Za-z0-9_./@+-]+$/.test(item) || /[$`*?{}[\]]/.test(item),
			)
		) {
			const dynamicBody = analyzeTestCommand(
				body.replace(reference, "dynamic-value"),
				options,
				depth + 1,
			);
			if (dynamicBody.kind !== "not_test")
				return { kind: "unknown", reason: "unresolved_test_wrapper" };
			return itemAnalyses.find(({ kind }) => kind === "allowed") ?? dynamicBody;
		}
		const analyses = items.map((item) =>
			analyzeTestCommand(body.replace(reference, item), options, depth + 1),
		);
		const forbidden = analyses.find(({ kind }) => kind === "forbidden");
		if (forbidden) return forbidden;
		const unknown = analyses.find(({ kind }) => kind === "unknown");
		if (unknown) return unknown;
		const allowed = analyses.filter(({ kind }) => kind === "allowed");
		if (!allowed.length) return { kind: "not_test", reason: "no_test_command" };
		return {
			kind: "allowed",
			reason: allowed[0].reason,
			mode: allowed[0].mode,
			selectedFiles: [
				...new Set(allowed.flatMap(({ selectedFiles = [] }) => selectedFiles)),
			],
		};
	}
	const processSubstitutions = shellProcessSubstitutions(command);
	const parsed = shellWordSegments(processSubstitutions.command);
	const heredocs = stripHeredocBodies(processSubstitutions.command, {
		preserveDelimiters: true,
	});
	const substitutionScans = [
		shellCommandSubstitutions(heredocs.command),
		...heredocs.expandableBodies.map((body) =>
			shellCommandSubstitutions(body, { quoteCharactersAreLiteral: true }),
		),
	];
	const substitutions = {
		bodies: substitutionScans.flatMap(({ bodies }) => bodies),
		incomplete: substitutionScans.some(({ incomplete }) => incomplete),
	};
	const analyses = [
		...parsed.segments.map((words) => analyzeSegment(words, options, depth)),
		...processSubstitutions.bodies.map((body) =>
			analyzeTestCommand(body, options, depth + 1),
		),
		...substitutions.bodies.map((body) => {
			const nested = analyzeTestCommand(body, options, depth + 1);
			return nested.kind === "not_test" && hasDynamicExecutable(body)
				? { kind: "unknown", reason: "unresolved_test_wrapper" }
				: nested;
		}),
	];
	const forbidden = analyses.find(({ kind }) => kind === "forbidden");
	if (forbidden) return forbidden;
	if (parsed.incompleteHeredoc)
		return { kind: "unknown", reason: "unterminated_heredoc" };
	if (substitutions.incomplete)
		return { kind: "unknown", reason: "unresolved_test_wrapper" };
	if (processSubstitutions.incomplete)
		return { kind: "unknown", reason: "unresolved_test_wrapper" };
	return (
		analyses.find(({ kind }) => kind === "unknown") ??
		analyses.find(({ kind }) => kind === "allowed") ?? {
			kind: "not_test",
			reason: "no_test_command",
		}
	);
}

export function classifyTestCommand(command, options = {}) {
	const { kind, reason, advisory } = analyzeTestCommand(command, options);
	return { kind, reason, ...(advisory ? { advisory } : {}) };
}

function missingIdentityFields(manifest) {
	const required = [
		"schemaVersion",
		"caseId",
		"attemptId",
		"candidateHead",
		"promptHash",
		"policyHash",
		"skillInventoryHash",
		"backend",
		"resolvedModel",
		"runId",
		"executionId",
		"nodeId",
		"role",
	];
	return required.filter(
		(field) => manifest?.[field] === undefined || manifest[field] === "",
	);
}

/**
 * Deterministic, fail-closed verdict. A proven forbidden execution is a FAIL
 * only after the evidence identity binds it to the requested matrix cell;
 * otherwise incomplete/unknown evidence cannot pass or be misattributed.
 */
export function evaluateRunnerTestDiscipline(evidence) {
	const findings = [];
	const advisories = [];
	const commands = Array.isArray(evidence?.commands) ? evidence.commands : [];
	const sessions = Array.isArray(evidence?.sessions) ? evidence.sessions : [];
	const selection = evidence?.selection ?? {};
	const analyses = [];
	for (const event of commands) {
		if (event.parseStatus === "unknown" || typeof event.command !== "string") {
			findings.push({
				code: "command_unparseable",
				detail: `${event.toolCallId ?? "unknown"}: command input is not statically parseable`,
			});
			continue;
		}
		const analysis = analyzeTestCommand(event.command, selection);
		analyses.push({ event, analysis });
		if (analysis.kind === "allowed" && analysis.advisory) {
			const allowed = new Set(
				(selection.allowedTestFiles ?? []).map((file) =>
					normalizeSelectionPath(file, selection.packageRoot),
				),
			);
			const unrelated = (analysis.selectedFiles ?? []).filter(
				(file) =>
					!allowed.has(normalizeSelectionPath(file, selection.packageRoot)),
			);
			advisories.push({
				code: analysis.advisory,
				detail: `${event.toolCallId ?? "unknown"}: ${unrelated.join(",")}`,
			});
		}
		if (analysis.kind === "forbidden") {
			findings.push({
				code: "forbidden_test_command",
				detail: `${event.toolCallId ?? "unknown"}: ${analysis.reason}`,
			});
		}
		if (analysis.kind === "unknown") {
			findings.push({
				code: "command_semantics_unknown",
				detail: `${event.toolCallId ?? "unknown"}: ${analysis.reason}`,
			});
		}
	}
	for (const session of sessions) {
		if (
			session?.delegated === true &&
			session.transcriptComplete === true &&
			!(session.policyMarkers >= 1)
		) {
			findings.push({
				code: "delegated_policy_missing",
				detail: `${session.id ?? "unknown"}: delegated transcript lacks the marked local-test policy`,
			});
		}
	}
	const missing = missingIdentityFields(evidence?.manifest);
	if (missing.length)
		findings.push({
			code: "manifest_identity_missing",
			detail: missing.join(","),
		});
	for (const [field, detail] of [
		[
			"candidateIdentityVerified",
			"live room HEAD/health identity was not verified",
		],
		[
			"promptMatchesCandidate",
			"injected role prompt does not match the candidate",
		],
		["backendMatchesRequest", "actual carrier does not match the matrix cell"],
		["modelMatchesRequest", "actual model does not match the matrix cell"],
	]) {
		if (evidence?.manifest?.[field] === false)
			findings.push({ code: "identity_mismatch", detail });
	}
	const hardFailure = findings.some(({ code }) =>
		new Set(["forbidden_test_command", "delegated_policy_missing"]).has(code),
	);
	const identityInvalid = findings.some(({ code }) =>
		new Set(["manifest_identity_missing", "identity_mismatch"]).has(code),
	);
	if (hardFailure && !identityInvalid)
		return {
			verdict: "FAIL",
			findings,
			...(advisories.length ? { advisories } : {}),
		};
	if (evidence?.manifest?.completed !== true)
		findings.push({
			code: "run_not_completed",
			detail: "role completion receipt is absent",
		});
	if (!commands.length)
		findings.push({ code: "commands_missing", detail: "no command events" });
	if (commands.some((event) => event.completed !== true))
		findings.push({
			code: "tool_result_missing",
			detail: "one or more command calls lack a paired result",
		});
	if (
		!Array.isArray(evidence?.sessions) ||
		!evidence.sessions.length ||
		evidence.sessions.some(
			(session) =>
				session.transcriptComplete !== true ||
				session.completionReceipt !== true,
		)
	)
		findings.push({
			code: "session_coverage_incomplete",
			detail: "all owned sessions need transcript and completion coverage",
		});
	if (
		evidence?.fixtureResult?.passed !== true ||
		!(evidence.fixtureResult.testsRun > 0) ||
		evidence.fixtureResult.changedFilesMatch !== true
	)
		findings.push({
			code: "fixture_result_incomplete",
			detail: "fixture check must pass with non-zero tests and exact changes",
		});

	const explicitSelections = new Set(
		analyses
			.filter(
				({ analysis, event }) =>
					analysis.reason === "vitest_explicit_test_files" &&
					event.succeeded === true,
			)
			.flatMap(({ analysis }) => analysis.selectedFiles ?? [])
			.map((file) => normalizeSelectionPath(file, selection.packageRoot)),
	);
	for (const literalMatch of selection.literalMatches ?? []) {
		if (
			!explicitSelections.has(
				normalizeSelectionPath(literalMatch, selection.packageRoot),
			)
		)
			findings.push({
				code: "literal_test_not_executed",
				detail: normalizeSelectionPath(literalMatch, selection.packageRoot),
			});
	}
	const changedTs = (selection.changedFiles ?? []).filter((file) =>
		/\.[cm]?[jt]sx?$/.test(file),
	);
	if (
		changedTs.length &&
		!analyses.some(
			({ analysis, event }) =>
				analysis.reason === "vitest_related_changed_files" &&
				event.succeeded === true,
		)
	)
		findings.push({
			code: "related_not_executed",
			detail: changedTs.join(","),
		});

	return {
		verdict: findings.length ? "INCONCLUSIVE" : "PASS",
		findings,
		...(advisories.length ? { advisories } : {}),
	};
}
