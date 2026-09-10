import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// This is a constrained lexical runbook protocol, not a shell parser or execution proof.
function significant(command) {
	const lines = [];
	let heredoc;
	for (const raw of command.replace(/\\\n/g, " ").split("\n")) {
		const line = raw.trim();
		if (heredoc) {
			if (line === heredoc) heredoc = undefined;
			continue;
		}
		if (!line || line.startsWith("#")) continue;
		lines.push(line);
		const match = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
		if (match) heredoc = match[1];
	}
	if (heredoc) throw new Error("unterminated heredoc");
	return lines;
}
const mutation = (line) =>
	/test-(?:deploy|cycle-bridge|teardown)\.sh\b|\bslot_runner\b.*\b(?:gate|complete|terminate|qa-result|operator-rework)\b|\bcurl\b.*(?:--data|(?:^|\s)-d(?:\s|$)|(?:-X|--request)\s+['"]?(?:POST|PUT|DELETE|PATCH))|\bgh\s+pr\s+(?:create|close|merge)\b|\bgit\b.*\b(?:push|commit)\b|\btmux\b.*\b(?:new-window|kill-window|new-session|kill-session)\b|^(?:mv|rm)\s/.test(
		line,
	);
function validateProtocol(lines, metadata) {
	for (const key of ["intent", "adopt", "effect"])
		if (
			typeof metadata[key] !== "string" ||
			!metadata[key] ||
			metadata[key].includes("\n")
		)
			throw new Error("effect metadata incomplete");
	if (
		!/\b(?:intent_file|manifest intent)\b/.test(metadata.intent) ||
		!/\b(?:adopt_db|adopt_file|manifest adopt)\b/.test(metadata.adopt)
	)
		throw new Error("effect protocol command invalid");
	const positions = ["intent", "adopt", "effect"].map((k) => {
		const matches = lines.flatMap((line, i) =>
			line === metadata[k] ? [i] : [],
		);
		if (matches.length !== 1)
			throw new Error("effect command missing or ambiguous");
		return matches[0];
	});
	const action = metadata.action ?? "ADOPT_ACTION";
	if (!/^[A-Z_][A-Z0-9_]*$/.test(action))
		throw new Error("action variable invalid");
	if (
		lines
			.slice(positions[1] + 1, positions[2])
			.some((line) => new RegExp(`(?:^|\\s)${action}=`).test(line))
	)
		throw new Error("action overwritten after adoption");
	const guards = [
		`if [ "$${action}" = execute ]; then`,
		`if test "$${action}" = execute; then`,
	];
	const guard = lines.findIndex(
		(line, i) => i > positions[1] && guards.includes(line),
	);
	let end = -1,
		depth = 0;
	for (let i = guard; i >= 0 && i < lines.length; i++) {
		if (/^if\b/.test(lines[i])) depth++;
		if (lines[i] === "fi" && --depth === 0) {
			end = i;
			break;
		}
	}
	if (
		!(
			positions[0] < positions[1] &&
			positions[1] < guard &&
			guard < positions[2] &&
			positions[2] < end
		)
	)
		throw new Error("intent adopt execute guard ordering invalid");
	if (
		lines
			.slice(guard + 1, positions[2])
			.some((line) => /^if\b|^else\b|^elif\b/.test(line)) ||
		lines
			.slice(positions[2] + 1, end)
			.some((line) => /^else\b|^elif\b/.test(line))
	)
		throw new Error("unsupported nested effect guard");
	if (lines.some((line, i) => mutation(line) && i !== positions[2]))
		throw new Error("unregistered effect command");
}
function checkPaths(lines, bindings) {
	const absolute = (value) =>
		value.startsWith("/") ||
		(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(value)?.[1] &&
			bindings.has(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(value)[1]));
	for (const line of lines) {
		if (/<[A-Za-z][A-Za-z0-9_ -]*>/.test(line))
			throw new Error("unresolved placeholder");
		for (const [, name, _quoted, value] of line.matchAll(
			/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(['"]?)([^\s'"]+)\2/g,
		)) {
			if (absolute(value)) bindings.add(name);
			else bindings.delete(name);
		}
		for (const match of line.matchAll(
			/\b(?:node|bash|sh|python3|python)\s+("[^"\n]*"|'[^'\n]*'|[^\s;]+)/g,
		)) {
			const invocation = line.slice(match.index);
			if (
				/^node\s+-e\s+(?:"(?:[^"\\]|\\.)*"|'[^']*')(?=\s|$|[);])/.test(
					invocation,
				) ||
				/^node\s+--input-type=module\s+-(?=\s|$)/.test(invocation)
			)
				continue;
			const path = match[1].replace(/^['"]|['"]$/g, "");
			if (path === "-") continue;
			if (path.startsWith("-") || !absolute(path))
				throw new Error("relative or unresolved tool path");
		}
	}
}
function validateSemantics(sections, commands) {
	const ids = new Set(),
		bindings = new Set(),
		validatedFunctions = new Map(),
		effectFunctions = new Set(),
		allFunctions = new Map();
	for (let index = 0; index < sections.length; index++) {
		const rows = [
			...sections[index].matchAll(/^<!-- fly2456-step (.+) -->$/gm),
		];
		if (rows.length !== 1)
			throw new Error("step metadata missing or ambiguous");
		const meta = JSON.parse(rows[0][1]);
		if (
			typeof meta.id !== "string" ||
			!meta.id ||
			ids.has(meta.id) ||
			!["setup", "read", "effect"].includes(meta.kind)
		)
			throw new Error("step metadata invalid");
		ids.add(meta.id);
		const lines = significant(commands[index]),
			runtime = [],
			functions = new Map();
		for (let i = 0; i < lines.length; i++) {
			const name = /^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{$/.exec(lines[i]);
			if (!name) {
				runtime.push(lines[i]);
				continue;
			}
			if (meta.kind !== "setup") throw new Error("functions require setup");
			const body = [];
			while (++i < lines.length && lines[i] !== "}") body.push(lines[i]);
			if (
				i === lines.length ||
				functions.has(name[1]) ||
				validatedFunctions.has(name[1])
			)
				throw new Error("function definition invalid");
			functions.set(name[1], body);
		}
		for (const [name, body] of functions) allFunctions.set(name, body);
		let changed;
		do {
			changed = false;
			for (const [name, body] of allFunctions)
				if (
					!effectFunctions.has(name) &&
					(body.some(mutation) ||
						body.some((line) => effectFunctions.has(line.split(/\s+/)[0])))
				) {
					effectFunctions.add(name);
					changed = true;
				}
		} while (changed);
		checkPaths(runtime, bindings);
		for (const body of functions.values()) checkPaths(body, new Set(bindings));
		if (meta.functions !== undefined && !Array.isArray(meta.functions))
			throw new Error("function metadata invalid");
		for (const fn of meta.functions ?? []) {
			const body = functions.get(fn.name);
			if (!body) throw new Error("annotated function missing");
			validateProtocol(body, fn);
			validatedFunctions.set(fn.name, body);
		}
		if (meta.kind === "effect") {
			if (meta.call !== undefined) {
				if (
					typeof meta.call !== "string" ||
					runtime.filter((line) => line === meta.call).length !== 1 ||
					!validatedFunctions.has(meta.call.split(/\s+/)[0]) ||
					runtime.some(
						(line) =>
							mutation(line) ||
							(line !== meta.call && effectFunctions.has(line.split(/\s+/)[0])),
					)
				)
					throw new Error("unvalidated effect function call");
			} else validateProtocol(runtime, meta);
		} else if (
			runtime.some(mutation) ||
			runtime.some((line) => effectFunctions.has(line.split(/\s+/)[0]))
		)
			throw new Error("runtime effect mislabeled setup/read");
	}
	return {
		protocol: "fly2456-step-v1",
		limitation:
			"Lexical metadata/path/order checks plus scanner receipt; not a shell parser or execution safety proof.",
	};
}
export function dryRun({ runbookPath, scannerPath, receiptPath }) {
	try {
		let receipt;
		try {
			receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
		} catch (error) {
			if (error.code === "ENOENT")
				return { status: "not-run", reason: "guard receipt missing" };
			throw error;
		}
		const raw = readFileSync(runbookPath),
			commands = [
				...raw.toString("utf8").matchAll(/^```bash\n([\s\S]*?)\n```$/gm),
			].map((match) => match[1]);
		const document = raw.toString("utf8");
		const fences = document.match(/^[ \t]*(?:`{3,}|~{3,}).*$/gm) ?? [];
		if (
			fences.length !== commands.length * 2 ||
			fences.some(
				(line, index) => line !== (index % 2 === 0 ? "```bash" : "```"),
			)
		)
			throw new Error("unsupported or incomplete command fence");
		const sections = document
			.split(/^## /m)
			.filter((section) => section.includes("```bash"));
		if (
			sections.length !== commands.length ||
			sections.some(
				(section) =>
					!["命令", "期望输出:", "落盘:", "停手:"].every((label) =>
						section.includes(label),
					),
			)
		)
			throw new Error("runbook step incomplete");
		if (
			!commands.length ||
			receipt.schemaVersion !== 1 ||
			receipt.inputsDigest !== hash(raw) ||
			receipt.scannerSha256 !== hash(readFileSync(scannerPath)) ||
			!Array.isArray(receipt.commands) ||
			receipt.commands.length !== commands.length
		)
			throw new Error("guard receipt inputs mismatch");
		for (const [index, command] of commands.entries()) {
			const row = receipt.commands[index];
			if (!row || row.sha256 !== hash(command) || row.hit !== null)
				throw new Error("guard command mismatch or denied");
		}
		const semantics = validateSemantics(sections, commands);
		return {
			status: "pass",
			semantics,
			commands: commands.length,
			inputsDigest: receipt.inputsDigest,
			scannerSha256: receipt.scannerSha256,
		};
	} catch (error) {
		return { status: "fail", reason: error.message };
	}
}
