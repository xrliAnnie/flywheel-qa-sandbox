import { randomUUID } from "node:crypto";
import type {
	CodexDaemonLiveness,
	CodexDaemonReapResult,
	CodexExecutionOwnershipRegistry,
	CodexLaunchSnapshot,
	RecoveryOwnershipReceipt,
} from "flywheel-claude-runner";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
} from "flywheel-core";
import type { Session, StateStore } from "../StateStore.js";
import type {
	RunnerTmuxWindowInventory,
	TmuxTargetLookup,
} from "./tmux-lookup.js";

export const CODEX_REOWN_EVENT_SOURCE = "bridge.codex-session-reown";
export const CODEX_RECOVERY_CLAIM_TTL_MS = 60_000;
export const CODEX_REOWN_ROLLOUT_STALE_MS = 10 * 60_000;

export type CodexReownEvent =
	| "reown_watch_started"
	| "reown_revive_started"
	| "reown_revive_succeeded"
	| "reown_revive_failed"
	| "reown_skipped_superseded"
	| "reown_skipped_not_turn_holder"
	| "reown_probe_unknown"
	| "reown_fence_lost";

export interface CodexRecoveryReceiptHook {
	onRecoveryOwnershipEstablished(
		receipt: RecoveryOwnershipReceipt,
	): Promise<void>;
}

export type PreparedCodexRecoveryCapabilities = Extract<
	ReturnType<StateStore["prepareCodexRecoveryCapabilities"]>,
	{ ok: true }
>;

export interface CodexSessionReownDeps {
	store: Pick<
		StateStore,
		| "getReadoptCandidateSessions"
		| "claimCodexRecovery"
		| "prepareCodexRecoveryCapabilities"
		| "abortCodexRecovery"
		| "commitCodexRecovery"
	>;
	owners: Pick<CodexExecutionOwnershipRegistry, "isExecutionOwned">;
	isCurrentBinding(session: Session): boolean | Promise<boolean>;
	preflightRecovery?(session: Session): void | Promise<void>;
	hasOpenGate(session: Session): boolean | Promise<boolean>;
	probe(executionId: string): Promise<CodexDaemonLiveness>;
	probeRolloutMtime?(
		executionId: string,
	): Promise<
		{ kind: "found"; mtimeMs: number } | { kind: "absent" | "unknown" }
	>;
	reap(executionId: string): Promise<CodexDaemonReapResult>;
	/** Starts the long-lived owner immediately and returns its terminal promise. */
	revive(
		session: Session,
		input: CodexRecoveryReceiptHook & {
			capabilities: PreparedCodexRecoveryCapabilities;
		},
	): Promise<AdapterExecutionResult>;
	readTurnHolder(session: Session): Promise<string | null>;
	onRecoveryExhausted(session: Session, attempts: number): Promise<void>;
	record(
		event: CodexReownEvent,
		session: Session,
		payload: Record<string, unknown>,
	): void;
	alert(session: Session, reason: string): Promise<void> | void;
	nowMs(): number;
	holderId: string;
	isExcluded(session: Session): boolean;
}

export interface CodexReownPassResult {
	/** The single StateStore snapshot shared with the adjacent orphan sweep. */
	snapshot: readonly Session[];
	activeExecutionIds: ReadonlySet<string>;
}

export type CodexRecoveryWindowDecision =
	| { founderWindow: "open"; label: string; windowName?: string }
	| { founderWindow: "suppressed"; reason: string };

function recoverableWindowName(windowName: string): boolean {
	return /^[A-Za-z0-9_.-]{1,50}$/.test(windowName);
}

