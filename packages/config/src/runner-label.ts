/**
 * FLY-123: shared pure label → runner-vendor parser.
 *
 * Extracted from the label-handling subset of
 * `packages/edge-worker/src/RunnerSelectionService.determineRunnerSelection`
 * so the teamlead dispatcher path can resolve task-level backend overrides
 * WITHOUT depending on edge-worker (Codex design review R1 #5).
 *
 * Phase 1 scope is LABELS ONLY — the dispatcher `StartRequest` carries
 * labels but not the issue description. Description-tag parsing
 * (`[agent=codex]` in the body) stays in RunnerSelectionService (EdgeWorker
 * Linear path) until Phase 2 unifies both onto this module.
 *
 * Semantics mirror RunnerSelectionService exactly (agent labels override
 * model labels; model labels can infer agent type) so the two paths cannot
 * diverge on the same label set.
 *
 * FLY-493: `antigravity` (alias `agy`) is a first-class runner vendor on the
 * TeamLead dispatcher path ONLY. The legacy EdgeWorker `agentSession` path
 * (`RunnerSelectionService`) is NOT updated — `[agent=agy]` is not wired there
 * in v1 (see plan §4.1), so this is no longer a 1:1 mirror of that service.
 *
 * FLY-494: `kimi` (alias `kimi-code`) is a first-class runner vendor on the
 * same TeamLead dispatcher path, mirroring antigravity (also transport=none).
 * Likewise NOT wired into the legacy `RunnerSelectionService`.
 */

export type RunnerVendorType =
	| "claude"
	| "gemini"
	| "codex"
	| "cursor"
	| "antigravity"
	| "kimi";

export interface RunnerLabelSelection {
	/** Vendor inferred from labels — undefined when no runner label present. */
	runnerType?: RunnerVendorType;
	/** Explicit model label (e.g. "opus", "gpt-5.5-codex") if present. */
	modelOverride?: string;
}

/** Mirrors RunnerSelectionService.isCodexModel (label-side subset). */
function isCodexModelLabel(label: string): boolean {
	return /gpt-[a-z0-9.-]*codex$/i.test(label);
}

function resolveAgentFromLabels(
	labels: string[],
): RunnerVendorType | undefined {
	// FLY-493: antigravity (alias `agy`) — checked first so an explicit
	// opt-in to Antigravity is unambiguous. Distinct keywords; existing
	// cursor/codex/gemini/claude precedence is unchanged for label sets that
	// don't mention antigravity.
	if (labels.includes("antigravity") || labels.includes("agy")) {
		return "antigravity";
	}
	// FLY-494: kimi (alias `kimi-code`) — distinct keyword, same first-class
	// opt-in shape as antigravity. Does not collide with any existing vendor.
	if (labels.includes("kimi") || labels.includes("kimi-code")) {
		return "kimi";
	}
	if (labels.includes("cursor")) return "cursor";
	if (labels.includes("codex") || labels.includes("openai")) return "codex";
	if (labels.includes("gemini")) return "gemini";
	if (labels.includes("claude")) return "claude";
	return undefined;
}

function resolveModelFromLabels(labels: string[]): string | undefined {
	const codexModelLabel = labels.find((label) => isCodexModelLabel(label));
	if (codexModelLabel) return codexModelLabel;

	if (labels.includes("gemini-2.5-pro") || labels.includes("gemini-2.5")) {
		return "gemini-2.5-pro";
	}
	if (labels.includes("gemini-2.5-flash")) return "gemini-2.5-flash";
	if (labels.includes("gemini-2.5-flash-lite")) return "gemini-2.5-flash-lite";
	if (
		labels.includes("gemini-3") ||
		labels.includes("gemini-3-pro") ||
		labels.includes("gemini-3-pro-preview")
	) {
		return "gemini-3-pro-preview";
	}

	// FLY-751: explicit 1M-context opt-in labels — checked BEFORE the bare
	// aliases so an issue carrying both `opus` and `opus-1m` resolves to 1M
	// (the more specific ask wins). `includes` is exact-match, so there is no
	// substring swallowing either way; the ordering is for precedence only.
	if (labels.includes("opus-1m")) return "claude-opus-4-8[1m]";
	if (labels.includes("fable-1m")) return "claude-fable-5[1m]";

	// FLY-728: per-issue model routing. `fable` resolves to the canonical
	// explicit id `claude-fable-5` (the exact string fleet-console, token
	// pricing/report, and the claude-tmux `--model` flag all use). It infers the
	// `claude` runner via inferRunnerFromModel because the id starts with
	// "claude". opus/sonnet/haiku stay bare aliases (already CLI-accepted).
	if (labels.includes("fable")) return "claude-fable-5";
	if (labels.includes("opus")) return "opus";
	if (labels.includes("sonnet")) return "sonnet";
	if (labels.includes("haiku")) return "haiku";

	return undefined;
}

function inferRunnerFromModel(
	model: string | undefined,
): RunnerVendorType | undefined {
	if (!model) return undefined;
	const normalized = model.toLowerCase();
	if (normalized.startsWith("gemini")) return "gemini";
	if (
		normalized === "opus" ||
		normalized === "sonnet" ||
		normalized === "haiku" ||
		normalized.startsWith("claude")
	) {
		return "claude";
	}
	if (isCodexModelLabel(normalized) || /^gpt-[a-z0-9.-]+$/i.test(normalized)) {
		return "codex";
	}
	return undefined;
}

/**
 * Parse Linear labels into an optional runner-vendor selection.
 *
 * Returns `{}` (no fields) when labels carry no runner signal — callers
 * fall through to the next precedence layer (project config / global env /
 * built-in default).
 */
export function parseRunnerLabels(
	labels: readonly string[] | undefined,
): RunnerLabelSelection {
	const normalized = (labels ?? []).map((label) => label.toLowerCase());
	const agentFromLabels = resolveAgentFromLabels(normalized);
	const modelFromLabels = resolveModelFromLabels(normalized);

	const runnerType =
		agentFromLabels ?? inferRunnerFromModel(modelFromLabels) ?? undefined;

	const result: RunnerLabelSelection = {};
	if (runnerType) result.runnerType = runnerType;
	if (modelFromLabels) {
		// Agent label overrides a conflicting model label (mirrors
		// RunnerSelectionService: "keep the agent and reset model").
		const modelRunner = inferRunnerFromModel(modelFromLabels);
		if (!agentFromLabels || !modelRunner || modelRunner === agentFromLabels) {
			result.modelOverride = modelFromLabels;
		}
	}
	return result;
}
