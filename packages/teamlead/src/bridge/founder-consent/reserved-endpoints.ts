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
	| "approve_to_ship_gate"
	// FLY-1185 §2.12: issue-scoped lifecycle actions (park tombstone / unpark
	// supersede / manual approved apply). kind `issue_lifecycle` — deliberately
	// NOT in the gateway's runner-lifecycle enum (LIFECYCLE_ACTIONS filters
	// kind === "lifecycle"), so the FLY-245 Codex authorization surface is
	// unchanged.
	| "park_issue"
	| "unpark_issue"
	| "lifecycle_apply";

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
	// FLY-1185 §2.12: issue-scoped lifecycle endpoints (api-token guarded;
	// single mount each — no dashboard alias).
	{
		method: "POST",
		path: "/api/lifecycle/park",
		action: "park_issue",
		surface: "A",
	},
	{
		method: "POST",
		path: "/api/lifecycle/unpark",
		action: "unpark_issue",
		surface: "A",
	},
	{
		method: "POST",
		path: "/api/lifecycle-apply",
		action: "lifecycle_apply",
		surface: "A",
	},
	// Surface B — flywheel-comm respond wrapper
	{
		method: "POST",
		path: "/api/founder-consent/runner-gate-response",
		action: "approve_to_ship_gate",
		surface: "B",
	},
] as const;

// ── FLY-245 D-d: action-class metadata (plan §5.5 / Codex R2#4) ──────────────
//
// `RESERVED_ENDPOINTS` mixes lifecycle actions, the ship-gate `approve`, and the
// `approve_to_ship_gate` Surface-B action, and most actions have a dual mount
// (`/api/actions/*` + `/actions/*`). The Codex Lead gateway derives its
// runner-lifecycle action enum from THIS single source of truth — so each action
// needs explicit classification: which `kind` (exclude merge/ship from the
// lifecycle enum), the ONE canonical execution endpoint (collapsing the dual
// mount), the eligible target statuses (§5.4 resolution), the crash-recovery
// idempotency class (§5.2.1 — `retry` is the only non-idempotent action), and the
// postcondition verifier name (the verifier impls land in D-f/D2). A coverage test
// asserts every reserved action is classified EXACTLY once, so a new reserved
// endpoint can't silently drift out of the lifecycle authorization surface.

export type ActionClassKind = "lifecycle" | "ship_gate" | "issue_lifecycle";
export type IdempotencyClass = "idempotent" | "non_idempotent";

export interface ActionClassMeta {
	action: ActionKey;
	kind: ActionClassKind;
	/** The ONE canonical execution endpoint (dual `/api/actions/*` + `/actions/*`
	 * mounts collapse to this; close-* point at `/api/sessions/:id/close-*`). */
	canonicalEndpoint: string;
	/** Session statuses this lifecycle action may target (§5.4 exactly-one
	 * resolution filter). Refined against the FSM in Phase F real-machine QA. */
	eligibleStatuses: readonly string[];
	/** Crash-recovery idempotency class (§5.2.1). */
	idempotencyClass: IdempotencyClass;
	/** Name of the postcondition verifier used during crash recovery (impl D-f/D2;
	 * "n/a" for ship-gate actions, which are not gateway-executed lifecycle). */
	postconditionVerifier: string;
}