export async function resolveCodexRecoveryWindow(input: {
	executionId: string;
	projectName: string;
	snapshotLabel?: string;
	listWindows(executionId: string): Promise<RunnerTmuxWindowInventory>;
	lookupTarget(executionId: string, projectName: string): TmuxTargetLookup;
}): Promise<CodexRecoveryWindowDecision> {
	if (input.snapshotLabel) {
		return { founderWindow: "open", label: input.snapshotLabel };
	}
	let inventory: RunnerTmuxWindowInventory;
	try {
		inventory = await input.listWindows(input.executionId);
	} catch {
		return {
			founderWindow: "suppressed",
			reason: "candidates_indeterminate",
		};
	}
	if (inventory.kind === "indeterminate") {
		return {
			founderWindow: "suppressed",
			reason: "candidates_indeterminate",
		};
	}
	if (inventory.windows.length === 0) {
		return { founderWindow: "suppressed", reason: "no_candidates" };
	}
	const names = new Set(inventory.windows.map((window) => window.windowName));
	if (names.size === 1) {
		const [windowName] = names;
		if (windowName && recoverableWindowName(windowName)) {
			return { founderWindow: "open", label: windowName, windowName };
		}
		return { founderWindow: "suppressed", reason: "unsafe_window_name" };
	}
	let lookup: TmuxTargetLookup;
	try {
		lookup = input.lookupTarget(input.executionId, input.projectName);
	} catch {
		return { founderWindow: "suppressed", reason: "commdb_lookup_error" };
	}
	if (lookup.kind === "error") {
		return { founderWindow: "suppressed", reason: "commdb_lookup_error" };
	}
	if (lookup.kind === "found") {
		const separator = lookup.target.tmuxWindow.lastIndexOf(":");
		const windowId = lookup.target.tmuxWindow.slice(separator + 1);
		const selected = inventory.windows.find(
			(window) => window.windowId === windowId,
		);
		if (selected) {
			return recoverableWindowName(selected.windowName)
				? {
						founderWindow: "open",
						label: selected.windowName,
						windowName: selected.windowName,
					}
				: { founderWindow: "suppressed", reason: "unsafe_window_name" };
		}
	}
	return {
		founderWindow: "suppressed",
		reason: "commdb_pointer_not_in_candidates",
	};
}

/** Rebuild the adapter input exclusively from immutable + freshly fenced data. */
export function buildCodexRecoveryContext(input: {
	session: Session;
	snapshot: CodexLaunchSnapshot;
	capabilities: PreparedCodexRecoveryCapabilities;
	label?: string;
	leadId?: string;
	agentName?: string;
	teamName?: string;
	commDbPath?: string;
	stateDbPath?: string;
	bridgeUrl?: string;
	bridgeIngestToken?: string;
	progressPath?: string;
	onHeartbeat?: (executionId: string) => void;
}): AdapterExecutionContext {
	const raw = input.snapshot.rehydrationContext;
	if (!raw) {
		throw new Error(
			`immutable launch snapshot for ${input.session.execution_id} lacks rehydration context`,
		);
	}
	if (
		raw.workflowSubmissionExpected !==
			input.capabilities.workflowSubmissionExpected ||
		raw.founderReviewRequired !== input.capabilities.founderReviewRequired
	) {
		throw new Error(
			`workflow capability drift for ${input.session.execution_id}`,
		);
	}
	const launch = input.snapshot.launchContext;
	return {
		executionId: input.session.execution_id,
		issueId: input.session.issue_id,
		prompt: input.snapshot.kickText,
		cwd: input.snapshot.cwd,
		pretrustWorkspace: true,
		...(input.label ? { label: input.label } : {}),
		permissionMode: "bypassPermissions",
		allowedTools: [...raw.allowedTools],
		enablePonytail: raw.enablePonytail,
		codexSkillDisableNames: [...raw.codexSkillDisableNames],
		workflowSubmissionExpected: raw.workflowSubmissionExpected,
		founderReviewRequired: raw.founderReviewRequired,
		vendor: "codex",
		waitingTimeoutMs: 176_400_000,
		projectName: input.session.project_name,
		...(launch.model ? { model: launch.model } : {}),
		...(launch.effort ? { effort: launch.effort } : {}),
		...(launch.skillFrameworkMode
			? { skillFrameworkMode: launch.skillFrameworkMode }
			: {}),
		...(raw.codexMattSkillsSourceDir
			? { codexMattSkillsSourceDir: raw.codexMattSkillsSourceDir }
			: {}),
		...(launch.phaseRole ? { phaseKeepAlive: { role: launch.phaseRole } } : {}),
		...(input.capabilities.workflowOutputCredential
			? {
					workflowOutputCredential: input.capabilities.workflowOutputCredential,
				}
			: {}),
		...(input.capabilities.workflowSubmissionCredential
			? {
					workflowSubmissionCredential:
						input.capabilities.workflowSubmissionCredential,
				}
			: {}),
		...(input.leadId ? { leadId: input.leadId } : {}),
		...(input.agentName ? { agentName: input.agentName } : {}),
		...(input.teamName ? { teamName: input.teamName } : {}),
		...(input.commDbPath ? { commDbPath: input.commDbPath } : {}),
		...(input.stateDbPath ? { stateDbPath: input.stateDbPath } : {}),
		...(input.bridgeUrl ? { bridgeUrl: input.bridgeUrl } : {}),
		...(input.bridgeIngestToken
			? { bridgeIngestToken: input.bridgeIngestToken }
			: {}),
		...(input.progressPath ? { progressPath: input.progressPath } : {}),
		...(input.onHeartbeat ? { onHeartbeat: input.onHeartbeat } : {}),
	};
}

