/**
 * FLY-1082 (Task 2.3): the tmux server-loss coordinator — the "13 runners
 * died at once and the system's reaction was 13 silent per-runner burials"
 * fix (2026-07-09 incident).
 *
 * WHY a HeartbeatService PRE-REAPER PHASE and not an onPollComplete sensor:
 * crash-reaper and reapOrphans both run inside `HeartbeatService.check()` —
 * a sensor on the LeadWatchdog poll cannot guarantee running BEFORE orphan
 * migration in the same cycle (Codex R2 #2). This coordinator is called from
 * `check()` between `reconcileMonitorLoss()` and `reapCrashedRunners()`;
 * every exec id it claims is fed into the orphan suppression set so no
 * runner is migrated twice. Still the existing heartbeat loop — no new timer.
 *
 * Two loss shapes:
 *  - SERVER DOWN (tick leg): `tmux list-sessions` proves "no server running"
 *    while StateStore holds ≥1 running tmux-backed session — any count is a
 *    server loss (the server hosting them is gone).
 *  - SERVER FRESH/EMPTY (boot leg, FIRST check only): the server responds but
 *    ≥ FLYWHEEL_TMUX_MASS_LOSS_MIN (default 3) previous-generation running
 *    sessions ALL have provably-gone targets — the server restarted under us.
 *
 * The ARC action runs AT DETECTION: one episode, grouped terminal migration
 * (same `failed` transition semantics as reapOrphans), ONE fleet ticket, and
 * ONE grouped casualty notification per Lead (casualty list + resume pointer
 * + current watermark). Respawn stays LEAD-DRIVEN — the coordinator never
 * spawns anything (FLY-175 iron law).
 */

import { createHash } from "node:crypto";
import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import { FLEET_ALERT_PROJECT } from "../LeadAlertNotifier.js";
import type {
	ServerLossEpisodeState,
	Session,
	StateStore,
} from "../StateStore.js";

export type ServerProbe = "up" | "down" | "unknown";

export interface ServerLossDeps {
	store: StateStore;
	/** tmux server liveness (list-sessions): down = PROVEN "no server". */
	probeServer: () => Promise<ServerProbe>;
	/**
	 * Boot-shape probe: is this session's tmux target provably GONE on the
	 * (live) server? true=gone, false=present, null=cannot tell (never claim).
	 */
	targetGone: (session: Session) => Promise<boolean | null>;
	/** Terminal migration for one runner (reapOrphans `failed` semantics). */
	migrate: (session: Session, episodeSignature: string) => Promise<boolean>;
	/** The owning Lead's agent id for grouping (null = unresolvable). */
	resolveLeadId: (session: Session) => string | null;
	/**
	 * Bridge → Lead instruction (CommDB inbox). Returns delivered. The
	 * dedupeId is a DETERMINISTIC downstream identity (episode + lead +
	 * casualty generation) — the sink must treat a repeat as already-delivered
	 * (Codex R6 MED: the CommDB commit and the StateStore checkpoint are two
	 * databases; a crash between them replays the send, and only downstream
	 * idempotency closes that window).
	 */
	notifyLead: (
		leadId: string,
		content: string,
		dedupeId: string,
	) => Promise<boolean>;
	/** The routed alert sink (ONE fleet ticket per episode). */
	alert: (p: AlertPayload) => Promise<AlertResult>;
	/** Current memory watermark summary (free%) for the notification. */
	currentWatermark?: () => string | null;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	logger?: (msg: string) => void;
}

function isTmuxBacked(session: Session): boolean {
	// Absent adapter_type = the claude-tmux default (legacy rows).
	return (session.adapter_type ?? "claude-tmux").includes("tmux");
}

export class ServerLossCoordinator {
	private readonly env: NodeJS.ProcessEnv;
	private readonly now: () => number;
	private readonly log: (msg: string) => void;
	private firstCheck = true;

	constructor(private readonly deps: ServerLossDeps) {
		this.env = deps.env ?? process.env;
		this.now = deps.now ?? (() => Date.now());
		this.log = deps.logger ?? ((m) => console.log(`[server-loss] ${m}`));
	}

