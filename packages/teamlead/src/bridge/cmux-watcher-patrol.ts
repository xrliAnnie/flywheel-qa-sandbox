/**
 * FLY-1944: judgement + episode control for the resident cmux watcher rider.
 *
 * The classifier is deliberately pure. Host reads (launchctl, owner tuple,
 * heartbeat/event/maintenance files) and the canonical shell recovery are
 * injected by the Bridge composition root, keeping this safety matrix fully
 * testable without touching the resident watcher.
 */

import { spawn } from "node:child_process";
import { lstat, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface CmuxWatcherOwner {
	pid: number;
	incarnation: string;
	nonce: string;
	startedAtMs: number;
	/** Exact bounded owner-file line: pid|incarnation|watch|nonce. */
	tuple: string;
}

export interface CmuxWatcherFileEvidence {
	ageMs: number;
	key: string;
}

export interface CmuxWatcherSnapshot {
	nowMs: number;
	rolloutAnchorMs: number;
	job: { ok: boolean; identity: string };
	ownerState: "valid" | "missing" | "malformed";
	owner?: CmuxWatcherOwner;
	heartbeat: CmuxWatcherFileEvidence | null;
	event: CmuxWatcherFileEvidence | null;
	park: (CmuxWatcherFileEvidence & { path: string }) | null;
	/** Rider-maintained age for the current loaded-without-owner generation. */
	ownerlessAgeMs: number;
	/** Rider-maintained age for the current launchd-job-absent generation. */
	jobAbsentAgeMs: number;
	/** Rider-maintained age for the current stale-event-backlog generation. */
	eventBacklogAgeMs: number;
}

export type CmuxWatcherBranch =
	| "job_absent"
	| "parked"
	| "parked_expired"
	| "owner_starting"
	| "owner_missing"
	| "legacy_no_heartbeat"
	| "heartbeat_missing"
	| "stalled"
	| "event_backlog"
	| "healthy";

export interface CmuxWatcherDecision {
	branch: CmuxWatcherBranch;
	alert: boolean;
	recovery: "kickstart" | "rebuild" | null;
	recover: boolean;
	episodeKey: string | null;
	detail: string;
}

export interface CmuxWatcherThresholds {
	ownerStartupGraceMs: number;
	parkTtlMs: number;
	heartbeatStaleMs: number;
	eventStaleMs: number;
	escalateAfterMs: number;
}

export const DEFAULT_CMUX_WATCHER_THRESHOLDS: CmuxWatcherThresholds = {
	ownerStartupGraceMs: 120_000,
	parkTtlMs: 1_800_000,
	heartbeatStaleMs: 300_000,
	eventStaleMs: 120_000,
	escalateAfterMs: 600_000,
};

function decision(
	branch: CmuxWatcherBranch,
	alert: boolean,
	recovery: CmuxWatcherDecision["recovery"],
	episodeKey: string | null,
	detail: string,
): CmuxWatcherDecision {
	return { branch, alert, recovery, recover: recovery !== null, episodeKey, detail };
}

/**
 * Priority is fail-closed around destructive recovery:
 * job absence, maintenance, or unverifiable ownership can alert, but can
 * never kill. Only a queryable KeepAlive job + exact live owner + stale
 * positive heartbeat evidence reaches `recover=true`; a stale event queue can
 * be caused by downstream cmux unavailability and therefore alerts only.
 */
export function classifyCmuxWatcher(
	snapshot: CmuxWatcherSnapshot,
	thresholds: CmuxWatcherThresholds = DEFAULT_CMUX_WATCHER_THRESHOLDS,
): CmuxWatcherDecision {
	// Planned teardown wins over missing-owner and stale-heartbeat evidence: the
	// watcher intentionally releases its lease while parked. Never delete a park
	// marker or recover through one.
	if (snapshot.park) {
		if (snapshot.park.ageMs > thresholds.parkTtlMs) {
			return decision(
				"parked_expired",
				true,
				null,
				`park:${snapshot.park.key}`,
				`maintenance marker ${snapshot.park.path} is ${snapshot.park.ageMs}ms old`,
			);
		}
		return decision(
			"parked",
			false,
			null,
			null,
			`maintenance marker is active: ${snapshot.park.path}`,
		);
	}

	if (!snapshot.job.ok) {
		const generationStarted = snapshot.nowMs - snapshot.jobAbsentAgeMs;
		return decision(
			"job_absent",
			true,
			"rebuild",
			`job:${snapshot.job.identity}:${generationStarted}`,
			`launchd job is not queryable: ${snapshot.job.identity}`,
		);
	}

	if (snapshot.ownerState !== "valid" || !snapshot.owner) {
		const starting = snapshot.ownerlessAgeMs <= thresholds.ownerStartupGraceMs;
		if (starting) {
			return decision(
				"owner_starting",
				false,
				null,
				null,
				`launchd job has no verified owner inside ${thresholds.ownerStartupGraceMs}ms startup grace`,
			);
		}
		const generationStarted = snapshot.nowMs - snapshot.ownerlessAgeMs;
		return decision(
			"owner_missing",
			true,
			null,
			`ownerless:${snapshot.job.identity}:${generationStarted}`,
			`launchd job has no verified owner for ${snapshot.ownerlessAgeMs}ms (state=${snapshot.ownerState})`,
		);
	}

	if (!snapshot.heartbeat) {
		if (snapshot.owner.startedAtMs < snapshot.rolloutAnchorMs) {
			return decision(
				"legacy_no_heartbeat",
				false,
				null,
				null,
				"pre-rollout watcher has no heartbeat; leaving it untouched",
			);
		}
		return decision(
			"heartbeat_missing",
			true,
			null,
			`heartbeat-missing:${snapshot.owner.tuple}`,
			"post-rollout watcher owns the lease but has no safe heartbeat; refusing blind recovery",
		);
	}

	const heartbeatStale = snapshot.heartbeat.ageMs > thresholds.heartbeatStaleMs;
	if (heartbeatStale) {
		return decision(
			"stalled",
			true,
			"kickstart",
			`stalled:${snapshot.owner.incarnation}`,
			[
				`owner_pid=${snapshot.owner.pid}`,
				`owner_incarnation=${snapshot.owner.incarnation}`,
				`heartbeat_age_ms=${snapshot.heartbeat.ageMs}`,
				snapshot.event
					? `event_age_ms=${snapshot.event.ageMs}`
					: "event_pending=false",
			].join(" "),
		);
	}

	const eventStale =
		snapshot.event !== null && snapshot.event.ageMs > thresholds.eventStaleMs;
	if (eventStale) {
		const generationStarted = snapshot.nowMs - snapshot.eventBacklogAgeMs;
		return decision(
			"event_backlog",
			true,
			null,
			`event-backlog:${snapshot.job.identity}:${generationStarted}`,
			[
				`owner_pid=${snapshot.owner.pid}`,
				`owner_incarnation=${snapshot.owner.incarnation}`,
				`heartbeat_age_ms=${snapshot.heartbeat.ageMs}`,
				`event_age_ms=${snapshot.event?.ageMs}`,
			].join(" "),
		);
	}

	return decision(
		"healthy",
		false,
		null,
		null,
		`heartbeat_age_ms=${snapshot.heartbeat.ageMs}`,
	);
}

const OWNER_NONCE = /^[A-Za-z0-9_.-]+$/;

/** Parse only the exact bounded lease shape the shell mutator publishes. */
export function parseCmuxWatcherOwner(
	text: string,
	observedIncarnation: string,
): CmuxWatcherOwner | null {
	if (Buffer.byteLength(text, "utf8") > 4_096) return null;
	const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
	if (!normalized || normalized.includes("\n") || normalized.includes("\r")) {
		return null;
	}
	const fields = normalized.split("|");
	if (fields.length !== 4) return null;
	const pidText = fields[0]!;
	const incarnation = fields[1]!;
	const mode = fields[2]!;
	const nonce = fields[3]!;
	if (!/^\d+$/.test(pidText) || mode !== "watch" || !OWNER_NONCE.test(nonce)) {
		return null;
	}
	const pid = Number(pidText);
	if (!Number.isSafeInteger(pid) || pid < 1) return null;
	if (!incarnation || incarnation !== observedIncarnation.trim()) return null;
	const startedAtMs = Date.parse(`${incarnation} UTC`);
	if (!Number.isFinite(startedAtMs)) return null;
	return { pid, incarnation, nonce, startedAtMs, tuple: normalized };
}

interface HostExecResult {
	stdout: string;
}

export interface HostCmuxWatcherPatrolOptions {
	homeDir: string;
	projectRoot: string;
	uid?: number;
	env?: NodeJS.ProcessEnv;
	execFile?: (
		file: string,
		args: readonly string[],
		options: {
			timeout: number;
			maxBuffer: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<HostExecResult>;
	now?: () => number;
	recover?: CmuxWatcherPatrolDeps["recover"];
	alert: CmuxWatcherPatrolDeps["alert"];
	escalate?: CmuxWatcherPatrolDeps["escalate"];
	rebuildDisabled?: () => boolean;
	thresholds?: CmuxWatcherThresholds;
}

async function safeFileEvidence(
	path: string,
	nowMs: number,
	options: { requireNonEmpty?: boolean; allowSymlink?: boolean } = {},
): Promise<CmuxWatcherFileEvidence | null> {
	try {
		const info = await lstat(path);
		if (!options.allowSymlink && (info.isSymbolicLink() || !info.isFile())) {
			return null;
		}
		if (options.requireNonEmpty && (!info.isFile() || info.size < 1))
			return null;
		return {
			ageMs: Math.max(0, nowMs - info.mtimeMs),
			key: `${info.dev}:${info.ino}:${Math.trunc(info.mtimeMs)}`,
		};
	} catch {
		return null;
	}
}

async function readHostOwner(
	ownerPath: string,
	exec: NonNullable<HostCmuxWatcherPatrolOptions["execFile"]>,
	env: NodeJS.ProcessEnv,
): Promise<
	| { state: "valid"; owner: CmuxWatcherOwner }
	| { state: "missing" | "malformed" }
> {
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(ownerPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { state: "missing" };
		}
		return { state: "malformed" };
	}
	if (
		info.isSymbolicLink() ||
		!info.isFile() ||
		info.size < 1 ||
		info.size > 4_096
	) {
		return { state: "malformed" };
	}
	let text: string;
	try {
		text = await readFile(ownerPath, "utf8");
	} catch {
		return { state: "malformed" };
	}
	const pidText = text.split("|", 1)[0] ?? "";
	if (!/^\d+$/.test(pidText)) return { state: "malformed" };
	try {
		const result = await exec("ps", ["-o", "lstart=", "-p", pidText], {
			timeout: 5_000,
			maxBuffer: 4_096,
			env: { ...env, TZ: "UTC", LC_ALL: "C" },
		});
		const owner = parseCmuxWatcherOwner(text, result.stdout.trim());
		if (!owner) return { state: "malformed" };
		process.kill(owner.pid, 0);
		return { state: "valid", owner };
	} catch {
		return { state: "malformed" };
	}
}

function secondsEnv(
	env: NodeJS.ProcessEnv,
	name: string,
	fallback: number,
	max: number,
): number {
	const text = env[name]?.trim();
	if (!text || !/^\d{1,6}$/.test(text)) return fallback;
	const value = Number(text);
	return value >= 1 && value <= max ? value : fallback;
}

export function cmuxWatcherThresholdsFromEnv(
	env: NodeJS.ProcessEnv,
): CmuxWatcherThresholds {
	return {
		ownerStartupGraceMs:
			secondsEnv(
				env,
				"FLYWHEEL_CMUX_WATCHER_STARTUP_GRACE_SECONDS",
				120,
				3_600,
			) * 1_000,
		parkTtlMs:
			secondsEnv(env, "FLYWHEEL_CMUX_WATCHER_PARK_TTL_SECONDS", 1_800, 86_400) *
			1_000,
		heartbeatStaleMs:
			secondsEnv(
				env,
				"FLYWHEEL_CMUX_WATCHER_HEARTBEAT_STALE_SECONDS",
				300,
				3_600,
			) * 1_000,
		eventStaleMs:
			secondsEnv(env, "FLYWHEEL_CMUX_WATCHER_EVENT_STALE_SECONDS", 120, 3_600) *
			1_000,
		escalateAfterMs:
			secondsEnv(env, "FLYWHEEL_CMUX_WATCHER_ESCALATE_SECONDS", 600, 86_400) *
			1_000,
	};
}

/** Read-only host sensor used by the GatePoller rider. Any ambiguous owner or
 * unsafe file shape degrades to a non-destructive branch in the classifier. */
export async function readHostCmuxWatcherSnapshot(
	options: HostCmuxWatcherPatrolOptions,
): Promise<CmuxWatcherSnapshot> {
	const nowMs = (options.now ?? Date.now)();
	const env = options.env ?? process.env;
	const uid = options.uid ?? process.getuid?.() ?? 0;
	const label = "com.flywheel.cmux-watcher";
	const jobIdentity = `gui/${uid}/${label}`;
	if (!options.execFile) {
		throw new Error("cmux watcher patrol execFile dependency is required");
	}
	let jobOk = false;
	try {
		await options.execFile("launchctl", ["print", jobIdentity], {
			timeout: 5_000,
			maxBuffer: 64 * 1_024,
			env,
		});
		jobOk = true;
	} catch {}

	const ownerPath =
		env.FLYWHEEL_CMUX_WATCHER_LOCK_DIR?.trim() ||
		"/tmp/flywheel-cmux-watcher.lock";
	const ownerRead = await readHostOwner(
		join(ownerPath, "owner"),
		options.execFile,
		env,
	);
	const stateDir = join(options.homeDir, ".flywheel", "state");
	const maintenancePath =
		env.FLYWHEEL_CMUX_MAINTENANCE_MARKER?.trim() ||
		join(stateDir, "cmux-maintenance");
	const parkPaths = [
		maintenancePath,
		`${maintenancePath}.qa-teardown`,
		`${maintenancePath}.ops-rebuild`,
	];
	const parks = await Promise.all(
		parkPaths.map(async (path) => {
			const evidence = await safeFileEvidence(path, nowMs, {
				allowSymlink: true,
			});
			return evidence ? { ...evidence, path } : null;
		}),
	);
	const park =
		parks
			.filter((row): row is NonNullable<typeof row> => row !== null)
			.sort((a, b) => b.ageMs - a.ageMs)[0] ?? null;
	const heartbeatPath =
		env.FLYWHEEL_CMUX_WATCHER_HEARTBEAT?.trim() ||
		join(stateDir, "cmux-watcher-heartbeat");
	const eventPath = env.EVENT_FILE?.trim() || "/tmp/flywheel-cmux-events";
	const [heartbeatEvidence, eventPending, eventProcessing, rolloutInfo] =
		await Promise.all([
			safeFileEvidence(heartbeatPath, nowMs),
			safeFileEvidence(eventPath, nowMs, { requireNonEmpty: true }),
			safeFileEvidence(`${eventPath}.processing`, nowMs, {
				requireNonEmpty: true,
			}),
			stat(join(options.projectRoot, "scripts", "flywheel-cmux-sync.sh")),
		]);
	const event =
		[eventPending, eventProcessing]
			.filter((item): item is CmuxWatcherFileEvidence => item !== null)
			.sort((a, b) => b.ageMs - a.ageMs)[0] ?? null;
	let heartbeat = heartbeatEvidence;
	if (heartbeat && ownerRead.state === "valid") {
		try {
			const content = await readFile(heartbeatPath, "utf8");
			const heartbeatPid = content.split("|", 1)[0];
			if (heartbeatPid !== String(ownerRead.owner.pid)) heartbeat = null;
		} catch {
			heartbeat = null;
		}
	}

	return {
		nowMs,
		rolloutAnchorMs: rolloutInfo.mtimeMs,
		job: { ok: jobOk, identity: jobIdentity },
		ownerState: ownerRead.state,
		...(ownerRead.state === "valid" ? { owner: ownerRead.owner } : {}),
		heartbeat,
		event,
		park,
		ownerlessAgeMs: 0,
		jobAbsentAgeMs: 0,
		eventBacklogAgeMs: 0,
	};
}

/** Invoke the repo-pinned canonical recovery operation with a larger outer
 * timeout. `detached` creates a process group so timeout cleanup reaps the
 * shell operation and all descendants, never just the direct bash child. */
export function runHostCmuxWatcherRecovery(
	projectRoot: string,
	recovery: NonNullable<CmuxWatcherDecision["recovery"]>,
	owner: CmuxWatcherOwner | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<CmuxWatcherRecoveryResult> {
	return new Promise((resolve) => {
		const script = join(
			projectRoot,
			"scripts",
			"lib",
			"restart-cmux-watcher.sh",
		);
		const args = [script, recovery === "rebuild" ? "--rebuild" : "--recover"];
		if (recovery === "kickstart" && owner) {
			args.push("--expected-owner", owner.tuple);
		}
		const child = spawn(
			"/bin/bash",
			args,
			{
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...env, FLYWHEEL_DIR: projectRoot },
			},
		);
		let output = "";
		let timedOut = false;
		const append = (chunk: Buffer) => {
			if (output.length < 16_384) output += chunk.toString("utf8");
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		const killGroup = (signal: NodeJS.Signals) => {
			if (!child.pid) return;
			try {
				process.kill(-child.pid, signal);
			} catch {}
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			killGroup("SIGTERM");
			setTimeout(() => killGroup("SIGKILL"), 2_000).unref();
		}, 150_000);
		timeout.unref();
		child.once("error", (error) => {
			clearTimeout(timeout);
			resolve({ ok: false, detail: `spawn failed: ${error.message}` });
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			const detail =
				output.trim().slice(-4_096) || `code=${code} signal=${signal}`;
			resolve({
				ok: !timedOut && code === 0 && /state=healthy\b/.test(output),
				detail: timedOut ? `outer timeout after 150000ms; ${detail}` : detail,
			});
		});
	});
}

export function createHostCmuxWatcherPatrol(
	options: HostCmuxWatcherPatrolOptions,
): CmuxWatcherPatrol {
	const env = options.env ?? process.env;
	return new CmuxWatcherPatrol({
		readSnapshot: () => readHostCmuxWatcherSnapshot(options),
		recover:
			options.recover ??
			((recovery, owner) =>
				runHostCmuxWatcherRecovery(options.projectRoot, recovery, owner, env)),
		alert: options.alert,
		escalate: options.escalate,
		rebuildDisabled: options.rebuildDisabled,
		thresholds: options.thresholds ?? cmuxWatcherThresholdsFromEnv(env),
	});
}

export interface CmuxWatcherRecoveryResult {
	ok: boolean;
	detail: string;
}

export interface CmuxWatcherPatrolDeps {
	readSnapshot: () => Promise<CmuxWatcherSnapshot>;
	recover: (
		recovery: NonNullable<CmuxWatcherDecision["recovery"]>,
		owner: CmuxWatcherOwner | undefined,
	) => Promise<CmuxWatcherRecoveryResult>;
	alert: (
		decision: CmuxWatcherDecision,
		recovery: CmuxWatcherRecoveryResult | null,
	) => Promise<void>;
	escalate?: (
		decision: CmuxWatcherDecision,
		recovery: CmuxWatcherRecoveryResult | null,
		generationKey: string,
	) => Promise<void>;
	rebuildDisabled?: () => boolean;
	thresholds?: CmuxWatcherThresholds;
}

/** Single-flight, per-episode orchestrator. Durable alert dedupe remains in the
 * existing LeadAlertNotifier; these latches prevent repeat recovery attempts
 * and noisy enqueue calls on the 60s rider cadence. */
export class CmuxWatcherPatrol {
	private inFlight: Promise<void> | null = null;
	private readonly recoveryEpisodes = new Map<CmuxWatcherBranch, string>();
	private readonly emittedEpisodes = new Map<CmuxWatcherBranch, string>();
	private ownerlessGeneration: {
		jobIdentity: string;
		firstSeenMs: number;
	} | null = null;
	private jobAbsentGeneration: {
		jobIdentity: string;
		firstSeenMs: number;
	} | null = null;
	private eventBacklogGeneration: {
		jobIdentity: string;
		firstSeenMs: number;
	} | null = null;
	private unhealthyGeneration: {
		key: string;
		firstSeenMs: number;
		ticketed: boolean;
		escalated: boolean;
		lastRecovery: CmuxWatcherRecoveryResult | null;
	} | null = null;

	constructor(private readonly deps: CmuxWatcherPatrolDeps) {}

	private rearmResolvedEpisodes(snapshot: CmuxWatcherSnapshot): void {
		if (snapshot.job.ok) this.emittedEpisodes.delete("job_absent");
		if (snapshot.job.ok) this.recoveryEpisodes.delete("job_absent");
		if (!snapshot.job.ok || snapshot.ownerState === "valid") {
			this.emittedEpisodes.delete("owner_missing");
		}
		const parkedKey = snapshot.park ? `park:${snapshot.park.key}` : null;
		if (this.emittedEpisodes.get("parked_expired") !== parkedKey) {
			this.emittedEpisodes.delete("parked_expired");
		}
		const heartbeatMissingKey = snapshot.owner
			? `heartbeat-missing:${snapshot.owner.tuple}`
			: null;
		if (
			snapshot.heartbeat ||
			this.emittedEpisodes.get("heartbeat_missing") !== heartbeatMissingKey
		) {
			this.emittedEpisodes.delete("heartbeat_missing");
		}

		const thresholds = this.deps.thresholds ?? DEFAULT_CMUX_WATCHER_THRESHOLDS;
		const stalledKey = snapshot.owner
			? `stalled:${snapshot.owner.incarnation}`
			: null;
		const freshEvidence =
			snapshot.job.ok &&
			!snapshot.park &&
			snapshot.ownerState === "valid" &&
			snapshot.heartbeat !== null &&
			snapshot.heartbeat.ageMs <= thresholds.heartbeatStaleMs;
		if (freshEvidence || this.emittedEpisodes.get("stalled") !== stalledKey) {
			this.emittedEpisodes.delete("stalled");
			this.recoveryEpisodes.delete("stalled");
		}

		const eventBacklogGenerationStarted =
			snapshot.nowMs - snapshot.eventBacklogAgeMs;
		const eventBacklogKey = `event-backlog:${snapshot.job.identity}:${eventBacklogGenerationStarted}`;
		const eventFresh =
			snapshot.event === null ||
			snapshot.event.ageMs <= thresholds.eventStaleMs;
		if (
			eventFresh ||
			this.emittedEpisodes.get("event_backlog") !== eventBacklogKey
		) {
			this.emittedEpisodes.delete("event_backlog");
		}
	}

	tick(): Promise<void> {
		if (this.inFlight) return this.inFlight;
		const pass = this.runPass().finally(() => {
			if (this.inFlight === pass) this.inFlight = null;
		});
		this.inFlight = pass;
		return pass;
	}

	private async runPass(): Promise<void> {
		let snapshot = await this.deps.readSnapshot();
		if (!snapshot.job.ok) {
			if (
				!this.jobAbsentGeneration ||
				this.jobAbsentGeneration.jobIdentity !== snapshot.job.identity
			) {
				this.jobAbsentGeneration = {
					jobIdentity: snapshot.job.identity,
					firstSeenMs: snapshot.nowMs,
				};
			}
			snapshot = {
				...snapshot,
				jobAbsentAgeMs: snapshot.nowMs - this.jobAbsentGeneration.firstSeenMs,
			};
		} else {
			this.jobAbsentGeneration = null;
		}
		if (
			snapshot.job.ok &&
			!snapshot.park &&
			(snapshot.ownerState !== "valid" || !snapshot.owner)
		) {
			if (
				!this.ownerlessGeneration ||
				this.ownerlessGeneration.jobIdentity !== snapshot.job.identity
			) {
				this.ownerlessGeneration = {
					jobIdentity: snapshot.job.identity,
					firstSeenMs: snapshot.nowMs,
				};
			}
			snapshot = {
				...snapshot,
				ownerlessAgeMs: snapshot.nowMs - this.ownerlessGeneration.firstSeenMs,
			};
		} else {
			this.ownerlessGeneration = null;
		}

		const thresholds = this.deps.thresholds ?? DEFAULT_CMUX_WATCHER_THRESHOLDS;
		const eventBacklogged =
			snapshot.job.ok &&
			!snapshot.park &&
			snapshot.ownerState === "valid" &&
			snapshot.owner !== undefined &&
			snapshot.heartbeat !== null &&
			snapshot.heartbeat.ageMs <= thresholds.heartbeatStaleMs &&
			snapshot.event !== null &&
			snapshot.event.ageMs > thresholds.eventStaleMs;
		if (eventBacklogged) {
			if (
				!this.eventBacklogGeneration ||
				this.eventBacklogGeneration.jobIdentity !== snapshot.job.identity
			) {
				this.eventBacklogGeneration = {
					jobIdentity: snapshot.job.identity,
					firstSeenMs: snapshot.nowMs,
				};
			}
			snapshot = {
				...snapshot,
				eventBacklogAgeMs:
					snapshot.nowMs - this.eventBacklogGeneration.firstSeenMs,
			};
		} else {
			this.eventBacklogGeneration = null;
		}

		this.rearmResolvedEpisodes(snapshot);
		const verdict = classifyCmuxWatcher(snapshot, this.deps.thresholds);
		if (verdict.branch === "healthy" || verdict.branch.startsWith("parked")) {
			this.unhealthyGeneration = null;
		} else if (
			!this.unhealthyGeneration &&
			["job_absent", "stalled", "owner_missing", "heartbeat_missing"].includes(
				verdict.branch,
			)
		) {
			this.unhealthyGeneration = {
				key: `unhealthy:${snapshot.job.identity}:${snapshot.nowMs}:${verdict.episodeKey ?? verdict.branch}`,
				firstSeenMs: snapshot.nowMs,
				ticketed: false,
				escalated: false,
				lastRecovery: null,
			};
		}

		let recovery: CmuxWatcherRecoveryResult | null = null;
		if (
			verdict.recovery &&
			verdict.episodeKey &&
			!(verdict.recovery === "rebuild" && this.deps.rebuildDisabled?.()) &&
			this.recoveryEpisodes.get(verdict.branch) !== verdict.episodeKey
		) {
			recovery = await this.deps.recover(
				verdict.recovery,
				verdict.recovery === "kickstart" ? snapshot.owner : undefined,
			);
			if (this.unhealthyGeneration) {
				this.unhealthyGeneration.lastRecovery = recovery;
			}
			if (recovery.ok) {
				this.recoveryEpisodes.set(verdict.branch, verdict.episodeKey);
			}
		}
		if (
			verdict.alert &&
			verdict.episodeKey &&
			this.emittedEpisodes.get(verdict.branch) !== verdict.episodeKey
		) {
			await this.deps.alert(verdict, recovery);
			this.emittedEpisodes.set(verdict.branch, verdict.episodeKey);
			if (this.unhealthyGeneration) this.unhealthyGeneration.ticketed = true;
		}

		const generation = this.unhealthyGeneration;
		if (
			generation?.ticketed &&
			!generation.escalated &&
			this.deps.escalate &&
			snapshot.nowMs - generation.firstSeenMs >= thresholds.escalateAfterMs
		) {
			await this.deps.escalate(
				verdict,
				generation.lastRecovery,
				generation.key,
			);
			generation.escalated = true;
		}
	}
}
