/**
 * WorkflowFSM — Declarative state machine for Flywheel session lifecycle.
 * Ported from Jido Directive pattern (GEO-158).
 */
import type { Directive } from "./directive-types.js";
export interface TransitionContext {
    executionId: string;
    issueId: string;
    projectName: string;
    trigger: string;
    payload?: Record<string, unknown>;
}
export interface TransitionResult {
    ok: boolean;
    newState: string;
    directives: Directive[];
    error?: string;
}
export type GuardFn = (ctx: TransitionContext) => boolean;
export type OnEnterFn = (ctx: TransitionContext) => Directive[];
export declare class WorkflowFSM {
    private transitions;
    private guards?;
    private onEnter?;
    constructor(transitions: Record<string, string[]>, guards?: Record<string, GuardFn> | undefined, onEnter?: Record<string, OnEnterFn> | undefined);
    /**
     * Attempt a state transition. Returns ok=true with auto-generated
     * AuditDirective (when ctx provided), or ok=false with error.
     */
    transition(currentState: string, targetState: string, ctx?: TransitionContext): TransitionResult;
    /** List all states reachable from the given state. */
    allowedTransitions(currentState: string): string[];
    /** A state is terminal if it has no outgoing transitions. */
    isTerminal(state: string): boolean;
    /** Quick check without side effects (no guards, no directives). */
    canTransition(from: string, to: string): boolean;
}
export declare const WORKFLOW_TRANSITIONS: Record<string, string[]>;
export interface ActionDefinition {
    action: string;
    fromStates: string[];
    targetState: string;
    composite?: boolean;
}
export declare const ACTION_DEFINITIONS: ActionDefinition[];
/** Pure static helper — returns actions available for a given state. */
export declare function allowedActionsForState(state: string): string[];
/** Get the target state for an action name. */
export declare function getActionTarget(action: string): string | undefined;
//# sourceMappingURL=workflow-fsm.d.ts.map