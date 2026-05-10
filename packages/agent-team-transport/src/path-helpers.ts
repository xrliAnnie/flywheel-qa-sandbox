/**
 * Path resolution helpers.
 *
 * Per plan §2.0.7 (Codex r1 high #5 + r2 medium #6):
 * - claude-code uses native `CLAUDE_CONFIG_DIR + "/teams"` (per
 *   `/Users/xiaorongli/Dev/claude-code/src/utils/envUtils.ts:8-17`).
 *   We MUST NOT introduce `FLYWHEEL_TEAMS_DIR` for claude-code — it would
 *   create a dual truth source where stock binary polls one path and
 *   flywheel writes to another.
 * - Vendor-neutral structured-inbox / sentinel files live under
 *   `FLYWHEEL_STATE_DIR` (default `~/.flywheel/state`).
 * - Other vendors (codex) own their own path env (e.g. future
 *   `FLYWHEEL_CODEX_INBOX_DIR`) — decoupled from CLAUDE_CONFIG_DIR.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CLAUDE_CONFIG_DIR = ".claude";
const DEFAULT_FLYWHEEL_STATE_DIR = ".flywheel/state";

/**
 * Resolve `CLAUDE_CONFIG_DIR` env (claude-code's native control), defaulting
 * to `~/.claude`. Returned path is absolute.
 */
export function getClaudeConfigDir(): string {
	const env = process.env.CLAUDE_CONFIG_DIR;
	if (env && env.length > 0) {
		return env;
	}
	return join(homedir(), DEFAULT_CLAUDE_CONFIG_DIR);
}

/**
 * Resolve `FLYWHEEL_STATE_DIR` env (vendor-neutral state path for
 * structured-inbox + sentinel files). Defaults to `~/.flywheel/state`.
 * Returned path is absolute.
 */
export function getStateDir(): string {
	const env = process.env.FLYWHEEL_STATE_DIR;
	if (env && env.length > 0) {
		return env;
	}
	return join(homedir(), DEFAULT_FLYWHEEL_STATE_DIR);
}

// ----------------------------------------------------------------------------
// Claude-specific path helpers (Used only by ClaudeCodeAdapter / its tests.
// Production code outside packages/agent-team-transport/src/claude/** MUST
// NOT call these directly — go through `transport.getInboxPath(...)` instead.
// CI grep gate enforces this.)
// ----------------------------------------------------------------------------

/** `<CLAUDE_CONFIG_DIR>/teams` */
export function getClaudeTeamsDir(): string {
	return join(getClaudeConfigDir(), "teams");
}

/** `<CLAUDE_CONFIG_DIR>/teams/<lead>/config.json` */
export function getClaudeTeamConfigPath(leadName: string): string {
	return join(getClaudeTeamsDir(), leadName, "config.json");
}

/** `<CLAUDE_CONFIG_DIR>/teams/<lead>/inboxes/<agent>.json` */
export function getClaudeInboxPath(leadName: string, agentName: string): string {
	return join(getClaudeTeamsDir(), leadName, "inboxes", `${agentName}.json`);
}

/** `<inbox>.flywheel.jsonl` — sidecar for flywheelId dedupe (§2.0.6). */
export function getClaudeSidecarPath(
	leadName: string,
	agentName: string,
): string {
	return `${getClaudeInboxPath(leadName, agentName)}.flywheel.jsonl`;
}

/**
 * `<FLYWHEEL_STATE_DIR>/inbox-structured/<lead>/requests` — vendor-neutral
 * structured request directory (Runner→Lead gate requests, watched by
 * Bridge `StructuredInboxRouter`).
 */
export function getStructuredRequestDir(leadName: string): string {
	return join(getStateDir(), "inbox-structured", leadName, "requests");
}

/**
 * `<FLYWHEEL_STATE_DIR>/inbox-structured/<runner>/responses` — vendor-neutral
 * structured response directory (Lead→Runner gate responses, watched by
 * await-mcp via fs.watch — §2.6 Codex r2 critical #2).
 */
export function getStructuredResponseDir(runnerName: string): string {
	return join(getStateDir(), "inbox-structured", runnerName, "responses");
}
