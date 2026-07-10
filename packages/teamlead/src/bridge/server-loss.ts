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

import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import { FLEET_ALERT_PROJECT } from "../LeadAlertNotifier.js";
import type { Session, StateStore } from "../StateStore.js";

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
	/** Bridge → Lead instruction (CommDB inbox). Returns delivered. */
	notifyLead: (leadId: string, content: string) => Promise<boolean>;
	/** The routed alert sink (ONE fleet ticket per episode). */
	alert: (p: AlertPayload) => Promise<AlertResult>;
	/** Current swap watermark summary for the notification (nullable). */
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
	/**
	 * Codex R1 HIGH-2: the ACTIVE loss episode. Claiming happens before the
	 * migration succeeds (that is deliberate — a failed migration must STILL
	 * suppress the per-runner reapers, or the runner gets buried twice), so a
	 * partial failure leaves sessions `running`. Without this latch the next
	 * tick would read them as a brand-new loss: a new episodeSignature, a new
	 * fleet ticket, and re-notified Leads EVERY cycle. With it, the same
	 * ongoing loss retries ONLY the pending migrations quietly under the same
	 * episode; the latch clears when no claimed session is still running.
	 */
	private activeEpisode: { signature: string; claimed: Set<string> } | null =
		null;

	constructor(private readonly deps: ServerLossDeps) {
		this.env = deps.env ?? process.env;
		this.now = deps.now ?? (() => Date.now());
		this.log = deps.logger ?? ((m) => console.log(`[server-loss] ${m}`));
	}

	/**
	 * The pre-reaper phase. Returns the exec ids this coordinator CLAIMED and
	 * migrated this cycle — HeartbeatService feeds them into the orphan
	 * suppression set so crash-reaper/reapOrphans never double-migrate.
	 */
	/**
	 * Codex R2 HIGH: does the active episode still have UNMIGRATED casualties?
	 * The Hub recovery probe consults this — an episode with pending
	 * migrations must never read as recovered (quiet resolve would strand the
	 * failed sessions in a silent retry loop with no T2 escalation).
	 */
	hasPendingMigrations(): boolean {
		if (!this.activeEpisode) return false;
		const claimed = this.activeEpisode.claimed;
		return this.deps.store
			.getRunningSessions()
			.some((s) => claimed.has(s.execution_id));
	}

	async check(): Promise<ReadonlySet<string>> {
		const wasFirst = this.firstCheck;
		this.firstCheck = false;
		const running = this.deps.store.getRunningSessions().filter(isTmuxBacked);

		// Episode latch maintenance: once every claimed session has left
		// `running` (migrations landed), the episode is over.
		if (this.activeEpisode) {
			const stillPending = running.filter((s) =>
				this.activeEpisode?.claimed.has(s.execution_id),
			);
			if (stillPending.length === 0) {
				this.activeEpisode = null;
			}
		}

		if (running.length === 0) return new Set();

		const probe = await this.deps.probeServer();

		// Codex R2 MEDIUM-2 (restart safety): the in-memory latch dies with the
		// Bridge, but the episode's TICKET row is durable. A fresh coordinator
		// finding a still-ACTIVE tmux_server_lost ticket ADOPTS that episode
		// (its event_id IS the episode signature) instead of declaring a brand
		// new loss — no duplicate ticket, no re-notified Leads after a restart
		// mid-partial-migration.
		if (!this.activeEpisode && probe !== "up") {
			const activeTicket = this.deps.store.getActiveAlertThread(
				`${FLEET_ALERT_PROJECT}|tmux-server|tmux_server_lost|`,
			);
			if (activeTicket?.event_id.startsWith("tmux-server-lost:")) {
				this.activeEpisode = {
					signature: activeTicket.event_id,
					claimed: new Set(running.map((s) => s.execution_id)),
				};
				this.log(
					`adopted durable episode ${activeTicket.event_id} after restart (${running.length} pending)`,
				);
			}
		}

		// Ongoing episode: retry ONLY the pending migrations quietly — no new
		// episode signature, no new fleet ticket, no re-notification (HIGH-2).
		if (this.activeEpisode && probe !== "up") {
			const episode = this.activeEpisode;
			const pending = running.filter((s) =>
				episode.claimed.has(s.execution_id),
			);
			for (const session of pending) {
				try {
					await this.deps.migrate(session, episode.signature);
				} catch (err) {
					this.log(
						`retry migrate failed for ${session.execution_id}: ${(err as Error).message}`,
					);
				}
			}
			return new Set(episode.claimed);
		}

		let casualties: Session[] | null = null;
		let shape: "server_down" | "server_fresh" | null = null;

		if (probe === "down") {
			// Tick leg: the server hosting these sessions is GONE — any count.
			casualties = running;
			shape = "server_down";
		} else if (probe === "up" && wasFirst) {
			// Boot leg: server responds but the previous generation's runners may
			// have died with a server restart. Aggregation threshold guards
			// against reading 1-2 naturally-drifted sessions as a fleet event.
			const raw = Number(this.env.FLYWHEEL_TMUX_MASS_LOSS_MIN);
			const massMin = Number.isFinite(raw) && raw > 0 ? raw : 3;
			if (running.length >= massMin) {
				const verdicts = await Promise.all(
					running.map((s) => this.deps.targetGone(s)),
				);
				// ALL provably gone (any present/indeterminate → not a mass loss).
				if (verdicts.every((v) => v === true)) {
					casualties = running;
					shape = "server_fresh";
				}
			}
		}
		if (!casualties || !shape) return new Set();

		const episodeSignature = `tmux-server-lost:${this.now()}`;
		this.log(
			`${shape}: ${casualties.length} running tmux session(s) lost — episode ${episodeSignature}`,
		);

		// 1. Claim + migrate every casualty (grouped, episode-tagged). The latch
		// arms NOW so a partial migration failure retries under THIS episode.
		const claimed = new Set<string>();
		this.activeEpisode = { signature: episodeSignature, claimed };
		let migrated = 0;
		for (const session of casualties) {
			claimed.add(session.execution_id);
			try {
				if (await this.deps.migrate(session, episodeSignature)) migrated++;
			} catch (err) {
				this.log(
					`migrate failed for ${session.execution_id}: ${(err as Error).message}`,
				);
			}
		}

		// 2. ONE grouped notification per Lead: its own casualty list + resume
		// pointers + the current watermark (anti-stampede context).
		const byLead = new Map<string, Session[]>();
		const unresolved: Session[] = [];
		for (const session of casualties) {
			const leadId = this.deps.resolveLeadId(session);
			if (!leadId) {
				unresolved.push(session);
				continue;
			}
			const list = byLead.get(leadId) ?? [];
			list.push(session);
			byLead.set(leadId, list);
		}
		let leadsNotified = 0;
		let leadsFailed = 0;
		const watermark = this.deps.currentWatermark?.() ?? null;
		for (const [leadId, sessions] of byLead) {
			const lines = sessions.map(
				(s) =>
					`- ${s.issue_identifier ?? s.issue_id} (exec ${s.execution_id})：progress ledger 在其分支上（$FLYWHEEL_PROGRESS_PATH 指向,可 resume 续跑）`,
			);
			const content = `[fleet-alert] tmux server 丢失（${episodeSignature}）— 你名下 ${sessions.length} 个 runner 阵亡,已标记终态：\n${lines.join(
				"\n",
			)}\n复活由你驱动（respawn 不代劳）;每个都有 restart-resilient resume（FLY-795）。${
				watermark
					? `当前 swap 水位 ${watermark} — 请按水位节奏复活,避免 stampede。`
					: ""
			}`;
			try {
				if (await this.deps.notifyLead(leadId, content)) leadsNotified++;
				else leadsFailed++;
			} catch {
				leadsFailed++;
			}
		}
		leadsFailed += unresolved.length > 0 ? 1 : 0; // unresolvable = a failed notify

		// 3. ONE fleet ticket for the whole episode (never 13 per-runner alerts).
		const perLead = [...byLead.entries()]
			.map(([leadId, sessions]) => `${leadId}: ${sessions.length}`)
			.join(" / ");
		await this.deps.alert({
			leadId: "tmux-server",
			projectName: FLEET_ALERT_PROJECT,
			eventId: episodeSignature,
			eventType: "tmux_server_lost",
			title: `tmux server 丢失 — ${casualties.length} 个 runner 阵亡`,
			body: `${
				shape === "server_down"
					? "tmux server 整个消失（no server running）"
					: "tmux server 重启（复活对账发现上一世代 runner 全灭）"
			}。受影响：${perLead}${
				unresolved.length > 0 ? ` / 无主 ${unresolved.length}` : ""
			}。已成组迁移 ${migrated}/${casualties.length} 到终态,并按 Lead 分组通知（各自阵亡清单 + resume 指针）。respawn 由各 Lead 驱动。`,
			severity: "severe",
			metadata: {
				tmuxServerLost: {
					casualties: casualties.length,
					migrated,
					leadsNotified,
					leadsFailed,
				},
			},
		});

		return claimed;
	}
}
