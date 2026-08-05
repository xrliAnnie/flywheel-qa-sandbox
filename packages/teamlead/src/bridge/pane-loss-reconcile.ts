/** FLY-1628: reconcile active StateStore rows against a superseded tmux body. */

import type { TransitionContext } from "flywheel-core";
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "../applyTransition.js";
import { isWakeTerminalStatus } from "../operational-terminal-status.js";
import type { Session, StateStore } from "../StateStore.js";
import { EXECUTOR_TO_TRANSPORT } from "./role-adapter-resolver.js";
import type {
	RunnerLiveness,
	RunnerTmuxTargetDiscovery,
	TmuxServerStartTimeProbe,
	TmuxTargetLookup,
} from "./tmux-lookup.js";

export type PaneLossFaceOutcome =
	| "ran"
	| "skipped_first_check"
	| "skipped_episode"
	| "skipped_hold"
	| "skipped_server"
	| "skipped_coordinator_in_flight";

export type PaneLossNotificationClass =
	| "advisory_absence_unproven"
	| "advisory_codex"
	| "advisory_generation_superseded"
	| "settlement";

export interface PaneLossGeneration {
	socket_path: string;
	server_start_time: string;
	window_id?: string;
	execution_id?: string;
	launch_generation?: number;
	launch_fingerprint?: string;
}

export function parsePaneLossGenerationParams(
	rawParams: string | null | undefined,
): PaneLossGeneration | undefined {
	if (!rawParams) return undefined;
	try {
		const params = JSON.parse(rawParams) as Record<string, unknown>;
		const raw = params.pane_loss_generation;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		const record = raw as Record<string, unknown>;
		return typeof record.socket_path === "string" &&
			record.socket_path.length > 0 &&
			typeof record.server_start_time === "string" &&
			/^[0-9]+$/.test(record.server_start_time)
			? {
					socket_path: record.socket_path,
					server_start_time: record.server_start_time,
					...(typeof record.window_id === "string" && {
						window_id: record.window_id,
					}),
					...(typeof record.execution_id === "string" && {
						execution_id: record.execution_id,
					}),
					...(Number.isInteger(record.launch_generation) && {
						launch_generation: Number(record.launch_generation),
					}),
					...(typeof record.launch_fingerprint === "string" && {
						launch_fingerprint: record.launch_fingerprint,
					}),
				}
			: undefined;
	} catch {
		return undefined;
	}
}

/** Crash-atomic launch callback used by RunDispatcher for claude-tmux. */
export function persistPaneLossGenerationCredential(
	store: StateStore,
	executionId: string,
	info: {
		windowId: string;
		socketPath: string;
		serverStartTime: string;
		executionId: string;
		launchGeneration?: number;
		launchFingerprint?: string;
	},
): void {
	const before = store.getSession(executionId);
	if (!before) throw new Error(`session ${executionId} is not registered`);
	if (isWakeTerminalStatus(before.status)) {
		throw new Error(`session ${executionId} is terminal (${before.status})`);
	}
	if (info.executionId !== executionId) {
		throw new Error(`tmux execution identity mismatch for ${executionId}`);
	}
	if (info.launchGeneration !== undefined) {
		const owner = store.getWorkflowLaunchOwner(executionId);
		if (
			!owner ||
			owner.owner_generation !== info.launchGeneration ||
			(owner.released_generation ?? 0) >= info.launchGeneration
		) {
			throw new Error(`workflow launch generation is stale for ${executionId}`);
		}
	}
	let params: Record<string, unknown>;
	try {
		params = store.getSessionParams(executionId) ?? {};
	} catch {
		throw new Error(`session ${executionId} has malformed session_params`);
	}
	const expected: PaneLossGeneration = {
		socket_path: info.socketPath,
		server_start_time: info.serverStartTime,
		window_id: info.windowId,
		execution_id: executionId,
		...(info.launchGeneration !== undefined && {
			launch_generation: info.launchGeneration,
		}),
		...(info.launchFingerprint && {
			launch_fingerprint: info.launchFingerprint,
		}),
	};
	store.setSessionParams(executionId, {
		...params,
		pane_loss_generation: expected,
	});
	const after = store.getSession(executionId);
	const persisted = readGeneration(store, executionId);
	if (
		!after ||
		isWakeTerminalStatus(after.status) ||
		!sameGeneration(persisted, expected)
	) {
		throw new Error(
			`session ${executionId} generation credential did not persist`,
		);
	}
}

