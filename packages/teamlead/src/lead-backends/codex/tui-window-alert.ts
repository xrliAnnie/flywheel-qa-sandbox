/**
 * FLY-871 §12 W2 — the "silent no-pane" alert guard for a windowed (cmux TUI)
 * Codex Lead.
 *
 * `ensureTuiWindow` is deliberately fail-open (a visibility loss must never take
 * down the Lead's Discord service — tui-window.ts §22). That is right for an
 * ordinary Lead, but for the Codex Infra Bot the founder MUST be able to watch
 * it (FLY-398 hard rule): a silently-missing pane is exactly the FLY-871 incident
 * shape, and the runtime had ZERO alert wiring (R-10.4-1). This guard watches the
 * runtime's own liveness cadence and, after K consecutive failures to (re)create
 * the window, fires ONE alert per episode via `scripts/lead-alert.sh` — the
 * FLY-83 Discord-independent path (works even when the Bridge is down; claims.db
 * cross-process dedup). It never touches the Lead's service loop.
 *
 * Two hard properties (Codex design R1):
 *   1. Episode-latched, EPISODE-level (not day-level). lead-alert.sh dedups on
 *      sha1(project|lead|kind|signature). If the signature were YYYYMMDD, the
 *      second REAL episode on the same day would collide with claims.db and be
 *      swallowed — violating "recover → fail again may re-alert". So the episode
 *      signature is `tui-window-lost:<startedAt>` where startedAt is stamped at
 *      trigger time and persisted to a state-dir file. Recovery deletes the file
 *      and clears the in-proc latch → the next episode gets a fresh startedAt =
 *      fresh signature = re-alertable. The file survives a KeepAlive restart so a
 *      new incarnation of the SAME unresolved episode does not double-report.
 *   2. Default OFF (Codex R1#5). The shared TUI runtime never alerts unless the
 *      InfraBot launcher opts in with FLYWHEEL_TUI_WINDOW_ALERT=1. Any future
 *      Mufasa/task-114 bootstrap on this same runtime is byte-compat.
 *
 * Fail-soft everywhere: an unresolved lead-alert.sh path (no FLYWHEEL_ROOT /
 * missing script) disables the guard with a warning (never throws); an alert
 * invocation that fails (queue spill, exit 2) is logged, never propagated.
 */

import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** The alert kind — mirrored in scripts/lead-alert.sh's kind allowlist AND in
 * LeadAlertNotifier.ts's AlertEventType union (shared type face, no drift). */
export const TUI_WINDOW_ALERT_KIND = "tui_window_lost";

/** ~3 minutes at the 20s liveness cadence — long enough that a transient tmux
 * hiccup or a normal single-tick rebuild never trips it. */
export const DEFAULT_TUI_WINDOW_ALERT_THRESHOLD = 9;

/** Basename of the per-episode latch file inside the Lead's state dir. */
export const TUI_WINDOW_EPISODE_FILE = "tui-window-lost-episode.json";

export interface TuiWindowAlertGuardConfig {
	/** projects.json project name (lead-alert.sh resolves the channel from it). */
	projectName: string;
	/** projects.json lead agentId. */
	leadId: string;
	/** Absolute path to scripts/lead-alert.sh (resolved by the factory). */
	alertScriptPath: string;
}

export interface TuiWindowAlertGuardDeps {
	/** Consecutive-failure threshold before the first alert (default 9). */
	threshold?: number;
	/** Monotonic-ish wall clock; injected for deterministic tests. */
	now?: () => number;
	/** Read the persisted episode startedAt (undefined = no active episode). */
	readEpisode?: () => number | undefined;
	/** Persist the episode startedAt (atomic). */
	writeEpisode?: (startedAt: number) => void;
	/** Delete the persisted episode file. */
	deleteEpisode?: () => void;
	/** Fire the alert. MUST NOT throw into the caller (default is async execFile). */
	runAlert?: (args: string[]) => void;
	log?: (m: string) => void;
}

/**
 * State machine: fed one liveness-tick outcome at a time via `record(healthy)`.
 * Process-scoped in the runtime so the counter + latch survive generation
 * rebuilds; the file latch survives process restarts.
 */
