import {
	type PatrolJudgmentFingerprintRead,
	type PatrolTurnSnapshot,
	patrolJudgmentFingerprint,
} from "flywheel-comm/db";
import {
	WORKFLOW_RUN_NODE_STATES,
	ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES,
} from "../workflow-ledger-states.js";

export const PATROL_RED_MIN_WAIT_MS = 30 * 60_000;

const ACTIVE_ATTEMPT_STATES: ReadonlySet<string> = new Set(
	WORKFLOW_RUN_NODE_STATES.filter(
		(state) =>
			state === "pending" ||
			state === "admitted" ||
			state === "running" ||
			state === "review",
	),
);

const HOLDER_TERMINAL_ATTEMPT_STATES: ReadonlySet<string> = new Set([
	"done",
	"failed",
	"superseded",
]);

const HOLDER_TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set([
	"failed",
	"blocked",
	"terminated",
	"completed",
	"ship_parked",
]);

export interface PatrolLoopRosterSession {
	executionId: string;
	status: string;
}

export interface PatrolLoopTurn {
	issueId: string;
	holderExecId: string;
	phase: string;
	epoch: number;
	targetRunId: string | null;
	targetNodeId: string | null;
	targetAttempt: number | null;
	activationId: string | null;
}

export interface PatrolLoopWait {
	executionId: string;
	holderExecId: string;
	epoch: number;
	firstSeenAt: number;
}

export interface PatrolLoopRun {
	runId: string;
	status: "active" | "held";
	currentNodeId: string | null;
}

export interface PatrolLoopAttempt {
	runId: string;
	nodeId: string;
	attempt: number;
	state: string;
	executionId: string | null;
}

export interface PatrolLoopReworkDelivery {
	runId: string;
	state: string;
	targetNodeId?: string | null;
	targetAttempt?: number | null;
	/** Route audit identity retained by the approved §5.2 read-model contract. */
	preferredActorExecutionId?: string | null;
	routeRevision?: number | null;
}

export interface PatrolLoopLandOperation {
	state: string;
	currentStep?: string | null;
	supersededAt?: string | null;
}

export interface PatrolLoopWake {
	issueId: string;
	state: string;
	pushCount: number;
	executionId: string;
	epoch: number;
	activationId: string | null;
}

export interface PatrolLoopGateAuthority {
	runId: string;
	kind: "gate" | "carrier";
	state: string;
}

export interface PatrolLoopSessionStatus {
	executionId: string;
	status: string | null;
}

export interface PatrolLoopProcessLiveness {
	executionId: string;
	state: "alive" | "dead" | "unknown";
}

export interface PatrolLoopFacts {
	issueId: string;
	identifier: string;
	nowMs: number;
	roster: PatrolLoopRosterSession[];
	turn: PatrolLoopTurn | null;
	waits: PatrolLoopWait[];
	runs: PatrolLoopRun[];
	attempts: PatrolLoopAttempt[];
	reworkDeliveries: PatrolLoopReworkDelivery[];
	landOperations: PatrolLoopLandOperation[];
	wakes: PatrolLoopWake[];
	gateAuthorities: PatrolLoopGateAuthority[];
	sessionStatuses: PatrolLoopSessionStatus[];
	processLiveness?: PatrolLoopProcessLiveness[];
	parkedExecutionIds: string[];
	displayWarnings: string[];
	unreadableSources: string[];
	fingerprintStable: boolean;
}

export interface PatrolCommReader {
	readPatrolTurnSnapshot(input: {
		issueIds: string[];
		executionIds: string[];
		nowMs: number;
	}): PatrolTurnSnapshot;
	rereadJudgmentFingerprint(
		issueId: string,
		executionIds: string[],
	): PatrolJudgmentFingerprintRead;
	close(): void;
}