export const ACTION_CLASS_METADATA: readonly ActionClassMeta[] = [
	{
		action: "terminate",
		kind: "lifecycle",
		canonicalEndpoint: "/api/actions/terminate",
		eligibleStatuses: [
			"running",
			"awaiting_review",
			"blocked",
			"approved_to_ship",
		],
		idempotencyClass: "idempotent",
		postconditionVerifier: "session_terminal",
	},
	{
		action: "reject",
		kind: "lifecycle",
		canonicalEndpoint: "/api/actions/reject",
		eligibleStatuses: ["awaiting_review"],
		idempotencyClass: "idempotent",
		postconditionVerifier: "status_equals",
	},
	{
		action: "defer",
		kind: "lifecycle",
		canonicalEndpoint: "/api/actions/defer",
		eligibleStatuses: ["awaiting_review", "running"],
		idempotencyClass: "idempotent",
		postconditionVerifier: "status_equals",
	},
	{
		action: "shelve",
		kind: "lifecycle",
		canonicalEndpoint: "/api/actions/shelve",
		eligibleStatuses: ["awaiting_review", "running", "blocked"],
		idempotencyClass: "idempotent",
		postconditionVerifier: "status_equals",
	},
	{
		action: "retry",
		kind: "lifecycle",
		canonicalEndpoint: "/api/actions/retry",
		eligibleStatuses: ["failed", "blocked", "completed", "awaiting_review"],
		idempotencyClass: "non_idempotent",
		postconditionVerifier: "successor_started",
	},
	{
		action: "close_tmux",
		kind: "lifecycle",
		canonicalEndpoint: "/api/sessions/:id/close-tmux",
		eligibleStatuses: ["completed", "timeout", "failed", "awaiting_review"],
		idempotencyClass: "idempotent",
		postconditionVerifier: "tmux_absent",
	},
	{
		action: "close_runner",
		kind: "lifecycle",
		canonicalEndpoint: "/api/sessions/:id/close-runner",
		eligibleStatuses: ["completed", "timeout", "failed", "awaiting_review"],
		idempotencyClass: "idempotent",
		postconditionVerifier: "runner_absent",
	},
	{
		action: "approve",
		kind: "ship_gate",
		canonicalEndpoint: "/api/actions/approve",
		eligibleStatuses: ["awaiting_review"],
		idempotencyClass: "idempotent",
		postconditionVerifier: "n/a",
	},
	{
		action: "approve_to_ship_gate",
		kind: "ship_gate",
		canonicalEndpoint: "/api/founder-consent/runner-gate-response",
		eligibleStatuses: ["awaiting_review"],
		idempotencyClass: "idempotent",
		postconditionVerifier: "n/a",
	},
	// FLY-1185 §2.12: issue-scoped actions — kind `issue_lifecycle` keeps them
	// OUT of the gateway's runner-lifecycle enum (statuses are issue-level,
	// not session-level, hence the sentinel "any").
	{
		action: "park_issue",
		kind: "issue_lifecycle",
		canonicalEndpoint: "/api/lifecycle/park",
		eligibleStatuses: ["any"],
		idempotencyClass: "idempotent",
		postconditionVerifier: "issue_tombstone_active",
	},
	{
		action: "unpark_issue",
		kind: "issue_lifecycle",
		canonicalEndpoint: "/api/lifecycle/unpark",
		eligibleStatuses: ["any"],
		idempotencyClass: "idempotent",
		postconditionVerifier: "issue_tombstone_superseded",
	},
	{
		action: "lifecycle_apply",
		kind: "issue_lifecycle",
		canonicalEndpoint: "/api/lifecycle-apply",
		eligibleStatuses: ["any"],
		idempotencyClass: "idempotent",
		postconditionVerifier: "manifest_hash_consumed",
	},
] as const;

/** Lookup the class metadata for an action (undefined if unclassified). */
export function getActionClassMeta(
	action: string,
): ActionClassMeta | undefined {
	return ACTION_CLASS_METADATA.find((m) => m.action === action);
}

/** The runner-lifecycle action enum DERIVED from the SSOT (excludes ship-gate
 * actions). The gateway maps the model's intent only to one of these. */
export const LIFECYCLE_ACTIONS: readonly ActionKey[] =
	ACTION_CLASS_METADATA.filter((m) => m.kind === "lifecycle").map(
		(m) => m.action,
	);

/** True when `action` is a gateway-executable runner-lifecycle action. */
export function isLifecycleAction(action: string): boolean {
	return LIFECYCLE_ACTIONS.includes(action as ActionKey);
}

/** The `runner_lifecycle:<action>` CommDB checkpoint for a lifecycle action. */
export function lifecycleCheckpoint(action: string): string {
	return `runner_lifecycle:${action}`;
}

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
