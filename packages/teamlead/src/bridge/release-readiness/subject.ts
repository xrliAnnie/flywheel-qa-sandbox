import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BASE_RE, normalizeVersionFile } from "flywheel-release-contract";
import {
	type BridgeBuildIdentity,
	resolveBridgeBuildIdentity,
} from "../build-identity.js";

export interface ReadinessSubject {
	baseVersion: string;
	sourceCommit: string;
}

export function readRunningSubject(
	versionPath: string,
	identity: BridgeBuildIdentity = resolveBridgeBuildIdentity(),
): ReadinessSubject | null {
	try {
		return parseReadinessSubject(
			normalizeVersionFile(readFileSync(versionPath, "utf8")),
			identity.buildSha,
		);
	} catch {
		return null;
	}
}

export function readLocalDeployedSha(
	path = process.env.FLYWHEEL_DEPLOYED_SHA_FILE ??
		join(homedir(), ".flywheel", "deployed-sha"),
): string | null {
	try {
		const sha = readFileSync(path, "utf8").trim();
		return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
	} catch {
		return null;
	}
}

export function parseReadinessSubject(
	baseVersion: unknown,
	sourceCommit: unknown,
): ReadinessSubject | null {
	return typeof baseVersion === "string" &&
		BASE_RE.test(baseVersion) &&
		typeof sourceCommit === "string" &&
		/^[0-9a-f]{40}$/.test(sourceCommit) &&
		sourceCommit.length === 40
		? { baseVersion, sourceCommit }
		: null;
}