export interface PatrolLoopStore {
	getPatrolWorkflowRuns(projectName: string, issueId: string): PatrolLoopRun[];
	listActiveNodeAttempts(runId: string): PatrolLoopAttempt[];
	getLatestNodeAttempt(
		runId: string,
		nodeId: string,
	): PatrolLoopAttempt | undefined;
	listOpenReworkDeliveries(runId: string): PatrolLoopReworkDelivery[];
	listOpenLandOperations(
		projectName: string,
		issueId: string,
	): PatrolLoopLandOperation[];
	listOpenGateAuthorities(runId: string): PatrolLoopGateAuthority[];
	getSession(executionId: string): { status?: string } | undefined;
}

export interface PatrolLoopRosterInput {
	issueId: string;
	identifier: string;
	executionId: string;
	status: string;
}

export type PatrolLoopLight = "red" | "not_triggered" | "unknown";

export type PatrolLoopRedCause =
	| {
			kind: "holder_terminal_attempt";
			nodeId: string;
			attempt: number;
			state: string;
	  }
	| {
			kind: "holder_terminal_session";
			status: string;
	  }
	| { kind: "holder_process_dead" }
	| { kind: "holder_parked" };

export interface PatrolLoopJudgment {
	light: PatrolLoopLight;
	reason?: string;
	redCause?: PatrolLoopRedCause;
}

export interface PatrolOpenLoop {
	kind: "rework" | "land" | "wake" | "gate" | "carrier";
	state: string;
	target?: string;
	step?: string;
}

export interface PatrolLoopEntry {
	issueId: string;
	identifier: string;
	runId8?: string;
	runStatus?: string;
	currentNode?: string;
	currentAttempt?: number;
	currentAttemptState?: string;
	turnHolderExecId8?: string;
	turnPhase?: string;
	turnEpoch?: number;
	processes?: Array<{
		executionId8: string;
		state: PatrolLoopProcessLiveness["state"];
	}>;
	openLoops: PatrolOpenLoop[];
	waiters: Array<{
		executionId8: string;
		kind: "turn-poll" | "turn-poll-stale" | "parked";
		waitedMinutes?: number;
		/** The shared predicate classified this exact waiter as a red trigger. */
		redQualified?: true;
	}>;
	displayWarnings?: string[];
	light: PatrolLoopLight;
	redCause?: PatrolLoopRedCause;
	unknownReason?: string;
}

function selectedRun(
	runs: PatrolLoopRun[],
): PatrolLoopRun | null | "ambiguous" {
	const active = runs.filter((run) => run.status === "active");
	if (active.length === 1) return active[0] ?? null;
	if (active.length > 1) return "ambiguous";
	const held = runs.filter((run) => run.status === "held");
	if (held.length === 1) return held[0] ?? null;
	if (held.length > 1) return "ambiguous";
	return null;
}

function selectedCurrentAttempt(
	facts: PatrolLoopFacts,
	run: PatrolLoopRun,
): PatrolLoopAttempt | undefined {
	if (!run.currentNodeId) return undefined;
	return facts.attempts
		.filter(
			(attempt) =>
				attempt.runId === run.runId && attempt.nodeId === run.currentNodeId,
		)
		.sort((left, right) => right.attempt - left.attempt)[0];
}

function processLivenessFor(
	facts: PatrolLoopFacts,
	executionId: string,
): PatrolLoopProcessLiveness["state"] | undefined {
	return facts.processLiveness?.find(
		(liveness) => liveness.executionId === executionId,
	)?.state;
}

function reworkDeliveryIsProgressSource(
	facts: PatrolLoopFacts,
	delivery: PatrolLoopReworkDelivery,
): boolean {
	if (
		delivery.state === "pending" ||
		delivery.state === "replacement_pending"
	) {
		return true;
	}
	if (
		delivery.state !== "turn_granted" &&
		delivery.state !== "wake_delivered"
	) {
		return false;
	}
	const actor = delivery.preferredActorExecutionId;
	if (!actor) return false;
	const liveness = processLivenessFor(facts, actor);
	// Until a caller supplies the real process snapshot, retain the conservative
	// legacy behavior. Production patrol ticks always inject this snapshot.
	return liveness == null || liveness === "alive";
}