export class TuiWindowAlertGuard {
	private readonly threshold: number;
	private readonly now: () => number;
	private readonly readEpisode: () => number | undefined;
	private readonly writeEpisode: (startedAt: number) => void;
	private readonly deleteEpisode: () => void;
	private readonly runAlert: (args: string[]) => void;
	private readonly log: (m: string) => void;
	private consecutiveFailures = 0;
	/** In-proc floor for the file latch (a failed file write must not let the
	 * guard re-fire every tick past threshold within this process). */
	private episodeLatched = false;

	constructor(
		private readonly config: TuiWindowAlertGuardConfig,
		deps: TuiWindowAlertGuardDeps = {},
	) {
		this.threshold = deps.threshold ?? DEFAULT_TUI_WINDOW_ALERT_THRESHOLD;
		this.now = deps.now ?? (() => Date.now());
		this.readEpisode = deps.readEpisode ?? (() => undefined);
		this.writeEpisode = deps.writeEpisode ?? (() => {});
		this.deleteEpisode = deps.deleteEpisode ?? (() => {});
		this.runAlert = deps.runAlert ?? (() => {});
		this.log = deps.log ?? (() => {});
	}

	/**
	 * Feed one liveness-tick outcome.
	 *   healthy === true  → the TUI window is up (or was just (re)created).
	 *   healthy === false → it could not be (re)created, or it died.
	 */
	record(healthy: boolean): void {
		if (healthy) {
			this.consecutiveFailures = 0;
			this.clearEpisode();
			return;
		}
		this.consecutiveFailures++;
		if (this.consecutiveFailures < this.threshold) return;
		// Threshold reached: alert ONCE per episode. A persisted episode file
		// (this process OR a prior KeepAlive incarnation) means we already alerted
		// for the current still-unresolved episode.
		if (this.episodeActive()) return;
		this.startEpisodeAndAlert();
	}

	private episodeActive(): boolean {
		if (this.episodeLatched) return true;
		return this.readEpisode() !== undefined;
	}

	private startEpisodeAndAlert(): void {
		const startedAt = this.now();
		// In-proc floor first so a throwing writeEpisode can't cause re-fire.
		this.episodeLatched = true;
		try {
			this.writeEpisode(startedAt);
		} catch (err) {
			this.log(
				`tui-window-alert: episode file write failed (alerting anyway): ${(err as Error).message}`,
			);
		}
		this.fire(startedAt);
	}

	private clearEpisode(): void {
		if (!this.episodeLatched && this.readEpisode() === undefined) return;
		this.episodeLatched = false;
		try {
			this.deleteEpisode();
		} catch (err) {
			this.log(
				`tui-window-alert: episode file delete failed: ${(err as Error).message}`,
			);
		}
	}

	private fire(startedAt: number): void {
		const minutes = Math.round((this.threshold * 20) / 60);
		const signature = `${TUI_WINDOW_ALERT_KIND}:${startedAt}`;
		const args = [
			"--lead",
			this.config.leadId,
			"--project",
			this.config.projectName,
			"--kind",
			TUI_WINDOW_ALERT_KIND,
			"--severity",
			"warning",
			"--title",
			"Infra Bot TUI window not visible",
			"--body",
			`The windowed codex resume --remote pane could not be (re)created after ${this.threshold} consecutive liveness checks (~${minutes} min). The founder-visible cmux tab may be missing. Bring-up check: verify-windowed-lead.sh ${this.config.projectName} ${this.config.leadId}`,
			"--signature",
			signature,
		];
		try {
			this.runAlert(args);
			this.log(
				`tui-window-alert: fired tui_window_lost (episode ${signature}, lead ${this.config.leadId})`,
			);
		} catch (err) {
			// Belt-and-suspenders: the default runAlert is async/no-throw, but an
			// injected one must never break the runtime either.
			this.log(
				`tui-window-alert: alert invocation threw (ignored): ${(err as Error).message}`,
			);
		}
	}
}

// ── default fs / exec deps ───────────────────────────────────────────────────

function defaultReadEpisode(path: string): () => number | undefined {
	return () => {
		try {
			if (!existsSync(path)) return undefined;
			const parsed = JSON.parse(readFileSync(path, "utf8")) as {
				startedAt?: unknown;
			};
			return typeof parsed.startedAt === "number" &&
				Number.isFinite(parsed.startedAt)
				? parsed.startedAt
				: undefined;
		} catch {
			// Corrupt/unreadable → treat as no episode (a fresh run re-latches).
			return undefined;
		}
	};
}

