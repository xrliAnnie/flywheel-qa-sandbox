import { homedir } from "node:os";
import { join } from "node:path";
import {
	type CompiledRunnerPrefixProfile,
	compileRunnerPrefixProfile,
	type FlagStoreRawValue,
	readLowerSkillOverrides,
	resolveRunnerPrefixSelection,
} from "flywheel-config";
import type { StateStore } from "../StateStore.js";
import { resolveExecutionWorkflowPrefixContext } from "../workflow-prefix-context.js";

export interface ReviewPrefixResolution {
	profile: CompiledRunnerPrefixProfile;
	/** Author execution's runner-state directory; stamps are per review session. */
	stampDir: string;
}

/**
 * FLY-2913: role-v1 profile for a cross-family Claude reviewer. The role comes
 * only from the persisted review type and the engineering identity only from
 * the author execution's pinned run; the author's own skills never widen the
 * reviewer profile. Legacy switch / unset store skip every provenance read.
 */
export function resolveReviewPrefixProfile(input: {
	store: Pick<StateStore, "getWorkflowExecutionRuntime" | "getWorkflowRun">;
	profile: FlagStoreRawValue | undefined;
	executionId: string;
	reviewType: string;
	home?: string;
	claudeConfigDir?: string;
	/** The reviewed checkout; its project settings are a lower layer too. */
	cwd?: string;
}): ReviewPrefixResolution | undefined {
	const select = (
		workflow?: Parameters<typeof resolveRunnerPrefixSelection>[0]["workflow"],
	) =>
		resolveRunnerPrefixSelection({
			actor: "reviewer",
			backend: "claude-print",
			reviewType: input.reviewType,
			workflow,
			profile: input.profile,
		});
	const eligibility = select();
	if (
		eligibility.mode === "legacy" &&
		eligibility.reason !== "unmapped-trigger"
	)
		return undefined;
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.executionId))
		throw new Error("review_prefix_profile: invalid execution id");
	const context = resolveExecutionWorkflowPrefixContext(input.store, {
		executionId: input.executionId,
	});
	if (!context) return undefined;
	const selection = select(context.workflow);
	if (selection.mode === "legacy") return undefined;
	const home = input.home ?? homedir();
	const claudeConfigDir =
		input.claudeConfigDir ??
		process.env.CLAUDE_CONFIG_DIR ??
		join(home, ".claude");
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
		stampDir: join(home, ".flywheel", "runner-state", input.executionId),
	};
}
