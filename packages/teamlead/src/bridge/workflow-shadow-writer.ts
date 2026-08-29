/**
 * FLY-1232 module ② — WorkflowShadowWriter: the lifecycle shadow adapter
 * between the production pipeline and the workflow run/node/event tables.
 *
 * OBSERVATION ONLY. The shadow ledger is NOT authoritative — every gate keeps
 * reading its legacy source (verify-approval / codex_review_record /
 * qa_required untouched); the read flip is sub-issue B. plugin.ts constructs
 * this writer solely when FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1 (the single switch
 * point); everywhere else the seam field is `undefined` ⇒ byte-compatible.
 *
 * ── THE TRANSITION TABLE (the contract every hook site implements; drift =
 *    a review defect. Umbrella spec §2.1/§2.4b/§3.1b; FLY-1232 plan Step 4.) ──
 *
 * | T  | moment                        | unique owner (hook)                     | event uid(s) (run-namespaced)                         | shadow write (ONE batch)                    | durable source (T8)            |
 * |----|-------------------------------|------------------------------------------|--------------------------------------------------------|---------------------------------------------|--------------------------------|
 * | T1 | run start (first dispatch)    | RunDispatcher.start() pre-launch seam    | run:{r}:dispatch:{node}:1:{ord}                         | run(active)+node(running)+dispatched+intent | intent row + marker + CommDB   |
 * | T2 | handoff spawn                 | dispatchNextPhase → start() seam         | run:{r}:edge:{from}:{to}:{n} + dispatch:{node}:{n}:{ord}| edge+node+dispatched+intent                 | sessions row + marker + CommDB |
 * | T3 | keep-alive fix wake           | runFailFlowKeepAlive wake point          | run:{r}:wake:implement:{n}                              | dispatched(wake)+node — NO ledger row       | belt/fix records (partial)     |
 * | T3b| handoff wake (retest)         | handoff() wake branch                    | run:{r}:edge:implement:qa:{n} + wake:qa:{n}             | edge+dispatched(wake)+node — NO ledger row  | belt/verdict records (partial) |
 * | T4 | node complete                 | onPhaseComplete                          | run:{r}:complete:{node}:{n}:{execId}                    | completed+node ended+current_node_id        | latest boundary only (partial) |
 * | T5 | QA PASS                       | onQaResult PASS branch                   | run:{r}:complete:qa:{n}:{execId} + edge:qa:end:{n}      | completed+edge                              | persisted QA verdict intent    |
 * | T6 | QA FAIL kickback              | belt round-increment point (sole owner)  | run:{r}:kickback:{round}                                | loop_iteration ONLY                         | three_stage_fix_round events   |
 * | T7 | replacement respawn           | same seam as T2 (same attempt, new exec) | run:{r}:dispatch:qa:{n}:{ord} (writer allocates ord)    | dispatched+NEW intent row                   | marker + CommDB                |
 * | T8 | startup replay                | reconcileOnStartup (dedicated — never    | reuses the formulas above (idempotent)                  | backfill per durable-source column          | —                              |
 * |    |                               | the orchestrator's skip-heavy reconcile) |                                                        | declared gaps: wake moments + historical T4 |                                |
 * | T9 | post-ship finalization        | runPostShipFinalization best-effort hook | run:{r}:finalized (projection identity — NO event:      | run.status active→completed                 | post_ship_finalization_claim   |
 * |    |                               | + claim-based reconcile repair           | §3.1b has no finalize kind, B9 discipline)              |                                             |                                |
 *
 * attempt semantics (normative, R1#3/R3#2/R4#1 + code-review R1#2): attempt =
 * the logical decision round = 1 + the ACTIVE shadow run's OWN loop_iteration
 * count — run-scoped by construction (a second workflow on the same issue
 * starts back at 1) and complete across BOTH belt paths (the T6 hook fires at
 * the keep-alive recordFixRound point AND the legacy close-respawn round
 * point). Identical for first dispatch (0 loops → 1), post-kickback re-entry
 * (loop just recorded → N+1) and same-attempt replacement (loops unchanged ⇒
 * same attempt; the writer-allocated ordinal separates physical launches).
 * launch_ordinal is allocated ONLY inside the batch transaction — callers
 * never pre-compute it and WorkflowShadowContext never carries it.
 *
 * Failure posture: a shadow failure rolls back its own batch and surfaces as
 * a LOUD warn carrying issue/run/execution identifiers — it never throws into
 * the production flow (explicit observation-period stance, plan §0.12).
 *
 * Coverage boundary (plan §0 red line): an EXTERNALLY INJECTED startDispatcher
 * (startBridge option — test/QA harnesses) is NOT shadow-wrapped; the
 * production assembly path is setupRunInfrastructure.
 */

