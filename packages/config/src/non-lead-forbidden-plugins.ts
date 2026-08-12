/**
 * FLY-1715: Discord is a Lead-only channel. Every non-Lead Claude launch must
 * disable both marketplace identities after all caller settings are merged.
 *
 * This is a security contract, not part of the optional runner MCP slimming
 * profile: kill switches, labels, and caller-provided positive entries must
 * never turn either plugin back on.
 */

export const NON_LEAD_FORBIDDEN_PLUGINS = [
	"discord@flywheel-plugins",
	"discord@claude-plugins-official",
] as const;

type JsonRecord = Record<string, unknown>;
export type ClaudeSettingsSource = JsonRecord | string | undefined;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettings(source: ClaudeSettingsSource): JsonRecord {
	if (source === undefined) return {};
	let parsed: unknown = source;
	if (typeof source === "string") {
		try {
			parsed = JSON.parse(source);
		} catch {
			throw new Error("Claude --settings must be a valid JSON object");
		}
	}
	if (!isRecord(parsed)) {
		throw new Error("Claude --settings must be a valid JSON object");
	}
	return parsed;
}

function deepMerge(left: JsonRecord, right: JsonRecord): JsonRecord {
	let merged: JsonRecord = { ...left };
	for (const [key, value] of Object.entries(right)) {
		const prior = merged[key];
		merged = {
			...merged,
			[key]:
				isRecord(prior) && isRecord(value) ? deepMerge(prior, value) : value,
		};
	}
	return merged;
}

/** Parse and merge settings sources, then force the Lead-only plugins off. */
export function buildNonLeadClaudeSettings(
	...sources: readonly ClaudeSettingsSource[]
): JsonRecord {
	let merged: JsonRecord = {};
	for (const source of sources) {
		merged = deepMerge(merged, parseSettings(source));
	}
	return deepMerge(merged, {
		enabledPlugins: Object.fromEntries(
			NON_LEAD_FORBIDDEN_PLUGINS.map((plugin) => [plugin, false]),
		),
	});
}

/**
 * Collapse `--settings value` and `--settings=value` occurrences into one
 * canonical flag. Malformed caller settings fail closed before spawn.
 */
export function mergeNonLeadClaudeSettingsArgv(
	argv: readonly string[],
): string[] {
	const remaining: string[] = [];
	const settings: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		if (arg === "--settings") {
			const value = argv[index + 1];
			if (value === undefined) {
				throw new Error("Claude --settings requires a JSON value");
			}
			settings.push(value);
			index += 1;
			continue;
		}
		if (arg.startsWith("--settings=")) {
			const value = arg.slice("--settings=".length);
			if (!value) {
				throw new Error("Claude --settings requires a JSON value");
			}
			settings.push(value);
			continue;
		}
		remaining.push(arg);
	}
	return [
		...remaining,
		"--settings",
		JSON.stringify(buildNonLeadClaudeSettings(...settings)),
	];
}
