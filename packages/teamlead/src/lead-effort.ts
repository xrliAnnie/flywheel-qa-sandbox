/**
 * FLY-671: per-Lead reasoning-effort control. This is the LOW-LEVEL source of
 * truth for the effort enum — it lives next to `ProjectConfig.ts` and has NO
 * dependency on the bridge / fleet-capabilities UI layer, so config parsing can
 * validate effort without inverting the dependency direction (bridge depends on
 * ProjectConfig, never the reverse — Codex design review R1 MEDIUM-7).
 *
 * The five levels mirror the Claude Code CLI `--effort <level>` flag
 * (`claude --help`: low, medium, high, xhigh, max). Lowering a Lead's effort
 * from the account default (effectively xhigh) to high/medium directly saves
 * tokens — the cost lever Annie asked for. Effort is orthogonal to model: you
 * pick a model AND an effort.
 *
 * The `packages/config` package keeps its own local copy (`RoleEffort` /
 * `ROLE_EFFORT_LEVELS`) for the runner side rather than importing this — the
 * FLY-123 cross-package boundary forbids config depending on teamlead.
 */

export type LeadEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORT_LEVELS: readonly LeadEffort[] = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** Type guard: true iff `v` is one of the five recognized effort levels. */
export function isLeadEffort(v: unknown): v is LeadEffort {
	return (
		typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v)
	);
}