import { randomUUID } from "node:crypto";
import type { StateStore, WorkflowShadowOp } from "../StateStore.js";
import { isWorkflowClaimsWriteEnabled } from "../workflow-claims.js";

/**
 * Semantic shadow context a spawn caller provides to the dispatcher seam
 * (T2/T7 via StartRequest.shadowContext; T1 synthesized by the seam itself).
 * NEVER carries an ordinal — the writer allocates it in-transaction (R4#1).
 */
export interface WorkflowShadowContext {
	node: string;
	attempt: number;
	/** The DAG edge this spawn traverses (handoff spawns). */
	edge?: { from: string; to: string };
}

/**
 * Durable-evidence probes for the ②b dispatch state machine (research §F.3).
 * Both facts are PERSISTENT (a file, a DB row) — readable at any later
 * reconcile; the live-window probe (started-evidence.ts) answers "alive now",
 * which the launch-history ledger deliberately never asks (R3#1).
 */
export interface WorkflowShadowEvidenceProbes {
	/** The adapter's durable commit marker (launchCommitPath file) exists. */
	hasCommitMarker(executionId: string): boolean;
	/**
	 * CommDB registration state for the execution — TRI-STATE (research §F.3
	 * lookup_error, Codex code R1 #1): `true` = a non-:pending row is PROVEN,
	 * `false` = absence is PROVEN (lookup succeeded / DB doesn't exist),
	 * `"unknown"` = the lookup itself failed. Only `false` may authorize an
	 * abandon; only `true` may complete the dual evidence for `started`.
	 */
	hasNonPendingCommDbRow(
		projectName: string,
		executionId: string,
	): boolean | "unknown";
}

/** The narrow hook surface PhaseOrchestrator sees (structurally = this writer). */
export interface WorkflowShadowHooks {
	onWake(args: {
		projectName: string;
		issueId: string;
		executionId: string;
		node: string;
		attempt: number;
		edge?: { from: string; to: string };
	}): void;
	onNodeComplete(args: {
		projectName: string;
		issueId: string;
		executionId: string;
		node: string;
		attempt: number;
	}): void;
	onQaPass(args: {
		projectName: string;
		issueId: string;
		executionId: string;
		attempt: number;
	}): void;
	onKickback(args: {
		projectName: string;
		issueId: string;
		round: number;
	}): void;
	currentAttempt(issueId: string): number;
}

export interface WorkflowShadowWriterDeps {
	store: StateStore;
	/** Evidence probes — absent ⇒ evidence-dependent paths warn + no-op. */
	probes?: WorkflowShadowEvidenceProbes;
	/** Run-id mint for a new shadow run (tests inject deterministic ids). */
	newRunId?: () => string;
	logger?: { log?: (m: string) => void; warn?: (m: string) => void };
}

/**
 * plugin.ts's single default-off switch (B1): flag absent/≠"1" → undefined →
 * every seam stays undefined → zero shadow writes anywhere.
 */
