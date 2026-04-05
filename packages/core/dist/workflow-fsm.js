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
    pending: ["running"],
    running: [
        "awaiting_review",
        "approved",
        "blocked",
        "completed",
        "failed",
        "terminated",
    ],
    awaiting_review: ["approved_to_ship", "rejected", "deferred", "shelved"],
    approved_to_ship: ["completed", "shelved"],
    blocked: ["deferred", "shelved"],
    failed: ["shelved"],
    rejected: ["shelved"],
    deferred: ["shelved"],
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
        fromStates: ["running"],
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