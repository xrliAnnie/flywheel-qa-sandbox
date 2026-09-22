import { LEAD_MODEL_ENV_NAMES } from "../../lead-capabilities/model-env.js";
import { buildTuiCommand, type TuiWindowSpec } from "./tui-window.js";

export type TuiBindingGrammar = "legacy" | "capability-v2";

export type AgentTuiBindingExpectation =
	| { kind: "canonical"; spec: TuiWindowSpec }
	| ({ kind: "legacy" } & LegacyTuiBindingExpectation)
	| ({ kind: "capability-v2" } & CapabilityTuiBindingExpectation);

export interface LegacyTuiBindingExpectation {
	codexHome: string;
	cwd: string;
	threadId: string;
	codexBin: string | null;
	remoteSocket: string;
}

export interface CapabilityTuiBindingExpectation {
	codexHome: string;
	cwd: string;
	threadId: string;
	codexBin: string;
	projectName: string;
	leadId: string;
	remoteSocket: string;
}

export type AgentTuiBindingVerdict =
	| { ok: true; grammar: TuiBindingGrammar; threadId: string }
	| { ok: false; reason: "unsafe_command" | "identity_mismatch" };

class UnsafeCommandError extends Error {}

/**
 * Decode shell words without invoking a shell. This intentionally implements
 * only the quoting emitted by buildTuiCommand/tmux and rejects operators,
 * redirects, substitutions, newlines, and malformed quoting.
 */