export function createWorkflowShadowWriterFromEnv(
	env: Record<string, string | undefined>,
	store: StateStore,
	probes?: WorkflowShadowEvidenceProbes,
): WorkflowShadowWriter | undefined {
	return isWorkflowClaimsWriteEnabled(env)
		? new WorkflowShadowWriter({ store, probes })
		: undefined;
}

export class WorkflowShadowWriter implements WorkflowShadowHooks {
	constructor(private readonly deps: WorkflowShadowWriterDeps) {}

	private warn(m: string): void {
		(this.deps.logger?.warn ?? console.warn)(m);
	}

	/** All hooks pass through here: shadow errors warn loudly, never throw. */
	private safe(
		label: string,
		ids: { issueId: string; executionId?: string },
		fn: () => void,
	): void {
		try {
			fn();
		} catch (err) {
			this.warn(
				`[workflow-shadow] ${label} failed (issue=${ids.issueId}${
					ids.executionId ? ` execution=${ids.executionId}` : ""
				}): ${(err as Error).message} — production flow unaffected (observation-only shadow)`,
			);
		}
	}

	private batch(
		projectName: string,
		issueId: string,
		ops: WorkflowShadowOp[],
	): void {
		this.deps.store.applyWorkflowShadowBatch({
			projectName,
			issueId,
			newRunId: this.deps.newRunId?.() ?? randomUUID(),
			ops,
		});
	}

	/**
	 * attempt = 1 + the ACTIVE shadow run's OWN loop_iteration count (see the
	 * header's attempt semantics). Run-scoped by construction (Codex code R1
	 * #2): a second workflow on the same issue starts back at 1, and the T6
	 * hook fires on BOTH belt paths (keep-alive recordFixRound AND the legacy
	 * close-respawn round point), so the run's shadow loops are the complete
	 * round source. No active run ⇒ 1 (the next dispatch creates a fresh run).
	 * Never throws: an error yields NaN, which the batch validation refuses
	 * fail-closed (the write no-ops with a warn instead of recording a wrong
	 * round or breaking the caller).
	 */
	currentAttempt(issueId: string): number {
		try {
			const run = this.deps.store.getActiveWorkflowRunForIssue(issueId);
			if (!run) return 1;
			// max() of the two run-scoped round sources (R2 #4): the shadow's own
			// loop events (covers the legacy belt, which has no durable record)
			// and the durable fix-round events ATTRIBUTED to this run's executions
			// (covers a transiently-failed T6 shadow write before T8 heals it).
			const loops = this.deps.store.countWorkflowRunLoopIterations(run.run_id);
			const attributed = this.deps.store.listWorkflowRunAttributedFixRounds(
				run.run_id,
				issueId,
			).length;
			return 1 + Math.max(loops, attributed);
		} catch (err) {
			this.warn(
				`[workflow-shadow] currentAttempt failed (issue=${issueId}): ${(err as Error).message}`,
			);
			return Number.NaN;
		}
	}

	/** T1/T2/T7 — called ONLY from the RunDispatcher.start() pre-launch seam. */
	onSpawnDispatch(args: {
		projectName: string;
		issueId: string;
		executionId: string;
		context: WorkflowShadowContext;
	}): void {
		this.safe("onSpawnDispatch", args, () => {
			const ops: WorkflowShadowOp[] = [];
			if (args.context.edge) {
				ops.push({
					op: "edge",
					from: args.context.edge.from,
					to: args.context.edge.to,
					attempt: args.context.attempt,
					executionId: args.executionId,
				});
			}
			ops.push({
				op: "dispatch",
				node: args.context.node,
				attempt: args.context.attempt,
				executionId: args.executionId,
			});
			this.batch(args.projectName, args.issueId, ops);
		});
	}

