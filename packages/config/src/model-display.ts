import {
	modelDisplayName,
	modelShortCode,
	vendorModelShortCode,
} from "./model-tiers.js";

/** Shared producer/consumer cap for the payload after the `Model ` namespace. */
export const RUNNER_MODEL_MARKER_PAYLOAD_MAX = 24;
const WINDOW_LABEL_MAX = 32;

export interface RunnerModelDisplayInput {
	vendor: string | null | undefined;
	model: string | null | undefined;
}

export interface RunnerModelDisplay {
	threadMarker: string;
	windowLabel: string;
}

function safeToken(raw: string, max: number): string {
	return raw
		.trim()
		.replace(/[^A-Za-z0-9._+-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-._+]+|[-._+]+$/g, "")
		.slice(0, max);
}

function windowSafe(raw: string): string {
	return raw
		.replace(/[^A-Za-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, WINDOW_LABEL_MAX);
}

export function renderRunnerModelDisplay(
	input: RunnerModelDisplayInput,
): RunnerModelDisplay | undefined {
	const model = input.model?.trim();
	if (!model) return undefined;

	const lowerModel = model.toLowerCase();
	const explicitFamily = safeToken(input.vendor ?? "", 12).toLowerCase();
	const claudeCodeCandidate = modelShortCode(model);
	const inferredFamily = claudeCodeCandidate
		? "claude"
		: lowerModel.startsWith("gpt-")
			? "codex"
			: lowerModel.startsWith("kimi-")
				? "kimi"
				: "unknown";
	const family = explicitFamily || inferredFamily;

	// FLY-1255 (Plan B — Annie): resolve a SINGLE-LETTER short code by table
	// lookup. Claude keeps its F/O/S/H tier codes (byte-unchanged); curated
	// non-Claude families fold to `G` (codex/GPT) or `K` (kimi). A model with no
	// curated code (gemini, antigravity, or another unlisted family) keeps the long
	// `Model <id>` fallback below — the letter is NEVER fabricated.
	const claudeCode = family === "claude" ? claudeCodeCandidate : undefined;
	const vendorCode = vendorModelShortCode(family, model);
	const code = claudeCode ?? vendorCode;

	// Claude window keeps its readable tier name (`claude-Fable`, byte-unchanged);
	// the NEW non-Claude codes use the compact letter in the window too so the
	// short label frees up the tmux/cmux issue-title sidebar (`codex-G`, `kimi-K`).
	// A model with no curated code falls back to its honest raw id in both the
	// `Model <id>` marker and the `<family>-<id>` window label (a formerly-
	// prettified `gpt-5.6` is now `G`, so the fallback no longer needs to reach
	// for a display name).
	const claudeDisplay =
		family === "claude" && claudeCode ? modelDisplayName(model) : undefined;
	const payload = safeToken(
		claudeDisplay ?? model,
		RUNNER_MODEL_MARKER_PAYLOAD_MAX,
	);
	if (!code && !payload) return undefined;

	const windowSegment = vendorCode ?? payload;

	return {
		threadMarker: code ?? `Model ${payload}`,
		windowLabel: windowSafe(`${family}-${windowSegment}`),
	};
}
