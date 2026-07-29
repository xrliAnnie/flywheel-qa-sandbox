import { isAbsolute } from "node:path";
import type { InjectionRefBuilder } from "./types.js";

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("injection ref must be a JSON object");
	}
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function absolute(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		isAbsolute(value)
	);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

export function validateInjectionRef(serialized: string): string {
	let value: Record<string, unknown>;
	try {
		value = record(JSON.parse(serialized));
	} catch (error) {
		throw new TypeError(
			`injection ref is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const claude =
		exactKeys(value, ["v", "backend", "inboxPath", "sidecarPath", "toAgent"]) &&
		value.v === 1 &&
		value.backend === "claude" &&
		absolute(value.inboxPath) &&
		absolute(value.sidecarPath) &&
		nonEmpty(value.toAgent);
	const codex =
		exactKeys(value, ["v", "backend", "socketPath", "threadId"]) &&
		value.v === 1 &&
		value.backend === "codex" &&
		absolute(value.socketPath) &&
		nonEmpty(value.threadId);
	if (!claude && !codex) {
		throw new TypeError("injection ref does not match an exact shim contract");
	}
	return JSON.stringify(value);
}

export function createInjectionRefBuilder(
	build: InjectionRefBuilder["build"],
): InjectionRefBuilder {
	return {
		build(input) {
			return validateInjectionRef(build(input));
		},
	};
}
