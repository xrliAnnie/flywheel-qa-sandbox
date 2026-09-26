import { homedir } from "node:os";
import { join } from "node:path";
import {
	type CompiledRunnerPrefixProfile,
	compileRunnerPrefixProfile,
	type RunnerPrefixAudit,
	type RunnerPrefixContext,
	readLowerSkillOverrides,
	resolveRunnerPrefixSelection,
} from "flywheel-config";
import type { StateStore } from "../StateStore.js";
import { resolveExecutionWorkflowPrefixContext } from "../workflow-prefix-context.js";

export interface ReviewPrefixResolution {
	profile?: CompiledRunnerPrefixProfile;
	audit?: RunnerPrefixAudit;
	/** Author execution's runner-state directory; stamps are per review session. */
	stampDir: string;
}

/**
 * FLY-2913: role-v1 profile for a cross-family Claude reviewer. The role comes
 * only from the persisted review type and the engineering identity only from
 * the author execution's pinned run; the author's own skills never widen the
 * reviewer profile. The reviewer declaration is independent of the runner.
 */
export function resolveReviewPrefixProfile(input: {
	store: Pick<StateStore, "getWorkflowExecutionRuntime" | "getWorkflowRun">;
	executionId: string;
	reviewType: string;
	home?: string;
	claudeConfigDir?: string;
	/** The reviewed checkout; its project settings are a lower layer too. */
	cwd?: string;
}): ReviewPrefixResolution | undefined {
	if (input.reviewType !== "design" && input.reviewType !== "code")
		return undefined;
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.executionId))
		throw new Error("review_prefix_profile: invalid execution id");
	const home = input.home ?? homedir();
	const stampDir = join(home, ".flywheel", "runner-state", input.executionId);
	let context: RunnerPrefixContext | undefined;
	const audit = (
		effectiveProfile: "legacy" | "role-v1",
		fallbackReason: string | null,
	): RunnerPrefixAudit => ({
		workflow: context?.workflow ?? null,
		nodeId: context?.nodeId ?? null,
		selectionSource: "review_prefix_profile",
		requestedProfile: context?.reviewPrefixProfile ?? "legacy",
		effectiveProfile,
		fallbackReason,
	});
	try {
		context = resolveExecutionWorkflowPrefixContext(input.store, {
			executionId: input.executionId,
		});
	} catch {
		return { stampDir, audit: audit("legacy", "provenance-error") };
	}
	if (!context) return { stampDir, audit: audit("legacy", "unmapped-trigger") };
	const selection = resolveRunnerPrefixSelection({
		actor: "reviewer",
		backend: "claude-print",
		reviewType: input.reviewType,
		workflow: context.workflow,
		profile: context.reviewPrefixProfile,
	});
	if (selection.mode === "legacy")
		return { stampDir, audit: audit("legacy", selection.reason) };
	const claudeConfigDir =
		input.claudeConfigDir ??
		process.env.CLAUDE_CONFIG_DIR ??
		join(home, ".claude");
	try {
		return {
			profile: compileRunnerPrefixProfile({
				request: { selection, context: { ...context, agent: null } },
				claudeConfigDir,
				lowerSkillOverrides: readLowerSkillOverrides([
					join(claudeConfigDir, "settings.json"),
					...(input.cwd
						? [
								join(input.cwd, ".claude", "settings.json"),
								join(input.cwd, ".claude", "settings.local.json"),
							]
						: []),
				]),
				// Reviewer launches never apply a skill-arm plugin change.
				skillArm: "superpowers",
			}),
			stampDir,
			audit: audit("role-v1", null),
		};
	} catch {
		return { stampDir, audit: audit("legacy", "compile-error") };
	}
}