function hasDeliverableWake(
	facts: PatrolLoopFacts,
	run: PatrolLoopRun | null,
): boolean {
	const turn = facts.turn;
	if (!turn) return false;
	return facts.wakes.some((wake) => {
		if (
			wake.issueId !== facts.issueId ||
			(wake.state !== "pending" && wake.state !== "sent") ||
			wake.pushCount >= 2 ||
			wake.executionId !== turn.holderExecId ||
			wake.epoch !== turn.epoch ||
			wake.activationId !== turn.activationId
		) {
			return false;
		}
		if (wake.activationId == null) {
			const sessionStatus = facts.sessionStatuses.find(
				(session) => session.executionId === wake.executionId,
			)?.status;
			return !ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES.some(
				(status) => status === sessionStatus,
			);
		}
		if (
			!run ||
			turn.targetRunId !== run.runId ||
			turn.targetNodeId == null ||
			turn.targetAttempt == null
		) {
			return false;
		}
		return facts.attempts.some(
			(attempt) =>
				attempt.runId === run.runId &&
				attempt.nodeId === turn.targetNodeId &&
				attempt.attempt === turn.targetAttempt &&
				attempt.executionId === wake.executionId &&
				ACTIVE_ATTEMPT_STATES.has(attempt.state),
		);
	});
}

function classifyTurnWaits(facts: PatrolLoopFacts): {
	blockedExecutionIds: Set<string>;
	selfWaitingExecutionIds: Set<string>;
	redWaiters: PatrolLoopWait[];
} {
	const rosterExecutionIds = new Set(
		facts.roster.map((session) => session.executionId),
	);
	const blockedExecutionIds = new Set<string>();
	const selfWaitingExecutionIds = new Set<string>();
	const redWaiters: PatrolLoopWait[] = [];
	for (const wait of facts.waits) {
		if (
			!facts.turn ||
			wait.holderExecId !== facts.turn.holderExecId ||
			wait.epoch !== facts.turn.epoch
		) {
			continue;
		}
		if (wait.executionId === facts.turn.holderExecId) {
			selfWaitingExecutionIds.add(wait.executionId);
			continue;
		}
		if (!rosterExecutionIds.has(wait.executionId)) continue;
		blockedExecutionIds.add(wait.executionId);
		if (facts.nowMs - wait.firstSeenAt >= PATROL_RED_MIN_WAIT_MS) {
			redWaiters.push(wait);
		}
	}
	redWaiters.sort((left, right) => left.firstSeenAt - right.firstSeenAt);
	return { blockedExecutionIds, selfWaitingExecutionIds, redWaiters };
}