/**
 * The 529 room is an isolated stub topology, not production daemon authority.
 * Keep the predicate narrow and data-derived so ordinary tests are unaffected.
 */
export function isCodexReownExcluded(
	session: Session,
	roomInfo?: unknown,
): boolean {
	if (roomInfo === undefined) return false;
	if (
		typeof roomInfo !== "object" ||
		roomInfo === null ||
		(roomInfo as { schemaVersion?: unknown }).schemaVersion !== 1 ||
		typeof (roomInfo as { slot?: unknown }).slot !== "number" ||
		!Number.isSafeInteger((roomInfo as { slot: number }).slot) ||
		(roomInfo as { slot: number }).slot < 1 ||
		typeof (roomInfo as { projectName?: unknown }).projectName !== "string" ||
		!(roomInfo as { projectName: string }).projectName.trim() ||
		typeof (roomInfo as { generalized?: unknown }).generalized !== "boolean"
	) {
		throw new Error("invalid generalized QA room-info marker");
	}
	return (
		(roomInfo as { generalized: boolean }).generalized === true &&
		(roomInfo as { projectName: string }).projectName === session.project_name
	);
}

function isParked(session: Session): boolean {
	return session.status !== "running";
}

/**
 * Boot/periodic coordinator for detached Codex executions.
 *
 * A pass is deliberately short-lived: it classifies one durable snapshot,
 * acquires the StateStore recovery fence, and starts a rescue owner. The owner
 * itself may live for days and is never awaited by the maintenance scheduler.
 */
export class CodexSessionReowner {
	private inFlight?: Promise<CodexReownPassResult>;
	private readonly unknownStreak = new Map<string, number>();
	private readonly watched = new Set<string>();
	private readonly rolloutByExecution = new Map<
		string,
		{ mtimeMs: number; lastAdvancedAtMs: number }
	>();

	constructor(private readonly deps: CodexSessionReownDeps) {}

	runPass(snapshot?: readonly Session[]): Promise<CodexReownPassResult> {
		if (this.inFlight) return this.inFlight;
		const selected = snapshot ?? this.deps.store.getReadoptCandidateSessions();
		const pass = this.runPassOwned(selected).finally(() => {
			if (this.inFlight === pass) this.inFlight = undefined;
		});
		this.inFlight = pass;
		return pass;
	}

	private async runPassOwned(
		snapshot: readonly Session[],
	): Promise<CodexReownPassResult> {
		const activeExecutionIds = new Set(
			snapshot.map((session) => session.execution_id),
		);
		for (const session of snapshot) {
			await this.inspectCandidate(session);
		}
		return { snapshot, activeExecutionIds };
	}

	private async inspectCandidate(session: Session): Promise<void> {
		if (
			session.adapter_type !== "codex-tmux" ||
			this.deps.isExcluded(session)
		) {
			return;
		}
		if (
			session.retry_successor ||
			!(await this.deps.isCurrentBinding(session))
		) {
			this.record("reown_skipped_superseded", session, {
				retrySuccessor: session.retry_successor ?? null,
			});
			return;
		}
		// Dimension zero: an in-process dispatch/rescue owner is authoritative.
		if (this.deps.owners.isExecutionOwned(session.execution_id)) return;

		let liveness: CodexDaemonLiveness;
		let gateHeld: boolean;
		try {
			[liveness, gateHeld] = await Promise.all([
				this.deps.probe(session.execution_id),
				this.deps.hasOpenGate(session),
			]);
		} catch (error) {
			await this.recordUnknown(
				session,
				error instanceof Error ? error.message : String(error),
			);
			return;
		}
		if (liveness === "unknown") {
			await this.recordUnknown(session, "daemon_liveness_unknown", gateHeld);
			return;
		}

		if (liveness === "alive" && !gateHeld && !isParked(session)) {
			let rolloutMtimeMs: number | undefined;
			if (this.deps.probeRolloutMtime) {
				let rollout:
					| { kind: "found"; mtimeMs: number }
					| { kind: "absent" | "unknown" };
				try {
					rollout = await this.deps.probeRolloutMtime(session.execution_id);
				} catch (error) {
					await this.recordUnknown(
						session,
						`rollout_probe:${error instanceof Error ? error.message : String(error)}`,
						gateHeld,
					);
					return;
				}
				if (rollout.kind !== "found") {
					await this.recordUnknown(
						session,
						`rollout_${rollout.kind}`,
						gateHeld,
					);
					return;
				}
				rolloutMtimeMs = rollout.mtimeMs;
				const observedAtMs = this.deps.nowMs();
				const previous = this.rolloutByExecution.get(session.execution_id);
				if (previous && rolloutMtimeMs <= previous.mtimeMs) {
					const staleForMs = Math.max(
						0,
						observedAtMs - previous.lastAdvancedAtMs,
					);
					if (staleForMs >= CODEX_REOWN_ROLLOUT_STALE_MS) {
						await this.recordUnknown(
							session,
							`rollout_mtime_stale:${previous.mtimeMs}:${rolloutMtimeMs}:${staleForMs}`,
							gateHeld,
						);
					} else {
						this.unknownStreak.delete(session.execution_id);
					}
					return;
				}
				this.rolloutByExecution.set(session.execution_id, {
					mtimeMs: rolloutMtimeMs,
					lastAdvancedAtMs: observedAtMs,
				});
			}
			this.unknownStreak.delete(session.execution_id);
			if (!this.watched.has(session.execution_id)) {
				this.watched.add(session.execution_id);
				this.record("reown_watch_started", session, {
					liveness,
					gateHeld,
					posture: "running",
					...(rolloutMtimeMs !== undefined ? { rolloutMtimeMs } : {}),
				});
			}
			return;
		}
		this.unknownStreak.delete(session.execution_id);
		this.watched.delete(session.execution_id);
		this.rolloutByExecution.delete(session.execution_id);

		await this.beginRecovery(session, { liveness, gateHeld });
	}

