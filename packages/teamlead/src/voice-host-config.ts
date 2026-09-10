import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { ProjectEntry } from "./ProjectConfig.js";

export interface VoiceHostConfig {
	schemaVersion: 1;
	qaVoiceChannelIds: string[];
	qaAllowUserIds: string[];
	evidenceRoots: string[];
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`voice-host.${field} must be a string array`);
	}
	return value;
}

export function loadVoiceHostConfig(input: {
	path?: string;
	projects: ProjectEntry[];
	homeDir?: string;
}): VoiceHostConfig {
	const homeDir = input.homeDir ?? homedir();
	const defaults: VoiceHostConfig = {
		schemaVersion: 1,
		qaVoiceChannelIds: [],
		qaAllowUserIds: [],
		evidenceRoots: [
			...input.projects.map(({ projectRoot }) => projectRoot),
			join(homeDir, ".flywheel"),
		],
	};
	const path = input.path ?? join(homeDir, ".flywheel", "voice-host.json");
	if (!existsSync(path)) return defaults;
	const info = lstatSync(path);
	if (info.isSymbolicLink() || !info.isFile()) {
		throw new Error("voice-host config must be a regular non-symlinked file");
	}
	if ((info.mode & 0o777) !== 0o600) {
		throw new Error("voice-host config must have mode 0600");
	}
	const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("voice-host config must be an object");
	}
	const object = raw as Record<string, unknown>;
	const allowed = new Set([
		"schemaVersion",
		"qaVoiceChannelIds",
		"qaAllowUserIds",
		"evidenceRoots",
	]);
	if (Object.keys(object).some((key) => !allowed.has(key))) {
		throw new Error("voice-host config contains an unknown field");
	}
	if (object.schemaVersion !== 1) {
		throw new Error("voice-host.schemaVersion must be 1");
	}
	const qaVoiceChannelIds = stringArray(
		object.qaVoiceChannelIds ?? [],
		"qaVoiceChannelIds",
	);
	const qaAllowUserIds = stringArray(
		object.qaAllowUserIds ?? [],
		"qaAllowUserIds",
	);
	if (
		[...qaVoiceChannelIds, ...qaAllowUserIds].some(
			(value) => !/^[0-9]{17,20}$/.test(value),
		)
	) {
		throw new Error("voice-host QA ids must be Discord snowflakes");
	}
	const evidenceRoots = stringArray(
		object.evidenceRoots ?? defaults.evidenceRoots,
		"evidenceRoots",
	).map((root) => {
		if (!isAbsolute(root) || resolve(root) === sep) {
			throw new Error(
				"voice-host.evidenceRoots must be absolute non-root paths",
			);
		}
		return root;
	});
	return { schemaVersion: 1, qaVoiceChannelIds, qaAllowUserIds, evidenceRoots };
}
