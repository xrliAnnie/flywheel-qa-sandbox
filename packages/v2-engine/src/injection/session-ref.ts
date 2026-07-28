import { isAbsolute } from "node:path";

export interface ClaudeInjectionSessionRef {
	v: 1;
	backend: "claude";
	inboxPath: string;
	sidecarPath: string;
	toAgent: string;
}

export interface CodexInjectionSessionRef {
	v: 1;
	backend: "codex";
	socketPath: string;
	threadId: string;
}

function parseRecord(sessionRef: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(sessionRef);
	} catch {
		throw new TypeError("sessionRef must be valid JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("sessionRef must be a JSON object");
	}
	return value as Record<string, unknown>;
}

function hasExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return (
		actual.length === wanted.length &&
		actual.every((key, index) => key === wanted[index])
	);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isAbsolutePath(value: unknown): value is string {
	return isNonEmptyString(value) && isAbsolute(value);
}

export function parseClaudeSessionRef(
	sessionRef: string,
): ClaudeInjectionSessionRef {
	const value = parseRecord(sessionRef);
	if (
		!hasExactKeys(value, [
			"v",
			"backend",
			"inboxPath",
			"sidecarPath",
			"toAgent",
		]) ||
		value.v !== 1 ||
		value.backend !== "claude" ||
		!isAbsolutePath(value.inboxPath) ||
		!isAbsolutePath(value.sidecarPath) ||
		!isNonEmptyString(value.toAgent)
	) {
		throw new TypeError(
			"sessionRef is not an exact Claude injection reference",
		);
	}
	return {
		v: 1,
		backend: "claude",
		inboxPath: value.inboxPath,
		sidecarPath: value.sidecarPath,
		toAgent: value.toAgent,
	};
}

export function parseCodexSessionRef(
	sessionRef: string,
): CodexInjectionSessionRef {
	const value = parseRecord(sessionRef);
	if (
		!hasExactKeys(value, ["v", "backend", "socketPath", "threadId"]) ||
		value.v !== 1 ||
		value.backend !== "codex" ||
		!isAbsolutePath(value.socketPath) ||
		!isNonEmptyString(value.threadId)
	) {
		throw new TypeError("sessionRef is not an exact Codex injection reference");
	}
	return {
		v: 1,
		backend: "codex",
		socketPath: value.socketPath,
		threadId: value.threadId,
	};
}