	private async recordUnknown(
		session: Session,
		reason: string,
		gateHeld?: boolean,
	): Promise<void> {
		const streak = (this.unknownStreak.get(session.execution_id) ?? 0) + 1;
		this.unknownStreak.set(session.execution_id, streak);
		this.record("reown_probe_unknown", session, {
			streak,
			reason,
			...(gateHeld !== undefined ? { gateHeld } : {}),
		});
		if (streak === 2) {
			await this.deps.alert(
				session,
				"Codex daemon ownership or rollout progress stayed unhealthy for two recovery passes; no mutation was attempted",
			);
		}
	}

	private async beginRecovery(
		session: Session,
		classification: {
			liveness: Exclude<CodexDaemonLiveness, "unknown">;
			gateHeld: boolean;
		},
	): Promise<void> {
		try {
			await this.deps.preflightRecovery?.(session);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.record("reown_revive_failed", session, {
				reason: `preflight_${reason}`,
			});
			await this.deps.alert(session, reason);
			return;
		}
		// Recheck immediately before the durable attempt reservation.
		if (this.deps.owners.isExecutionOwned(session.execution_id)) return;
		const expectedRevision = session.lifecycle_revision ?? 0;
		const claim = this.deps.store.claimCodexRecovery(
			session.execution_id,
			expectedRevision,
			{
				holder: this.deps.holderId,
				nowMs: this.deps.nowMs(),
				ttlMs: CODEX_RECOVERY_CLAIM_TTL_MS,
				maxAttempts: 2,
			},
		);
		if (!claim.ok) {
			if (claim.reason === "superseded" || claim.reason === "stale_revision") {
				this.record("reown_skipped_superseded", session, {
					reason: claim.reason,
				});
			} else if (claim.reason === "episode_exhausted") {
				const attempts = claim.attempts ?? 2;
				this.record("reown_revive_failed", session, {
					reason: claim.reason,
					attempts,
				});
				await this.deps.onRecoveryExhausted(session, attempts);
				await this.deps.alert(
					session,
					`Codex recovery episode exhausted after ${attempts} attempts`,
				);
			}
			return;
		}

		const abort = (
			event: CodexReownEvent,
			reason: string,
			input: { releaseAttempt?: boolean } = {},
		): void => {
			this.deps.store.abortCodexRecovery(
				session.execution_id,
				claim.claimToken,
				input,
			);
			this.record(event, session, {
				reason,
				episodeId: claim.episodeId,
				attempt: claim.attempt,
			});
		};

		// Binding and ownership can change while probe/claim I/O was in flight.
		if (
			this.deps.owners.isExecutionOwned(session.execution_id) ||
			!(await this.deps.isCurrentBinding(session))
		) {
			abort("reown_fence_lost", "owner_or_binding_changed_after_claim", {
				releaseAttempt: true,
			});
			return;
		}
		let observedTurnHolder: string | null;
		try {
			observedTurnHolder = await this.deps.readTurnHolder(session);
		} catch (error) {
			abort(
				"reown_fence_lost",
				`turn_holder_unreadable:${error instanceof Error ? error.message : String(error)}`,
				{ releaseAttempt: true },
			);
			return;
		}
		if (observedTurnHolder !== session.execution_id) {
			abort(
				isParked(session)
					? "reown_skipped_not_turn_holder"
					: "reown_fence_lost",
				"turn_holder_changed_before_recycle",
				{
					releaseAttempt: true,
				},
			);
			return;
		}

		if (classification.liveness === "alive") {
			const reaped = await this.deps.reap(session.execution_id);
			if (reaped.outcome !== "reaped" && reaped.outcome !== "absent") {
				abort("reown_revive_failed", `recycle_${reaped.outcome}`);
				return;
			}
		}

		const capabilities = this.deps.store.prepareCodexRecoveryCapabilities(
			session.execution_id,
			claim.claimToken,
			expectedRevision,
			this.deps.nowMs(),
		);
		if (!capabilities.ok) {
			abort("reown_revive_failed", `capabilities_${capabilities.reason}`);
			return;
		}

		// Last destructive/spawn boundary check required by the approved fence.
		if (
			this.deps.owners.isExecutionOwned(session.execution_id) ||
			!(await this.deps.isCurrentBinding(session))
		) {
			abort("reown_fence_lost", "owner_or_binding_changed_before_spawn");
			return;
		}

		this.record("reown_revive_started", session, {
			episodeId: claim.episodeId,
			attempt: claim.attempt,
			...classification,
			posture: isParked(session) ? "parked" : "running",
		});

		let committed = false;
		let precommitSettled = false;
		const failPrecommit = (reason: string): void => {
			if (committed || precommitSettled) return;
			precommitSettled = true;
			this.deps.store.abortCodexRecovery(
				session.execution_id,
				claim.claimToken,
			);
			this.record("reown_revive_failed", session, {
				reason,
				episodeId: claim.episodeId,
				attempt: claim.attempt,
			});
			void Promise.resolve(this.deps.alert(session, reason)).catch(() => {});
		};

		let terminal: Promise<AdapterExecutionResult>;
		try {
			terminal = this.deps.revive(session, {
				capabilities,
				onRecoveryOwnershipEstablished: async (receipt) => {
					if (committed) return;
					const threadId = receipt.threadId;
					const turnId =
						receipt.kind === "turn_started" ? receipt.turnId : undefined;
					const goalStatus =
						receipt.kind === "turn_started" ? undefined : receipt.goalStatus;
					const observedTurnHolder = await this.deps.readTurnHolder(session);
					const result = this.deps.store.commitCodexRecovery(
						session.execution_id,
						claim.claimToken,
						expectedRevision,
						{
							nowMs: this.deps.nowMs(),
							observedTurnHolder,
						},
					);
					if (!result.ok) {
						this.record("reown_fence_lost", session, {
							reason: result.reason,
							episodeId: claim.episodeId,
							attempt: claim.attempt,
							threadId,
							receiptKind: receipt.kind,
							...(turnId ? { turnId } : {}),
							...(goalStatus ? { goalStatus } : {}),
						});
						throw new Error(`recovery commit refused: ${result.reason}`);
					}
					committed = true;
					this.record("reown_revive_succeeded", session, {
						episodeId: claim.episodeId,
						attempt: claim.attempt,
						threadId,
						receiptKind: receipt.kind,
						...(turnId ? { turnId } : {}),
						...(goalStatus ? { goalStatus } : {}),
						lifecycleRevision: result.lifecycleRevision,
					});
				},
			});
		} catch (error) {
			failPrecommit(error instanceof Error ? error.message : String(error));
			return;
		}

		void terminal.then(
			(result) => {
				if (!result.success) {
					const reason =
						result.resultText ?? "recovery owner failed before commit";
					if (committed) {
						this.record("reown_revive_failed", session, {
							reason,
							episodeId: claim.episodeId,
							attempt: claim.attempt,
							postCommit: true,
						});
					} else {
						failPrecommit(reason);
					}
				}
			},
			(error) => {
				const reason = error instanceof Error ? error.message : String(error);
				if (committed) {
					this.record("reown_revive_failed", session, {
						reason,
						episodeId: claim.episodeId,
						attempt: claim.attempt,
						postCommit: true,
					});
					void Promise.resolve(this.deps.alert(session, reason)).catch(
						() => {},
					);
				} else {
					failPrecommit(reason);
				}
			},
		);
	}

	private record(
		event: CodexReownEvent,
		session: Session,
		payload: Record<string, unknown>,
	): void {
		this.deps.record(event, session, {
			...payload,
			eventId: `${event}-${session.execution_id}-${randomUUID()}`,
			source: CODEX_REOWN_EVENT_SOURCE,
		});
	}
}
