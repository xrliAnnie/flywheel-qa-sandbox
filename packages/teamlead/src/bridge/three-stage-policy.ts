/**
 * FLY-793: the three-stage pipeline enablement policy.
 *
 * Decides whether a task should run as three internal phase-sessions
 * (Design → Implement → QA, each its own model) instead of a single session.
 *
 * Unlike auto-QA (FLY-752, opt-out/default-ON), three-stage is a NEW opt-in
 * feature — the default is OFF so byte-compatibility is preserved (a task runs
 * as one session exactly as before). Decision order:
 *
 *   1. FLYWHEEL_THREE_STAGE=0        → OFF (global hard kill-switch).
 *   2. Linear `no-three-stage` label → OFF (per-issue founder/Lead override).
 *   3. pipeline.three_stage === true → ON.
 *   4. otherwise (absent config / no `pipeline` block / `three_stage` absent /
 *      `three_stage: false`)         → OFF (opt-in default).
 *
 * A MALFORMED `pipeline` block throws at config load (ConfigLoader, mirrors
 * `doc_flow`); a failed/absent load reaches this resolver as an undefined
 * config → OFF, so the default-off feature is trivially fail-closed.
 *
 * SECURITY: `pipelineConfig` MUST be loaded from the project's canonical /
 * mainline root, NEVER an implementation PR's worktree — otherwise a runner
 * could flip its own pipeline config. The issue labels are the Linear snapshot
 * taken at run start (trusted, not worktree-derived).
 */

import {
	type PhaseDispatchVendor,
	type PipelineConfig,
	type RoleEffort,
	resolvePhaseDispatch,
} from "flywheel-config";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";

export interface ThreeStagePolicyInput {
	/** Pipeline config, loaded from the CANONICAL root (never a PR worktree). */
	pipelineConfig: PipelineConfig | undefined;
	/** The issue's labels (snapshotted from Linear at run start). */
	issueLabels: string[];
	/** Env source for the kill-switch (defaults to process.env). */
	env?: Record<string, string | undefined>;
	/**
	 * FLY-887 R2: the dispatching Lead's Discord chatChannel, resolved
	 * SERVER-SIDE by the caller (leadId → `project.leads[].chatChannel`) —
	 * NEVER taken from the request body. leadId itself is trusted because
	 * runs-route validates it against the project's leads (membership check)
	 * and auto-resolves it server-side when absent, both BEFORE the
	 * three-stage entry decision. Only consulted when
	 * `pipeline.three_stage_channels` is defined.
	 */
	dispatchChannelId?: string;
}

export interface ThreeStagePolicyDecision {
	enabled: boolean;
	reason?: string;
}

const NO_THREE_STAGE_LABEL = "no-three-stage";

export function resolveThreeStagePolicy(
	input: ThreeStagePolicyInput,
): ThreeStagePolicyDecision {
	const env = input.env ?? process.env;
	if (env.FLYWHEEL_THREE_STAGE === "0") {
		return {
			enabled: false,
			reason: "FLYWHEEL_THREE_STAGE=0 global kill-switch",
		};
	}

	const labels = input.issueLabels.map((l) => l.toLowerCase());
	if (labels.includes(NO_THREE_STAGE_LABEL)) {
		return { enabled: false, reason: "issue labelled no-three-stage" };
	}

	if (input.pipelineConfig?.three_stage === true) {
		// FLY-887 R2: channel gating. Allowlist undefined → no restriction
		// (byte-compat). Defined → the dispatching Lead's chatChannel must be in
		// it; an empty array is an explicit universal OFF; an unresolvable
		// channel fails closed (can't prove membership → single-session).
		const allowlist = input.pipelineConfig.three_stage_channels;
		if (allowlist !== undefined) {
			const channel = input.dispatchChannelId;
			if (!channel || !allowlist.includes(channel)) {
				return {
					enabled: false,
					reason: `dispatch channel ${channel ?? "(unresolved)"} not in pipeline.three_stage_channels [${allowlist.join(", ")}]`,
				};
			}
		}
		return { enabled: true };
	}

	return { enabled: false, reason: "three-stage not enabled (opt-in default)" };
}

/**
 * FLY-902: resolve the dispatching Lead's chatChannel for the HANDOFF-side
 * policy checks (the PhaseOrchestrator's `resolveThreeStage` closure in
 * plugin.ts). Mirrors the entry-side resolution in runs-route (leadId →
 * `project.leads[].chatChannel`) via the same label-based lead resolution the
 * handoff paths already use for `resolveLeadId` (project config + the issue's
 * trusted Linear labels).
 *
 * Without this, a configured `three_stage_channels` allowlist read the channel
 * as unresolved at EVERY handoff and failed closed — silently disabling every
 * phase handoff after entry (design stuck at design_done forever, zero logs).
 *
 * Unresolvable (unknown project / missing projectName) → undefined; the policy
 * then fails closed and the orchestrator's handoff-boundary warn surfaces it.
 */
