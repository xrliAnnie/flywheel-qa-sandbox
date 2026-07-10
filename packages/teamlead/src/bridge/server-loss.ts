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
		const claimed = new Set(episode.claimed);
		return this.deps.store
			.getRunningSessions()
			.some((s) => claimed.has(s.execution_id));
	}

	/**
	 * The pre-reaper phase. Returns the exec ids this coordinator CLAIMED and
	 * migrated this cycle — HeartbeatService feeds them into the orphan
	 * suppression set so crash-reaper/reapOrphans never double-migrate.
	 *
	 * Episode state lives in the DURABLE StateStore ledger (Codex R1 HIGH-2 +
	 * R2 MED-2 + R3: signature AND claimed exec ids persist across restarts —
	 * never inferred from the alert ticket row, whose ACTIVE state only means
	 * unresolved and would let a stale ESCALATED ticket swallow a NEW
	 * incident). Claiming happens before the migration succeeds on purpose:
	 * a failed migration must still suppress the per-runner reapers. The
	 * ongoing episode retries ONLY its pending migrations quietly (no new
	 * ticket, no re-notification) and clears when nothing claimed still runs.
	 */
	async check(): Promise<ReadonlySet<string>> {
		const wasFirst = this.firstCheck;
		this.firstCheck = false;
		const running = this.deps.store.getRunningSessions().filter(isTmuxBacked);

		// Ledger maintenance (Codex R4 HIGH-1): only an ANNOUNCED episode with
		// no claimed session still running is complete. An un-announced one
		// still OWES its ticket + Lead notifications (a crash landed between
		// the migrations and the announcement) and is replayed below.
		let episode = this.deps.store.getServerLossEpisode();
		if (episode?.announced) {
			const claimed = new Set(episode.claimed);
			if (!running.some((s) => claimed.has(s.execution_id))) {
				this.deps.store.clearServerLossEpisode();
				episode = undefined;
			}
		}

		if (!episode && running.length === 0) return new Set();

		// The probe is only needed when sessions could be migrated/extended.
		const probe: ServerProbe =
			running.length > 0 ? await this.deps.probeServer() : "unknown";

		// Fresh detection (no active episode).
		if (!episode) {
			let casualties: Session[] | null = null;
			if (probe === "down") {
				// Tick leg: the server hosting these sessions is GONE — any count.
				casualties = running;
				this.lastShape = "server_down";
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
						this.lastShape = "server_fresh";
					}
				}
			}
			if (!casualties) return new Set();
			const signature = `tmux-server-lost:${this.now()}`;
			this.log(
				`${this.lastShape}: ${casualties.length} running tmux session(s) lost — episode ${signature}`,
			);
			// The DURABLE ledger arms BEFORE any side effect (announced=0) so a
			// crash anywhere below replays under THIS episode, never a new one.
			this.deps.store.setServerLossEpisode(
				signature,
				casualties.map((s) => s.execution_id),
			);
			episode = {
				signature,
				claimed: casualties.map((s) => s.execution_id),
				announced: false,
			};
		}

		const claimed = new Set(episode.claimed);

		// Codex R4 HIGH-2: NEW casualties appearing while the SAME server loss
		// is ongoing (server still provably down) JOIN the episode — claimed +
		// migrated under the same signature, their Leads notified with a delta
		// message, no second fleet ticket. Without this they would be masked
		// from both the episode and fresh detection while old migrations retry.
		let extension: Session[] = [];
		if (probe === "down") {
			extension = running.filter((s) => !claimed.has(s.execution_id));
			if (extension.length > 0) {
				for (const s of extension) claimed.add(s.execution_id);
				this.deps.store.updateServerLossEpisodeClaimed([...claimed]);
				this.log(
					`episode ${episode.signature} extended by ${extension.length} new casualties`,
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
				await this.deps.migrate(session, episode.signature);
			} catch (err) {
				this.log(
					`migrate failed for ${session.execution_id}: ${(err as Error).message}`,
				);
			}
		}

		// Announcement phase — durable, exactly-once-ish: replayed from the
		// ledger until it RESOLVES (a throw leaves announced=0 for next tick).
		if (!episode.announced) {
			if (await this.announceEpisode(episode.signature, [...claimed])) {
				this.deps.store.markServerLossEpisodeAnnounced();
			}
		} else if (extension.length > 0) {
			// Already-announced episode extended: delta-notify the affected Leads
			// (their casualty lists) — the fleet ticket stays the one episode.
			this.notifyLeadsGrouped(episode.signature, extension);
		}

		return claimed;
	}

	/** Remembered for the announcement copy (replay defaults to server_down). */
	private lastShape: "server_down" | "server_fresh" = "server_down";

	/**
	 * The episode's side effects: ONE grouped notification per Lead + ONE
	 * fleet ticket, built from the ledger's claimed ids (works on replay too —
	 * migrated sessions still have their store rows). Returns true when the
	 * ticket emission RESOLVED (sent/queued/dead-lettered/deduped — all
	 * recorded outcomes); only a throw reports false so the ledger replays.
	 */
	private async announceEpisode(
		signature: string,
		claimedIds: string[],
	): Promise<boolean> {
		const sessions = claimedIds
			.map((id) => this.deps.store.getSession(id))
			.filter((s): s is Session => !!s);
		const migrated = sessions.filter((s) => s.status !== "running").length;
		const { byLead, unresolvedCount, leadsNotified, leadsFailed } =
			await this.notifyLeadsGrouped(signature, sessions);
		const perLead = [...byLead.entries()]
			.map(([leadId, group]) => `${leadId}: ${group.length}`)
			.join(" / ");
		try {
			await this.deps.alert({
				leadId: "tmux-server",
				projectName: FLEET_ALERT_PROJECT,
				eventId: signature,
				eventType: "tmux_server_lost",
				title: `tmux server 丢失 — ${claimedIds.length} 个 runner 阵亡`,
				body: `${
					this.lastShape === "server_down"
						? "tmux server 整个消失（no server running）"
						: "tmux server 重启（复活对账发现上一世代 runner 全灭）"
				}。受影响：${perLead}${
					unresolvedCount > 0 ? ` / 无主 ${unresolvedCount}` : ""
				}。已成组迁移 ${migrated}/${claimedIds.length} 到终态,并按 Lead 分组通知（各自阵亡清单 + resume 指针）。respawn 由各 Lead 驱动。`,
				severity: "severe",
				metadata: {
					tmuxServerLost: {
						casualties: claimedIds.length,
						migrated,
						leadsNotified,
						leadsFailed,
					},
				},
			});
			return true;
		} catch (err) {
			this.log(
				`episode announcement failed (will replay): ${(err as Error).message}`,
			);
			return false;
		}
	}

	/** ONE grouped notification per Lead: its own casualty list + resume
	 * pointers + the current watermark (anti-stampede context). */
	private async notifyLeadsGrouped(
		signature: string,
		sessions: Session[],
	): Promise<{
		byLead: Map<string, Session[]>;
		unresolvedCount: number;
		leadsNotified: number;
		leadsFailed: number;
	}> {
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
		let leadsNotified = 0;
		let leadsFailed = 0;
		const watermark = this.deps.currentWatermark?.() ?? null;
		for (const [leadId, group] of byLead) {
			const lines = group.map(
				(s) =>
					`- ${s.issue_identifier ?? s.issue_id} (exec ${s.execution_id})：progress ledger 在其分支上（$FLYWHEEL_PROGRESS_PATH 指向,可 resume 续跑）`,
			);
			const content = `[fleet-alert] tmux server 丢失（${signature}）— 你名下 ${group.length} 个 runner 阵亡,已标记终态：\n${lines.join(
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
		leadsFailed += unresolvedCount > 0 ? 1 : 0; // unresolvable = a failed notify
		return { byLead, unresolvedCount, leadsNotified, leadsFailed };
	}
}