export type PaneLossDecision =
	| { action: "keep" }
	| {
			action: "advisory";
			notificationClass: Exclude<PaneLossNotificationClass, "settlement">;
	  }
	| { action: "fail"; notificationClass: "settlement" };

export function isAutoMigratableClaudeTmux(
	adapterType: string | null | undefined,
): boolean {
	const normalized = adapterType?.trim();
	return !normalized || normalized === "claude-tmux";
}

export function evaluatePaneLossEvidence(input: {
	status: string;
	adapterType: string | undefined;
	body: RunnerLiveness;
	generation: "superseded" | "same_generation" | "unavailable";
}): PaneLossDecision {
	if (input.body !== "absent") return { action: "keep" };
	if (
		input.adapterType &&
		Object.hasOwn(EXECUTOR_TO_TRANSPORT, input.adapterType) &&
		EXECUTOR_TO_TRANSPORT[
			input.adapterType as keyof typeof EXECUTOR_TO_TRANSPORT
		] === "none"
	) {
		return { action: "keep" };
	}
	if (input.adapterType === "codex-tmux") {
		return { action: "advisory", notificationClass: "advisory_codex" };
	}
	if (!isAutoMigratableClaudeTmux(input.adapterType)) {
		return {
			action: "advisory",
			notificationClass: "advisory_absence_unproven",
		};
	}
	if (input.generation !== "superseded") {
		return {
			action: "advisory",
			notificationClass: "advisory_absence_unproven",
		};
	}
	if (input.status === "running") {
		return { action: "fail", notificationClass: "settlement" };
	}
	return {
		action: "advisory",
		notificationClass: "advisory_generation_superseded",
	};
}

export interface PaneLossReconcileDeps {
	store: StateStore;
	transitionOpts: ApplyTransitionOpts;
	/** false is a strictly read-only evidence pass. */
	mutate: boolean;
	nowMs: () => number;
	preflight: () => Promise<PaneLossFaceOutcome>;
	/** Synchronous fence re-check after the final awaited generation probe. */
	fence: () => PaneLossFaceOutcome;
	lookupTarget: (executionId: string, projectName: string) => TmuxTargetLookup;
	probeRunner: (tmuxWindow: string) => Promise<RunnerLiveness>;
	discoverTarget: (executionId: string) => Promise<RunnerTmuxTargetDiscovery>;
	probeServerGeneration: (
		socketPath: string,
	) => Promise<TmuxServerStartTimeProbe>;
	isCompleteMarkerPending: (executionId: string) => boolean;
	notify: (
		session: Session,
		classification: PaneLossNotificationClass,
		terminalLifecycleId?: string,
	) => Promise<boolean>;
	lifecycleMutex?: {
		withIssueMutex: <T>(keys: string[], fn: () => Promise<T>) => Promise<T>;
		resolveLockKeys: (issueId: string) => string[];
	};
	launchGraceMs?: number;
	log?: (message: string) => void;
}

export interface PaneLossReconcileResult {
	face: PaneLossFaceOutcome;
	scanned: number;
	failed: number;
	advisories: number;
	kept: number;
}

function readGeneration(
	store: StateStore,
	executionId: string,
): PaneLossGeneration | undefined {
	try {
		const raw = store.getSessionParams(executionId)?.pane_loss_generation;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		const record = raw as Record<string, unknown>;
		return typeof record.socket_path === "string" &&
			record.socket_path.length > 0 &&
			typeof record.server_start_time === "string" &&
			/^[0-9]+$/.test(record.server_start_time)
			? {
					socket_path: record.socket_path,
					server_start_time: record.server_start_time,
					...(typeof record.window_id === "string" && {
						window_id: record.window_id,
					}),
					...(typeof record.execution_id === "string" && {
						execution_id: record.execution_id,
					}),
					...(Number.isInteger(record.launch_generation) && {
						launch_generation: Number(record.launch_generation),
					}),
					...(typeof record.launch_fingerprint === "string" && {
						launch_fingerprint: record.launch_fingerprint,
					}),
				}
			: undefined;
	} catch {
		return undefined;
	}
}

function sameGeneration(
	left: PaneLossGeneration | undefined,
	right: PaneLossGeneration | undefined,
): boolean {
	return (
		left?.socket_path === right?.socket_path &&
		left?.server_start_time === right?.server_start_time &&
		(left?.window_id === undefined ||
			right?.window_id === undefined ||
			left.window_id === right.window_id) &&
		(left?.launch_generation === undefined ||
			right?.launch_generation === undefined ||
			left.launch_generation === right.launch_generation)
	);
}