export function resolveHandoffDispatchChannelId(
	projects: ProjectEntry[],
	projectName: string | undefined,
	issueLabels: string[],
): string | undefined {
	if (!projectName) return undefined;
	try {
		return resolveLeadForIssue(projects, projectName, issueLabels).lead
			.chatChannel;
	} catch {
		return undefined;
	}
}

export interface ThreeStageEntryInput {
	/** The role from the dispatch request (`main` when the caller sent none). */
	requestRole: string;
	/** Pipeline config, loaded from the CANONICAL root (never a PR worktree). */
	pipelineConfig: PipelineConfig | undefined;
	/** The issue's labels (snapshotted from Linear at run start). */
	issueLabels: string[];
	/** Env source for the kill-switch (defaults to process.env). */
	env?: Record<string, string | undefined>;
	/**
	 * FLY-887 R2: the dispatching Lead's chatChannel for the
	 * `three_stage_channels` gate (see ThreeStagePolicyInput.dispatchChannelId
	 * for the trust chain). Only consulted when the allowlist is defined.
	 */
	dispatchChannelId?: string;
}

export interface ThreeStageEntryDecision {
	/** `design` when the fresh dispatch enters three-stage; else the request role. */
	role: string;
	/** True ONLY when the fresh dispatch enters three-stage (→ start the Design phase). */
	enteredThreeStage: boolean;
	/**
	 * FLY-887 R2: the phase-table model for the entered phase (design). Present
	 * ONLY when `enteredThreeStage` — the caller applies it UNCONDITIONALLY,
	 * overriding any difficulty-sorter pin, so phase-model sovereignty lives in
	 * this policy module (Annie's table: no phase ever runs on Sonnet). An issue
	 * that genuinely needs a special model opts out via the `no-three-stage`
	 * label and runs single-session.
	 */
	dispatchModel?: string;
	/**
	 * FLY-1224: the phase table's vendor for the entered phase — the caller
	 * forwards it alongside dispatchModel so the resolver's dispatch layer picks
	 * the phase's executor backend. Present ONLY when `enteredThreeStage`.
	 */
	dispatchVendor?: PhaseDispatchVendor;
	/** FLY-1224: the phase table's reasoning effort for the entered phase. */
	dispatchEffort?: RoleEffort;
}

/**
 * FLY-793 (Step 4 ENTRY): decide whether a fresh dispatch STARTS at the Design
 * phase. This is the entry the PhaseOrchestrator (handoff-only) does not cover —
 * without it, `three_stage: true` has zero effect on a real issue.
 *
 * ONLY a fresh `main` dispatch can enter three-stage; an explicit phase role
 * (a PhaseOrchestrator handoff) or auto-QA (`qa`) passes through unchanged. The
 * caller resolves `pipelineConfig` from the project's CANONICAL root and passes
 * the trusted Linear labels — the decision is SERVER-SIDE, so `shareParentBranch`
 * stays Bridge-internal and a runner cannot self-elevate its own run.
 */
export function resolveThreeStageEntry(
	input: ThreeStageEntryInput,
): ThreeStageEntryDecision {
	if (input.requestRole !== "main") {
		return { role: input.requestRole, enteredThreeStage: false };
	}
	const enabled = resolveThreeStagePolicy({
		pipelineConfig: input.pipelineConfig,
		issueLabels: input.issueLabels,
		env: input.env,
		dispatchChannelId: input.dispatchChannelId,
	}).enabled;
	if (!enabled) return { role: "main", enteredThreeStage: false };
	// FLY-1224: the entry dispatches the DESIGN phase — return its full
	// {model, vendor, effort} triple from the phase table (kill-switch aware
	// via the same injectable env).
	const dispatch = resolvePhaseDispatch("design", input.env);
	return {
		role: "design",
		enteredThreeStage: true,
		dispatchModel: dispatch.model,
		dispatchVendor: dispatch.vendor,
		...(dispatch.effort && { dispatchEffort: dispatch.effort }),
	};
}

/**
 * FLY-887: the three-stage phase-session KEEP-ALIVE kill-switch. Default ON:
 * when three-stage runs, phase-sessions park (stay alive) across handoffs and are
 * woken (not respawned) — so QA↔implement fix loops keep full context. `=0`
 * forces the legacy close-and-respawn behavior everywhere (byte-compatible with
 * the pre-FLY-887 three-stage pipeline), for emergency rollback without disabling
 * three-stage itself. Orthogonal to `FLYWHEEL_THREE_STAGE` (which disables
 * three-stage entirely) and to the per-project `pipeline.three_stage` opt-in.
 *
 * Read at call time (both the PhaseOrchestrator handoff/fail decisions and the
 * Blueprint worktree in-place-takeover gate) so a flip is live without a
 * dispatch-shape change; the two read sites share this one env.
 */
export function threeStageKeepAliveEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.FLYWHEEL_THREE_STAGE_KEEPALIVE !== "0";
}
