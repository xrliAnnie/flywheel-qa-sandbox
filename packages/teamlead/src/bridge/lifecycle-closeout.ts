/**
 * FLY-1185 §2.12 — the unified lifecycle-closeout executor.
 *
 * ONE checklist, FIVE entries (plan §0.5): A ship-terminal, B explicit
 * close/terminate, C crash reap, D issue-terminal reconcile (FLY-1165
 * engine), E periodic sweep. All five call THIS module for the issue-level
 * work; each keeps its own battle-tested primitives for the parts it
 * already shipped (tmux kill sequences, archive sinks, Linear finalizers).
 *
 * CONTRACTS enforced here:
 *   - IssueDisposition ∈ shipped | canceled | founder_parked, with an
 *     EXHAUSTIVE per-status action table for `canceled` (R9#3) — a canceled
 *     issue NEVER fabricates `completed`, and forceStatus is never used;
 *   - per-node hard order (FLY-228 transition-first): fresh status re-read
 *     → legal FSM transition → MCP reap + kill (via closeRunner, which
 *     reaps MCP descendants before its kill sequence) → confirmed gone;
 *     a failed transition leaves MCP + window with ZERO signals and blocks
 *     the node's remaining items;
 *   - issue-level items run only after ALL related nodes are confirmed
 *     closed/already-gone; the Linear consistency item runs LAST;
 *   - everything runs inside the per-root issue mutex (R10#2); disposition
 *     arbitration: an ACTIVE founder park intent outranks everything;
 *     conflicting authorities → `disposition_conflict`, zero mutation.
 */

import { WORKFLOW_TRANSITIONS } from "flywheel-core";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { applyTransition } from "../applyTransition.js";
import type { StateStore } from "../StateStore.js";
import {
	AUTO_CLOSE_STATES,
	closeRunner,
	FINALIZE_DONE_SOURCE_STATES,
} from "./close-runner.js";
import { finalizeCommDbSession } from "./commdb-session-prune.js";
import { isUuidKey, resolveLifecycleRootKey } from "./lifecycle-root-key.js";
import type { WithRepoLock } from "./repo-mutation-lock.js";
import {
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	type RunnerLiveness,
} from "./tmux-lookup.js";
import { sqliteDatetime } from "./types.js";

export type IssueDisposition = "shipped" | "canceled" | "founder_parked";

/** The authority that legitimizes an automatic closeout (allowlist, §2.12). */
export type CloseoutAuthority =
	| "ship_complete"
	| "linear_reconcile"
	| "founder_park";

/**
 * R9#3 — the EXHAUSTIVE canceled-disposition table over every persisted
 * session status. Full-matrix unit tests pin this.
 *   terminate         → FSM transition to terminated, then teardown
 *   preserve_teardown → status untouched (forensics preserved), live target
 *                       torn down under the issue-terminal authority with an
 *                       explicit `forensics_released_by_issue_terminal` audit
 *   already_terminal  → no transition; teardown only if the husk is live
 */
export const CANCELED_STATUS_ACTIONS: Record<
	string,
	"terminate" | "preserve_teardown" | "already_terminal"
> = {
	pending: "terminate",
	running: "terminate",
	design_done: "terminate",
	awaiting_review: "terminate",
	approved_to_ship: "terminate",
	blocked: "preserve_teardown",
	failed: "preserve_teardown",
	completed: "already_terminal",
	terminated: "already_terminal",
	rejected: "already_terminal",
	deferred: "already_terminal",
	shelved: "already_terminal",
	approved: "already_terminal",
};

export interface CloseoutNode {
	executionId: string;
	issueKey: string;
	projectName: string;
	role: "root" | "session" | "qa" | "launch_claim";
	status?: string;
	qaStatus?: string;
	/**
	 * FLY-1185 (Codex R6#1): a `session` node whose execution ALSO holds an
	 * open (starting/active) launch claim with NO durable worktree binding yet
	 * — i.e. emitStarted wrote the session row synchronously but the Blueprint
	 * has not reached emitWorktreeReady, so the worktree/window don't exist and
	 * lookupTarget would wrongly say "gone". Such a node must NOT be declared
	 * gone (the spawn will still create the runner); confirmedGone stays false
	 * so the intent remains PARTIAL and the replay owns the born runner.
	 */
	claimInFlight?: boolean;
}

export type NodeOutcome =
	| { state: "done"; detail?: string }
	| { state: "skipped"; reason: string }
	| { state: "failed"; error: string }
	| { state: "blocked"; prerequisite: string };

export interface NodeClosureReport {
	node: CloseoutNode;
	transition: NodeOutcome;
	teardown: NodeOutcome;
	confirmedGone: boolean;
	/** FLY-1238: unresolved founder gates and the CommDB session were retired
	 * atomically. Issue-level cleanup is blocked until both this and
	 * confirmedGone are true. */
	communicationsFinalized: boolean;
}

export interface ClosureReport {
	rootKey: string;
	aliasKeys: string[];
	disposition: IssueDisposition;
	authority: CloseoutAuthority;
	nodes: NodeClosureReport[];
	/** blocked_open_pr / blocked_linear_child style operator items. */
	operatorItems: string[];
	outcome: "complete" | "partial" | "needs_operator" | "conflict" | "blocked";
}

// ── Node collection (R8#3 — FLY-799 collector extended + wired) ────────────

/**
 * The authoritative issue-level node collector: sessions across the full
 * alias set (includes DAG workflow sessions — they share the issue) ∪
 * auto-QA children by parent issue keys ∪ open launch claims on the root.
 * Deduped by executionId.
 */
export function collectIssueCloseoutNodes(
	store: Pick<
		StateStore,
		| "getSessionsForIssueAliases"
		| "findAutoQaRecordsByParentIssueKeys"
		| "listOpenLaunchClaims"
		| "getSession"
		| "getWorktreeBinding"
	>,
	args: { rootKey: string; aliasKeys: string[]; projectName: string },
): CloseoutNode[] {
	const byExec = new Map<string, CloseoutNode>();

	for (const row of store.getSessionsForIssueAliases(args.aliasKeys)) {
		byExec.set(row.execution_id, {
			executionId: row.execution_id,
			issueKey: row.issue_id,
			projectName: row.project_name,
			role: "session",
			status: row.status,
		});
	}

	for (const rec of store.findAutoQaRecordsByParentIssueKeys(args.aliasKeys)) {
		if (!rec.qa_execution_id) continue;
		const session = store.getSession(rec.qa_execution_id);
		byExec.set(rec.qa_execution_id, {
			executionId: rec.qa_execution_id,
			issueKey: rec.qa_issue_id ?? rec.issue_id,
			projectName: rec.project_name,
			role: "qa",
			status: session?.status,
			qaStatus: rec.status,
		});
	}

	for (const claim of store.listOpenLaunchClaims(args.rootKey)) {
		const existing = byExec.get(claim.executionId);
		if (existing) {
			// R6#1: a session row was written by emitStarted (synchronously,
			// before the worktree/binding), yet the launch claim is STILL
			// starting/active. With no durable binding the spawn is mid-flight —
			// mark the node so closeout keeps it confirmedGone=false / intent
			// PARTIAL, so a park can't complete before the runner is born.
			if (
				(claim.state === "starting" || claim.state === "active") &&
				!store.getWorktreeBinding(claim.executionId)
			) {
				existing.claimInFlight = true;
			}
			continue;
		}
		const session = store.getSession(claim.executionId);
		byExec.set(claim.executionId, {
			executionId: claim.executionId,
			issueKey: args.rootKey,
			projectName: claim.project,
			role: "launch_claim",
			status: session?.status,
		});
	}

	return [...byExec.values()];
}