function startedAtMs(session: Session): number | undefined {
	if (!session.started_at) return undefined;
	const parsed = Date.parse(
		session.started_at.includes("T")
			? session.started_at
			: `${session.started_at.replace(" ", "T")}Z`,
	);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function targetFingerprint(lookup: TmuxTargetLookup): string | undefined {
	if (lookup.kind === "gone") return "gone";
	if (lookup.kind === "found") return `found:${lookup.target.tmuxWindow}`;
	return undefined;
}

async function resolveBodyEvidence(
	session: Session,
	deps: PaneLossReconcileDeps,
): Promise<{ body: RunnerLiveness; targetFingerprint: string } | undefined> {
	const lookup = deps.lookupTarget(session.execution_id, session.project_name);
	const fingerprint = targetFingerprint(lookup);
	if (!fingerprint) return undefined;
	if (lookup.kind === "found") {
		const body = await deps.probeRunner(lookup.target.tmuxWindow);
		if (body === "alive" || body === "dead_pin" || body === "indeterminate") {
			return { body, targetFingerprint: fingerprint };
		}
	}
	const discovery = await deps.discoverTarget(session.execution_id);
	if (discovery.kind !== "found") {
		return discovery.kind === "missing"
			? { body: "absent", targetFingerprint: fingerprint }
			: undefined;
	}
	const reprobe = await deps.probeRunner(discovery.tmuxWindow);
	return reprobe === "indeterminate"
		? undefined
		: { body: reprobe, targetFingerprint: fingerprint };
}

function notifiedEventId(
	executionId: string,
	classification: PaneLossNotificationClass,
	terminalLifecycleId?: string,
): string {
	return classification === "settlement"
		? `pane-loss-notified-${executionId}-settlement-${terminalLifecycleId ?? "missing"}`
		: `pane-loss-notified-${executionId}-${classification}`;
}

function hasEvent(
	store: StateStore,
	executionId: string,
	eventId: string,
): boolean {
	return store
		.getEventsByExecution(executionId)
		.some((event) => event.event_id === eventId);
}

async function deliverNotification(
	session: Session,
	classification: PaneLossNotificationClass,
	deps: PaneLossReconcileDeps,
	terminalLifecycleId?: string,
): Promise<void> {
	const eventId = notifiedEventId(
		session.execution_id,
		classification,
		terminalLifecycleId,
	);
	if (hasEvent(deps.store, session.execution_id, eventId)) return;
	if (!(await deps.notify(session, classification, terminalLifecycleId)))
		return;
	deps.store.insertEvent({
		event_id: eventId,
		execution_id: session.execution_id,
		issue_id: session.issue_id,
		project_name: session.project_name,
		event_type: "runner_pane_loss_notified",
		source: "bridge.pane-loss-reconcile",
		payload: { classification, terminalLifecycleId },
	});
}

/** One full project face. Every destructive conclusion is generation-fenced. */
export async function reconcilePaneLoss(
	projectName: string,
	deps: PaneLossReconcileDeps,
): Promise<PaneLossReconcileResult> {
	const face = await deps.preflight();
	const result: PaneLossReconcileResult = {
		face,
		scanned: 0,
		failed: 0,
		advisories: 0,
		kept: 0,
	};
	if (face !== "ran") return result;

	const candidates = deps.store
		.getReadoptCandidateSessions()
		.filter((session) => session.project_name === projectName);
	result.scanned = candidates.length;
	const attemptedSettlements = new Set<string>();
	for (const snapshot of candidates) {
		const run = async (): Promise<void> => {
			if (deps.isCompleteMarkerPending(snapshot.execution_id)) {
				result.kept++;
				return;
			}
			const generation = readGeneration(deps.store, snapshot.execution_id);
			const bodyEvidence = await resolveBodyEvidence(snapshot, deps);
			if (!bodyEvidence || bodyEvidence.body !== "absent") {
				result.kept++;
				return;
			}

			// This is intentionally the final await before the synchronous mutation
			// fence. Missing/malformed credentials cannot authorize terminalization.
			const currentGeneration = generation
				? await deps.probeServerGeneration(generation.socket_path)
				: ({ kind: "indeterminate" } as const);
			if (generation && currentGeneration.kind !== "found") {
				result.kept++;
				return;
			}
			const generationVerdict =
				generation && currentGeneration.kind === "found"
					? currentGeneration.startTime === generation.server_start_time
						? "same_generation"
						: "superseded"
					: "unavailable";
			const decision = evaluatePaneLossEvidence({
				status: snapshot.status,
				adapterType: snapshot.adapter_type,
				body: bodyEvidence.body,
				generation: generationVerdict,
			});
			if (decision.action === "keep") {
				result.kept++;
				return;
			}
			if (!deps.mutate) {
				if (decision.action === "fail") result.failed++;
				else result.advisories++;
				return;
			}

			const started = startedAtMs(snapshot);
			if (
				decision.action === "advisory" &&
				(started === undefined ||
					deps.nowMs() - started < (deps.launchGraceMs ?? 10 * 60_000))
			) {
				result.kept++;
				return;
			}

			const current = deps.store.getSession(snapshot.execution_id);
			const currentTarget = deps.lookupTarget(
				snapshot.execution_id,
				snapshot.project_name,
			);
			if (
				!current ||
				current.project_name !== snapshot.project_name ||
				current.status !== snapshot.status ||
				(current.lifecycle_revision ?? 0) !==
					(snapshot.lifecycle_revision ?? 0) ||
				!sameGeneration(
					readGeneration(deps.store, snapshot.execution_id),
					generation,
				) ||
				targetFingerprint(currentTarget) !== bodyEvidence.targetFingerprint ||
				deps.isCompleteMarkerPending(snapshot.execution_id) ||
				deps.fence() !== "ran"
			) {
				result.kept++;
				return;
			}

			deps.store.insertEvent({
				event_id: `pane-loss-${snapshot.execution_id}`,
				execution_id: snapshot.execution_id,
				issue_id: snapshot.issue_id,
				project_name: snapshot.project_name,
				event_type: "runner_pane_loss_detected",
				severity: generationVerdict === "superseded" ? "warning" : "info",
				source: "bridge.pane-loss-reconcile",
				payload: {
					previousStatus: snapshot.status,
					adapterType: snapshot.adapter_type ?? null,
					generation: generationVerdict,
				},
			});
			if (
				!hasEvent(
					deps.store,
					snapshot.execution_id,
					`pane-loss-${snapshot.execution_id}`,
				)
			) {
				result.kept++;
				return;
			}

			if (decision.action === "advisory") {
				result.advisories++;
				await deliverNotification(snapshot, decision.notificationClass, deps);
				return;
			}
			if (!generation || currentGeneration.kind !== "found") {
				result.kept++;
				return;
			}

			const ctx: TransitionContext = {
				executionId: snapshot.execution_id,
				issueId: snapshot.issue_id,
				projectName: snapshot.project_name,
				trigger: "pane_loss_reconcile",
			};
			const transition = applyTransition(
				deps.transitionOpts,
				snapshot.execution_id,
				"failed",
				ctx,
				{
					last_activity_at: new Date(deps.nowMs())
						.toISOString()
						.replace("T", " ")
						.replace(/\.\d+Z$/, ""),
					last_error: `pane_loss: server generation superseded (socket=${generation.socket_path}, recorded=${generation.server_start_time}, current=${currentGeneration.startTime}); target ${bodyEvidence.targetFingerprint} absent; rediscovery missing; recovery requires Lead/founder action`,
				},
			);
			if (!transition.ok) {
				result.kept++;
				return;
			}
			result.failed++;
			const terminal = deps.store.getSession(snapshot.execution_id);
			if (terminal?.terminal_lifecycle_id) {
				attemptedSettlements.add(snapshot.execution_id);
				await deliverNotification(
					terminal,
					"settlement",
					deps,
					terminal.terminal_lifecycle_id,
				);
			}
		};
		if (deps.lifecycleMutex) {
			await deps.lifecycleMutex.withIssueMutex(
				deps.lifecycleMutex.resolveLockKeys(snapshot.issue_id),
				run,
			);
		} else {
			await run();
		}
	}

	// Notification debt survives a notifier outage and Bridge restart. A failed
	// row no longer appears in the active candidate query, so scan only the exact
	// pane_loss terminal shape for its missing lifecycle-scoped settlement.
	if (deps.mutate) {
		for (const session of deps.store.getProjectSessions(projectName)) {
			if (
				session.status !== "failed" ||
				!session.last_error?.startsWith("pane_loss:") ||
				!session.terminal_lifecycle_id ||
				attemptedSettlements.has(session.execution_id)
			) {
				continue;
			}
			await deliverNotification(
				session,
				"settlement",
				deps,
				session.terminal_lifecycle_id,
			);
		}
	}
	return result;
}
