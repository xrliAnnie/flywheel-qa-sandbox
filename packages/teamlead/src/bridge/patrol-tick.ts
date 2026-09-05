import { createHash } from "node:crypto";
import type { MailboxSettlement } from "flywheel-comm/mailbox-queue";
import {
	effectivePatrolIntervalMs,
	getGlobalPatrolConfigSnapshot,
	getProjectPatrolConfigSnapshot,
	type PatrolConfig,
} from "flywheel-config";
import type { EpicResidualTrigger } from "../epic-page/residual.js";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import type { CapacitySnapshot } from "./capacity-snapshot.js";
import type { EpicScanMaterialized } from "./epic-residual-scan.js";
import { parseSqliteUtcMs } from "./founder-notify-utils.js";
import type { HookPayload, PatrolRosterEntry } from "./hook-payload.js";
import { canonicalLeadEventDeliveryId } from "./lead-event-queue.js";
import { parseSessionLabels } from "./lead-scope.js";
import { leadEventEnvelopeFromJournalRow } from "./legacy-lead-event-reconciler.js";
import {
	collectPatrolLoopEntries,
	type PatrolCommReader,
	type PatrolLoopProcessLiveness,
	unavailablePatrolLoopEntries,
} from "./patrol-loop-ledger.js";
import type { DurableQueueReceipt } from "./runtime-registry.js";

export interface PatrolTickDeps {
	projects: ProjectEntry[];
	store: Pick<
		StateStore,
		| "getPatrolRosterSessions"
		| "getLatestPatrolTickEvent"
		| "appendLeadEvent"
		| "getLeadEventBySeq"
		| "getPatrolWorkflowRuns"
		| "listActiveNodeAttempts"
		| "getLatestNodeAttempt"
		| "listOpenReworkDeliveries"
		| "listOpenLandOperations"
		| "listOpenGateAuthorities"
		| "getSession"
	>;
	openCommReadonly?: (projectName: string) => PatrolCommReader | null;
	probeProcessLiveness?: (
		executionId: string,
		projectName: string,
	) => Promise<PatrolLoopProcessLiveness["state"]>;
	inspectDeliveryState(
		projectName: string,
		deliveryId: string,
	): MailboxSettlement;
	enqueueLeadEvent(
		envelope: ReturnType<typeof leadEventEnvelopeFromJournalRow>,
	): DurableQueueReceipt;
	getGlobalConfig?: () => Readonly<PatrolConfig>;
	getProjectConfig?: (projectRoot: string) => Readonly<PatrolConfig>;
	capacity?: () => Promise<CapacitySnapshot>;
	epicResidual?: {
		materializeForScan(project: ProjectEntry): Promise<EpicScanMaterialized>;
		summarizeForLead(
			materialized: EpicScanMaterialized,
			leadId: string,
			trigger: EpicResidualTrigger,
		): HookPayload["epic"];
	};
	now?: () => number;
	alertFailure?: (failure: PatrolFailure) => Promise<void>;
	log?: (message: string) => void;
}

export type PatrolFailure =
	| {
			kind: "unowned_roster";
			projectName: string;
			leadId: string | null;
			detail: string;
			episodeId: string;
	  }
	| {
			kind: "lead_failure";
			projectName: string;
			leadId: string;
			detail: string;
			episodeId: string;
	  };

interface FailureTracker {
	succeeded(projectName: string, leadId: string): void;
	failed(projectName: string, leadId: string, error: unknown): Promise<void>;
}

const PATROL_FAILURE_ALERT_COOLDOWN_MS = 30 * 60_000;
// FLY-1687: a just-settled catch-up may sit immediately before this Lead's
// phase boundary. Give it one nominal rider minute before minting a new tick.
const PATROL_SETTLEMENT_DOUBLE_TICK_GUARD_MS = 60_000;

export function patrolSessionKey(projectName: string, leadId: string): string {
	return `patrol:${projectName}:${leadId}`;
}

/** Stable per-Lead phase inside one patrol interval. */
export function patrolTickOffsetMs(leadId: string, intervalMs: number): number {
	const interval = Math.floor(intervalMs);
	if (!Number.isSafeInteger(interval) || interval <= 0) {
		throw new Error(`invalid patrol interval: ${intervalMs}`);
	}
	return (
		createHash("sha256").update(leadId).digest().readUInt32BE(0) % interval
	);
}

function scheduledAtOrBefore(
	nowMs: number,
	leadId: string,
	intervalMs: number,
): number {
	const interval = Math.floor(intervalMs);
	const offsetMs = patrolTickOffsetMs(leadId, interval);
	return Math.floor((nowMs - offsetMs) / interval) * interval + offsetMs;
}