export function judgeLoopLight(facts: PatrolLoopFacts): PatrolLoopJudgment {
	const unreadable = facts.unreadableSources[0];
	if (unreadable) {
		return { light: "unknown", reason: `ledger_unreadable:${unreadable}` };
	}
	if (!facts.fingerprintStable) {
		return { light: "unknown", reason: "turn_tuple_moved" };
	}

	const run = selectedRun(facts.runs);
	if (run === "ambiguous") {
		return { light: "unknown", reason: "ambiguous_runs" };
	}
	const { blockedExecutionIds, selfWaitingExecutionIds, redWaiters } =
		classifyTurnWaits(facts);
	const holderProcessLiveness = facts.turn
		? processLivenessFor(facts, facts.turn.holderExecId)
		: undefined;
	if (holderProcessLiveness === "unknown" && facts.turn) {
		return {
			light: "unknown",
			reason: `process_liveness_unknown:${executionId8(facts.turn.holderExecId)}`,
		};
	}
	if (run) {
		const unknownActor = [
			...facts.attempts
				.filter(
					(attempt) =>
						attempt.runId === run.runId &&
						ACTIVE_ATTEMPT_STATES.has(attempt.state),
				)
				.map((attempt) => attempt.executionId),
			...facts.reworkDeliveries
				.filter(
					(delivery) =>
						delivery.runId === run.runId &&
						(delivery.state === "turn_granted" ||
							delivery.state === "wake_delivered"),
				)
				.map((delivery) => delivery.preferredActorExecutionId),
		].find(
			(executionId): executionId is string =>
				executionId != null &&
				processLivenessFor(facts, executionId) === "unknown",
		);
		if (unknownActor) {
			return {
				light: "unknown",
				reason: `process_liveness_unknown:${executionId8(unknownActor)}`,
			};
		}
	}

	if (run) {
		const hasActiveAttempt = facts.attempts.some((attempt) => {
			if (
				attempt.runId !== run.runId ||
				!ACTIVE_ATTEMPT_STATES.has(attempt.state)
			) {
				return false;
			}
			if (attempt.executionId == null) return attempt.state === "pending";
			if (processLivenessFor(facts, attempt.executionId) === "dead") {
				return false;
			}
			return (
				!blockedExecutionIds.has(attempt.executionId) &&
				!selfWaitingExecutionIds.has(attempt.executionId)
			);
		});
		if (hasActiveAttempt) return { light: "not_triggered" };
		if (
			facts.reworkDeliveries.some(
				(delivery) =>
					delivery.runId === run.runId &&
					reworkDeliveryIsProgressSource(facts, delivery),
			)
		) {
			return { light: "not_triggered" };
		}
		if (
			facts.gateAuthorities.some((authority) => {
				if (authority.runId !== run.runId) return false;
				return authority.kind === "carrier"
					? authority.state !== "completed"
					: authority.state === "materializing" ||
							authority.state === "awaiting_review";
			})
		) {
			return { light: "not_triggered" };
		}
	}
	if (
		facts.landOperations.some(
			(operation) =>
				operation.state !== "completed" && operation.supersededAt == null,
		)
	) {
		return { light: "not_triggered" };
	}
	if (hasDeliverableWake(facts, run)) {
		return { light: "not_triggered" };
	}

	if (run && facts.turn) {
		if (holderProcessLiveness === "dead") {
			return {
				light: "red",
				redCause: { kind: "holder_process_dead" },
			};
		}
		const attempt = selectedCurrentAttempt(facts, run);
		if (
			attempt?.executionId === facts.turn.holderExecId &&
			HOLDER_TERMINAL_ATTEMPT_STATES.has(attempt.state)
		) {
			return {
				light: "red",
				redCause: {
					kind: "holder_terminal_attempt",
					nodeId: attempt.nodeId,
					attempt: attempt.attempt,
					state: attempt.state,
				},
			};
		}
		const holderStatus = facts.sessionStatuses.find(
			(session) => session.executionId === facts.turn?.holderExecId,
		)?.status;
		if (
			holderStatus != null &&
			HOLDER_TERMINAL_SESSION_STATUSES.has(holderStatus)
		) {
			return {
				light: "red",
				redCause: {
					kind: "holder_terminal_session",
					status: holderStatus,
				},
			};
		}
		const holderInRoster = facts.roster.some(
			(session) => session.executionId === facts.turn?.holderExecId,
		);
		if (
			holderInRoster &&
			facts.parkedExecutionIds.includes(facts.turn.holderExecId)
		) {
			return {
				light: "red",
				redCause: { kind: "holder_parked" },
			};
		}
	}

	if (redWaiters.length === 0) return { light: "not_triggered" };

	return { light: "red" };
}

function executionId8(executionId: string): string {
	return executionId.slice(0, 8);
}

function wakeDisplayState(
	facts: PatrolLoopFacts,
	run: PatrolLoopRun | null,
	wake: PatrolLoopWake,
): string {
	if (wake.pushCount >= 2) return "exhausted";
	const probe: PatrolLoopFacts = { ...facts, wakes: [wake] };
	return hasDeliverableWake(probe, run) ? wake.state : "stale";
}