	/** T3 (no edge) / T3b (with edge) — orchestrator wake points. */
	onWake(args: {
		projectName: string;
		issueId: string;
		executionId: string;
		node: string;
		attempt: number;
		edge?: { from: string; to: string };
	}): void {
		this.safe("onWake", args, () => {
			const ops: WorkflowShadowOp[] = [];
			if (args.edge) {
				ops.push({
					op: "edge",
					from: args.edge.from,
					to: args.edge.to,
					attempt: args.attempt,
					executionId: args.executionId,
				});
			}
			ops.push({
				op: "wake",
				node: args.node,
				attempt: args.attempt,
				executionId: args.executionId,
			});
			this.batch(args.projectName, args.issueId, ops);
		});
	}

	/** T4 — onPhaseComplete at a genuine handoff boundary. */
	onNodeComplete(args: {
		projectName: string;
		issueId: string;
		executionId: string;
		node: string;
		attempt: number;
	}): void {
		this.safe("onNodeComplete", args, () => {
			this.batch(args.projectName, args.issueId, [
				{
					op: "complete",
					node: args.node,
					attempt: args.attempt,
					executionId: args.executionId,
				},
			]);
		});
	}

	/** T5 — QA PASS: qa completes AND the qa→end edge is traversed. */
	onQaPass(args: {
		projectName: string;
		issueId: string;
		executionId: string;
		attempt: number;
	}): void {
		this.safe("onQaPass", args, () => {
			this.batch(args.projectName, args.issueId, [
				{
					op: "complete",
					node: "qa",
					attempt: args.attempt,
					executionId: args.executionId,
				},
				{
					op: "edge",
					from: "qa",
					to: "end",
					attempt: args.attempt,
					executionId: args.executionId,
				},
			]);
		});
	}

	/** T6 — the belt round-increment point (loop_iteration's SOLE owner). */
	onKickback(args: {
		projectName: string;
		issueId: string;
		round: number;
	}): void {
		this.safe("onKickback", args, () => {
			this.batch(args.projectName, args.issueId, [
				{ op: "kickback", round: args.round },
			]);
		});
	}

	/** T9 fast path — the runPostShipFinalization best-effort hook. */
	onShipFinalized(args: { projectName: string; issueId: string }): void {
		this.safe("onShipFinalized", args, () => {
			// finalize only an EXISTING active run — a ship for a run that was
			// never shadowed (flag flipped on later) must not mint an empty run.
			const run = this.deps.store.getActiveWorkflowRun(
				args.projectName,
				args.issueId,
			);
			if (!run) return;
			this.deps.store.applyWorkflowShadowBatch({
				projectName: args.projectName,
				issueId: args.issueId,
				ops: [{ op: "finalize" }],
			});
		});
	}

	/**
	 * Dispatch failure callback (start()'s rejection path). ABANDON needs
	 * POSITIVE pre-commit failure evidence: run() rejected AND no durable
	 * commit marker AND no non-pending CommDB row. A durable marker ⇒ the
	 * launch committed (post-start failure — stops at launch_committed,
	 * never abandoned); a row without a marker is the honest Codex pre-goal
	 * unknown ⇒ stays intent_recorded forever (R3#1). No probes ⇒ nothing
	 * can be proven ⇒ warn + leave as-is.
	 */
	onDispatchFailed(args: {
		projectName: string;
		issueId: string;
		executionId: string;
		node: string;
		attempt: number;
		error: string;
	}): void {
		this.safe("onDispatchFailed", args, () => {
			const probes = this.deps.probes;
			if (!probes) {
				this.warn(
					`[workflow-shadow] onDispatchFailed without evidence probes (issue=${args.issueId} execution=${args.executionId}) — leaving ledger state untouched`,
				);
				return;
			}
			const marker = probes.hasCommitMarker(args.executionId);
			const row = probes.hasNonPendingCommDbRow(
				args.projectName,
				args.executionId,
			);
			if (marker) {
				this.batch(args.projectName, args.issueId, [
					{
						op: "side_effect",
						node: args.node,
						attempt: args.attempt,
						executionId: args.executionId,
						to: "launch_committed",
					},
				]);
				return;
			}
			// Abandon requires PROVEN absence on BOTH evidences. `true` = the
			// Codex pre-goal shape (row without marker — honest unknown, no
			// rewrite); `"unknown"` = the lookup itself failed (research §F.3
			// lookup_error — fail-closed, keep state; Codex code R1 #1).
			if (row !== false) {
				if (row === "unknown") {
					this.warn(
						`[workflow-shadow] onDispatchFailed lookup_error (issue=${args.issueId} execution=${args.executionId}) — evidence unprovable, ledger state kept`,
					);
				}
				return;
			}
			this.batch(args.projectName, args.issueId, [
				{
					op: "side_effect",
					node: args.node,
					attempt: args.attempt,
					executionId: args.executionId,
					to: "abandoned",
					reason: `pre_commit_failure: ${args.error}`,
				},
			]);
		});
	}

