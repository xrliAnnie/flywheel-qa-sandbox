import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	ENTITLEMENT_POINTER,
	validateManifest,
} from "../../packages/release-contract/src/index.mjs";

const execute = promisify(execFile);

/** Pure receiver contracts; callers pass GitHub context through env, never shell interpolation. */
export function betaInvocation(env) {
	const owner = env.FW_BETA_SCHEDULER_OWNER || "legacy";
	if (!["legacy", "paused", "bridge"].includes(owner))
		throw new Error("beta_owner_invalid");
	if (env.GITHUB_REF !== "refs/heads/main") throw new Error("beta_ref_invalid");
	if (!["schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME))
		throw new Error("beta_event_invalid");
	const fields = [env.PROJECT_KEY, env.SCHEDULE_KEY, env.SOURCE_COMMIT];
	const bridge = fields.some(Boolean);
	if (bridge) {
		if (
			env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
			owner !== "bridge" ||
			env.RELEASE_ID_INPUT ||
			!fields.every(Boolean) ||
			env.PROJECT_KEY !== env.EXPECTED_PROJECT_KEY ||
			!/^[a-f0-9]{64}$/.test(env.SCHEDULE_KEY) ||
			!/^[a-f0-9]{40}$/.test(env.SOURCE_COMMIT)
		)
			throw new Error("beta_schedule_input_invalid");
	}
	const eligible =
		bridge ||
		(owner !== "paused" &&
			(env.GITHUB_EVENT_NAME === "workflow_dispatch" || owner === "legacy"));
	return { eligible, activated: Boolean(env.FW_ENDPOINT), bridge };
}
export function betaScheduleReceipt(identity, result) {
	const invalid = () => {
		throw new Error("beta_receipt_invalid");
	};
	if (
		!identity ||
		!result ||
		Object.keys(identity).sort().join(",") !==
			"projectName,repositoryId,runId,scheduleKey,sourceCommit,workflowId"
	)
		invalid();
	if (
		typeof identity.projectName !== "string" ||
		!identity.projectName ||
		identity.projectName.length > 128 ||
		!/^[a-f0-9]{64}$/.test(identity.scheduleKey) ||
		!/^[a-f0-9]{40}$/.test(identity.sourceCommit) ||
		!["repositoryId", "workflowId", "runId"].every(
			(k) => Number.isSafeInteger(identity[k]) && identity[k] > 0,
		)
	)
		invalid();
	if (
		Object.keys(result).sort().join(",") !==
		"outcome,publishedAt,publishedSourceCommit,publishedVersion"
	)
		invalid();
	if (result.outcome === "not_activated") {
		if (
			result.publishedVersion !== null ||
			result.publishedSourceCommit !== null ||
			result.publishedAt !== null
		)
			invalid();
	} else {
		if (
			!["published", "no_change", "covered_by_newer"].includes(
				result.outcome,
			) ||
			typeof result.publishedVersion !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result.publishedVersion) ||
			typeof result.publishedSourceCommit !== "string" ||
			!/^[a-f0-9]{40}$/.test(result.publishedSourceCommit) ||
			typeof result.publishedAt !== "string" ||
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(
				result.publishedAt,
			) ||
			!Number.isFinite(Date.parse(result.publishedAt))
		)
			invalid();
		if (
			result.outcome !== "covered_by_newer" &&
			result.publishedSourceCommit !== identity.sourceCommit
		)
			invalid();
	}
	return { schemaVersion: 1, ...identity, ...result };
}

/** Run from the trusted workflow checkout before checking out the frozen source. */
export async function assessBetaSource({
	repoRoot,
	sourceCommit,
	manifest,
	defaultRef = "refs/remotes/origin/main",
}) {
	if (!/^[a-f0-9]{40}$/.test(sourceCommit))
		throw new Error("beta_source_invalid");
	const ancestor = async (base, head) => {
		try {
			await execute(
				"git",
				["-C", repoRoot, "merge-base", "--is-ancestor", base, head],
				{ timeout: 10000, maxBuffer: 65536 },
			);
			return true;
		} catch (error) {
			if (error.code === 1) return false;
			throw new Error("beta_ancestry_unknown");
		}
	};
	if (!(await ancestor(sourceCommit, defaultRef)))
		throw new Error("beta_source_unreachable");
	if (!manifest || validateManifest(manifest).length)
		throw new Error("beta_manifest_invalid");
	const version = manifest.channels[ENTITLEMENT_POINTER.internal].latest;
	if (version === null) return null;
	const entry = manifest.versions[version];
	if (
		!entry ||
		entry.status !== "active" ||
		entry.channel !== "beta" ||
		!/^[a-f0-9]{40}$/.test(entry.sourceCommit)
	)
		throw new Error("beta_manifest_invalid");
	let outcome;
	if (entry.sourceCommit === sourceCommit) outcome = "no_change";
	else if (await ancestor(sourceCommit, entry.sourceCommit))
		outcome = "covered_by_newer";
	else if (await ancestor(entry.sourceCommit, sourceCommit)) return null;
	else throw new Error("beta_source_diverged");
	return {
		outcome,
		publishedVersion: version,
		publishedSourceCommit: entry.sourceCommit,
		publishedAt: entry.publishedAt,
	};
}