// ── The closeout ────────────────────────────────────────────────────────────

/**
 * FLY-1185 (Codex R1#14) — cooperative per-node mutator budget. Checked
 * BEFORE every node mutation; exhausted → the node reports
 * `blocked(budget_exhausted)` and the closeout returns partial so the next
 * run continues. D passes its per-run cap; other entries may omit (∞).
 */
export interface CloseoutBudget {
	/** Consume one mutator slot; false = exhausted (no mutation may run). */
	tryConsume: () => boolean;
	/** Deadline / cooperative abort; true = stop before the next node. */
	shouldStop?: () => boolean;
}

export interface LifecycleCloseoutDeps {
	store: StateStore;
	transitionOpts: ApplyTransitionOpts;
	/** Per-root issue mutex — the SAME keyed lock the admission decorator uses.
	 * (A re-entrant keyed mutex; keys are canonical root UUIDs.) */
	withIssueMutex: <T>(keys: string[], fn: () => Promise<T>) => Promise<T>;
	/**
	 * FLY-1185 hard constraint (Codex R1#4): optional integration seam. When a
	 * caller supplies false, closeout reports blocked(autoclean_disabled) with
	 * ZERO mutators run. Production uses the always-on default.
	 */
	mutationEnabled?: () => boolean;
	/** Codex R1#14 — per-run mutator budget/deadline (D entry supplies). */
	budget?: CloseoutBudget;
	/**
	 * Codex R2#5 — fresh external-authority re-check, called BEFORE every node
	 * mutation and every issue-level item. "reopened"/"unknown" blocks the
	 * remaining work for this issue (a founder reopen during a long closeout
	 * must WIN). D injects a fresh Linear lookup; the manual apply injects the
	 * lock-held Linear verification. Absent → the entry's own authority
	 * (merge proof / founder intent) stands.
	 */
	freshAuthority?: () => Promise<"authorized" | "reopened" | "unknown">;
	/** Repo lock — passed through to worktree/branch items when wired. */
	withRepoLock?: WithRepoLock;
	closeRunnerFn?: typeof closeRunner;
	finalizeCommDbSessionFn?: typeof finalizeCommDbSession;
	lookupTarget?: typeof lookupTmuxTarget;
	probeLiveness?: (w: string) => Promise<RunnerLiveness>;
	/** Optional fresh-Linear alias contributor (D entry supplies its lookup). */
	extraAliases?: string[];
	/** Issue-level items, injected per entry (thread archive / Linear / etc.).
	 * Run ONLY after all nodes are confirmed closed; Linear item runs LAST. */
	/**
	 * FLY-1185 R9#5: canceled/parked open-PR disposal — the mechanically-bound
	 * auto-close (or `blocked_open_pr` operator item). Runs BEFORE the thread
	 * archive. Absent → open PRs are untouched (byte-compat).
	 */
	openPrDisposal?: (args: {
		disposition: IssueDisposition;
		aliasKeys: string[];
		/** R3#13: per-PR budget — each `gh pr close` consumes one slot. */
		budget?: CloseoutBudget;
	}) => Promise<{ blockedItems?: string[] } | undefined>;
	archiveThreads?: (aliasKeys: string[]) => Promise<void>;
	linearConsistency?: (args: {
		disposition: IssueDisposition;
		aliasKeys: string[];
	}) => Promise<{ blockedItems?: string[] } | undefined>;
	audit?: (event: string, detail: Record<string, unknown>) => void;
	log?: (msg: string) => void;
}

export interface CloseoutInput {
	issueKey: string;
	projectName: string;
	disposition: IssueDisposition;
	authority: CloseoutAuthority;
}