function tokenizeShellWords(raw: string): string[] {
	if (!raw || raw.includes("\0") || /[\r\n]/.test(raw))
		throw new UnsafeCommandError();
	const words: string[] = [];
	let word = "";
	let started = false;
	let quote: "single" | "double" | null = null;
	for (let index = 0; index < raw.length; index++) {
		const char = raw[index]!;
		if (quote === "single") {
			if (char === "'") quote = null;
			else word += char;
			continue;
		}
		if (quote === "double") {
			if (char === '"') {
				quote = null;
				continue;
			}
			if (char === "\\") {
				const next = raw[++index];
				if (next === undefined) throw new UnsafeCommandError();
				word += next;
				continue;
			}
			if (char === "`" || char === "$") throw new UnsafeCommandError();
			word += char;
			continue;
		}
		if (/\s/.test(char)) {
			if (started) {
				words.push(word);
				word = "";
				started = false;
			}
			continue;
		}
		started = true;
		if (char === "'") {
			quote = "single";
			continue;
		}
		if (char === '"') {
			quote = "double";
			continue;
		}
		if (char === "\\") {
			const next = raw[++index];
			if (next === undefined) throw new UnsafeCommandError();
			word += next;
			continue;
		}
		if (/[;|&<>`$]/.test(char)) throw new UnsafeCommandError();
		word += char;
	}
	if (quote !== null) throw new UnsafeCommandError();
	if (started) words.push(word);
	if (words.length === 0) throw new UnsafeCommandError();
	return words;
}

function decodeObserved(raw: string): string[] {
	// tmux commonly renders pane_start_command as a JSON-compatible quoted
	// string. Treat that outer layer as serialization, not as another shell.
	if (raw.startsWith('"') && raw.endsWith('"')) {
		try {
			const decoded: unknown = JSON.parse(raw);
			if (typeof decoded !== "string" || decoded === raw)
				throw new UnsafeCommandError();
			return tokenizeShellWords(decoded);
		} catch (error) {
			if (error instanceof UnsafeCommandError) throw error;
			throw new UnsafeCommandError();
		}
	}
	const first = tokenizeShellWords(raw);
	// tmux may render pane_start_command as one quoted command argument. Decode
	// exactly one such wrapper, never recursively.
	if (first.length !== 1 || first[0] === raw) return first;
	const second = tokenizeShellWords(first[0]!);
	if (second.length === 1 && second[0] !== first[0])
		throw new UnsafeCommandError();
	return second;
}

function sameWords(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		left.every((word, index) => word === right[index])
	);
}

export function legacyTuiBindingExpectation(input: {
	codexHome: string;
	cwd: string;
	threadId: string;
	codexBin?: string | false;
}): LegacyTuiBindingExpectation {
	return {
		codexHome: input.codexHome,
		cwd: input.cwd,
		threadId: input.threadId,
		codexBin: input.codexBin === false ? null : (input.codexBin ?? "codex"),
		remoteSocket: `${input.codexHome}/app-server-control/app-server-control.sock`,
	};
}

function legacyExpectedWords(expected: LegacyTuiBindingExpectation): string[] {
	return [
		`CODEX_HOME=${expected.codexHome}`,
		expected.codexBin ?? "__TRUSTED_RUNTIME_BIN__",
		"resume",
		"--remote",
		`unix://${expected.remoteSocket}`,
		"-C",
		expected.cwd,
		expected.threadId,
	];
}

function matchesLegacyWords(
	observed: readonly string[],
	expected: LegacyTuiBindingExpectation,
): boolean {
	const wanted = legacyExpectedWords(expected);
	if (expected.codexBin === null) {
		if (observed.length < 2 || !observed[1]) return false;
		wanted[1] = observed[1];
	}
	return sameWords(observed, wanted);
}

function matchesCapabilityWords(
	observed: readonly string[],
	expected: CapabilityTuiBindingExpectation,
): boolean {
	if (observed[0] !== "/usr/bin/env" || observed[1] !== "-i") return false;
	const binIndices = observed
		.map((word, index) => (word === expected.codexBin ? index : -1))
		.filter((index) => index >= 0);
	if (binIndices.length !== 1 || binIndices[0]! < 3) return false;
	const binIndex = binIndices[0]!;
	const env = new Map<string, string>();
	for (const assignment of observed.slice(2, binIndex)) {
		const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(assignment);
		if (!match || env.has(match[1]!)) return false;
		env.set(match[1]!, match[2]!);
	}
	const required = new Map<string, string>([
		["CODEX_HOME", expected.codexHome],
		["FLYWHEEL_CODEX_TUI_HOME", expected.codexHome],
		["FLYWHEEL_PROJECT_NAME", expected.projectName],
		["FLYWHEEL_LEAD_ID", expected.leadId],
		["FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION", "2"],
		["FLYWHEEL_CODEX_LEAD_PROFILE", "full-access"],
	]);
	for (const [key, value] of required) if (env.get(key) !== value) return false;
	for (const key of [
		"TERM",
		"LANG",
		"TMPDIR",
		"FLYWHEEL_LEAD_CAPABILITY_ACTIVATION",
		"FLYWHEEL_LEAD_CAPABILITY_SOCKET",
		"FLYWHEEL_LEAD_CAPABILITY_MANIFEST",
	])
		if (!env.get(key)) return false;
	const allowed = new Set<string>([
		...LEAD_MODEL_ENV_NAMES,
		...required.keys(),
		"TMPDIR",
		"FLYWHEEL_LEAD_CAPABILITY_ACTIVATION",
		"FLYWHEEL_LEAD_CAPABILITY_SOCKET",
		"FLYWHEEL_LEAD_CAPABILITY_MANIFEST",
	]);
	if ([...env.keys()].some((key) => !allowed.has(key))) return false;
	for (const key of [
		"TMPDIR",
		"FLYWHEEL_LEAD_CAPABILITY_SOCKET",
		"FLYWHEEL_LEAD_CAPABILITY_MANIFEST",
	])
		if (!env.get(key)!.startsWith("/")) return false;
	const tail = observed.slice(binIndex);
	if (
		tail.length !== 7 ||
		tail[0] !== expected.codexBin ||
		tail[1] !== "resume" ||
		tail[2] !== "--remote" ||
		tail[3] !== `unix://${expected.remoteSocket}` ||
		tail[4] !== "-C" ||
		tail[5] !== expected.cwd ||
		tail[6] !== expected.threadId
	)
		return false;
	return true;
}

export function verifyAgentTuiBinding(
	observed: string,
	expected: AgentTuiBindingExpectation,
): AgentTuiBindingVerdict {
	try {
		const observedWords = decodeObserved(observed);
		if (expected.kind === "canonical") {
			const expectedWords = tokenizeShellWords(buildTuiCommand(expected.spec));
			if (!sameWords(observedWords, expectedWords))
				return { ok: false, reason: "identity_mismatch" };
			return {
				ok: true,
				grammar: expected.spec.capabilityModelEnv ? "capability-v2" : "legacy",
				threadId: expected.spec.threadId,
			};
		}
		if (expected.kind === "capability-v2") {
			if (!matchesCapabilityWords(observedWords, expected))
				return { ok: false, reason: "identity_mismatch" };
			return {
				ok: true,
				grammar: "capability-v2",
				threadId: expected.threadId,
			};
		}
		if (!matchesLegacyWords(observedWords, expected))
			return { ok: false, reason: "identity_mismatch" };
		return {
			ok: true,
			grammar: "legacy",
			threadId: expected.threadId,
		};
	} catch (error) {
		if (error instanceof UnsafeCommandError)
			return { ok: false, reason: "unsafe_command" };
		return { ok: false, reason: "identity_mismatch" };
	}
}
