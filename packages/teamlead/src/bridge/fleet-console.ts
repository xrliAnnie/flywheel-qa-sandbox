/**
 * FLY-247 inc2a (§2.1 / §2.2 / §2.5): the Bridge-side glue that mounts the
 * fleet console. It owns the audit table + confirmToken store and implements the
 * `FleetRouteDeps` the stage/apply handlers need, plus:
 *
 *   - the secret-free read model snapshot (§2.4),
 *   - `createLaunching` — exclusive-create the durable launching journal BEFORE
 *     spawn so there is never a pre-journal window (R6 #4),
 *   - `spawnEngine` — a Bridge-independent detached process group running
 *     `flywheel-fleet.sh apply --changes-file <cf> --yes`, stdout/stderr to a
 *     per-batch durable log (Bridge restart never kills the engine),
 *   - progress reading from the durable journals (watcher → SSE), and
 *   - startup reconciliation (R8 #2): a live engine is observed (never its phase
 *     overwritten); a dead engine's batch is reconciled via the engine's own
 *     `recover --batch` (launching→rejected zero-mutation; running→reconcile).
 *
 * Identity/liveness is carried on a per-batch OWNER SIDECAR file
 * (`owner-<id>.json`), written once by the parent right after spawn. It is
 * a SEPARATE file from the journal so the parent never does a read-modify-write
 * on the journal the detached engine is concurrently advancing (Codex R1 HIGH-2:
 * a journal RMW would clobber the engine's newer transitions). `apply-result`
 * audit rows are reconciled (idempotent upsert) from terminal journals here and
 * on boot.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	type AsyncExecFileFn,
	defaultAsyncExecFile,
} from "flywheel-claude-runner";
import {
	EXECUTOR_BACKENDS,
	type FlagView,
	getModelTiers,
} from "flywheel-config";
import { EFFORT_LEVELS } from "../lead-effort.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { CanonicalRequest } from "./fleet-admin.js";
import { ConfirmTokenStore } from "./fleet-admin.js";
import { FleetAdminAudit } from "./fleet-admin-audit.js";
import {
	buildConsoleSnapshot,
	type ConsoleLeadOnline,
	type ConsoleSnapshot,
	type CronModelView,
	type PerIssueModelProvider,
	type ProjectRunnerDefaultView,
	type RunnerCapabilities,
} from "./fleet-console-model.js";
import type { FleetPresentation, FleetSnapshot } from "./fleet-data.js";
import {
	BATCH_STATUS_VIEW,
	type BatchJournal,
	type BatchProgress,
	buildBatchProgress,
} from "./fleet-progress.js";
import type { FleetRouteDeps } from "./fleet-routes.js";
import type { ManagementChangeCoordinator } from "./management-change-coordinator.js";
import type { ManagementSnapshot } from "./management-console-contract.js";
import {
	composeManagementSnapshot,
	type ManagementSnapshotProvider,
} from "./management-console-snapshot.js";

export interface FleetConsoleOptions {
	/** The projects.json the engine operates on (HOME/.flywheel/projects.json). */
	projectsJsonPath: string;
	/** Durable transaction dir shared with the engine (FLEET_TXN_DIR). */
	txnDir: string;
	/** audit.db path (shared with founder_consent_audit, separate table). */
	auditDbPath: string;
	/** Absolute path to flywheel-fleet.sh. */
	fleetScriptPath: string;
	/** Dir for per-batch engine stdout/stderr logs. */
	logDir: string;
	/** The live (hot-overlay) project topology for the read model. */
	liveProjects: () => ProjectEntry[];
	/** FLY-224 legacy backend resolution per project (model display alignment). */
	legacyBackendOf: (p: ProjectEntry) => string | null | undefined;
	/**
	 * Live fleet evidence (the FleetPoller snapshot) used ONLY to derive the
	 * online dot per Lead. Null/stale → "unknown" (never a stale confirmed dot).
	 */
	fleetEvidence?: () => FleetSnapshot | null;
	/** Injectable clock (epoch ms). */
	now?: () => number;
	/** Injectable liveness probe (kill(pid,0)-style). */
	pidAlive?: (pid: number) => boolean;
	/** Injectable batch recovery (defaults to spawning `recover --batch`). */
	recoverBatch?: (batchId: string) => void | Promise<void>;
	/** Injectable async child seam for the default recovery implementation. */
	recoverExec?: AsyncExecFileFn;
	/**
	 * FLY-709: resolved feature-flag views (from flywheel-config resolveAllFlags,
	 * ctx = process.env + per-project config). Optional — omitted → no flags section.
	 */
	featureFlags?: () => FlagView[];
	/** FLY-728 seam (read-only): per-issue model rows; omitted → no section. */
	perIssueModels?: PerIssueModelProvider;
	/**
	 * FLY-709 ② (b): per-project runner default model (read-only), from
	 * `roles.runner` in each project's config.yaml. Optional — omitted → no section.
	 */
	projectRunnerDefaults?: () => ProjectRunnerDefaultView[];
	/** FLY-709 P4.4: cron recurring-issue model rows; omitted → no section. */
	cronModels?: () => CronModelView[];
	/** FLY-1262: source providers for the versioned aggregate management view. */
	managementSnapshotProviders?: () => readonly ManagementSnapshotProvider[];
	/**
	 * FLY-709 P4 (Codex R1 #6): stat-and-reload-on-change of the per-project
	 * config cache, awaited by the snapshot routes so a runner-config CLI write
	 * is visible without a Bridge restart.
	 */
	refreshProjectConfigs?: () => Promise<void>;
	/** FLY-709 P4.2: flywheel-comm dist path for the runner/cron copy commands. */
	commCliPath?: string;
	logger?: (msg: string) => void;
}