function makeAudit(
	store: StateStore,
	input: Pick<CloseoutInput, "issueKey" | "projectName">,
	override?: (event: string, detail: Record<string, unknown>) => void,
): (event: string, detail: Record<string, unknown>) => void {
	return (
		override ??
		((event: string, detail: Record<string, unknown>) => {
			try {
				store.insertEvent({
					event_id: `lifecycle-closeout-${event}-${input.issueKey}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
					execution_id: `closeout-${input.issueKey}`,
					issue_id: input.issueKey,
					project_name: input.projectName,
					event_type: event,
					source: "bridge.lifecycle-closeout",
					payload: detail,
				});
			} catch {
				/* audit must not break closeout */
			}
		})
	);
}

/** Production closeout mutations are permanently enabled. */
function defaultMutationEnabled(): boolean {
	return true;
}

/**
 * FLY-1185 (Codex R7#1 + R8#1 + R9#1): the set of statuses a resume may see on
 * a still-present approved node — its approved START status plus the ONLY
 * terminal status the epoch's OWN first run could have produced from that start
 * status. This mirrors the executor's per-node branch EXACTLY (role + qaStatus
 * + status + disposition), so a node can never be waved through with a terminal
 * status only ANOTHER role could produce:
 *   - canceled/park: CANCELED_STATUS_ACTIONS — `terminate` start → `terminated`;
 *     preserve/already-terminal → unchanged.
 *   - shipped, non-PASS QA (role=qa, qaStatus≠passed): terminate iff the status
 *     is not already an AUTO_CLOSE terminal (mirrors `wantTerminate`).
 *   - shipped, any other node (root/session/PASS-QA): finalize to `completed`
 *     ONLY from a FINALIZE_DONE source status; otherwise unchanged.
 * The approved snapshot carries `role`/`qaStatus` per node (R9#1) so the guard
 * can make this exact determination.
 */
export function resumeAllowedNodeStatuses(
	disposition: IssueDisposition,
	role: string | undefined,
	qaStatus: string | undefined,
	approvedStatus: string,
): Set<string> {
	// A node the epoch never mutates may only appear unchanged.
	const unchanged = new Set<string>([approvedStatus]);
	if (disposition === "canceled" || disposition === "founder_parked") {
		const action =
			CANCELED_STATUS_ACTIONS[approvedStatus] ?? "preserve_teardown";
		return action === "terminate"
			? new Set<string>([approvedStatus, "terminated"])
			: unchanged;
	}
	// shipped — mirror the executor's role/qaStatus branch EXACTLY (R11#1). The
	// shipped non-PASS QA executor sets `wantTerminate = !AUTO_CLOSE_STATES.has`
	// and then goes through the production FSM, so `terminated` is self-produced
	// iff the status is NOT an AUTO_CLOSE terminal AND the FSM has a legal
	// status→terminated edge. That set is
	// pending/running/design_done/awaiting_review/approved_to_ship/blocked/failed;
	// `approved` (FSM `approved:[]`) and `timeout` (no FSM entry) have no
	// terminate edge → unchanged. (The canceled table is NOT the source of truth
	// here — it marks blocked/failed `preserve_teardown`, which the shipped QA
	// path does not.)
	if (role === "qa" && qaStatus !== "passed") {
		const fsmCanTerminate =
			!AUTO_CLOSE_STATES.has(approvedStatus) &&
			(WORKFLOW_TRANSITIONS[approvedStatus] ?? []).includes("terminated");
		return fsmCanTerminate
			? new Set<string>([approvedStatus, "terminated"])
			: unchanged;
	}
	if (FINALIZE_DONE_SOURCE_STATES.has(approvedStatus)) {
		return new Set<string>([approvedStatus, "completed"]);
	}
	return unchanged;
}
/** R6#3/R7#1: the claim states the epoch's own first run may have produced. */
const RESUME_TERMINAL_CLAIM_STATE = new Set<string>(["closed", "cancelled"]);

/**
 * FLY-1185 (Codex R5#4 + R6#3): does the CURRENT snapshot DRIFT from the
 * APPROVED one in a way the founder did NOT approve? Returns the FIRST drift
 * descriptor (for the reject reason), or undefined when the current snapshot is
 * a legal continuation of the approved one. plan.md:158 requires a whole-issue
 * reject on ANY unapproved drift — so this compares the FULL canonical record
 * of every object still present (node status, claim state, binding
 * branch/generation, PR number/head), NOT just executionIds:
 *   - a NEW object (executionId/thread not in approved) → drift (widening).
 *   - a MISSING approved object → tolerated (the first run finished it).
 *   - a node whose status changed to a NON-terminal value, or a claim whose
 *     state changed to a NON-terminal value → drift (only the epoch's own
 *     terminal transition is allowed).
 *   - a binding whose branch/generation changed, or a PR whose number/head
 *     advanced → drift (these are set-once / append-only; any change is a new
 *     object the founder never saw).
 */
function snapshotDriftsApproved(
	approvedJson: string,
	currentJson: string,
	disposition: IssueDisposition,
): string | undefined {
	type Node = {
		executionId?: string;
		status?: string;
		role?: string;
		qaStatus?: string;
	};
	type Claim = { executionId?: string; state?: string };
	type Binding = { executionId?: string; branch?: string; generation?: string };
	type Pr = { executionId?: string; prNumber?: number; prHeadSha?: string };
	type ObjSet = {
		nodes?: Node[];
		claims?: Claim[];
		bindings?: Binding[];
		prs?: Pr[];
		threadIds?: string[];
	};
	let approved: ObjSet;
	let current: ObjSet;
	try {
		approved = JSON.parse(approvedJson) as ObjSet;
		current = JSON.parse(currentJson) as ObjSet;
	} catch {
		// Unparseable snapshot → fail-closed (never resume against a snapshot we
		// cannot verify).
		return "unparseable_snapshot";
	}
	const byId = <T extends { executionId?: string }>(
		arr: T[] | undefined,
	): Map<string, T> =>
		new Map((arr ?? []).map((o) => [o.executionId ?? "", o]));

	// Nodes: a still-present node may ONLY have moved to a status the epoch's OWN
	// first run could have produced from its approved START status under this
	// disposition (R8#1 — preserve/already-terminal nodes may not change at all).
	// A MISSING approved node is rejected — this closeout never DELETES a session
	// row, so a vanished node is an external mutation, not epoch progress (R7#1).
	const aNodes = byId(approved.nodes);
	const cNodes = byId(current.nodes);
	for (const n of current.nodes ?? []) {
		const a = aNodes.get(n.executionId ?? "");
		if (!a) return `new_node:${n.executionId}`;
		// R10#1: role + qaStatus are set-once provenance this closeout never
		// mutates — any drift changes WHICH executor branch applies (terminate vs
		// finalizeDone), so a byte-exact mismatch is a whole-issue reject. This
		// catches e.g. AutoQaCoordinator flipping a non-PASS QA to `passed`
		// between the approval and a partial-resume while the session status is
		// unchanged (which the status check alone would wave through).
		if ((n.role ?? "") !== (a.role ?? "")) {
			return `node_role:${n.executionId}:${a.role}->${n.role}`;
		}
		if ((n.qaStatus ?? "") !== (a.qaStatus ?? "")) {
			return `node_qastatus:${n.executionId}:${a.qaStatus}->${n.qaStatus}`;
		}
		if (
			n.status !== a.status &&
			!resumeAllowedNodeStatuses(
				disposition,
				a.role,
				a.qaStatus,
				a.status ?? "",
			).has(n.status ?? "")
		) {
			return `node_status:${n.executionId}:${a.status}->${n.status}`;
		}
	}
	for (const id of aNodes.keys()) {
		if (!cNodes.has(id)) return `missing_node:${id}`;
	}
	// Claims: field drift → reject; a MISSING approved claim is allowed (this
	// DAG cancels/closes launch claims as part of its own work).
	const aClaims = byId(approved.claims);
	for (const c of current.claims ?? []) {
		const a = aClaims.get(c.executionId ?? "");
		if (!a) return `new_claim:${c.executionId}`;
		if (
			c.state !== a.state &&
			!RESUME_TERMINAL_CLAIM_STATE.has(c.state ?? "")
		) {
			return `claim_state:${c.executionId}:${a.state}->${c.state}`;
		}
	}
	// Bindings: set-once — ANY field change → reject; a MISSING approved binding
	// is rejected (the closeout does not clear binding metadata).
	const aBindings = byId(approved.bindings);
	const cBindings = byId(current.bindings);
	for (const b of current.bindings ?? []) {
		const a = aBindings.get(b.executionId ?? "");
		if (!a) return `new_binding:${b.executionId}`;
		if (b.branch !== a.branch || b.generation !== a.generation) {
			return `binding_drift:${b.executionId}`;
		}
	}
	for (const id of aBindings.keys()) {
		if (!cBindings.has(id)) return `missing_binding:${id}`;
	}
	// PRs: append-only — number/head change → reject; a MISSING approved PR is
	// rejected (a vanished PR record is an external mutation).
	const aPrs = byId(approved.prs);
	const cPrs = byId(current.prs);
	for (const p of current.prs ?? []) {
		const a = aPrs.get(p.executionId ?? "");
		if (!a) return `new_pr:${p.executionId}`;
		if (p.prNumber !== a.prNumber || p.prHeadSha !== a.prHeadSha) {
			return `pr_drift:${p.executionId}`;
		}
	}
	for (const id of aPrs.keys()) {
		if (!cPrs.has(id)) return `missing_pr:${id}`;
	}
	// Threads: a NEW thread → reject; a MISSING thread is allowed (this DAG
	// archives threads as part of its own work).
	const aThreads = new Set(approved.threadIds ?? []);
	for (const t of current.threadIds ?? []) {
		if (!aThreads.has(t)) return `new_thread:${t}`;
	}
	return undefined;
}

export async function closeoutIssue(
	deps: LifecycleCloseoutDeps,
	input: CloseoutInput,
	/** R4#3: the post-ship DAG already holds the canonical issue mutex (the
	 * keyed lock is not re-entrant) — skip the executor's own acquisition. */
	opts?: { alreadyLocked?: boolean },
): Promise<ClosureReport> {
	const { store } = deps;
	// R4#7: integration seam BEFORE any resolution/audit — false means ZERO
	// StateStore writes from this entry (console only), same contract as park.
	const mutationEnabled = deps.mutationEnabled ?? defaultMutationEnabled;
	if (!mutationEnabled()) {
		console.warn(
			`[lifecycle-closeout] mutations disabled — closeout skipped for ${input.issueKey} (zero writes)`,
		);
		return {
			rootKey: input.issueKey,
			aliasKeys: [input.issueKey],
			disposition: input.disposition,
			authority: input.authority,
			nodes: [],
			operatorItems: ["autoclean_disabled"],
			outcome: "blocked",
		};
	}
	const audit = makeAudit(store, input, deps.audit);

	const resolution = resolveLifecycleRootKey(
		store,
		input.issueKey,
		deps.extraAliases ?? [],
	);
	const identifierShip =
		!resolution.ok &&
		resolution.reason === "no_uuid_mapping" &&
		input.disposition === "shipped" &&
		input.authority === "ship_complete";
	if (!resolution.ok && !identifierShip) {
		audit("closeout_root_unresolved", {
			issueKey: input.issueKey,
			reason: resolution.reason,
		});
		return {
			rootKey: input.issueKey,
			aliasKeys: resolution.aliasKeys,
			disposition: input.disposition,
			authority: input.authority,
			nodes: [],
			operatorItems: [],
			outcome: "blocked",
		};
	}
	const resolved = resolution.ok
		? resolution
		: {
				rootKey: input.issueKey,
				aliasKeys: resolution.aliasKeys,
				lockKeys: resolution.lockKeys,
			};

	if (opts?.alreadyLocked) {
		return closeoutIssueLocked(deps, input, resolved, audit);
	}
	return deps.withIssueMutex(resolved.lockKeys, () =>
		closeoutIssueLocked(deps, input, resolved, audit),
	);
}

/**
 * FLY-1185 (Codex R1#5) — founder park executed ATOMICALLY under the issue
 * mutex: tombstone write + trusted terminal-authority claim + closeout run
 * inside ONE mutex hold, so a concurrent spawn admission can never interleave
 * between the tombstone becoming active and the closeout collecting nodes.
 */
export async function parkIssue(
	deps: LifecycleCloseoutDeps,
	input: {
		issueUuid: string;
		projectName: string;
		founderDecisionId: string;
	},
): Promise<ClosureReport> {
	const { store } = deps;
	const closeoutInput: CloseoutInput = {
		issueKey: input.issueUuid,
		projectName: input.projectName,
		disposition: "founder_parked",
		authority: "founder_park",
	};
	// R5#7: master switch BEFORE any audit/resolution write — an unresolved /
	// A caller-disabled uuid-conflict direct park must be ZERO-write (console
	// only), same contract as closeoutIssue.
	const mutationEnabledTop = deps.mutationEnabled ?? defaultMutationEnabled;
	if (!mutationEnabledTop()) {
		console.warn(
			`[lifecycle-closeout] mutations disabled — park skipped for ${input.issueUuid} (zero writes)`,
		);
		return {
			rootKey: input.issueUuid,
			aliasKeys: [input.issueUuid],
			disposition: "founder_parked",
			authority: "founder_park",
			nodes: [],
			operatorItems: ["autoclean_disabled"],
			outcome: "blocked",
		};
	}
	const audit = makeAudit(store, closeoutInput, deps.audit);
	const resolution = resolveLifecycleRootKey(store, input.issueUuid, []);
	if (!resolution.ok) {
		audit("closeout_root_unresolved", {
			issueKey: input.issueUuid,
			reason: resolution.reason,
		});
		return {
			rootKey: input.issueUuid,
			aliasKeys: resolution.aliasKeys,
			disposition: "founder_parked",
			authority: "founder_park",
			nodes: [],
			operatorItems: [],
			outcome: "blocked",
		};
	}
	return deps.withIssueMutex(resolution.lockKeys, async () => {
		// Codex R2#1: the master switch gates the TOMBSTONE + AUTHORITY writes
		// too — with the integration seam disabled a park performs ZERO
		// StateStore mutation (a tombstone would silently block every future
		// spawn and flip cutover authority while "everything is off").
		const mutationEnabled = deps.mutationEnabled ?? defaultMutationEnabled;
		if (!mutationEnabled()) {
			// R3#1: with the integration seam disabled even the AUDIT stays out of the
			// StateStore — zero writes of any kind. Non-durable log only.
			(deps.log ?? console.warn)(
				`[lifecycle-closeout] park refused for ${resolution.rootKey}: autoclean disabled (zero-write)`,
			);
			return {
				rootKey: resolution.rootKey,
				aliasKeys: resolution.aliasKeys,
				disposition: "founder_parked" as const,
				authority: "founder_park" as const,
				nodes: [],
				operatorItems: ["autoclean_disabled"],
				outcome: "blocked" as const,
			};
		}
		store.upsertIssueDispositionIntent({
			issueUuid: resolution.rootKey,
			project: input.projectName,
			founderDecisionId: input.founderDecisionId,
			expectedProject: input.projectName,
		});
		store.claimLocalTerminalAuthority({
			project: input.projectName,
			issueUuid: resolution.rootKey,
			source: "founder_park",
		});
		return closeoutIssueLocked(deps, closeoutInput, resolution, audit);
	});
}

/**
 * Codex R2#6 — the manual-apply issue closeout with the snapshot guard held
 * INSIDE the issue mutex: recompute + byte-compare + fresh Linear
 * verification and the closeout itself all happen under ONE mutex hold, so
 * an admission / new QA node / reopen racing the approval CANNOT slip
 * between the compare and the execution.
 */
export async function closeoutIssueWithSnapshotGuard(
	deps: LifecycleCloseoutDeps,
	input: CloseoutInput,
	guard: {
		/** R3#7: the approvedHash — the durable idempotency key. Same-hash
		 * retries return the persisted report instead of a spurious
		 * snapshot-drift rejection (the first success changed the snapshot). */
		approvedHash?: string;
		/** Canonical JSON of the APPROVED snapshot (byte-compared). */
		approvedJson: string;
		/** Recompute the snapshot canonical JSON — called INSIDE the mutex. */
		recompute: () => string | undefined;
		/** Fresh Linear read — called INSIDE the mutex. Unavailable/failed →
		 * the issue is rejected (fail-closed: the approval binds live Linear
		 * state, and only a live read can prove it still holds). */
		freshLinear?: () => Promise<
			{ stateType: string; updatedAt?: string } | null | undefined
		>;
		approvedLinear: { stateType: string; updatedAt: string };
	},
): Promise<ClosureReport | { rejected: true; reason: string }> {
	const { store } = deps;
	// R4#7: integration seam BEFORE any audit/claim write — a disabled apply is
	// rejected with ZERO StateStore writes (no epoch claim, no audit row).
	const mutationEnabled = deps.mutationEnabled ?? defaultMutationEnabled;
	if (!mutationEnabled()) {
		console.warn(
			`[lifecycle-closeout] mutations disabled — apply closeout rejected for ${input.issueKey} (zero writes)`,
		);
		return { rejected: true, reason: "autoclean_disabled" };
	}
	const audit = makeAudit(store, input, deps.audit);
	const resolution = resolveLifecycleRootKey(
		store,
		input.issueKey,
		deps.extraAliases ?? [],
	);
	if (!resolution.ok) {
		return { rejected: true, reason: `root_unresolved:${resolution.reason}` };
	}
	return deps.withIssueMutex(resolution.lockKeys, async () => {
		// R3#7 + R4#4: durable approvedHash epoch.
		//   complete prior  → replay the persisted report verbatim.
		//   non-complete prior (in_progress / partial / blocked) → AUTHORIZED
		//     RESUME: the first run's own mutations changed the snapshot, so the
		//     byte-compare is deliberately SKIPPED (the epoch pins the approval);
		//     the fresh-Linear check below still gates every resume, and the
		//     executor re-runs idempotently (already-terminal nodes are no-ops).
		//   no prior → full byte-compare, then an in_progress claim is persisted
		//     FAIL-CLOSED before the first mutation (crash → the claim exists →
		//     the retry resumes instead of drift-rejecting).
		let resumeEpoch = false;
		if (guard.approvedHash) {
			const prior = store.getApplyClaim(resolution.rootKey, guard.approvedHash);
			if (prior?.reportJson && prior.status === "complete") {
				try {
					return JSON.parse(prior.reportJson) as ClosureReport;
				} catch {
					/* unreadable prior report → fall through to a fresh run */
				}
			}
			if (prior && prior.status !== "complete") {
				resumeEpoch = true;
				audit("apply_epoch_resume", {
					rootKey: resolution.rootKey,
					approvedHash: guard.approvedHash,
					priorStatus: prior.status,
				});
			}
		}
		if (!resumeEpoch) {
			const freshJson = guard.recompute();
			if (!freshJson || freshJson !== guard.approvedJson) {
				audit("apply_issue_rejected", {
					rootKey: resolution.rootKey,
					reason: freshJson ? "snapshot_drift" : "snapshot_unavailable",
				});
				return {
					rejected: true as const,
					reason: freshJson ? "snapshot_drift" : "snapshot_unavailable",
				};
			}
		} else {
			// R5#4 (plan.md:158): a resume still RECOMPUTES and rejects any object
			// NOT in the approved set. The epoch tolerates approved nodes becoming
			// terminal (a missing object = the first run finished it), but a NEW
			// node / claim / binding / PR / thread that appeared between attempts
			// (a fresh retry / QA / PR) would widen the batch beyond what the
			// founder approved — whole-issue reject, never a dynamic widening.
			// Because current ⊆ approved is enforced here, the closeout below
			// collects only objects already in the approved set (idempotent
			// re-run of the SAME approved node IDs).
			const freshJson = guard.recompute();
			if (!freshJson) {
				audit("apply_issue_rejected", {
					rootKey: resolution.rootKey,
					reason: "snapshot_unavailable",
				});
				return { rejected: true as const, reason: "snapshot_unavailable" };
			}
			const driftedBy = snapshotDriftsApproved(
				guard.approvedJson,
				freshJson,
				input.disposition,
			);
			if (driftedBy) {
				audit("apply_issue_rejected", {
					rootKey: resolution.rootKey,
					reason: "snapshot_drift",
					drift: driftedBy,
				});
				return {
					rejected: true as const,
					reason: `snapshot_drift:${driftedBy}`,
				};
			}
		}
		if (!guard.freshLinear) {
			audit("apply_issue_rejected", {
				rootKey: resolution.rootKey,
				reason: "linear_lookup_unavailable",
			});
			return { rejected: true as const, reason: "linear_lookup_unavailable" };
		}
		const live = await guard.freshLinear().catch(() => undefined);
		if (
			!live ||
			live.stateType !== guard.approvedLinear.stateType ||
			(live.updatedAt ?? "") !== guard.approvedLinear.updatedAt
		) {
			audit("apply_issue_rejected", {
				rootKey: resolution.rootKey,
				reason: live ? "linear_drift" : "linear_lookup_failed",
			});
			return {
				rejected: true as const,
				reason: live ? "linear_drift" : "linear_lookup_failed",
			};
		}
		// R3#6: the closeout itself re-verifies the approval's Linear state
		// before EVERY mutation (uncached) — a reopen mid-execution blocks the
		// remaining nodes/items exactly like the D entry.
		const freshLinear = guard.freshLinear;
		const applyAuthority = async (): Promise<
			"authorized" | "reopened" | "unknown"
		> => {
			try {
				const cur = await freshLinear();
				if (!cur) return "unknown";
				return cur.stateType === guard.approvedLinear.stateType &&
					(cur.updatedAt ?? "") === guard.approvedLinear.updatedAt
					? "authorized"
					: "reopened";
			} catch {
				return "unknown";
			}
		};
		// R4#4: persist the in_progress epoch BEFORE the first mutation —
		// FAIL-CLOSED: if the claim cannot be made durable, a mid-run crash
		// would leave no resume anchor and the retry would drift-reject, so we
		// refuse to mutate at all (the approval stays valid for a retry).
		if (guard.approvedHash && !resumeEpoch) {
			try {
				store.putApplyClaim(
					resolution.rootKey,
					guard.approvedHash,
					"in_progress",
					"",
				);
			} catch (err) {
				audit("apply_issue_rejected", {
					rootKey: resolution.rootKey,
					reason: "epoch_persist_failed",
				});
				return {
					rejected: true as const,
					reason: `epoch_persist_failed:${(err as Error).message}`,
				};
			}
		}
		const report = await closeoutIssueLocked(
			{ ...deps, freshAuthority: applyAuthority },
			input,
			resolution,
			audit,
		);
		// R3#7 + R4#4: persist the outcome under (root, approvedHash) —
		// complete reports replay verbatim on same-hash retries;
		// partial/blocked stay resumable through the epoch. A failed
		// post-execution write is tolerable: the in_progress claim written
		// above already anchors the resume.
		if (guard.approvedHash) {
			try {
				store.putApplyClaim(
					resolution.rootKey,
					guard.approvedHash,
					report.outcome === "complete" ? "complete" : report.outcome,
					JSON.stringify(report),
				);
			} catch {
				/* the pre-mutation in_progress claim already anchors the resume */
			}
		}
		return report;
	});
}

/** Founder unpark — the tombstone supersede also runs under the issue mutex
 * so it cannot race a concurrent park/closeout on the same root. */
export async function unparkIssue(
	deps: Pick<
		LifecycleCloseoutDeps,
		"store" | "withIssueMutex" | "mutationEnabled"
	>,
	input: { issueUuid: string; supersededBy: string },
): Promise<boolean> {
	// R3#1: the supersede is a StateStore mutation too — seam-gated.
	const mutationEnabled = deps.mutationEnabled ?? defaultMutationEnabled;
	if (!mutationEnabled()) return false;
	const resolution = resolveLifecycleRootKey(deps.store, input.issueUuid, []);
	// R3#3: NEVER split-lock — the resolver's lockKeys cover the full related
	// set even on ok:false (uuid conflicts); fall back only when empty.
	const lockKeys =
		resolution.lockKeys.length > 0 ? resolution.lockKeys : [input.issueUuid];
	const rootKey = resolution.ok ? resolution.rootKey : input.issueUuid;
	return deps.withIssueMutex(lockKeys, async () =>
		deps.store.supersedeIssueDispositionIntent(rootKey, input.supersededBy),
	);
}

async function closeoutIssueLocked(
	deps: LifecycleCloseoutDeps,
	input: CloseoutInput,
	resolution: { rootKey: string; aliasKeys: string[] },
	audit: (event: string, detail: Record<string, unknown>) => void,
): Promise<ClosureReport> {
	const { store } = deps;
	const log =
		deps.log ?? ((m: string) => console.log(`[lifecycle-closeout] ${m}`));
	const rootKey = resolution.rootKey;
	const baseReport = (outcome: ClosureReport["outcome"]): ClosureReport => ({
		rootKey,
		aliasKeys: resolution.aliasKeys,
		disposition: input.disposition,
		authority: input.authority,
		nodes: [],
		operatorItems: [],
		outcome,
	});

	// ── Integration seam (Codex R1#4 + R4#7): false → ZERO mutation AND zero
	// StateStore writes (console only — the entry-level gates normally catch
	// this earlier; this is the defensive backstop for direct locked calls).
	const mutationEnabled = deps.mutationEnabled ?? defaultMutationEnabled;
	if (!mutationEnabled()) {
		console.warn(
			`[lifecycle-closeout] mutations disabled — locked closeout skipped for ${rootKey} (zero writes)`,
		);
		const report = baseReport("blocked");
		report.operatorItems.push("autoclean_disabled");
		return report;
	}

	// ── Disposition arbitration (R11#2): active founder park intent wins;
	// a non-park closeout colliding with an active park is a conflict. ──
	const parkIntent = isUuidKey(rootKey)
		? store.getActiveIssueDispositionIntent(rootKey)
		: undefined;
	if (parkIntent && input.disposition !== "founder_parked") {
		audit("disposition_conflict", {
			rootKey,
			requested: input.disposition,
			active: "founder_parked",
		});
		return { ...baseReport("conflict") };
	}

	// ── Codex R1#8: exact-ship proof vs persisted CANCELED observation.
	// A shipped closeout must NOT overwrite a durably-observed canceled
	// issue — conflicting authorities → conflict, zero mutation. ──
	if (input.disposition === "shipped" && isUuidKey(rootKey)) {
		const obs = store.getLinearStateObservation(input.projectName, rootKey);
		if (obs && obs.lastStateType === "canceled") {
			audit("disposition_conflict", {
				rootKey,
				requested: "shipped",
				observed: "canceled",
				lastLinearUpdatedAt: obs.lastLinearUpdatedAt,
			});
			const report = baseReport("conflict");
			report.operatorItems.push("shipped_vs_canceled_conflict");
			return report;
		}
	}

	const nodes = collectIssueCloseoutNodes(store, {
		rootKey,
		aliasKeys: resolution.aliasKeys,
		projectName: input.projectName,
	});

	const report = baseReport("complete");
	let anyBlocked = false;
	let anyFailed = false;

	let authorityLost: string | undefined;
	for (const node of nodes) {
		// Codex R2#5 — fresh authority BEFORE each node mutation: reopen wins.
		if (deps.freshAuthority && !authorityLost) {
			const auth = await deps.freshAuthority().catch(() => "unknown" as const);
			if (auth !== "authorized") {
				authorityLost =
					auth === "reopened" ? "authority_reopened" : "authority_unknown";
				audit("closeout_authority_lost", { rootKey, reason: authorityLost });
			}
		}
		if (authorityLost) {
			report.nodes.push({
				node,
				transition: { state: "blocked", prerequisite: authorityLost },
				teardown: { state: "skipped", reason: authorityLost },
				confirmedGone: false,
				communicationsFinalized: false,
			});
			anyBlocked = true;
			continue;
		}
		// Codex R1#14 + R3#13 — call-level budget: individual mutators consume
		// INSIDE closeoutOneNode; this outer check is the deadline/abort gate.
		if (deps.budget?.shouldStop?.()) {
			report.nodes.push({
				node,
				transition: { state: "blocked", prerequisite: "budget_exhausted" },
				teardown: { state: "skipped", reason: "budget_exhausted" },
				confirmedGone: false,
				communicationsFinalized: false,
			});
			anyBlocked = true;
			continue;
		}
		const nodeReport = await closeoutOneNode(deps, input, node, audit, log);
		report.nodes.push(nodeReport);
		if (
			nodeReport.transition.state === "blocked" ||
			!nodeReport.confirmedGone ||
			!nodeReport.communicationsFinalized
		) {
			anyBlocked = true;
		}
		if (
			nodeReport.transition.state === "failed" ||
			nodeReport.teardown.state === "failed"
		) {
			anyFailed = true;
		}
		// Launch-claim closure follows the node's confirmed state. A claim
		// the closeout itself CANCELLED (R1#5) is already terminal — leave it.
		if (nodeReport.confirmedGone && nodeReport.node.status !== undefined) {
			store.setLaunchClaimState(node.executionId, "closed");
		}
	}

	// ── Issue-level items: ONLY after every node is confirmed gone. ──
	// Codex R2#13: issue-level mutators consume budget slots too — a
	// zero-node issue's PR close / archive / Linear write still counts.
	const budgetAllows = (item: string): boolean => {
		if (!deps.budget) return true;
		if (deps.budget.shouldStop?.() || !deps.budget.tryConsume()) {
			report.operatorItems.push(`budget_exhausted:${item}`);
			return false;
		}
		return true;
	};
	// Codex R2#5 — issue-level items re-verify authority too (each one is a
	// slow-await boundary; a reopen landing mid-run must stop PR/archive/
	// Linear mutations as well).
	const authorityAllows = async (item: string): Promise<boolean> => {
		if (!deps.freshAuthority) return true;
		const auth = await deps.freshAuthority().catch(() => "unknown" as const);
		if (auth !== "authorized") {
			report.operatorItems.push(
				`${auth === "reopened" ? "authority_reopened" : "authority_unknown"}:${item}`,
			);
			return false;
		}
		return true;
	};
	if (!anyBlocked) {
		if (deps.openPrDisposal && (await authorityAllows("pr_disposal"))) {
			try {
				// R3#13: the disposal consumes one slot PER PR internally.
				const res = await deps.openPrDisposal({
					disposition: input.disposition,
					aliasKeys: resolution.aliasKeys,
					budget: deps.budget,
				});
				if (res?.blockedItems?.length) {
					report.operatorItems.push(...res.blockedItems);
				}
			} catch (err) {
				anyFailed = true;
				audit("closeout_pr_disposal_failed", {
					rootKey,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		if (
			deps.archiveThreads &&
			(await authorityAllows("thread_archive")) &&
			budgetAllows("thread_archive")
		) {
			try {
				await deps.archiveThreads(resolution.aliasKeys);
			} catch (err) {
				anyFailed = true;
				audit("closeout_thread_archive_failed", {
					rootKey,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		// Linear consistency LAST (plan DAG edge #4).
		if (
			deps.linearConsistency &&
			(await authorityAllows("linear_consistency")) &&
			budgetAllows("linear_consistency")
		) {
			try {
				const res = await deps.linearConsistency({
					disposition: input.disposition,
					aliasKeys: resolution.aliasKeys,
				});
				if (res?.blockedItems?.length) {
					report.operatorItems.push(...res.blockedItems);
				}
			} catch (err) {
				anyFailed = true;
				audit("closeout_linear_consistency_failed", {
					rootKey,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	} else {
		audit("closeout_issue_items_blocked", {
			rootKey,
			reason: "nodes_not_confirmed_gone",
			nodes: report.nodes.flatMap((nodeReport) => {
				const blockedBy: string[] = [];
				if (nodeReport.transition.state === "blocked") {
					blockedBy.push("transition_blocked");
				}
				if (!nodeReport.confirmedGone) {
					blockedBy.push("confirmed_gone_false");
				}
				if (!nodeReport.communicationsFinalized) {
					blockedBy.push("communications_finalized_false");
				}
				return blockedBy.length > 0
					? [{ executionId: nodeReport.node.executionId, blockedBy }]
					: [];
			}),
		});
	}

	report.outcome = anyBlocked
		? "blocked"
		: report.operatorItems.length > 0
			? "needs_operator"
			: anyFailed
				? "partial"
				: "complete";

	// Founder-park execution dimension (tombstone itself untouched).
	if (input.disposition === "founder_parked" && parkIntent) {
		const status =
			report.outcome === "complete"
				? "complete"
				: report.outcome === "needs_operator"
					? "needs_operator"
					: "partial";
		store.setIntentCloseoutStatus(
			rootKey,
			status,
			JSON.stringify({ outcome: report.outcome, nodes: report.nodes.length }),
		);
	}

	audit("closeout_report", {
		rootKey,
		disposition: input.disposition,
		authority: input.authority,
		outcome: report.outcome,
		nodes: report.nodes.length,
		operatorItems: report.operatorItems,
	});
	return report;
}

/** Per-node hard order (R9#3): re-read → transition → teardown → confirm. */
async function closeoutOneNode(
	deps: LifecycleCloseoutDeps,
	input: CloseoutInput,
	node: CloseoutNode,
	audit: (event: string, detail: Record<string, unknown>) => void,
	log: (msg: string) => void,
): Promise<NodeClosureReport> {
	const { store } = deps;
	const closeRunnerFn = deps.closeRunnerFn ?? closeRunner;
	const finalizeCommDbSessionFn =
		deps.finalizeCommDbSessionFn ?? finalizeCommDbSession;
	const lookupTarget = deps.lookupTarget ?? lookupTmuxTarget;
	const probeLiveness = deps.probeLiveness ?? probeRunnerProcessLiveness;

	// (1) fresh status re-read — the collected snapshot is NOT authority.
	const fresh = store.getSession(node.executionId);
	const status = fresh?.status;
	const result: NodeClosureReport = {
		node: { ...node, status },
		transition: { state: "skipped", reason: "no_action" },
		teardown: { state: "skipped", reason: "not_reached" },
		confirmedGone: false,
		communicationsFinalized: false,
	};

	if (!fresh) {
		// No session row. For a launch claim this is the park-vs-start race
		// window (Codex R1#5): the dispatcher may STILL be mid-flight between
		// admission and spawn. Atomically CAS starting→cancelled — if we win,
		// the dispatcher's pre-spawn recheck aborts; if the dispatcher already
		// advanced the claim to `active`, the session row is imminent and the
		// node must NOT be treated as gone (blocked; next pass handles it).
		result.transition = { state: "skipped", reason: "no_session_row" };
		if (node.role === "launch_claim") {
			const cancelled = store.casLaunchClaimState(
				node.executionId,
				"starting",
				"cancelled",
			);
			if (cancelled) {
				audit("closeout_launch_claim_cancelled", {
					executionId: node.executionId,
				});
				result.teardown = { state: "done", detail: "launch_claim_cancelled" };
				// R5#1 (plan.md:145): cancelling a `starting` claim does NOT prove
				// the runner won't be born — emitStarted fires BEFORE the
				// worktree/binding (Blueprint.ts), so a spawn already past the
				// dispatcher's pre-launch verify still creates a durable binding
				// (activation at emitWorktreeReady then refuses, but only audits —
				// it can't unwind the worktree). So do NOT declare the node gone:
				// keep confirmedGone=false so the issue's disposition intent stays
				// PARTIAL and the next replay tick owns any born runner via its
				// binding-owned residue. Next tick, if no runner was born the claim
				// is already `cancelled` (not `starting`) → the no_session_row path
				// below confirms it gone and the issue converges to complete.
				result.confirmedGone = false;
				return result;
			}
			const claim = store.getLaunchClaim(node.executionId);
			if (claim && (claim.state === "starting" || claim.state === "active")) {
				result.teardown = { state: "skipped", reason: "launch_in_flight" };
				result.confirmedGone = false; // dispatcher won the CAS — wait
				return result;
			}
		}
		const finalized = finalizeCommDbSessionFn(
			node.executionId,
			node.projectName,
		);
		store.recordCommDbFinalizeOutcome({
			executionId: node.executionId,
			issueId: node.issueKey,
			projectName: node.projectName,
			ok: finalized.ok,
			error: finalized.error,
			audit: {
				retiredGateCount: finalized.retiredGateCount,
				retiredAskCount: finalized.retiredAskCount,
				source: "bridge.lifecycle-closeout",
			},
		});
		result.communicationsFinalized = finalized.ok;
		result.teardown = finalized.ok
			? { state: "done", detail: "no_session_row_communications_finalized" }
			: {
					state: "failed",
					error: `commdb_finalize_failed:${finalized.error ?? "unknown"}`,
				};
		result.confirmedGone = true;
		return result;
	}

	// (2) decide + apply the FSM-legal transition for the disposition.
	let preserveForensics = false;
	let finalizeDone = false;
	let wantTerminate = false;

	if (input.disposition === "shipped") {
		if (node.role === "qa" && node.qaStatus !== "passed") {
			// R8#3: a non-PASS QA under a shipped root is closed with CANCELED
			// semantics — terminate, never a fabricated completed.
			wantTerminate = !AUTO_CLOSE_STATES.has(status ?? "");
		} else if (FINALIZE_DONE_SOURCE_STATES.has(status ?? "")) {
			finalizeDone = true; // existing finalizeDone semantics preserved
		}
	} else if (
		input.disposition === "canceled" ||
		input.disposition === "founder_parked"
	) {
		const action = CANCELED_STATUS_ACTIONS[status ?? ""] ?? "preserve_teardown";
		if (action === "terminate") wantTerminate = true;
		if (action === "preserve_teardown") preserveForensics = true;
	}

	const consume = (what: string): boolean => {
		if (!deps.budget) return true;
		if (deps.budget.shouldStop?.() || !deps.budget.tryConsume()) {
			result.transition =
				result.transition.state === "done"
					? result.transition
					: { state: "blocked", prerequisite: `budget_exhausted:${what}` };
			result.teardown = {
				state: "skipped",
				reason: `budget_exhausted:${what}`,
			};
			return false;
		}
		return true;
	};

	if (wantTerminate) {
		// R3#13: the FSM transition is ONE mutator call — one budget slot.
		if (!consume("fsm_transition")) return result;
		const tr = applyTransition(
			deps.transitionOpts,
			node.executionId,
			"terminated",
			{
				executionId: node.executionId,
				issueId: node.issueKey,
				projectName: node.projectName,
				trigger: `lifecycle_closeout_${input.disposition}`,
			},
			{ last_activity_at: sqliteDatetime() },
		);
		if (!tr.ok) {
			// Concurrent state change — HARD STOP for this node: MCP + window get
			// ZERO signals, remaining items blocked (plan §2.12 DAG rule).
			result.transition = {
				state: "blocked",
				prerequisite: `fsm_transition_failed:${tr.error ?? "?"}`,
			};
			audit("closeout_node_transition_blocked", {
				executionId: node.executionId,
				from: status,
				error: tr.error,
			});
			return result;
		}
		result.transition = { state: "done", detail: `${status}→terminated` };
	} else if (finalizeDone) {
		result.transition = {
			state: "done",
			detail: `${status}→completed(finalizeDone)`,
		};
	} else {
		result.transition = {
			state: "skipped",
			reason: preserveForensics ? "forensics_preserved" : "already_terminal",
		};
	}

	if (preserveForensics) {
		audit("forensics_released_by_issue_terminal", {
			executionId: node.executionId,
			status,
			disposition: input.disposition,
		});
	}

	// (3) teardown — closeRunner owns the battle-tested MCP-reap → cmux →
	// window → terminal-view sequence (the reap primitive is wired inside it).
	// R3#5: the transition above was a slow boundary — re-verify authority
	// (uncached) before the kill sequence; R3#13: teardown = one mutator slot.
	if (deps.freshAuthority) {
		const auth = await deps.freshAuthority().catch(() => "unknown" as const);
		if (auth !== "authorized") {
			result.teardown = {
				state: "skipped",
				reason:
					auth === "reopened" ? "authority_reopened" : "authority_unknown",
			};
			return result;
		}
	}
	if (!consume("teardown")) return result;
	let preserved = false;
	try {
		const closeRes = await closeRunnerFn(
			{
				executionId: node.executionId,
				issueId: node.issueKey,
				projectName: node.projectName,
				reason: `FLY-1185 lifecycle closeout (${input.disposition})`,
				leadId: "bridge.lifecycle-closeout",
				executorType: "lifecycle",
				// preserve-state nodes are torn down under the ISSUE-TERMINAL
				// authority (audited above) — that is exactly forcePreserved.
				forcePreserved: preserveForensics,
				finalizeDone,
				// Codex R1#13: legacy statuses OUTSIDE closeRunner's eligible sets
				// (e.g. a live `approved` husk) are torn down under the explicit
				// issue-terminal authority — without this the matrix's
				// already_terminal husks would stay blocked forever.
				issueTerminalOverride: true,
				// R2#3: the executor already holds the issue mutex.
				skipLifecycleGuard: true,
				transitionOpts: deps.transitionOpts,
				// R4#2: thread the fresh-authority probe INTO the kill sequence —
				// closeRunner re-verifies before each subsequent external mutation
				// (MCP reap → cmux kill → tmux kill → terminal view), so a Linear
				// reopen landing mid-teardown stops the remaining kills.
				...(deps.freshAuthority && {
					authorityCheck: async () => {
						const auth = await deps
							.freshAuthority?.()
							.catch(() => "unknown" as const);
						return auth === "authorized"
							? { ok: true }
							: {
									ok: false,
									reason:
										auth === "reopened"
											? "authority_reopened"
											: "authority_unknown",
								};
					},
				}),
			},
			store,
		);
		result.communicationsFinalized = closeRes.commDbFinalized;
		if (closeRes.closed || closeRes.alreadyGone) {
			result.teardown = closeRes.commDbFinalized
				? {
						state: "done",
						detail: closeRes.alreadyGone ? "already_gone" : "closed",
					}
				: {
						state: "failed",
						error: closeRes.error ?? "commdb_finalize_failed:unknown",
					};
		} else if (closeRes.preserved) {
			preserved = true;
			result.teardown = { state: "skipped", reason: "crash_preserve" };
		} else {
			result.teardown = {
				state: "failed",
				error: closeRes.error ?? "close_failed",
			};
		}
	} catch (err) {
		result.teardown = {
			state: "failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}

	// R6#1: a mid-flight launch (session row written, no durable binding yet)
	// has no worktree/window, so the liveness probe below would wrongly say
	// "gone" and let a park complete before the runner is born. Keep it
	// confirmedGone=false so the intent stays PARTIAL and the next replay tick
	// owns the born runner via its binding-owned residue.
	if (node.claimInFlight) {
		result.confirmedGone = false;
		return result;
	}

	// (4) confirmed gone — FRESH liveness, never a status set (triple-veto
	// family: status all-terminal while a window is alive is NOT gone).
	try {
		const look = lookupTarget(node.executionId, node.projectName);
		if (look.kind === "gone") {
			result.confirmedGone = true;
		} else if (look.kind === "found") {
			const live = await probeLiveness(look.target.tmuxWindow);
			// A dead pin preserves the forensic window, but its process is provably dead.
			result.confirmedGone = live === "absent" || live === "dead_pin";
			if (!result.confirmedGone) {
				log(
					`node ${node.executionId} teardown ran but window still ${live} — blocked`,
				);
			}
		} else {
			result.confirmedGone = false; // lookup error → fail-closed
		}
	} catch (err) {
		audit("closeout_node_liveness_error", {
			executionId: node.executionId,
			projectName: node.projectName,
			error: err instanceof Error ? err.message : String(err),
		});
		result.confirmedGone = false;
	}
	// Physical crash evidence stays intact; only its communication ledger closes.
	if (preserved && result.confirmedGone) {
		const finalized = finalizeCommDbSessionFn(
			node.executionId,
			node.projectName,
		);
		store.recordCommDbFinalizeOutcome({
			executionId: node.executionId,
			issueId: node.issueKey,
			projectName: node.projectName,
			ok: finalized.ok,
			error: finalized.error,
			audit: {
				retiredGateCount: finalized.retiredGateCount,
				retiredAskCount: finalized.retiredAskCount,
				source: "bridge.lifecycle-closeout",
			},
		});
		result.communicationsFinalized = finalized.ok;
		if (!finalized.ok) {
			result.teardown = {
				state: "failed",
				error: `commdb_finalize_failed:${finalized.error ?? "unknown"}`,
			};
		}
	}
	return result;
}

/**
 * Shared keyed mutex for issue roots — same construction pattern as the repo
 * mutation lock, but keyed on canonical root UUIDs and multi-key capable
 * (sorted acquisition, deadlock-free).
 */
export function createIssueMutex(): <T>(
	keys: string[],
	fn: () => Promise<T>,
) => Promise<T> {
	const tails = new Map<string, Promise<void>>();
	const acquireOne = async (key: string): Promise<() => void> => {
		const prev = tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const done = new Promise<void>((r) => {
			release = r;
		});
		const newTail = prev.then(() => done);
		tails.set(key, newTail);
		await prev;
		return () => {
			release();
			if (tails.get(key) === newTail) tails.delete(key);
		};
	};
	return async <T>(keys: string[], fn: () => Promise<T>): Promise<T> => {
		const sorted = [...new Set(keys)].sort();
		const releases: Array<() => void> = [];
		try {
			for (const key of sorted) {
				releases.push(await acquireOne(key));
			}
			return await fn();
		} finally {
			for (const rel of releases.reverse()) rel();
		}
	};
}
