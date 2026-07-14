/**
 * WorkflowFSM — Declarative state machine for Flywheel session lifecycle.
 * Ported from Jido Directive pattern (GEO-158).
 */
// ── WorkflowFSM ─────────────────────────────────────────────────────
export class WorkflowFSM {
    transitions;
    guards;
    onEnter;
    constructor(transitions, guards, onEnter) {
        this.transitions = transitions;
        this.guards = guards;
        this.onEnter = onEnter;
    }
    /**
     * Attempt a state transition. Returns ok=true with auto-generated
     * AuditDirective (when ctx provided), or ok=false with error.
     */
    transition(currentState, targetState, ctx) {
        const allowed = this.transitions[currentState];
        if (!allowed || !allowed.includes(targetState)) {
            return {
                ok: false,
                newState: currentState,
                directives: [],
                error: `Transition ${currentState} → ${targetState} is not allowed`,
            };
        }
        // Guard check (key = "from → to")
        if (ctx && this.guards) {
            const guardKey = `${currentState} → ${targetState}`;
            const guard = this.guards[guardKey];
            if (guard && !guard(ctx)) {
                return {
                    ok: false,
                    newState: currentState,
                    directives: [],
                    error: `Guard rejected transition ${currentState} → ${targetState}`,
                };
            }
        }
        // Collect directives: auto-generated audit + onEnter
        const directives = [];
        // Auto-generate AuditDirective when context is provided
        if (ctx) {
            const audit = {
                type: "audit",
                executionId: ctx.executionId,
                issueId: ctx.issueId,
                projectName: ctx.projectName,
                fromState: currentState,
                toState: targetState,
                trigger: ctx.trigger,
            };
            directives.push(audit);
        }
        // onEnter hook (key = targetState)
        if (ctx && this.onEnter) {
            const hook = this.onEnter[targetState];
            if (hook) {
                directives.push(...hook(ctx));
            }
        }
        return { ok: true, newState: targetState, directives };
    }
    /** List all states reachable from the given state. */
    allowedTransitions(currentState) {
        return this.transitions[currentState] ?? [];
    }
    /** A state is terminal if it has no outgoing transitions. */
    isTerminal(state) {
        const targets = this.transitions[state];
        return targets !== undefined && targets.length === 0;
    }
    /** Quick check without side effects (no guards, no directives). */
    canTransition(from, to) {
        const allowed = this.transitions[from];
        return allowed?.includes(to) ?? false;
    }
}
// ── Flywheel workflow transition map ─────────────────────────────────
export const WORKFLOW_TRANSITIONS = {
    // FLY-1185 §2.12 (R10#5): `terminated` added — a CANCELED issue must be
    // able to close a never-started (admission-claimed / dispatch-crashed)
    // session through the FSM instead of a forceStatus bypass.
    pending: ["running", "terminated"],
    running: [
        "awaiting_review",
        "completed",
        "blocked",
        "failed",
        "terminated",
        // FLY-793: a three-stage Design phase-session completes into design_done
        // (non-terminal); the PhaseOrchestrator hands off to the Implement phase.
        "design_done",
    ],
    // FLY-793: Design phase done (docs on the shared branch). Non-terminal — the
    // PhaseOrchestrator captures the head + starts Implement, then this session is
    // finalized (completed) or fails out (blocked/failed/terminated).
    design_done: ["completed", "blocked", "failed", "terminated"],
    // FLY-44: terminate allowed from all started non-terminal states.
    // FLY-60 W2 (b): `completed` added to support post-merge re-finalization
    // from the `stage_changed=completed + landing_status.status="merged"`
    // branch in Bridge event-route. Merge-proof guard lives at the event-route
    // call site (it must verify landing_status before calling applyTransition);
    // this FSM map only declares the transition is legal. Defense-in-depth FSM
    // guard via ctx.payload is a follow-up if needed (per plan §12.3).
    awaiting_review: [
        "approved_to_ship",
        "completed",
        "rejected",
        "deferred",
        "shelved",
        "terminated",
    ],
    // FLY-208 5a (Codex design R2 #2): `blocked` added — event-route's
    // route=blocked branch always claimed "ship failed after approval →
    // blocked" semantics, but the edge was missing, so applyTransition
    // rejected it and the session stayed stuck in approved_to_ship (the same
    // latent stuck-state family as the LEARN-12 incident). `blocked` already
    // has human-unblock exits (deferred/shelved/terminated).
    //
    // FLY-945 Fix C: `awaiting_review` added — an approved session whose head
    // moved after the approval (verify-approval pr_head_sha mismatch) legally
    // RE-OPENS review with a NEW gate question (`complete --route needs_review
    // --question-id <new>`). All completion sinks map that combination (new
    // questionId ≠ current binding, no merged landing) back to awaiting_review;
    // without this edge the recovery lap was FSM-invalid and fell into the 5a
    // evidence-gap completion instead of a fresh review window.
    approved_to_ship: [
        "awaiting_review",
        "completed",
        "blocked",
        "failed",
        "terminated",
    ],
    blocked: ["deferred", "shelved", "terminated"],
    failed: ["shelved", "terminated"],
    rejected: ["shelved", "terminated"],
    deferred: ["shelved", "terminated"],
    // FLY-58: approved kept as terminal for backward compat (existing DB records)
    approved: [],
    completed: [],
    shelved: [],
    terminated: [],
};
export const ACTION_DEFINITIONS = [
    {
        action: "approve",
        fromStates: ["awaiting_review"],
        targetState: "approved_to_ship",
    },
    {
        action: "reject",
        fromStates: ["awaiting_review"],
        targetState: "rejected",
    },
    {
        action: "defer",
        fromStates: ["awaiting_review", "blocked"],
        targetState: "deferred",
    },
    {
        action: "retry",
        fromStates: ["failed", "blocked", "rejected"],
        targetState: "running",
        composite: true,
    },
    {
        action: "shelve",
        fromStates: [
            "awaiting_review",
            "blocked",
            "failed",
            "rejected",
            "deferred",
        ],
        targetState: "shelved",
    },
    {
        action: "terminate",
        fromStates: [
            // FLY-1185 (R10#5): pending + design_done added — the WORKFLOW_
            // TRANSITIONS edges existed (design_done) / were added (pending), but
            // the ACTION surface never allowed terminating them, so a canceled
            // issue could not close a parked design phase or a claimed-but-
            // never-started session without a forceStatus bypass.
            "pending",
            "running",
            "awaiting_review",
            "approved_to_ship",
            "design_done",
            "blocked",
            "failed",
            "rejected",
            "deferred",
        ],
        targetState: "terminated",
    },
];
/** Pure static helper — returns actions available for a given state. */
export function allowedActionsForState(state) {
    return ACTION_DEFINITIONS.filter((d) => d.fromStates.includes(state)).map((d) => d.action);
}
/** Get the target state for an action name. */
export function getActionTarget(action) {
    return ACTION_DEFINITIONS.find((d) => d.action === action)?.targetState;
}
//# sourceMappingURL=workflow-fsm.js.map