	/**
	 * ②b reconcile: advance non-terminal ledger rows from DURABLE evidence
	 * only. started = marker ∧ PROVEN non-pending row (dual evidence, no
	 * shortcut — an "unknown" lookup never completes it, R1 #1); marker alone
	 * = launch_committed; row alone = stays intent_recorded. Iterates the
	 * LEDGER ROWS, never the active-run list — a run that shipped (completed)
	 * before its evidence was read still converges (Codex code R1 #3).
	 * ZERO production side effects (B8): no spawn/wake/Blueprint surface is
	 * even reachable from here — dispatch driving is sub-issue D.
	 */
	reconcileSideEffects(): void {
		const probes = this.deps.probes;
		if (!probes) {
			this.warn(
				"[workflow-shadow] reconcileSideEffects skipped — no evidence probes wired",
			);
			return;
		}
		let rows: ReturnType<StateStore["listNonTerminalWorkflowSideEffects"]>;
		try {
			rows = this.deps.store.listNonTerminalWorkflowSideEffects();
		} catch (err) {
			this.warn(
				`[workflow-shadow] reconcileSideEffects ledger query failed: ${(err as Error).message}`,
			);
			return;
		}
		for (const r of rows) {
			this.safe(
				"reconcileSideEffects",
				{ issueId: r.issue_id, executionId: r.execution_id },
				() => {
					const marker = probes.hasCommitMarker(r.execution_id);
					if (!marker) return; // no marker → never advance (R3#1)
					const row = probes.hasNonPendingCommDbRow(
						r.project_name,
						r.execution_id,
					);
					const to =
						row === true ? ("started" as const) : ("launch_committed" as const);
					if (to === r.state) return;
					this.deps.store.applyWorkflowShadowBatch({
						projectName: r.project_name,
						issueId: r.issue_id,
						runId: r.run_id, // explicit — the run may already be completed
						ops: [
							{
								op: "side_effect",
								node: r.node_id,
								attempt: r.attempt,
								executionId: r.execution_id,
								to,
							},
						],
					});
				},
			);
		}
	}

