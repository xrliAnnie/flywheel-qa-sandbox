/**
 * WorkflowFSM — Declarative state machine for Flywheel session lifecycle.
 * Ported from Jido Directive pattern (GEO-158).
 */

import type { AuditDirective, Directive } from "./directive-types.js";

// ── Transition context & result ──────────────────────────────────────

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

// ── Guard & hook function types ──────────────────────────────────────

export type GuardFn = (ctx: TransitionContext) => boolean;
export type OnEnterFn = (ctx: TransitionContext) => Directive[];

// ── WorkflowFSM ─────────────────────────────────────────────────────

export class WorkflowFSM {
	constructor(
		private transitions: Record<string, string[]>,
		private guards?: Record<string, GuardFn>,
		private onEnter?: Record<string, OnEnterFn>,
	) {}

	/**
	 * Attempt a state transition. Returns ok=true with auto-generated
	 * AuditDirective (when ctx provided), or ok=false with error.
	 */
	transition(
		currentState: string,
		targetState: string,
		ctx?: TransitionContext,
	): TransitionResult {
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
		const directives: Directive[] = [];

		// Auto-generate AuditDirective when context is provided
		if (ctx) {
			const audit: AuditDirective = {
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
	allowedTransitions(currentState: string): string[] {
		return this.transitions[currentState] ?? [];
	}

	/** A state is terminal if it has no outgoing transitions. */
	isTerminal(state: string): boolean {
		const targets = this.transitions[state];
		return targets !== undefined && targets.length === 0;
	}

	/** Quick check without side effects (no guards, no directives). */
	canTransition(from: string, to: string): boolean {
		const allowed = this.transitions[from];
		return allowed?.includes(to) ?? false;
	}
}

// ── Flywheel workflow transition map ─────────────────────────────────

export const WORKFLOW_TRANSITIONS: Record<string, string[]> = {
	pending: ["running"],
	running: ["awaiting_review", "completed", "blocked", "failed", "terminated"],
	// FLY-44: terminate allowed from all started non-terminal states
	awaiting_review: [
		"approved_to_ship",
		"rejected",
		"deferred",
		"shelved",
		"terminated",
	],
	approved_to_ship: ["completed", "failed", "terminated"],
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

// ── Action definitions (single source of truth) ─────────────────────

export interface ActionDefinition {
	action: string;
	fromStates: string[];
	targetState: string;
	composite?: boolean;
}

export const ACTION_DEFINITIONS: ActionDefinition[] = [
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
			"running",
			"awaiting_review",
			"approved_to_ship",
			"blocked",
			"failed",
			"rejected",
			"deferred",
		],
		targetState: "terminated",
	},
];

/** Pure static helper — returns actions available for a given state. */
export function allowedActionsForState(state: string): string[] {
	return ACTION_DEFINITIONS.filter((d) => d.fromStates.includes(state)).map(
		(d) => d.action,
	);
}

/** Get the target state for an action name. */
export function getActionTarget(action: string): string | undefined {
	return ACTION_DEFINITIONS.find((d) => d.action === action)?.targetState;
}