function rosterEntry(session: Session): PatrolRosterEntry {
	return {
		identifier: session.issue_identifier ?? session.execution_id.slice(0, 8),
		issueId: session.issue_id,
		sessionRole: session.session_role ?? "main",
		status: session.status,
		executionId8: session.execution_id.slice(0, 8),
	};
}

function settlementAnchor(settlement: MailboxSettlement): string | null {
	if (
		settlement.kind === "absent_identity" ||
		settlement.kind === "torn_identity" ||
		settlement.kind === "archived_nonterminal"
	) {
		return null;
	}
	if (settlement.kind === "live") {
		if (settlement.state === "QUEUED" || settlement.state === "LEASED") {
			return null;
		}
		if (!settlement.settledAt) {
			throw new Error(
				`terminal mailbox row lacks settlement time (${settlement.state})`,
			);
		}
		return settlement.settledAt;
	}
	return settlement.settledAt;
}

async function alertUnownedRoster(
	deps: PatrolTickDeps,
	project: ProjectEntry,
	eligibleLeadIds: string[],
	unowned: Session[],
	nowMs: number,
): Promise<void> {
	if (unowned.length === 0 || !deps.alertFailure) return;
	const leadId = eligibleLeadIds[0] ?? null;
	const allIdentities = unowned.map((session) => session.execution_id).sort();
	const identities = allIdentities.slice(0, 20).join(",");
	const detail =
		`${unowned.length} active roster session(s) resolve to no patrol-capable Lead: ${identities}` +
		(unowned.length > 20 ? ` (+${unowned.length - 20} more)` : "");
	const fingerprint = createHash("sha256")
		.update(detail)
		.digest("hex")
		.slice(0, 16);
	await deps.alertFailure({
		kind: "unowned_roster",
		projectName: project.projectName,
		leadId,
		detail,
		episodeId: `unowned:${project.projectName}:${fingerprint}:${Math.floor(nowMs / PATROL_FAILURE_ALERT_COOLDOWN_MS)}`,
	});
}