function defaultWriteEpisode(path: string): (startedAt: number) => void {
	return (startedAt) => {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp.${process.pid}`;
		writeFileSync(tmp, JSON.stringify({ startedAt }), { mode: 0o600 });
		renameSync(tmp, path); // atomic same-dir replace
	};
}

function defaultDeleteEpisode(path: string): () => void {
	return () => {
		rmSync(path, { force: true });
	};
}

function defaultRunAlert(
	scriptPath: string,
	log: (m: string) => void,
): (args: string[]) => void {
	return (args) => {
		// Async fire-and-forget: the runtime liveness tick must never block on
		// Discord I/O, and a non-zero exit (exit 2 = queue spill) is not our
		// problem to recover — lead-alert.sh already persists to its queue.
		execFile(
			"/bin/bash",
			[scriptPath, ...args],
			{ timeout: 20_000 },
			(err, _stdout, stderr) => {
				if (err) {
					log(
						`tui-window-alert: lead-alert.sh exited non-zero (${err.code ?? "?"}): ${String(stderr).slice(0, 200)}`,
					);
				}
			},
		);
	};
}

export interface CreateTuiWindowAlertGuardOptions {
	stateDir: string;
	leadId: string;
	projectName: string;
	env: NodeJS.ProcessEnv;
	log?: (m: string) => void;
	// Test seams (production defaults injected below).
	exists?: (p: string) => boolean;
	now?: () => number;
	threshold?: number;
	runAlert?: (args: string[]) => void;
}

/**
 * Build the guard from env, or return null (disabled) — the runtime calls
 * `guard?.record(...)` so null is a no-op.
 *
 * Disabled when:
 *   - FLYWHEEL_TUI_WINDOW_ALERT !== "1" (default OFF — Codex R1#5), OR
 *   - lead-alert.sh cannot be resolved (no FLYWHEEL_LEAD_ALERT_SH override AND no
 *     FLYWHEEL_ROOT), OR the resolved script does not exist (fail-soft — Codex R1#4).
 *
 * The dist runtime runs from packages/teamlead/dist/... and cannot guess the repo
 * root from cwd, so the InfraBot launcher exports FLYWHEEL_ROOT (claude-lead.sh
 * precedent); FLYWHEEL_LEAD_ALERT_SH is an explicit override for tests / unusual
 * layouts.
 */
export function createTuiWindowAlertGuard(
	opts: CreateTuiWindowAlertGuardOptions,
): TuiWindowAlertGuard | null {
	const log = opts.log ?? (() => {});
	const exists = opts.exists ?? ((p: string) => existsSync(p));

	if (opts.env.FLYWHEEL_TUI_WINDOW_ALERT?.trim() !== "1") return null;

	const override = opts.env.FLYWHEEL_LEAD_ALERT_SH?.trim();
	const root = opts.env.FLYWHEEL_ROOT?.trim();
	const alertScriptPath =
		override || (root ? join(root, "scripts", "lead-alert.sh") : "");
	if (!alertScriptPath) {
		log(
			"tui-window-alert: FLYWHEEL_TUI_WINDOW_ALERT=1 but neither FLYWHEEL_LEAD_ALERT_SH nor FLYWHEEL_ROOT is set — silent-no-pane guard DISABLED (fail-soft).",
		);
		return null;
	}
	if (!exists(alertScriptPath)) {
		log(
			`tui-window-alert: lead-alert.sh not found at ${alertScriptPath} — silent-no-pane guard DISABLED (fail-soft).`,
		);
		return null;
	}

	const episodePath = join(opts.stateDir, TUI_WINDOW_EPISODE_FILE);
	return new TuiWindowAlertGuard(
		{
			projectName: opts.projectName,
			leadId: opts.leadId,
			alertScriptPath,
		},
		{
			threshold: opts.threshold,
			now: opts.now,
			readEpisode: defaultReadEpisode(episodePath),
			writeEpisode: defaultWriteEpisode(episodePath),
			deleteEpisode: defaultDeleteEpisode(episodePath),
			runAlert: opts.runAlert ?? defaultRunAlert(alertScriptPath, log),
			log,
		},
	);
}
