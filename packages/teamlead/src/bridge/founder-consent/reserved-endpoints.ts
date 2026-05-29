/**
 * FLY-175 Track 2 — Single source of truth for the reserved-action set.
 *
 * Mirrors the Track 1 R1+R2 reserved actions (plan §4.3). The middleware and
 * the gate-response router consult these tables; the test
 * `reserved-endpoints.test.ts` asserts the table contains EXACTLY the 14
 * Surface A entries + 1 Surface B entry so the set can't silently drift.
 */

import type { Request } from "express";

/** All founder-gated action keys. */
export type ActionKey =
	| "approve"
	| "close_tmux"
	| "close_runner"
	| "terminate"
	| "reject"
	| "defer"
	| "shelve"
	| "retry"
	| "approve_to_ship_gate";

/**
 * Action keys handled by the Bridge action router (`/api/actions/:action`
 * and the `/actions/:action` dashboard alias). These are matched against
 * `req.params.action` / the first path segment.
 */
export const ACTION_ROUTER_RESERVED: ReadonlySet<string> = new Set([
	"approve",
	"terminate",
	"retry",
	"reject",
	"defer",
	"shelve",
]);

/** Surface A endpoint descriptors — for the table-integrity test + docs. */
export interface ReservedEndpoint {
	method: "POST";
	path: string;
	action: ActionKey;
	surface: "A" | "B";
}

export const RESERVED_ENDPOINTS: readonly ReservedEndpoint[] = [
	// Surface A — action router (auth) + dashboard alias (no-auth loopback)
	{
		method: "POST",
		path: "/api/actions/approve",
		action: "approve",
		surface: "A",
	},
	{ method: "POST", path: "/actions/approve", action: "approve", surface: "A" },
	{
		method: "POST",
		path: "/api/sessions/:id/close-tmux",
		action: "close_tmux",
		surface: "A",
	},
	{
		method: "POST",
		path: "/api/sessions/:id/close-runner",
		action: "close_runner",
		surface: "A",
	},
	{
		method: "POST",
		path: "/api/actions/terminate",
		action: "terminate",
		surface: "A",
	},
	{
		method: "POST",
		path: "/actions/terminate",
		action: "terminate",
		surface: "A",
	},
	{
		method: "POST",
		path: "/api/actions/reject",
		action: "reject",
		surface: "A",
	},
	{ method: "POST", path: "/actions/reject", action: "reject", surface: "A" },
	{ method: "POST", path: "/api/actions/defer", action: "defer", surface: "A" },
	{ method: "POST", path: "/actions/defer", action: "defer", surface: "A" },
	{
		method: "POST",
		path: "/api/actions/shelve",
		action: "shelve",
		surface: "A",
	},
	{ method: "POST", path: "/actions/shelve", action: "shelve", surface: "A" },
	{ method: "POST", path: "/api/actions/retry", action: "retry", surface: "A" },
	{ method: "POST", path: "/actions/retry", action: "retry", surface: "A" },
	// Surface B — flywheel-comm respond wrapper
	{
		method: "POST",
		path: "/api/founder-consent/runner-gate-response",
		action: "approve_to_ship_gate",
		surface: "B",
	},
] as const;

/**
 * How a middleware mount resolves the action key + executionId for an
 * incoming request. The action router mounts read the action from the path
 * and the executionId from the body (`execution_id`, snake_case — matches the
 * existing handler). The session-close mounts have a fixed action and read
 * executionId from the route params.
 */
export type MountKind = "action_router" | "close_tmux" | "close_runner";

export interface ResolvedReservedAction {
	action: ActionKey;
	executionId?: string;
}

/**
 * Resolve the reserved action + executionId for a request hitting a given
 * mount. Returns `null` when the request is NOT a reserved action (so the
 * middleware passes it straight through — e.g. an unknown `/api/actions/foo`).
 */
export function resolveReservedAction(
	mount: MountKind,
	req: Request,
): ResolvedReservedAction | null {
	const paramExecId =
		typeof req.params.executionId === "string"
			? req.params.executionId
			: undefined;
	if (mount === "close_tmux") {
		return { action: "close_tmux", executionId: paramExecId };
	}
	if (mount === "close_runner") {
		return { action: "close_runner", executionId: paramExecId };
	}

	// action_router: first path segment after the mount, e.g. "/approve".
	const seg = req.path.replace(/^\/+/, "").split("/")[0];
	if (!seg || !ACTION_ROUTER_RESERVED.has(seg)) {
		return null;
	}
	const body = (req.body ?? {}) as {
		execution_id?: string;
		executionId?: string;
	};
	return {
		action: seg as ActionKey,
		executionId: body.execution_id ?? body.executionId,
	};
}