/**
 * FLY-709 P4.3 — dropdown options for the per-project runner-default rows.
 * Backends = the full executor set (this is the RUNNER layer, where
 * Antigravity/Kimi genuinely exist); models = the FLY-728 canonical tier ids;
 * efforts = the Claude CLI levels (writer enforces claude-tmux-only).
 */
export function runnerCapabilities(): RunnerCapabilities {
	return {
		backends: EXECUTOR_BACKENDS,
		models: [...new Set(Object.values(getModelTiers()).map((tier) => tier.id))],
		efforts: EFFORT_LEVELS,
	};
}

/** Map the fleet presentation verdict to the console's online dot state. */
export function onlineFromPresentation(
	p: FleetPresentation | undefined,
): ConsoleLeadOnline {
	if (p === undefined) return "unknown";
	if (p === "ONLINE" || p === "EXTERNAL") return "online";
	if (p === "DOWN") return "offline";
	return "degraded"; // PARTIAL / DEGRADED / CONFLICT / CONFLICT-CARRIER
}

function defaultPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM = alive but not ours; ESRCH = dead.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class FleetConsole {
	readonly audit: FleetAdminAudit;
	readonly tokens: ConfirmTokenStore;
	private readonly o: Required<
		Pick<FleetConsoleOptions, "now" | "pidAlive" | "logger">
	> &
		FleetConsoleOptions;
	private managementCoordinator?: ManagementChangeCoordinator;
	private reconcileInFlight: Promise<void> | null = null;

	constructor(opts: FleetConsoleOptions) {
		this.o = {
			now: opts.now ?? (() => Date.now()),
			pidAlive: opts.pidAlive ?? defaultPidAlive,
			logger: opts.logger ?? (() => {}),
			...opts,
		};
		// Zero startup disk (byte-compat, §2.2): FleetAdminAudit is lazy (opens on
		// first record/query) and the txn/log dirs are created on first write —
		// an unused console touches nothing at boot.
		this.audit = new FleetAdminAudit(this.o.auditDbPath);
		this.tokens = new ConfirmTokenStore();
	}

	setManagementCoordinator(coordinator: ManagementChangeCoordinator): void {
		if (this.managementCoordinator) {
			throw new Error("management coordinator is already configured");
		}
		this.managementCoordinator = coordinator;
	}

	getManagementCoordinator(): ManagementChangeCoordinator | undefined {
		return this.managementCoordinator;
	}

	// ── Read model (§2.4) ──────────────────────────────────────────────────

	/**
	 * FLY-709 P4: mtime-refresh the per-project config cache (delegates to the
	 * wired provider). Awaited by the snapshot routes before buildSnapshot().
	 */
	async refreshProjectConfigs(): Promise<void> {
		await this.o.refreshProjectConfigs?.();
	}

	/** Secret-free console snapshot: every configured Lead + capabilities. */
	buildSnapshot(): ConsoleSnapshot {
		const projects = this.o.liveProjects();
		const byName = new Map(projects.map((p) => [p.projectName, p]));
		const snap = buildConsoleSnapshot(
			projects,
			(projectName) => {
				const proj = byName.get(projectName);
				return proj ? this.o.legacyBackendOf(proj) : undefined;
			},
			{
				featureFlags: this.o.featureFlags?.(),
				perIssueModels: this.o.perIssueModels?.list(),
				projectRunnerDefaults: this.o.projectRunnerDefaults?.(),
				cronModels: this.o.cronModels?.(),
				runnerCapabilities: runnerCapabilities(),
				fleetScriptPath: this.o.fleetScriptPath,
				commCliPath: this.o.commCliPath,
			},
		);
		// Enrich the online dot from the live fleet evidence (presentation by key);
		// null/stale evidence → "unknown" (never a stale confirmed dot).
		const evidence = this.o.fleetEvidence?.() ?? null;
		const byKey = new Map<string, FleetPresentation>();
		if (evidence)
			for (const l of evidence.leads) byKey.set(l.key, l.presentation);
		for (const lead of snap.leads) {
			lead.online = onlineFromPresentation(byKey.get(lead.key));
		}
		return snap;
	}

	/** Versioned SSOT projection. The legacy flat snapshot remains during UI migration. */
	buildManagementSnapshot(): ManagementSnapshot {
		return composeManagementSnapshot({
			providers: this.o.managementSnapshotProviders?.() ?? [],
			now: () => new Date(this.o.now()),
		});
	}

	/** SHA-256 of the live projects.json file (matches the engine's file_sha). */
	configSha(): string {
		try {
			return createHash("sha256")
				.update(readFileSync(this.o.projectsJsonPath))
				.digest("hex");
		} catch {
			return "";
		}
	}

	/**
	 * Current model per exact key `${projectName}-${agentId}` read FRESH from the
	 * projects.json file — the same bytes the engine's baseline gate re-verifies,
	 * so the staged `from` can never disagree with what the engine sees.
	 */
	currentModels(): Map<string, string | null> {
		const out = new Map<string, string | null>();
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(this.o.projectsJsonPath, "utf8"));
		} catch {
			return out;
		}
		if (!Array.isArray(raw)) return out;
		for (const project of raw as Array<Record<string, unknown>>) {
			const projectName = project?.projectName;
			const leads = project?.leads;
			if (typeof projectName !== "string" || !Array.isArray(leads)) continue;
			for (const lead of leads as Array<Record<string, unknown>>) {
				const agentId = lead?.agentId;
				if (typeof agentId !== "string") continue;
				const model = typeof lead.model === "string" ? lead.model : null;
				out.set(`${projectName}-${agentId}`, model);
			}
		}
		return out;
	}

	/**
	 * FLY-671: current effort per exact key read FRESH from projects.json (mirrors
	 * `currentModels`) — the `from.effort` baseline the engine re-verifies.
	 */
	currentEfforts(): Map<string, string | null> {
		const out = new Map<string, string | null>();
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(this.o.projectsJsonPath, "utf8"));
		} catch {
			return out;
		}
		if (!Array.isArray(raw)) return out;
		for (const project of raw as Array<Record<string, unknown>>) {
			const projectName = project?.projectName;
			const leads = project?.leads;
			if (typeof projectName !== "string" || !Array.isArray(leads)) continue;
			for (const lead of leads as Array<Record<string, unknown>>) {
				const agentId = lead?.agentId;
				if (typeof agentId !== "string") continue;
				const effort = typeof lead.effort === "string" ? lead.effort : null;
				out.set(`${projectName}-${agentId}`, effort);
			}
		}
		return out;
	}

	// ── Route deps (§2.2) ──────────────────────────────────────────────────

	routeDeps(): FleetRouteDeps {
		return {
			audit: this.audit,
			tokens: this.tokens,
			currentModels: () => this.currentModels(),
			currentEfforts: () => this.currentEfforts(),
			allowedTargets: () => this.allowedTargets(),
			allowedEffortTargets: () => this.allowedEffortTargets(),
			configSha: () => this.configSha(),
			createLaunching: (batchId, req) => this.createLaunching(batchId, req),
			spawnEngine: (batchId, req) => this.spawnEngine(batchId, req),
		};
	}

	/**
	 * Allowed `to.model` targets per exact key, server-computed from the live
	 * capabilities (Claude tiers ∪ {null}; Codex = [null]). The stage handler
	 * enforces this so a forged client can't stage an unauthorized model.
	 */
	allowedTargets(): Map<string, Array<string | null>> {
		const out = new Map<string, Array<string | null>>();
		for (const lead of this.buildSnapshot().leads) {
			out.set(lead.key, lead.allowedModelTargets);
		}
		return out;
	}

	/**
	 * FLY-671: allowed `to.effort` targets per key (backend-aware: Claude =
	 * levels ∪ {null}, Codex = [null]). Same forged-client gate as model.
	 */
	allowedEffortTargets(): Map<string, Array<string | null>> {
		const out = new Map<string, Array<string | null>>();
		for (const lead of this.buildSnapshot().leads) {
			out.set(lead.key, lead.allowedEffortTargets);
		}
		return out;
	}

	// ── Journal paths ──────────────────────────────────────────────────────

	private journalPath(batchId: string): string {
		return join(this.o.txnDir, `batch-${batchId}.json`);
	}
	private changesPath(batchId: string): string {
		return join(this.o.txnDir, `changes-${batchId}.json`);
	}
	/**
	 * Owner liveness sidecar — SEPARATE from the journal (Codex R1 HIGH-2). Named
	 * `owner-*` (NOT `batch-*`) so it never matches the `batch-*.json` journal
	 * enumeration in listProgress/reconcileOnStartup.
	 */
	private ownerPath(batchId: string): string {
		return join(this.o.txnDir, `owner-${batchId}.json`);
	}
	private logPath(batchId: string): string {
		return join(this.o.logDir, `engine-${batchId}.log`);
	}

	/** Read the engine pid for liveness: sidecar first, journal owner.pid fallback. */
	private readOwnerPid(batchId: string): number {
		try {
			const o = JSON.parse(readFileSync(this.ownerPath(batchId), "utf8")) as {
				pid?: number;
			};
			if (typeof o.pid === "number") return o.pid;
		} catch {
			// no sidecar — fall through to the journal placeholder.
		}
		const j = this.readJournal(batchId);
		return typeof j?.owner?.pid === "number" ? j.owner.pid : 0;
	}

	// ── Launching journal (§2.1, R6 #4: created BEFORE spawn) ───────────────

	/**
	 * Exclusive-create the durable launching record + the engine's changes file.
	 * Mirrors the bash `batch_journal_create` schema so the engine can attach and
	 * advance it. Returns false if a journal already exists (no silent overwrite)
	 * or any write fails.
	 */
	createLaunching(batchId: string, req: CanonicalRequest): boolean {
		const jp = this.journalPath(batchId);
		const cp = this.changesPath(batchId);
		try {
			mkdirSync(dirname(jp), { recursive: true });
			// The engine reads the canonical request via --changes-file.
			writeFileSync(cp, `${JSON.stringify(req)}\n`, { mode: 0o600 });
			const keys: BatchJournal["keys"] = {};
			for (const c of req.changes) {
				keys[c.key] = {
					from: c.from ?? { model: null },
					to: c.to,
					status: "pending",
				};
			}
			const record: BatchJournal = {
				batchId,
				batchStatus: "launching",
				owner: { pid: 0, created: Math.floor(this.o.now() / 1000) },
				preImageSha: this.configSha(),
				canonicalRequest: req,
				keys,
			};
			// Exclusive create: 'wx' throws EEXIST if the journal already exists.
			writeFileSync(jp, `${JSON.stringify(record)}\n`, {
				flag: "wx",
				mode: 0o600,
			});
			return true;
		} catch (err) {
			this.o.logger(
				`[fleet-console] createLaunching(${batchId}) failed: ${(err as Error).message}`,
			);
			return false;
		}
	}

	// ── Engine spawn (§2.1, R4/R5/R6 #4: Bridge-independent process group) ───

	/**
	 * Spawn the detached engine for an already-created launching batch. The engine
	 * is its own process group (`detached: true` + `unref`), stdout/stderr to a
	 * per-batch durable log, so a Bridge restart never kills it. The real engine
	 * pid is patched onto the journal synchronously right after spawn (before the
	 * engine's startup can advance the journal) for liveness reconciliation.
	 */
	spawnEngine(batchId: string, _req: CanonicalRequest): boolean {
		const cp = this.changesPath(batchId);
		if (!existsSync(cp)) {
			this.o.logger(
				`[fleet-console] spawnEngine(${batchId}): changes file missing`,
			);
			return false;
		}
		let logFd: number;
		try {
			mkdirSync(this.o.logDir, { recursive: true });
			logFd = openSync(this.logPath(batchId), "a", 0o600);
		} catch (err) {
			this.o.logger(
				`[fleet-console] spawnEngine(${batchId}): cannot open log: ${(err as Error).message}`,
			);
			return false;
		}
		let child: ChildProcess;
		try {
			child = spawn(
				"bash",
				[this.o.fleetScriptPath, "apply", "--changes-file", cp, "--yes"],
				{
					detached: true,
					stdio: ["ignore", logFd, logFd],
					env: { ...process.env, FLEET_TXN_DIR: this.o.txnDir },
				},
			);
		} catch (err) {
			closeSync(logFd);
			this.o.logger(
				`[fleet-console] spawnEngine(${batchId}) failed: ${(err as Error).message}`,
			);
			return false;
		}
		// The parent's copy of the log fd is no longer needed once handed off.
		closeSync(logFd);
		child.once("error", (error) => {
			this.o.logger(
				`[fleet-console] spawnEngine(${batchId}) child error: ${error.message}`,
			);
		});
		child.once("exit", (code, signal) => {
			this.o.logger(
				`[fleet-console] spawnEngine(${batchId}) exited: code=${code ?? "null"} signal=${signal ?? "null"}`,
			);
		});
		if (typeof child.pid !== "number") {
			this.o.logger(`[fleet-console] spawnEngine(${batchId}): no pid`);
			return false;
		}
		// Record liveness in a SEPARATE sidecar (Codex R1 HIGH-2): the parent must
		// never write the journal the detached engine is concurrently advancing.
		// If ownership can't be published, KILL the just-spawned engine and fail
		// the apply (Codex R2 HIGH-2: never leave an unowned live engine that a
		// later startup recover could reject while it keeps mutating). The engine
		// ALSO claims ownership itself as its first action, covering a crash in the
		// microsecond gap before this write.
		if (!this.writeOwnerSidecar(batchId, child.pid)) {
			// Kill the whole detached PROCESS GROUP (negative pid), not just the
			// shell — the engine may already have spawned a cutover child (Codex R3
			// HIGH-2c). Fall back to the bare pid if the group signal is unsupported.
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				try {
					process.kill(child.pid, "SIGKILL");
				} catch {
					// already gone — nothing to clean up
				}
			}
			return false;
		}
		child.unref();
		return true;
	}

	/**
	 * Atomically write the owner liveness sidecar (single writer = the parent,
	 * separate file from the journal → no read-modify-write race with the engine).
	 * Returns false on failure so spawnEngine can kill the unowned engine.
	 */
	private writeOwnerSidecar(batchId: string, pid: number): boolean {
		const op = this.ownerPath(batchId);
		try {
			const tmp = `${op}.tmp.${process.pid}`;
			writeFileSync(
				tmp,
				`${JSON.stringify({ pid, created: Math.floor(this.o.now() / 1000) })}\n`,
				{ mode: 0o600 },
			);
			renameSync(tmp, op);
			return true;
		} catch (err) {
			this.o.logger(
				`[fleet-console] writeOwnerSidecar(${batchId}) failed: ${(err as Error).message}`,
			);
			return false;
		}
	}

	// ── Progress (§2.5: watcher reads durable journals) ─────────────────────

	private readJournal(batchId: string): BatchJournal | null {
		try {
			return JSON.parse(
				readFileSync(this.journalPath(batchId), "utf8"),
			) as BatchJournal;
		} catch {
			return null;
		}
	}

	progressFor(batchId: string): BatchProgress | null {
		const j = this.readJournal(batchId);
		return j ? buildBatchProgress(j) : null;
	}

	/** All known batches' progress (newest first by owner.created). */
	listProgress(): BatchProgress[] {
		let files: string[];
		try {
			files = readdirSync(this.o.txnDir).filter(
				(f) => f.startsWith("batch-") && f.endsWith(".json"),
			);
		} catch {
			return [];
		}
		const out: Array<{ created: number; p: BatchProgress }> = [];
		for (const f of files) {
			const batchId = f.slice("batch-".length, -".json".length);
			const j = this.readJournal(batchId);
			if (!j) continue;
			out.push({ created: j.owner?.created ?? 0, p: buildBatchProgress(j) });
		}
		out.sort((a, b) => b.created - a.created);
		return out.map((x) => x.p);
	}

	// ── apply-result audit reconciliation (R4 #5) ───────────────────────────

	/**
	 * For a batch in a terminal state, idempotently upsert its `apply-result`
	 * audit row from the durable journal (the only honest source once the engine
	 * may have mutated and the Bridge may have restarted).
	 *
	 * Returns true when there is nothing more to do (non-terminal no-op, row
	 * already present, or a fresh write succeeded) and false when a terminal
	 * batch's row still needs writing but the audit DB write/read failed — the
	 * caller must NOT mark such a batch "done" (Codex R1 MEDIUM-5: marking it seen
	 * before a confirmed write permanently loses the apply-result). Never throws.
	 */
	reconcileTerminalAudit(batchId: string): boolean {
		try {
			const j = this.readJournal(batchId);
			// Unreadable journal → can't CONFIRM the apply-result; return false so a
			// caller that already knows the batch is terminal keeps retrying instead
			// of marking it done (Codex R2 MEDIUM-2). reconcileOnStartup ignores the
			// return (it pre-skips null journals), so this only affects the SSE path.
			if (!j) return false;
			if (!BATCH_STATUS_VIEW[j.batchStatus]?.terminal) return true; // not terminal yet
			if (this.audit.hasApplyResult(batchId)) return true; // already recorded
			return this.audit.record({
				batchId,
				event: "apply-result",
				result: j.batchStatus,
			});
		} catch (err) {
			this.o.logger(
				`[fleet-console] reconcileTerminalAudit(${batchId}) failed: ${(err as Error).message}`,
			);
			return false;
		}
	}

	// ── Startup reconciliation (R8 #2) ──────────────────────────────────────

	/**
	 * On Bridge boot, decide each non-terminal batch by engine liveness:
	 *   - live engine (owner sidecar pid alive) → leave it (never overwrite a live
	 *     txn);
	 *   - dead engine → invoke the engine's own `recover --batch --yes`, which does
	 *     launching→rejected (zero mutation) / running→per-key reconcile.
	 * A dead engine at boot means the engine is definitively gone (this is a fresh
	 * process), so it is reconciled regardless of age — there is no later pass
	 * (Codex R1 MEDIUM-4: a deadline "leave for later" would strand it forever).
	 * recover is awaited so the subsequent `apply-result` reconcile sees the
	 * post-recovery terminal state (Codex R1 HIGH-3).
	 */
	reconcileOnStartup(): Promise<void> {
		if (this.reconcileInFlight) return this.reconcileInFlight;
		const run = this.reconcileOnStartupPass();
		const owner = run.finally(() => {
			if (this.reconcileInFlight === owner) this.reconcileInFlight = null;
		});
		this.reconcileInFlight = owner;
		return owner;
	}

	private async reconcileOnStartupPass(): Promise<void> {
		let files: string[];
		try {
			files = readdirSync(this.o.txnDir).filter(
				(f) => f.startsWith("batch-") && f.endsWith(".json"),
			);
		} catch {
			return;
		}
		for (const f of files) {
			const batchId = f.slice("batch-".length, -".json".length);
			const j = this.readJournal(batchId);
			if (!j) continue;
			const view = BATCH_STATUS_VIEW[j.batchStatus];
			if (view?.terminal) {
				this.reconcileTerminalAudit(batchId);
				continue;
			}
			if (this.o.pidAlive(this.readOwnerPid(batchId))) {
				// Live engine owns it — observe only, never touch its phase.
				continue;
			}
			// Dead engine at boot → reconcile now (recover is synchronous so the
			// terminal state is settled before the audit reconcile reads it).
			await this.runRecover(batchId);
			this.reconcileTerminalAudit(batchId);
		}
	}

	/**
	 * Invoke the engine's own batch reconciliation with a bounded async child.
	 * `--yes` is mandatory — `recover --batch` is mutating and dies without it
	 * (Codex R1 HIGH-3: omitting it made every startup recovery a no-op).
	 */
	private async runRecover(batchId: string): Promise<void> {
		if (this.o.recoverBatch) {
			await this.o.recoverBatch(batchId);
			return;
		}
		try {
			await (this.o.recoverExec ?? defaultAsyncExecFile)(
				"bash",
				[this.o.fleetScriptPath, "recover", "--batch", batchId, "--yes"],
				{
					env: { ...process.env, FLEET_TXN_DIR: this.o.txnDir },
					envMode: "replace",
					// Recovery is a mutating multi-project operation. Preserve a finite
					// memory ceiling, but do not let the shared 1 MiB probe default kill
					// an otherwise healthy recovery merely because a sub-tool is chatty.
					maxBuffer: 16 * 1024 * 1024,
					timeoutMs: 120_000,
				},
			);
		} catch (err) {
			this.o.logger(
				`[fleet-console] recover(${batchId}) failed: ${(err as Error).message}`,
			);
		}
	}

	// ── Active SSE progress clients (Codex R4/R5 MEDIUM: graceful shutdown) ──

	private readonly progressClients = new Set<() => void>();
	private closed = false;

	/** True once close() has run — the route refuses new SSE streams (R5). */
	isClosed(): boolean {
		return this.closed;
	}

	/**
	 * Register an active SSE progress client's teardown (clear its timer + end the
	 * response). Returns an unregister to call when the client disconnects on its
	 * own. close() runs all remaining teardowns so `server.close()` can't hang on
	 * an open SSE response and no timer reopens the audit DB after close.
	 *
	 * After close(), a late reconnect (the server can still be open during async
	 * teardown) is REJECTED — the teardown is run immediately and the client is
	 * not tracked, so no post-close timer reopens the audit DB (Codex R5 MEDIUM).
	 */
	registerProgress(stop: () => void): () => void {
		if (this.closed) {
			try {
				stop();
			} catch {
				// best-effort
			}
			return () => {};
		}
		this.progressClients.add(stop);
		return () => {
			this.progressClients.delete(stop);
		};
	}

	private stopAllProgress(): void {
		for (const stop of this.progressClients) {
			try {
				stop();
			} catch {
				// best-effort teardown
			}
		}
		this.progressClients.clear();
	}

	close(): void {
		// Set closed FIRST so any late registration during async shutdown is
		// rejected (R5) before draining + closing the audit DB.
		this.closed = true;
		this.stopAllProgress();
		this.audit.close();
	}
}

/** Resolve the default console wiring paths for production (HOME-relative). */
export function defaultFleetConsoleOptions(
	overrides: Partial<FleetConsoleOptions> & {
		liveProjects: FleetConsoleOptions["liveProjects"];
		legacyBackendOf: FleetConsoleOptions["legacyBackendOf"];
		fleetScriptPath: string;
	},
): FleetConsoleOptions {
	const home = homedir();
	const flywheelDir = join(home, ".flywheel");
	return {
		projectsJsonPath: join(flywheelDir, "projects.json"),
		txnDir: join(flywheelDir, "fleet-txns"),
		auditDbPath: join(flywheelDir, "audit.db"),
		logDir: join(flywheelDir, "fleet-logs"),
		...overrides,
	};
}