function openLoopsForFacts(
	facts: PatrolLoopFacts,
	run: PatrolLoopRun | null,
): PatrolOpenLoop[] {
	const loops: PatrolOpenLoop[] = [];
	if (run) {
		for (const delivery of facts.reworkDeliveries) {
			if (delivery.runId !== run.runId || delivery.state === "completed") {
				continue;
			}
			const target =
				delivery.targetNodeId && delivery.targetAttempt != null
					? `${delivery.targetNodeId}@${delivery.targetAttempt}`
					: undefined;
			loops.push({
				kind: "rework",
				state: delivery.state,
				...(target ? { target } : {}),
			});
		}
	}
	for (const operation of facts.landOperations) {
		if (operation.state === "completed" || operation.supersededAt != null) {
			continue;
		}
		loops.push({
			kind: "land",
			state: operation.state,
			...(operation.currentStep ? { step: operation.currentStep } : {}),
		});
	}
	for (const wake of facts.wakes) {
		if (wake.issueId !== facts.issueId) continue;
		loops.push({
			kind: "wake",
			state: wakeDisplayState(facts, run, wake),
			target: executionId8(wake.executionId),
		});
	}
	if (run) {
		for (const authority of facts.gateAuthorities) {
			if (authority.runId !== run.runId) continue;
			if (authority.kind === "gate" && authority.state === "superseded") {
				continue;
			}
			if (authority.kind === "carrier" && authority.state === "completed") {
				continue;
			}
			loops.push({ kind: authority.kind, state: authority.state });
		}
	}
	const seen = new Set<string>();
	return loops.filter((loop) => {
		const key = JSON.stringify(loop);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function toPatrolLoopEntry(
	facts: PatrolLoopFacts,
	judgment: PatrolLoopJudgment,
): PatrolLoopEntry {
	const run = selectedRun(facts.runs);
	const selected = run === "ambiguous" ? null : run;
	const currentAttempt = selected
		? selectedCurrentAttempt(facts, selected)
		: undefined;
	const rosterExecutionIds = new Set(
		facts.roster.map((session) => session.executionId),
	);
	const redExecutionIds =
		judgment.light === "red" && !judgment.redCause
			? new Set(
					classifyTurnWaits(facts).redWaiters.map((wait) => wait.executionId),
				)
			: new Set<string>();
	const waiters: PatrolLoopEntry["waiters"] = [];
	const staleWaiterExecutionIds = new Set<string>();
	for (const wait of facts.waits) {
		if (!rosterExecutionIds.has(wait.executionId)) continue;
		const exact =
			facts.turn != null &&
			wait.holderExecId === facts.turn.holderExecId &&
			wait.epoch === facts.turn.epoch;
		if (!exact) {
			if (staleWaiterExecutionIds.has(wait.executionId)) continue;
			staleWaiterExecutionIds.add(wait.executionId);
		}
		waiters.push(
			exact
				? {
						executionId8: executionId8(wait.executionId),
						kind: "turn-poll",
						waitedMinutes: Math.max(
							0,
							Math.floor((facts.nowMs - wait.firstSeenAt) / 60_000),
						),
						...(redExecutionIds.has(wait.executionId)
							? { redQualified: true as const }
							: {}),
					}
				: {
						executionId8: executionId8(wait.executionId),
						kind: "turn-poll-stale",
					},
		);
	}
	for (const executionId of facts.parkedExecutionIds) {
		if (!rosterExecutionIds.has(executionId)) continue;
		waiters.push({ executionId8: executionId8(executionId), kind: "parked" });
	}

	return {
		issueId: facts.issueId,
		identifier: facts.identifier,
		...(selected
			? {
					runId8: selected.runId.slice(0, 8),
					runStatus: selected.status,
					...(selected.currentNodeId
						? { currentNode: selected.currentNodeId }
						: {}),
					...(currentAttempt
						? {
								currentAttempt: currentAttempt.attempt,
								currentAttemptState: currentAttempt.state,
							}
						: {}),
				}
			: {}),
		...(facts.turn
			? {
					turnHolderExecId8: executionId8(facts.turn.holderExecId),
					turnPhase: facts.turn.phase,
					turnEpoch: facts.turn.epoch,
				}
			: {}),
		...(facts.processLiveness
			? {
					processes: facts.processLiveness.map((process) => ({
						executionId8: executionId8(process.executionId),
						state: process.state,
					})),
				}
			: {}),
		openLoops: openLoopsForFacts(facts, selected),
		waiters,
		...(facts.displayWarnings.length > 0
			? { displayWarnings: [...facts.displayWarnings] }
			: {}),
		light: judgment.light,
		...(judgment.redCause ? { redCause: judgment.redCause } : {}),
		...(judgment.reason ? { unknownReason: judgment.reason } : {}),
	};
}

function emptyFacts(
	projectName: string,
	issueId: string,
	identifier: string,
	roster: PatrolLoopRosterSession[],
	nowMs: number,
): PatrolLoopFacts {
	void projectName;
	return {
		issueId,
		identifier,
		nowMs,
		roster,
		turn: null,
		waits: [],
		runs: [],
		attempts: [],
		reworkDeliveries: [],
		landOperations: [],
		wakes: [],
		gateAuthorities: [],
		sessionStatuses: [],
		parkedExecutionIds: [],
		displayWarnings: [],
		unreadableSources: [],
		fingerprintStable: true,
	};
}

function pushUnreadable(facts: PatrolLoopFacts, source: string): void {
	if (!facts.unreadableSources.includes(source)) {
		facts.unreadableSources.push(source);
	}
}

export async function collectPatrolLoopEntries(input: {
	projectName: string;
	roster: PatrolLoopRosterInput[];
	nowMs: number;
	store: PatrolLoopStore;
	reader: PatrolCommReader | null;
	probeProcessLiveness?: (
		executionId: string,
		projectName: string,
	) => Promise<PatrolLoopProcessLiveness["state"]>;
}): Promise<PatrolLoopEntry[]> {
	const groups = new Map<string, PatrolLoopRosterInput[]>();
	for (const session of input.roster) {
		if (!session.issueId.trim() || !session.executionId.trim()) continue;
		const group = groups.get(session.issueId) ?? [];
		group.push(session);
		groups.set(session.issueId, group);
	}
	if (groups.size === 0) return [];
	const issueIds = [...groups.keys()];
	const executionIds = [
		...new Set(input.roster.map((session) => session.executionId)),
	];
	const snapshot = input.reader?.readPatrolTurnSnapshot({
		issueIds,
		executionIds,
		nowMs: input.nowMs,
	});

	const entries: PatrolLoopEntry[] = [];
	for (const [issueId, group] of groups) {
		const roster = group.map((session) => ({
			executionId: session.executionId,
			status: session.status,
		}));
		const facts = emptyFacts(
			input.projectName,
			issueId,
			group[0]?.identifier ?? issueId,
			roster,
			input.nowMs,
		);
		if (!snapshot) {
			pushUnreadable(facts, "comm_db");
			entries.push(toPatrolLoopEntry(facts, judgeLoopLight(facts)));
			continue;
		}
		if (!snapshot.judgment.available) {
			for (const source of snapshot.judgment.missingSources) {
				pushUnreadable(facts, source);
			}
		} else {
			const judgment = snapshot.judgment;
			facts.turn = judgment.turns.get(issueId) ?? null;
			const scopedExecutionIds = new Set([
				...group.map((session) => session.executionId),
				...(facts.turn ? [facts.turn.holderExecId] : []),
			]);
			facts.waits = [...scopedExecutionIds].flatMap(
				(executionId) => judgment.waits.get(executionId) ?? [],
			);
			facts.wakes = judgment.wakes.get(issueId) ?? [];
		}
		if (snapshot.display.available) {
			facts.parkedExecutionIds = group
				.filter(
					(session) =>
						snapshot.display.available &&
						snapshot.display.declared.get(session.executionId) === "parked",
				)
				.map((session) => session.executionId);
		} else {
			facts.displayWarnings.push("parked_unavailable");
		}

		try {
			facts.runs = input.store.getPatrolWorkflowRuns(
				input.projectName,
				issueId,
			);
		} catch {
			pushUnreadable(facts, "workflow_run");
		}
		const run = selectedRun(facts.runs);
		if (run !== "ambiguous" && run) {
			try {
				facts.attempts = input.store.listActiveNodeAttempts(run.runId);
				if (run.currentNodeId) {
					const latest = input.store.getLatestNodeAttempt(
						run.runId,
						run.currentNodeId,
					);
					if (
						latest &&
						!facts.attempts.some(
							(attempt) =>
								attempt.runId === latest.runId &&
								attempt.nodeId === latest.nodeId &&
								attempt.attempt === latest.attempt,
						)
					) {
						facts.attempts.push(latest);
					}
				}
			} catch {
				pushUnreadable(facts, "workflow_run_node");
			}
			try {
				facts.reworkDeliveries = input.store.listOpenReworkDeliveries(
					run.runId,
				);
			} catch {
				pushUnreadable(facts, "workflow_rework_delivery");
			}
			try {
				facts.gateAuthorities = input.store.listOpenGateAuthorities(run.runId);
			} catch {
				pushUnreadable(facts, "workflow_gate_holder");
			}
		}
		try {
			facts.landOperations = input.store.listOpenLandOperations(
				input.projectName,
				issueId,
			);
		} catch {
			pushUnreadable(facts, "land_operation");
		}
		try {
			facts.sessionStatuses = [
				...new Set([
					...(facts.turn ? [facts.turn.holderExecId] : []),
					...facts.wakes
						.filter((wake) => wake.activationId == null)
						.map((wake) => wake.executionId),
				]),
			].map((executionId) => ({
				executionId,
				status: input.store.getSession(executionId)?.status ?? null,
			}));
		} catch {
			pushUnreadable(facts, "sessions");
		}
		if (input.probeProcessLiveness) {
			const probeExecutionIds = [
				...new Set([
					...group.map((session) => session.executionId),
					...(facts.turn ? [facts.turn.holderExecId] : []),
					...facts.attempts.flatMap((attempt) =>
						attempt.executionId ? [attempt.executionId] : [],
					),
					...facts.reworkDeliveries.flatMap((delivery) =>
						delivery.preferredActorExecutionId
							? [delivery.preferredActorExecutionId]
							: [],
					),
				]),
			];
			facts.processLiveness = await Promise.all(
				probeExecutionIds.map(async (executionId) => {
					try {
						return {
							executionId,
							state: await input.probeProcessLiveness!(
								executionId,
								input.projectName,
							),
						};
					} catch {
						return { executionId, state: "unknown" as const };
					}
				}),
			);
		}

		if (snapshot.judgment.available && input.reader) {
			const groupExecutionIds = group.map((session) => session.executionId);
			const initialFingerprint = patrolJudgmentFingerprint(
				snapshot.judgment,
				issueId,
				groupExecutionIds,
			);
			const reread = input.reader.rereadJudgmentFingerprint(
				issueId,
				groupExecutionIds,
			);
			if (!reread.available) {
				for (const source of reread.missingSources)
					pushUnreadable(facts, source);
			} else {
				facts.fingerprintStable = reread.fingerprint === initialFingerprint;
			}
		}
		const judgment = judgeLoopLight(facts);
		entries.push(toPatrolLoopEntry(facts, judgment));
	}
	return entries;
}

export async function unavailablePatrolLoopEntries(input: {
	projectName: string;
	roster: PatrolLoopRosterInput[];
	nowMs: number;
	source: string;
}): Promise<PatrolLoopEntry[]> {
	return (
		await collectPatrolLoopEntries({
			...input,
			store: {
				getPatrolWorkflowRuns: () => [],
				listActiveNodeAttempts: () => [],
				getLatestNodeAttempt: () => undefined,
				listOpenReworkDeliveries: () => [],
				listOpenLandOperations: () => [],
				listOpenGateAuthorities: () => [],
				getSession: () => undefined,
			},
			reader: null,
		})
	).map((entry) => ({
		...entry,
		unknownReason: `ledger_unreadable:${input.source}`,
	}));
}
