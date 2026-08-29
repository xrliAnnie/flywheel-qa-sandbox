/**
 * Comm backend selector — single source of truth for the
 * `FLYWHEEL_COMM_BACKEND` env var (`mailbox` default vs `commdb` rollback).
 *
 * FLY-168: moved here from `teamlead/src/bridge/plugin.ts` so non-teamlead
 * packages (`flywheel-comm`, `claude-runner`) can share ONE parser instead of
 * each maintaining a divergent copy. The Bridge runtime selection
 * (`plugin.ts:createLeadRuntime`), Runner spawn identity
 * (`run-dispatcher.ts:buildAgentTeamIdentity`), TmuxAdapter sentinel gating,
 * and `flywheel-comm send` mailbox dual-write all resolve the backend through
 * this function.
 *
 * Lenient parse (matches the shell `normalize_comm_backend` in
 * `claude-lead.sh`):
 *   - default to `mailbox` when unset / empty
 *   - `.trim()` so operator-typed `.env` quirks like `FLYWHEEL_COMM_BACKEND=" commdb "`
 *     route as rollback (the shell already fixed this; the prior TS copy did
 *     NOT trim → a whitespace-padded value silently routed as mailbox while
 *     the shell launcher treated it as commdb, breaking rollback)
 *   - `.toLowerCase()` so `Commdb` / `COMMDB` compare correctly
 *   - unknown non-empty values warn (stderr) and fall back to `mailbox`
 */
export type CommBackend = "mailbox" | "commdb";

export function resolveCommBackend(): CommBackend {
	const raw = (process.env.FLYWHEEL_COMM_BACKEND ?? "mailbox")
		.trim()
		.toLowerCase();
	if (raw === "commdb") return "commdb";
	if (raw === "mailbox" || raw === "") return "mailbox";
	console.warn(
		`[flywheel] Unrecognized FLYWHEEL_COMM_BACKEND="${raw}" — falling back to "mailbox" default. Set to "mailbox" or "commdb" explicitly.`,
	);
	return "mailbox";
}
