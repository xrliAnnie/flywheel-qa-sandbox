import { readFileSync } from "node:fs";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type EnvFileSource =
	| { status: "readable"; content: string }
	| { status: "unavailable" };

export type EnvFileValue =
	| { status: "readable"; raw?: string }
	| { status: "unavailable" };

/** Read the last uncommented plain/export assignment for a shell-sourced file. */
export function readEnvValueFromContent(
	content: string,
	key: string,
): string | undefined {
	if (!ENV_KEY_RE.test(key)) return undefined;
	const re = new RegExp(`^\\s*(?:export\\s+)?${key}=(.*)$`);
	let value: string | undefined;
	for (const line of content.split("\n")) {
		if (/^\s*#/.test(line)) continue;
		const match = line.match(re);
		if (match) value = match[1];
	}
	return value;
}

/** Capture readability separately from key presence. */
export function readEnvFileSource(
	path: string,
	readFile: (path: string) => string = (file) => readFileSync(file, "utf8"),
): EnvFileSource {
	try {
		return { status: "readable", content: readFile(path) };
	} catch {
		return { status: "unavailable" };
	}
}

export function readEnvFileValue(
	source: EnvFileSource,
	key: string,
): EnvFileValue {
	if (source.status === "unavailable") return { status: "unavailable" };
	return {
		status: "readable",
		raw: readEnvValueFromContent(source.content, key),
	};
}
