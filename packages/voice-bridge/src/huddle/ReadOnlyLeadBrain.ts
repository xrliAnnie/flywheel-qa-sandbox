/**
 * ReadOnlyLeadBrain (FLY-545 PR-2, D3 gate ruling) — the huddle's ask_lead
 * brain: `claude -p` carrying the Lead's persona with a READ-ONLY whitelist.
 *
 * The whitelist is structural, not advisory: `--tools "Read,Grep,Glob"` +
 * `--strict-mcp-config` means Bash/writes/MCP physically do not exist in the
 * child — a spoken "ship it" can only ever produce words (actions run through
 * ConfirmationLadder + the existing founder gate, never through this brain).
 * cwd is pinned to the project root so Read/Grep/Glob answer real project
 * questions. Prompt via stdin (argv hygiene contract from voice-core).
 */
import {
	HeadlessClaudeBrain,
	type HeadlessClaudeBrainOptions,
} from "flywheel-voice-core";

export const READ_ONLY_TOOL_ARGS = [
	"--tools",
	"Read,Grep,Glob",
	"--strict-mcp-config",
] as const;

const HUDDLE_VOICE_CONTEXT = [
	"You are speaking with the founder over a VOICE channel in a live huddle.",
	"Answer in short, spoken, conversational sentences. No markdown, no code blocks, no bullet lists.",
	"You have READ-ONLY tools (Read/Grep/Glob) rooted at the project — use them for real project facts, never guess.",
	"You cannot execute anything: no shell, no writes, no ship/merge/deploy. If asked, you may DISCUSS an",
	"action, but real actions happen through the normal approval flow, not this voice session.",
].join(" ");

export interface ReadOnlyLeadBrainOptions {
	claudeBin: string;
	/** the Lead's identity.md (persona source). */
	identityFile: string;
	/** project root — anchors the read-only tools. */
	projectRoot: string;
	timeoutMs?: number;
	runner?: HeadlessClaudeBrainOptions["runner"];
	extraArgs?: string[];
	/** override the spoken-register context (the summary generator writes
	 * markdown, not speech — same read-only whitelist either way). */
	voiceContext?: string;
}

/** QA R3 P0 (Annie's 7-min freeze): a hung claude child with NO timeout froze
 * the whole meeting with zero cue. Until FLY-1160's resident session lands,
 * every huddle brain turn is BOUNDED — timeout kills the child, the ask_lead
 * error surfaces to Gemini as a tool response (spoken recovery), and the next
 * turn spawns fresh. */
export const DEFAULT_HUDDLE_BRAIN_TIMEOUT_MS = 45_000;

export function createReadOnlyLeadBrain(
	opts: ReadOnlyLeadBrainOptions,
): HeadlessClaudeBrain {
	return new HeadlessClaudeBrain({
		claudeBin: opts.claudeBin,
		identityFile: opts.identityFile,
		voiceContext: opts.voiceContext ?? HUDDLE_VOICE_CONTEXT,
		toolDisableArgs: [...READ_ONLY_TOOL_ARGS],
		cwd: opts.projectRoot,
		timeoutMs: opts.timeoutMs ?? DEFAULT_HUDDLE_BRAIN_TIMEOUT_MS,
		...(opts.runner ? { runner: opts.runner } : {}),
		...(opts.extraArgs ? { extraArgs: opts.extraArgs } : {}),
	});
}