	/**
	 * Codex R2 HIGH: does the active episode still have UNMIGRATED casualties?
	 * The Hub recovery probe consults this — an episode with pending
	 * migrations must never read as recovered (quiet resolve would strand the
	 * failed sessions in a silent retry loop with no T2 escalation).
	 * Reads the DURABLE episode ledger (restart-safe by construction).
	 */
	hasPendingMigrations(): boolean {
		const episode = this.deps.store.getServerLossEpisode();
		if (!episode) return false;
		const claimed = new Set(episode.state.claimed);
		return this.deps.store
			.getRunningSessions()
			.some((s) => claimed.has(s.execution_id));
	}

	/**
	 * The pre-reaper phase. Returns the exec ids this coordinator CLAIMED —
	 * HeartbeatService feeds them into the orphan suppression set so
	 * crash-reaper/reapOrphans never double-migrate.
	 *
	 * Episode state lives in the DURABLE StateStore ledger (Codex R1→R5):
	 * signature, loss shape, claimed exec ids, the per-Lead notification
	 * OUTBOX, and the ticket phase all persist across restarts — never
	 * inferred from the alert ticket row. Claiming happens before migration
	 * succeeds on purpose (a failed migration must still suppress the
	 * per-runner reapers); every side effect is delivered exactly once per
	 * target: a lead is notified once (retried up to 3 attempts, then marked
	 * failed and surfaced via the ticket's leadsFailed → needs_human), the
	 * fleet ticket is emitted once.
	 */
	async check(): Promise<ReadonlySet<string>> {
		const wasFirst = this.firstCheck;
		this.firstCheck = false;
		const running = this.deps.store.getRunningSessions().filter(isTmuxBacked);

		// Completion check: the episode is over when the ticket landed, every
		// owed Lead is either notified or terminally failed, and nothing claimed
		// still runs. An episode still OWING side effects is kept and replayed.
		let ledger = this.deps.store.getServerLossEpisode();
		if (ledger && this.episodeComplete(ledger.state, running)) {
			this.deps.store.clearServerLossEpisode();
			ledger = undefined;
		}

		if (!ledger && running.length === 0) return new Set();

		// The probe is only needed when sessions could be migrated/extended.
		const probe: ServerProbe =
			running.length > 0 ? await this.deps.probeServer() : "unknown";

		// Fresh detection (no active episode).
		if (!ledger) {
			let casualties: Session[] | null = null;
			let shape: "server_down" | "server_fresh" = "server_down";
			if (probe === "down") {
				// Tick leg: the server hosting these sessions is GONE — any count.
				casualties = running;
			} else if (probe === "up" && wasFirst) {
				// Boot leg: server responds but the previous generation's runners
				// may have died with a server restart. Aggregation threshold guards
				// against reading 1-2 naturally-drifted sessions as a fleet event.
				const raw = Number(this.env.FLYWHEEL_TMUX_MASS_LOSS_MIN);
				const massMin = Number.isFinite(raw) && raw > 0 ? raw : 3;
				if (running.length >= massMin) {
					const verdicts = await Promise.all(
						running.map((s) => this.deps.targetGone(s)),
					);
					// ALL provably gone (any present/indeterminate → no mass loss).
					if (verdicts.every((v) => v === true)) {
						casualties = running;
						shape = "server_fresh";
					}
				}
			}
			if (!casualties) return new Set();
			const signature = `tmux-server-lost:${this.now()}`;
			this.log(
				`${shape}: ${casualties.length} running tmux session(s) lost — episode ${signature}`,
			);
			// The DURABLE ledger arms BEFORE any side effect so a crash anywhere
			// below replays under THIS episode, never a new one.
			const state: ServerLossEpisodeState = {
				shape,
				claimed: casualties.map((s) => s.execution_id),
				ticketDone: false,
				notifiedLeads: [],
				failedLeads: [],
				notifyAttempts: {},
			};
			this.deps.store.setServerLossEpisode(signature, state);
			ledger = { signature, state };
		}

		const state = ledger.state;
		const claimed = new Set(state.claimed);
		let stateDirty = false;

		// Codex R4 HIGH-2: NEW casualties appearing while the SAME server loss
		// is ongoing (server still provably down) JOIN the episode — claimed +
		// migrated under the same signature. Their Leads move back into the
		// OWED set (durably — Codex R5 HIGH: their casualty lists changed, and a
		// crash before the delta delivery must replay it), no second ticket.
		if (probe === "down") {
			const extension = running.filter((s) => !claimed.has(s.execution_id));
			if (extension.length > 0) {
				for (const s of extension) claimed.add(s.execution_id);
				state.claimed = [...claimed];
				for (const s of extension) {
					const leadId = this.deps.resolveLeadId(s);
					if (!leadId) continue;
					state.notifiedLeads = state.notifiedLeads.filter((l) => l !== leadId);
					state.failedLeads = state.failedLeads.filter((l) => l !== leadId);
					delete state.notifyAttempts[leadId];
				}
				this.deps.store.setServerLossEpisode(ledger.signature, state);
				this.log(
					`episode ${ledger.signature} extended by ${extension.length} new casualties`,
				);
			}
		}

		// Migrate pending sessions — PROOF-gated per session (Codex R3 HIGH-1):
		// server provably down, or the session's own target provably gone. An
		// `unknown` probe suppresses the reapers but buries nothing.
		const pending = running.filter((s) => claimed.has(s.execution_id));
		for (const session of pending) {
			const provablyDead =
				probe === "down" || (await this.deps.targetGone(session)) === true;
			if (!provablyDead) continue;
			try {
				await this.deps.migrate(session, ledger.signature);
			} catch (err) {
				this.log(
					`migrate failed for ${session.execution_id}: ${(err as Error).message}`,
				);
			}
		}

		// Side-effect phase A — the per-Lead notification OUTBOX (Codex R5):
		// each owed Lead is delivered its grouped casualty list exactly once;
		// a failure increments its attempt count (retried next tick, terminal
		// after 3 → failedLeads, surfaced via the ticket's leadsFailed).
		const sessions = state.claimed
			.map((id) => this.deps.store.getSession(id))
			.filter((s): s is Session => !!s);
		const byLead = new Map<string, Session[]>();
		let unresolvedCount = 0;
		for (const session of sessions) {
			const leadId = this.deps.resolveLeadId(session);
			if (!leadId) {
				unresolvedCount++;
				continue;
			}
			const group = byLead.get(leadId) ?? [];
			group.push(session);
			byLead.set(leadId, group);
		}
		const watermark = this.deps.currentWatermark?.() ?? null;
		for (const [leadId, group] of byLead) {
			if (
				state.notifiedLeads.includes(leadId) ||
				state.failedLeads.includes(leadId)
			)
				continue;
			const lines = group.map(
				(s) =>
					`- ${s.issue_identifier ?? s.issue_id} (exec ${s.execution_id})：progress ledger 在其分支上（$FLYWHEEL_PROGRESS_PATH 指向,可 resume 续跑）`,
			);
			const content = `[fleet-alert] tmux server 丢失（${ledger.signature}）— 你名下 ${group.length} 个 runner 阵亡,已标记终态：\n${lines.join(
				"\n",
			)}\n复活由你驱动（respawn 不代劳）;每个都有 restart-resilient resume（FLY-795）。${
				watermark
					? `当前内存水位 ${watermark} — 请按内存压力节奏复活,避免 stampede。`
					: ""
			}`;
			// Deterministic per-(episode, lead, casualty-generation) identity:
			// a crash-replay of the SAME list re-sends under the SAME id (the
			// sink dedups); an extension CHANGES the list → new id → the delta
			// goes out as a genuinely new message.
			const generation = createHash("sha256")
				.update(
					group
						.map((s) => s.execution_id)
						.sort()
						.join(","),
				)
				.digest("hex")
				.slice(0, 16);
			const dedupeId = `server-loss:${ledger.signature}:${leadId}:${generation}`;
			let delivered = false;
			try {
				delivered = await this.deps.notifyLead(leadId, content, dedupeId);
			} catch {
				delivered = false;
			}
			if (delivered) {
				state.notifiedLeads.push(leadId);
			} else {
				state.notifyAttempts[leadId] = (state.notifyAttempts[leadId] ?? 0) + 1;
				if ((state.notifyAttempts[leadId] ?? 0) >= 3) {
					state.failedLeads.push(leadId);
					this.log(
						`lead ${leadId} notification failed 3 attempts — surfacing via ticket leadsFailed`,
					);
				}
			}
			stateDirty = true;
		}
		if (stateDirty) {
			this.deps.store.setServerLossEpisode(ledger.signature, state);
			stateDirty = false;
		}

		// Side-effect phase B — the ONE fleet ticket. Emitted only once the
		// outbox is fully SETTLED (every Lead either notified or terminally
		// failed) so its leadsNotified/leadsFailed are FINAL — a Lead still
		// mid-retry must never be reported as failed (Codex R6 HIGH: that
		// false leadsFailed>0 would permanently escalate the ticket to
		// needs_human over a one-tick transient). Replayed until alert()
		// RESOLVES; the per-Lead outbox above prevents duplicate
		// notifications on that replay (Codex R5 MED-1).
		const owed = [...byLead.keys()].filter(
			(l) => !state.notifiedLeads.includes(l) && !state.failedLeads.includes(l),
		);
		if (!state.ticketDone && owed.length > 0) {
			this.log(
				`holding episode ticket: ${owed.length} lead notification(s) still retrying`,
			);
		}
		if (!state.ticketDone && owed.length === 0) {
			const migrated = state.claimed.filter(
				(id) => this.deps.store.getSession(id)?.status !== "running",
			).length;
			const perLead = [...byLead.entries()]
				.map(([leadId, group]) => `${leadId}: ${group.length}`)
				.join(" / ");
			try {
				await this.deps.alert({
					leadId: "tmux-server",
					projectName: FLEET_ALERT_PROJECT,
					eventId: ledger.signature,
					eventType: "tmux_server_lost",
					title: `tmux server 丢失 — ${state.claimed.length} 个 runner 阵亡`,
					body: `${
						state.shape === "server_down"
							? "tmux server 整个消失（no server running）"
							: "tmux server 重启（复活对账发现上一世代 runner 全灭）"
					}。受影响：${perLead}${
						unresolvedCount > 0 ? ` / 无主 ${unresolvedCount}` : ""
					}。已成组迁移 ${migrated}/${state.claimed.length} 到终态,并按 Lead 分组通知（各自阵亡清单 + resume 指针）。respawn 由各 Lead 驱动。`,
					severity: "severe",
					metadata: {
						tmuxServerLost: {
							casualties: state.claimed.length,
							migrated,
							leadsNotified: state.notifiedLeads.length,
							// Outbox is settled here — only TERMINAL failures count
							// (plus one slot for unresolvable-lead casualties).
							leadsFailed:
								state.failedLeads.length + (unresolvedCount > 0 ? 1 : 0),
						},
					},
				});
				state.ticketDone = true;
				this.deps.store.setServerLossEpisode(ledger.signature, state);
			} catch (err) {
				this.log(
					`episode ticket emission failed (will replay): ${(err as Error).message}`,
				);
			}
		}

		return claimed;
	}

	/** Over when: ticket landed, no owed Lead remains (notified or terminally
	 * failed), and nothing claimed still runs. */
	private episodeComplete(
		state: ServerLossEpisodeState,
		running: Session[],
	): boolean {
		if (!state.ticketDone) return false;
		const claimed = new Set(state.claimed);
		if (running.some((s) => claimed.has(s.execution_id))) return false;
		const settled = new Set([...state.notifiedLeads, ...state.failedLeads]);
		for (const id of state.claimed) {
			const session = this.deps.store.getSession(id);
			if (!session) continue;
			const leadId = this.deps.resolveLeadId(session);
			if (leadId && !settled.has(leadId)) return false;
		}
		return true;
	}
}