async function runLeadPatrolTickPass(
	deps: PatrolTickDeps,
	failures: FailureTracker,
	emptySlotSeen: Map<string, number>,
): Promise<void> {
	const nowMs = deps.now?.() ?? Date.now();
	const globalConfig =
		deps.getGlobalConfig?.() ?? getGlobalPatrolConfigSnapshot().config;
	let capacityPromise: Promise<CapacitySnapshot | undefined> | undefined;
	const capacityOnce = () => {
		if (!capacityPromise) {
			capacityPromise = Promise.resolve()
				.then(() => deps.capacity?.())
				.catch(() => undefined);
		}
		return capacityPromise;
	};
	const epicByProject = new Map<string, Promise<EpicScanMaterialized>>();
	const epicOnce = (project: ProjectEntry): Promise<EpicScanMaterialized> => {
		const existing = epicByProject.get(project.projectName);
		if (existing) return existing;
		const materialized = Promise.resolve()
			.then(() => deps.epicResidual?.materializeForScan(project))
			.catch(() => undefined);
		epicByProject.set(project.projectName, materialized);
		return materialized;
	};
	const epicForLead = async (
		project: ProjectEntry,
		leadId: string,
		trigger: EpicResidualTrigger,
	): Promise<HookPayload["epic"]> => {
		if (!deps.epicResidual) return undefined;
		try {
			return deps.epicResidual.summarizeForLead(
				await epicOnce(project),
				leadId,
				trigger,
			);
		} catch {
			return undefined;
		}
	};
	for (const project of deps.projects) {
		let sessions: Session[];
		let projectConfig: Readonly<PatrolConfig>;
		try {
			// One project snapshot is shared by every Lead in this pass.
			projectConfig =
				deps.getProjectConfig?.(project.projectRoot) ??
				getProjectPatrolConfigSnapshot(project.projectRoot).config;
			sessions = deps.store.getPatrolRosterSessions(project.projectName);
		} catch (error) {
			deps.log?.(
				`[patrol_tick] project=${project.projectName}: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		const intervalMs = effectivePatrolIntervalMs(projectConfig, globalConfig);
		const eligibleLeads = project.leads.filter(
			(lead) => lead.canSpawnRunners !== false,
		);
		const rosterByLead = new Map(
			eligibleLeads.map((lead) => [lead.agentId, [] as Session[]]),
		);
		const unowned: Session[] = [];
		for (const session of sessions) {
			try {
				const owner = resolveLeadForIssue(
					deps.projects,
					session.project_name,
					parseSessionLabels(session),
				).lead;
				const roster = rosterByLead.get(owner.agentId);
				if (roster) roster.push(session);
				else unowned.push(session);
			} catch (error) {
				deps.log?.(
					`[patrol_tick] roster exclude execution=${session.execution_id}: ${error instanceof Error ? error.message : String(error)}`,
				);
				unowned.push(session);
			}
		}
		try {
			await alertUnownedRoster(
				deps,
				project,
				eligibleLeads.map((lead) => lead.agentId),
				unowned,
				nowMs,
			);
		} catch (error) {
			deps.log?.(
				`[patrol_tick] project=${project.projectName} unowned alert: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		for (const lead of eligibleLeads) {
			try {
				const roster = rosterByLead.get(lead.agentId) ?? [];
				const emptyRoster = roster.length === 0;
				if (emptyRoster && !deps.epicResidual) {
					failures.succeeded(project.projectName, lead.agentId);
					continue;
				}
				const currentScheduledAt = scheduledAtOrBefore(
					nowMs,
					lead.agentId,
					intervalMs,
				);
				const emptySlotKey = `${project.projectName}:${lead.agentId}`;
				if (
					emptyRoster &&
					emptySlotSeen.get(emptySlotKey) === currentScheduledAt
				) {
					failures.succeeded(project.projectName, lead.agentId);
					continue;
				}

				const sessionKey = patrolSessionKey(project.projectName, lead.agentId);
				const previous = deps.store.getLatestPatrolTickEvent(
					lead.agentId,
					sessionKey,
				);
				if (previous) {
					const previousEnvelope = leadEventEnvelopeFromJournalRow(previous, 2);
					const previousDeliveryId =
						canonicalLeadEventDeliveryId(previousEnvelope);
					const settlement = deps.inspectDeliveryState(
						project.projectName,
						previousDeliveryId,
					);
					if (settlement.kind === "absent_identity") {
						deps.enqueueLeadEvent(previousEnvelope);
						failures.succeeded(project.projectName, lead.agentId);
						continue;
					}
					const previousPayload = JSON.parse(previous.payload) as HookPayload;
					const previousBasisMs = parseSqliteUtcMs(
						previousPayload.scheduled_at ?? previousPayload.generated_at,
					);
					if (previousBasisMs == null) {
						throw new Error(
							"patrol_tick payload lacks scheduled_at/generated_at",
						);
					}
					const previousSlotStart = scheduledAtOrBefore(
						previousBasisMs,
						lead.agentId,
						intervalMs,
					);
					if (
						settlement.kind === "torn_identity" ||
						settlement.kind === "archived_nonterminal"
					) {
						if (previousSlotStart >= currentScheduledAt) {
							failures.succeeded(project.projectName, lead.agentId);
							continue;
						}
						const poisonLabel =
							settlement.kind === "torn_identity"
								? "torn"
								: "archived_nonterminal";
						deps.log?.(
							`[patrol_tick] project=${project.projectName} lead=${lead.agentId} ${poisonLabel} delivery=${previousDeliveryId} previous_slot=${new Date(previousSlotStart).toISOString()} current_slot=${new Date(currentScheduledAt).toISOString()}; advancing`,
						);
					} else if (
						settlement.kind === "live" &&
						(settlement.state === "QUEUED" || settlement.state === "LEASED")
					) {
						failures.succeeded(project.projectName, lead.agentId);
						continue;
					} else {
						const anchor = settlementAnchor(settlement);
						const anchorMs = parseSqliteUtcMs(anchor);
						if (anchorMs == null) {
							throw new Error(
								`invalid patrol settlement timestamp: ${String(anchor)}`,
							);
						}
						// FLY-1771: phase is anchored to this Lead's deterministic wall-clock grid,
						// not the previous mailbox settlement. Settlement retains one job:
						// a stale tick settled inside the current slot counts that slot as
						// served, preventing an immediate catch-up double tick.
						if (
							previousSlotStart >= currentScheduledAt ||
							anchorMs >= currentScheduledAt ||
							nowMs - anchorMs < PATROL_SETTLEMENT_DOUBLE_TICK_GUARD_MS
						) {
							failures.succeeded(project.projectName, lead.agentId);
							continue;
						}
					}
				}

				let emptyRosterEpic: HookPayload["epic"];
				if (emptyRoster) {
					emptyRosterEpic = await epicForLead(project, lead.agentId, "scope");
					if (
						!emptyRosterEpic ||
						emptyRosterEpic.kind !== "available" ||
						emptyRosterEpic.remainingForLead === 0
					) {
						emptySlotSeen.set(emptySlotKey, currentScheduledAt);
						failures.succeeded(project.projectName, lead.agentId);
						continue;
					}
				}

				const loopRoster = roster.map((session) => ({
					issueId: session.issue_id,
					identifier:
						session.issue_identifier ?? session.execution_id.slice(0, 8),
					executionId: session.execution_id,
					status: session.status,
				}));
				let loops: HookPayload["loops"];
				if (!emptyRoster && deps.openCommReadonly) {
					let reader: PatrolCommReader | null = null;
					try {
						reader = deps.openCommReadonly(project.projectName);
						loops = await collectPatrolLoopEntries({
							projectName: project.projectName,
							roster: loopRoster,
							nowMs,
							store: deps.store,
							reader,
							probeProcessLiveness: deps.probeProcessLiveness,
						});
					} catch {
						loops = await unavailablePatrolLoopEntries({
							projectName: project.projectName,
							roster: loopRoster,
							nowMs,
							source: "collector",
						});
					} finally {
						try {
							reader?.close();
						} catch (error) {
							deps.log?.(
								`[patrol_tick] project=${project.projectName} loop reader close: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					}
				}

				const eventId = `patrol_tick:${project.projectName}:${lead.agentId}:after-${previous?.seq ?? "genesis"}`;
				const [capacity, epic] = emptyRoster
					? [await capacityOnce(), emptyRosterEpic]
					: await Promise.all([
							capacityOnce(),
							epicForLead(project, lead.agentId, "roster"),
						]);
				const payload: HookPayload = {
					event_type: "patrol_tick",
					execution_id: sessionKey,
					issue_id: "",
					project_name: project.projectName,
					roster: roster.map(rosterEntry),
					...(loops ? { loops } : {}),
					...(capacity ? { capacity } : {}),
					...(epic ? { epic } : {}),
					generated_at: new Date(nowMs).toISOString(),
					scheduled_at: new Date(currentScheduledAt).toISOString(),
				};
				const seq = deps.store.appendLeadEvent(
					lead.agentId,
					eventId,
					"patrol_tick",
					JSON.stringify(payload),
					sessionKey,
				);
				const durable = deps.store.getLeadEventBySeq(seq);
				if (!durable)
					throw new Error(`journal row missing after append seq=${seq}`);
				deps.enqueueLeadEvent(leadEventEnvelopeFromJournalRow(durable, 2));
				failures.succeeded(project.projectName, lead.agentId);
			} catch (error) {
				deps.log?.(
					`[patrol_tick] project=${project.projectName} lead=${lead.agentId}: ${error instanceof Error ? error.message : String(error)}`,
				);
				await failures.failed(project.projectName, lead.agentId, error);
			}
		}
	}
}

/** Independent single-flight: GatePoller's main poll guard is not this rider's guard. */
export function createLeadPatrolTickPass(
	deps: PatrolTickDeps,
): () => Promise<void> {
	let inFlight: Promise<void> | null = null;
	const bootEpisode = deps.now?.() ?? Date.now();
	const consecutiveFailures = new Map<string, number>();
	const episodeCounts = new Map<string, number>();
	const lastFailureAlertAt = new Map<string, number>();
	const emptySlotSeen = new Map<string, number>();
	const failures: FailureTracker = {
		succeeded: (projectName, leadId) => {
			consecutiveFailures.delete(`${projectName}:${leadId}`);
		},
		failed: async (projectName, leadId, error) => {
			const key = `${projectName}:${leadId}`;
			const count = (consecutiveFailures.get(key) ?? 0) + 1;
			consecutiveFailures.set(key, count);
			if (count < 3 || !deps.alertFailure) return;
			const nowMs = deps.now?.() ?? Date.now();
			const lastAlertAt = lastFailureAlertAt.get(key);
			if (
				lastAlertAt !== undefined &&
				nowMs - lastAlertAt < PATROL_FAILURE_ALERT_COOLDOWN_MS
			) {
				return;
			}
			lastFailureAlertAt.set(key, nowMs);
			const episode = (episodeCounts.get(key) ?? 0) + 1;
			episodeCounts.set(key, episode);
			try {
				await deps.alertFailure({
					kind: "lead_failure",
					projectName,
					leadId,
					detail: error instanceof Error ? error.message : String(error),
					episodeId: `failure:${bootEpisode}:${key}:${episode}`,
				});
			} catch (alertError) {
				deps.log?.(
					`[patrol_tick] failure alert project=${projectName} lead=${leadId}: ${alertError instanceof Error ? alertError.message : String(alertError)}`,
				);
			}
		},
	};
	return () => {
		if (inFlight) return inFlight;
		const pass = Promise.resolve().then(() =>
			runLeadPatrolTickPass(deps, failures, emptySlotSeen),
		);
		const guarded = pass.finally(() => {
			if (inFlight === guarded) inFlight = null;
		});
		inFlight = guarded;
		return guarded;
	};
}
