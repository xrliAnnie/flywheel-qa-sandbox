import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readRegularFileNoFollow } from "flywheel-comm/lead-registry-file-io";

/** Fixed inventory: callers cannot provide a smaller bootstrap contract. */
export const LEAD_BOOTSTRAP_FILES = [
	"scripts/flywheel-lead.sh",
	"scripts/flywheel-daemon.sh",
	"packages/teamlead/scripts/lib/canonical-lead-identity.sh",
	"packages/teamlead/scripts/codex-lead.sh",
	"packages/teamlead/scripts/run-codex-lead-mufasa.sh",
	"packages/teamlead/scripts/run-codex-lead-mufasa-fullaccess.sh",
	"packages/teamlead/scripts/run-codex-lead-mufasa-writecapable.sh",
	"packages/teamlead/scripts/run-codex-lead-mufasa-tui.sh",
	"packages/teamlead/scripts/run-codex-lead-mufasa-tui-fullaccess.sh",
	"packages/teamlead/scripts/run-codex-infra-bot-tui.sh",
	"packages/teamlead/dist/lead-runtime-tuning.js",
	"packages/teamlead/dist/lead-backends/codex/codex-lead-runtime.js",
	"packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js",
	"packages/teamlead/dist/lead-backends/codex/LeadRuntimeConfigCoordinator.js",
	"packages/teamlead/dist/lead-backends/codex/LeadRuntimeConfigHost.js",
	"packages/teamlead/dist/lead-backends/codex/NativeLeadRuntimeConfig.js",
	"packages/teamlead/dist/lead-backends/codex/lead-turn-evidence.js",
	"packages/teamlead/dist/lead-backends/codex/lead-model-context.js",
	"packages/teamlead/dist/lead-backends/codex/CodexLeadProcess.js",
	"packages/teamlead/dist/lead-backends/codex/CodexLeadInboxSocket.js",
] as const;
function digest(text: string) {
	return createHash("sha256").update(text).digest("hex");
}
export function makeLeadBuildIdentity(root: string, artifactBuildSha: string) {
	if (!/^[a-f0-9]{40}$/.test(artifactBuildSha))
		throw new Error("invalid_artifact_build_sha");
	return {
		artifactBuildSha,
		leadBootstrap: {
			contract: "registry_tuning_v1",
			files: Object.fromEntries(
				LEAD_BOOTSTRAP_FILES.map((path) => [
					path,
					digest(
						readRegularFileNoFollow(join(root, path), "bootstrap artifact"),
					),
				]),
			),
		},
	};
}
/** Call at process initialization, before asynchronous startup. Never infer a build from env or git HEAD. */
export function captureLeadRuntimeBuild(
	root?: string,
): { artifactBuildSha: string; bootstrapBuildSha: string } | undefined {
	if (root === undefined) {
		if (!fileURLToPath(import.meta.url).endsWith("/dist/lead-runtime-build.js"))
			return undefined;
		root = fileURLToPath(new URL("../../../", import.meta.url));
	}
	try {
		const marker = JSON.parse(
			readRegularFileNoFollow(
				join(root, "packages/teamlead/dist/build-identity.json"),
				"build identity",
			),
		);
		const expected = makeLeadBuildIdentity(root, marker.artifactBuildSha);
		if (marker.leadBootstrap?.contract !== expected.leadBootstrap.contract)
			return undefined;
		const files = marker.leadBootstrap.files;
		if (
			!files ||
			typeof files !== "object" ||
			Array.isArray(files) ||
			Object.keys(files).length !== LEAD_BOOTSTRAP_FILES.length
		)
			return undefined;
		if (
			LEAD_BOOTSTRAP_FILES.some(
				(path) => files[path] !== expected.leadBootstrap.files[path],
			)
		)
			return undefined;
		return {
			artifactBuildSha: expected.artifactBuildSha,
			bootstrapBuildSha: expected.artifactBuildSha,
		};
	} catch {
		return undefined;
	}
}