	/**
	 * T8 — startup replay over ACTIVE shadow runs, per the transition table's
	 * durable-source column. Backfills only crash windows where the PRODUCTION
	 * source is durable but the shadow write is missing:
	 *   - T6: three_stage_fix_round events recorded DURING this run (ts >=
	 *     run.created_at — a previous workflow's rounds are its own history,
	 *     R1 #2), each with its ACTUAL production round number;
	 *   - T9: post_ship_finalization_claim → finalize (external-merge repair);
	 *   - T4/T5: the NEWEST phase session per role only (R1 #4 — historical
	 *     boundary rows from legacy close-respawns stay a declared gap);
	 * DECLARED GAPS (R2#4/R3#4 — honest, never fabricated): wake-class
	 * fine-grained moments, HISTORICAL T4 completes across earlier keep-alive
	 * rounds, and legacy-path kickbacks that crashed before their shadow write
	 * (the legacy belt has no durable per-round record). Pre-enable history
	 * (flag OFF→ON) is likewise not invented: only issues with an active
	 * shadow run are visited. Dedicated to the shadow — NEVER piggybacks the
	 * orchestrator's skip-heavy reconcile, NEVER triggers production actions.
	 */
	reconcileOnStartup(): void {
		let runs: ReturnType<StateStore["listActiveWorkflowRuns"]>;
		try {
			runs = this.deps.store.listActiveWorkflowRuns();
		} catch (err) {
			this.warn(
				`[workflow-shadow] reconcileOnStartup run query failed: ${(err as Error).message}`,
			);
			return;
		}
		for (const run of runs) {
			this.safe("reconcileOnStartup", { issueId: run.issue_id }, () => {
				const store = this.deps.store;
				const issueId = run.issue_id;
				const project = run.project_name;

				// T6 backfill — only rounds ATTRIBUTED to executions this run
				// dispatched (execution identity, never timestamps — R2 #1), with
				// their real production round numbers (idempotent uids).
				for (const round of store.listWorkflowRunAttributedFixRounds(
					run.run_id,
					issueId,
				)) {
					store.applyWorkflowShadowBatch({
						projectName: project,
						issueId,
						ops: [{ op: "kickback", round }],
					});
				}
				// Attempt derives from the run's own shadow loops AFTER the T6
				// backfill above — the same run-scoped source currentAttempt uses.
				const attempt = 1 + store.countWorkflowRunLoopIterations(run.run_id);

				// T4/T5 latest-boundary backfill: the NEWEST session per role only
				// (getPhaseSessionsForIssue orders newest-first) — older rows at a
				// boundary status are historical facts we cannot attribute to an
				// attempt, a declared gap (R1 #4).
				const phases = store.getPhaseSessionsForIssue(issueId);
				const seenRoles = new Set<string>();
				for (const p of phases) {
					const role = p.chat_thread_role ?? "";
					if (seenRoles.has(role)) continue;
					seenRoles.add(role);
					// Cross-run attribution (R2 #2): a session row backfills into
					// this run ONLY if this run dispatched its execution — a prior
					// workflow's rows on the same issue are that run's history.
					if (
						!store.isExecutionAttributedToWorkflowRun(
							run.run_id,
							p.execution_id,
						)
					) {
						continue;
					}
					if (role === "design" && p.status === "design_done") {
						store.applyWorkflowShadowBatch({
							projectName: project,
							issueId,
							ops: [
								{
									op: "complete",
									node: "design",
									attempt: 1,
									executionId: p.execution_id,
								},
							],
						});
					}
					if (role === "implement" && p.status === "awaiting_review") {
						store.applyWorkflowShadowBatch({
							projectName: project,
							issueId,
							ops: [
								{
									op: "complete",
									node: "implement",
									attempt,
									executionId: p.execution_id,
								},
							],
						});
					}
					if (role === "qa") {
						const intent = store.getSessionParams(p.execution_id)
							?.three_stage_verdict as { status?: string } | undefined;
						if (intent?.status === "pass") {
							store.applyWorkflowShadowBatch({
								projectName: project,
								issueId,
								ops: [
									{
										op: "complete",
										node: "qa",
										attempt,
										executionId: p.execution_id,
									},
									{
										op: "edge",
										from: "qa",
										to: "end",
										attempt,
										executionId: p.execution_id,
									},
								],
							});
						}
					}
				}

				// T9 claim repair — covers the external-merge path and any
				// in-process hook failure (B10's second leg). Attribution-gated
				// (R2 #3): only a claim raised by an execution THIS run dispatched
				// finalizes it — a prior workflow's ship must never close a new run
				// (an unattributable claim, e.g. pre-flag dispatch, stays a
				// declared gap rather than a fabricated finalization).
				if (store.hasWorkflowRunAttributedShipClaim(run.run_id, issueId)) {
					store.applyWorkflowShadowBatch({
						projectName: project,
						issueId,
						ops: [{ op: "finalize" }],
					});
				}
			});
		}
		// Evidence advancement rides the same boot pass.
		this.reconcileSideEffects();
	}
}
