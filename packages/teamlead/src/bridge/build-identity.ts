import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type BridgeBuildIdentity =
	| { mode: "source"; buildSha: string }
	| { mode: "built"; buildSha: string; artifactBuildSha: string }
	| { mode: "unknown"; buildSha: null };

const SHA40 = /^[0-9a-f]{40}$/i;

export function resolveBridgeBuildIdentity(input?: {
	env?: NodeJS.ProcessEnv;
	artifactPath?: string;
}): BridgeBuildIdentity {
	const env = input?.env ?? process.env;
	if (env.FLYWHEEL_BRIDGE_SOURCE_MODE === "1") {
		const sha = env.FLYWHEEL_BRIDGE_SOURCE_SHA?.trim().toLowerCase();
		return sha && SHA40.test(sha)
			? { mode: "source", buildSha: sha }
			: { mode: "unknown", buildSha: null };
	}
	try {
		const path =
			input?.artifactPath ??
			fileURLToPath(new URL("../build-identity.json", import.meta.url));
		const sha = (
			JSON.parse(readFileSync(path, "utf8")) as {
				artifactBuildSha?: unknown;
			}
		).artifactBuildSha;
		if (typeof sha === "string" && SHA40.test(sha)) {
			const normalized = sha.toLowerCase();
			return {
				mode: "built",
				buildSha: normalized,
				artifactBuildSha: normalized,
			};
		}
	} catch {
		// Unknown is the fail-closed identity for absent or malformed artifacts.
	}
	return { mode: "unknown", buildSha: null };
}
