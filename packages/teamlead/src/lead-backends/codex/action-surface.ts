/**
 * FLY-245 Phase A3 — non-MCP action-surface guard (plan §3.5 / Codex R2#1).
 *
 * The MCP allowlist (Phase A2) only constrains MCP *servers*. Codex app-server
 * also exposes BUILT-IN / non-MCP capability surfaces — Apps/connectors, hooks,
 * multi-agent spawn, skill auto-install, login, web search. Any of these that can
 * reach GitHub / the Bridge / external side effects would be an ACTION-BYPASS
 * around the gateway, breaking the "gateway is the only out-of-sandbox action
 * channel" invariant.
 *
 * Two parts:
 *   1. NON_MCP_ACTION_SURFACES — the checklist of surfaces a write-capable Lead
 *      must explicitly disable via managed-CODEX_HOME config. The EXACT config
 *      keys + their effect are confirmed by Phase F real-machine QA (the schema
 *      cache does not enumerate the model-facing tool surface), so the disable
 *      ARGV is assembled there. This list is the spec F implements against.
 *   2. assertActionToolSurface() — the load-bearing RUNTIME guard: the set of
 *      model-callable tools observed at startup must be a SUBSET of the approved
 *      gateway tools. Any extra action-capable tool (a live connector, a built-in
 *      egress tool) fails the Lead closed — even if a disable key was wrong, the
 *      assertion catches the residual surface.
 */

/** The non-MCP capability surfaces a write-capable Codex Lead must disable. The
 * disable config keys are verified + wired in Phase F real-machine QA (§3.5). */
export const NON_MCP_ACTION_SURFACES = [
	"web_search",
	"connectors",
	"apps",
	"hooks",
	"multi_agent",
	"skill_install",
	"login",
] as const;

export type NonMcpActionSurface = (typeof NON_MCP_ACTION_SURFACES)[number];

/**
 * The SSOT of gateway action tools a write-capable Codex Lead may reach.
 * `gateway-main.ts` registers EXACTLY these; the runtime asserts the
 * model-callable surface equals this set. Adding a tool to the gateway MUST add
 * it here, or the runtime assertion fail-closes (drift guard).
 *
 * Two classes:
 *  - FLY-245 RESERVED (founder-gated, per-handler CodexFounderPreflight /
 *    lifecycle consent): `request_runner_lifecycle`, `relay_ship_decision`.
 *  - FLY-350 (Z) SCOPED (NOT founder-gated — they cannot reach the merge red
 *    line; alias/scope-gated + audited): `discord_send` (proactive roundtable/
 *    chat post), `git_push` + `open_pr` (gateway-proxied PR — push a feature
 *    branch / open a PR ≠ merge; the net-off shell holds no GH_TOKEN and the
 *    gateway exposes no merge/:cool: tool, so self-merge is structurally
 *    impossible).
 * `start_runner`/`read_runner_tmux`/etc. are FLY-251 and deliberately NOT here.
 */
export const GATEWAY_ACTION_TOOL_NAMES = [
	"request_runner_lifecycle",
	"relay_ship_decision",
	"discord_send",
	"git_push",
	"open_pr",
] as const;

/**
 * HARD-ASSERT the model-callable tool surface is EXACTLY the approved gateway
 * tools (plan §3.5 / §7 release condition ⑧, Codex code-review R1 HIGH-1).
 *
 * `observed` is the set of tools the app-server advertises as callable by the
 * model (collected by the runtime from MCP tool advertisements). Two ways to
 * fail closed — both are action-bypass risks the old subset check let through:
 *   - an EMPTY observed set: we never PROVED the surface, so we must not unlock
 *     write capability on the strength of "saw nothing" (HIGH-1);
 *   - EXACT-equality, not subset: any EXTRA tool (a live connector / built-in
 *     egress tool) OR any MISSING approved tool means the observed surface is
 *     not the one we vetted.
 *
 * Pure.
 */
export function assertActionToolSurface(
	observed: readonly string[],
	approvedGatewayTools: readonly string[],
): void {
	const observedSet = new Set(observed);
	if (observedSet.size === 0) {
		throw new Error(
			"FLY-245 action-surface assertion failed: no model-callable tools observed — " +
				"the tool surface was never proven, so a write-capable Codex Lead must fail closed (plan §3.5 / §7 ⑧, HIGH-1). " +
				"If the app-server's tool-advertisement shape differs from what the runtime collects, the Phase F threat-matrix QA must pin it.",
		);
	}
	const approved = new Set(approvedGatewayTools);
	const extra = [...observedSet].filter((t) => !approved.has(t));
	const missing = [...approved].filter((t) => !observedSet.has(t));
	if (extra.length > 0 || missing.length > 0) {
		const parts: string[] = [];
		if (extra.length > 0) parts.push(`extra [${extra.sort().join(", ")}]`);
		if (missing.length > 0)
			parts.push(`missing [${missing.sort().join(", ")}]`);
		throw new Error(
			`FLY-245 action-surface assertion failed: model-callable tools must EQUAL the gateway allowlist — ${parts.join("; ")}. ` +
				"A write-capable Codex Lead may only reach actions through the flywheel_gateway; disable the offending connector/built-in surface (plan §3.5).",
		);
	}
}

/**
 * The ⑧ runtime guard, bound to the canonical gateway tool set. The runtime
 * calls this after the MCP inventory is confirmed and BEFORE any thread is
 * usable — an observed surface that isn't exactly the gateway's two reserved
 * tools fails the Lead closed.
 */
export function assertGatewayOnlyToolSurface(
	observed: readonly string[],
): void {
	assertActionToolSurface(observed, GATEWAY_ACTION_TOOL_NAMES);
}
