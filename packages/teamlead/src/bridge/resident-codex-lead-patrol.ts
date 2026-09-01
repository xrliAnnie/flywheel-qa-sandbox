import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { ResidentCodexLeadTarget } from "../resident-codex-lead-roster.js";

export type ResidentCodexLeadFailureClass =
	| "auth"
	| "rate_limit"
	| "server"
	| "network"
	| "unknown";

export interface ResidentCodexLeadExactIdentity {
	state: "exact";
	pid: number;
	lstart: string;
	startedAtMs: number;
	argv: string[];
	codexHome: string;
	label: string;
	wrapper: string;
}

export type ResidentCodexLeadIdentity =
	| ResidentCodexLeadExactIdentity
	| { state: "uncertain"; reason: string };

export interface ResidentCodexLeadHeartbeatValue {
	v: 1;
	generationId: string;
	threadId: string;
	processPid: number;
	carrierInstanceId: string;
	state: "online" | "running" | "generation_lost" | "shutdown";
	lastGatewayPollAttemptAt?: string;
	lastGatewayPollResultAt?: string;
	lastGatewayPollStatus?: "ok" | "failed";
	lastGatewayPollFailureClass?: ResidentCodexLeadFailureClass;
	lastGatewayPollStatusCode?: number;
	activeTurn: { turnId: string; startedAt: string } | null;
	updatedAt: string;
}

export type ResidentCodexLeadHeartbeatEvidence =
	| { state: "valid"; value: ResidentCodexLeadHeartbeatValue }
	| { state: "missing" | "malformed" };

export interface ResidentCodexLeadObservedGeneration {
	pid: number;
	lstart: string;
	generationId: string;
	carrierInstanceId: string;
	observedAt: string;
}

export interface ResidentCodexLeadControlledWave {
	pid: number;
	lstart: string;
	phase: "bootout" | "bootstrap";
}

export interface ResidentCodexLeadSnapshot {
	nowMs: number;
	identity: ResidentCodexLeadIdentity;
	heartbeat: ResidentCodexLeadHeartbeatEvidence;
	observed: ResidentCodexLeadObservedGeneration | null;
	controlledWave: ResidentCodexLeadControlledWave | null;
}

export type ResidentCodexLeadBranch =
	| "uncertain_identity"
	| "starting"
	| "observer_missing"
	| "suppressed_controlled_wave"
	| "upstream_unavailable"
	| "turn_stalled"
	| "poll_loop_stalled"
	| "heartbeat_stalled"
	| "healthy";

export interface ResidentCodexLeadDecision {
	branch: ResidentCodexLeadBranch;
	alert: boolean;
	candidate: boolean;
	recover: boolean;
	detail: string;
}

export interface ResidentCodexLeadThresholds {
	startupGraceMs: number;
	pollAttemptStaleMs: number;
	turnStaleMs: number;
	heartbeatStaleMs: number;
	consecutiveFailures: number;
}

export const DEFAULT_RESIDENT_CODEX_LEAD_THRESHOLDS: ResidentCodexLeadThresholds =
	{
		startupGraceMs: 120_000,
		pollAttemptStaleMs: 120_000,
		turnStaleMs: 1_800_000,
		heartbeatStaleMs: 180_000,
		consecutiveFailures: 3,
	};

const MAX_EVIDENCE_BYTES = 65_536;
const EXACT_RUNTIME_SUFFIX =
	"/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js";

function boundedString(value: unknown, max = 256): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function positiveInteger(value: unknown): value is number {
	return Number.isInteger(value) && Number(value) > 0;
}

/** Parse the fixed helper's output without granting authority to nearby jobs. */
export function parseResidentCodexLeadProbe(
	raw: string,
	target: ResidentCodexLeadTarget,
	homeDir: string,
): ResidentCodexLeadIdentity {
	if (raw.length > MAX_EVIDENCE_BYTES) {
		return { state: "uncertain", reason: "probe output exceeds size limit" };
	}
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		const argv = value.argv;
		const expectedLabel = `com.flywheel.lead.${target.leadKey}`;
		const codexHomeRelative =
			typeof value.codexHome === "string"
				? relative(homeDir, value.codexHome)
				: "..";
		if (
			value.state !== "exact" ||
			!positiveInteger(value.pid) ||
			!boundedString(value.lstart, 128) ||
			typeof value.startedAtMs !== "number" ||
			!Number.isFinite(value.startedAtMs) ||
			value.startedAtMs <= 0 ||
			!Array.isArray(argv) ||
			argv.length < 2 ||
			argv.length > 32 ||
			!argv.every((arg) => boundedString(arg, 4_096)) ||
			!argv.some((arg) => arg.endsWith(EXACT_RUNTIME_SUFFIX)) ||
			!boundedString(value.codexHome, 4_096) ||
			!isAbsolute(value.codexHome) ||
			!codexHomeRelative ||
			codexHomeRelative.startsWith("..") ||
			isAbsolute(codexHomeRelative) ||
			value.label !== expectedLabel ||
			!boundedString(value.wrapper, 256) ||
			!/^flywheel-codex-lead-wrapper-[A-Za-z0-9._-]+\.sh$/.test(value.wrapper)
		) {
			return { state: "uncertain", reason: "probe identity contract mismatch" };
		}
		return {
			state: "exact",
			pid: value.pid,
			lstart: value.lstart,
			startedAtMs: value.startedAtMs,
			argv: argv as string[],
			codexHome: value.codexHome,
			label: expectedLabel,
			wrapper: value.wrapper,
		};
	} catch {
		return { state: "uncertain", reason: "probe output is malformed" };
	}
}

function isHeartbeat(value: unknown): value is ResidentCodexLeadHeartbeatValue {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	const activeTurn = item.activeTurn;
	const validActiveTurn =
		activeTurn === null ||
		(activeTurn !== null &&
			typeof activeTurn === "object" &&
			boundedString((activeTurn as Record<string, unknown>).turnId) &&
			boundedString((activeTurn as Record<string, unknown>).startedAt, 64));
	return (
		item.v === 1 &&
		boundedString(item.generationId) &&
		boundedString(item.threadId) &&
		positiveInteger(item.processPid) &&
		boundedString(item.carrierInstanceId) &&
		["online", "running", "generation_lost", "shutdown"].includes(
			String(item.state),
		) &&
		validActiveTurn &&
		boundedString(item.updatedAt, 64) &&
		(item.lastGatewayPollStatus === undefined ||
			["ok", "failed"].includes(String(item.lastGatewayPollStatus))) &&
		(item.lastGatewayPollFailureClass === undefined ||
			["auth", "rate_limit", "server", "network", "unknown"].includes(
				String(item.lastGatewayPollFailureClass),
			))
	);
}

async function safeDirectoryChain(
	root: string,
	target: string,
	create: boolean,
): Promise<boolean> {
	const suffix = relative(root, target);
	if (!suffix || suffix.startsWith("..") || isAbsolute(suffix)) return false;
	let current = root;
	try {
		const rootStat = await lstat(root);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
		for (const segment of suffix.split("/")) {
			current = join(current, segment);
			if (create) {
				try {
					await mkdir(current, { mode: 0o700 });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
			}
			const metadata = await lstat(current);
			if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
		}
		return true;
	} catch {
		return false;
	}
}

async function readSafeJson(
	path: string,
	root: string,
): Promise<unknown | undefined> {
	try {
		if (!(await safeDirectoryChain(root, dirname(path), false)))
			return undefined;
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink() || !metadata.isFile()) return undefined;
		if (metadata.size > MAX_EVIDENCE_BYTES) return undefined;
		const raw = await readFile(path, "utf8");
		if (raw.length > MAX_EVIDENCE_BYTES) return undefined;
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

function parseObserved(
	value: unknown,
): ResidentCodexLeadObservedGeneration | null {
	if (!value || typeof value !== "object") return null;
	const item = value as Record<string, unknown>;
	if (
		!positiveInteger(item.pid) ||
		!boundedString(item.lstart, 128) ||
		!boundedString(item.generationId) ||
		!boundedString(item.carrierInstanceId) ||
		!boundedString(item.observedAt, 64)
	)
		return null;
	return item as unknown as ResidentCodexLeadObservedGeneration;
}

function parseControlledWave(
	value: unknown,
	expectedLabel: string,
): ResidentCodexLeadControlledWave | null {
	if (!value || typeof value !== "object") return null;
	const item = value as Record<string, unknown>;
	const tuple = item.old_supervisor_tuple;
	if (
		item.expected_label !== expectedLabel ||
		(item.phase !== "bootout" && item.phase !== "bootstrap") ||
		!tuple ||
		typeof tuple !== "object" ||
		!positiveInteger((tuple as Record<string, unknown>).pid) ||
		!boundedString((tuple as Record<string, unknown>).start, 128)
	)
		return null;
	return {
		pid: (tuple as Record<string, unknown>).pid as number,
		lstart: (tuple as Record<string, unknown>).start as string,
		phase: item.phase,
	};
}

async function writeObserved(
	homeDir: string,
	brainDir: string,
	observed: ResidentCodexLeadObservedGeneration,
): Promise<void> {
	if (!(await safeDirectoryChain(homeDir, brainDir, true))) {
		throw new Error("resident Codex Lead state directory is unsafe");
	}
	const path = join(brainDir, "patrol-observed-generation.json");
	try {
		const existing = await lstat(path);
		if (existing.isSymbolicLink() || !existing.isFile()) {
			throw new Error("resident Codex Lead observed marker is unsafe");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, `${JSON.stringify(observed)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		await rename(temp, path);
	} finally {
		await rm(temp, { force: true });
	}
}

function thresholdFromEnv(
	env: NodeJS.ProcessEnv,
	name: string,
	fallback: number,
	min: number,
	max: number,
): number {
	const raw = env[name];
	if (!raw || !/^\d+$/.test(raw)) return fallback;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= min && value <= max
		? value
		: fallback;
}

export function residentCodexLeadThresholdsFromEnv(
	env: NodeJS.ProcessEnv,
): ResidentCodexLeadThresholds {
	return {
		startupGraceMs: thresholdFromEnv(
			env,
			"FLYWHEEL_CODEX_LEAD_RESIDENCY_STARTUP_GRACE_MS",
			DEFAULT_RESIDENT_CODEX_LEAD_THRESHOLDS.startupGraceMs,
			10_000,
			900_000,
		),
		pollAttemptStaleMs: thresholdFromEnv(
			env,
			"FLYWHEEL_CODEX_LEAD_RESIDENCY_POLL_STALE_MS",
			DEFAULT_RESIDENT_CODEX_LEAD_THRESHOLDS.pollAttemptStaleMs,
			30_000,
			900_000,
		),
		turnStaleMs: thresholdFromEnv(
			env,
			"FLYWHEEL_CODEX_LEAD_RESIDENCY_TURN_STALE_MS",
			DEFAULT_RESIDENT_CODEX_LEAD_THRESHOLDS.turnStaleMs,
			60_000,
			86_400_000,
		),
		heartbeatStaleMs: thresholdFromEnv(
			env,
			"FLYWHEEL_CODEX_LEAD_RESIDENCY_HEARTBEAT_STALE_MS",
			DEFAULT_RESIDENT_CODEX_LEAD_THRESHOLDS.heartbeatStaleMs,
			30_000,
			900_000,
		),
		consecutiveFailures: thresholdFromEnv(
			env,
			"FLYWHEEL_CODEX_LEAD_RESIDENCY_CONSECUTIVE_FAILURES",
			DEFAULT_RESIDENT_CODEX_LEAD_THRESHOLDS.consecutiveFailures,
			2,
			10,
		),
	};
}

function decision(
	branch: ResidentCodexLeadBranch,
	alert: boolean,
	candidate: boolean,
	detail: string,
): ResidentCodexLeadDecision {
	return { branch, alert, candidate, recover: false, detail };
}

function parseTime(value: string | undefined): number | null {
	if (!value || value.length > 64) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function observedMatches(
	identity: ResidentCodexLeadExactIdentity,
	observed: ResidentCodexLeadObservedGeneration | null,
): observed is ResidentCodexLeadObservedGeneration {
	return (
		observed !== null &&
		observed.pid === identity.pid &&
		observed.lstart === identity.lstart
	);
}

function heartbeatBelongsToExactProcess(
	identity: ResidentCodexLeadExactIdentity,
	heartbeat: ResidentCodexLeadHeartbeatValue,
): boolean {
	const updatedAt = parseTime(heartbeat.updatedAt);
	return (
		heartbeat.processPid === identity.pid &&
		updatedAt !== null &&
		updatedAt >= identity.startedAtMs
	);
}

function controlledWaveMatches(
	identity: ResidentCodexLeadExactIdentity,
	wave: ResidentCodexLeadControlledWave | null,
): boolean {
	return (
		wave !== null &&
		wave.pid === identity.pid &&
		wave.lstart === identity.lstart
	);
}

function recoveryCandidate(
	branch: "turn_stalled" | "poll_loop_stalled" | "heartbeat_stalled",
	detail: string,
): ResidentCodexLeadDecision {
	return decision(branch, true, true, detail);
}

export function classifyResidentCodexLead(
	snapshot: ResidentCodexLeadSnapshot,
	thresholds: ResidentCodexLeadThresholds = DEFAULT_RESIDENT_CODEX_LEAD_THRESHOLDS,
): ResidentCodexLeadDecision {
	if (snapshot.identity.state !== "exact") {
		return decision(
			"uncertain_identity",
			true,
			false,
			snapshot.identity.reason.slice(0, 512),
		);
	}
	const identity = snapshot.identity;
	if (controlledWaveMatches(identity, snapshot.controlledWave)) {
		return decision(
			"suppressed_controlled_wave",
			false,
			false,
			`exact controlled wave phase=${snapshot.controlledWave?.phase}`,
		);
	}
	const processAgeMs = Math.max(0, snapshot.nowMs - identity.startedAtMs);
	if (snapshot.heartbeat.state !== "valid") {
		if (processAgeMs <= thresholds.startupGraceMs) {
			return decision(
				"starting",
				false,
				false,
				`heartbeat ${snapshot.heartbeat.state} inside startup grace`,
			);
		}
		if (!observedMatches(identity, snapshot.observed)) {
			return decision(
				"observer_missing",
				true,
				false,
				`current pid+lstart never produced a valid heartbeat (${snapshot.heartbeat.state})`,
			);
		}
		return recoveryCandidate(
			"heartbeat_stalled",
			`previously observed generation heartbeat is ${snapshot.heartbeat.state}`,
		);
	}

	const heartbeat = snapshot.heartbeat.value;
	if (
		heartbeat.v !== 1 ||
		!heartbeatBelongsToExactProcess(identity, heartbeat) ||
		!heartbeat.generationId ||
		!heartbeat.carrierInstanceId ||
		heartbeat.generationId.length > 256 ||
		heartbeat.carrierInstanceId.length > 256
	) {
		return decision(
			"uncertain_identity",
			true,
			false,
			"heartbeat identity does not match the exact launchd process",
		);
	}

	const updatedAt = parseTime(heartbeat.updatedAt);
	if (updatedAt === null) {
		return decision(
			"uncertain_identity",
			true,
			false,
			"heartbeat updatedAt is invalid",
		);
	}
	if (snapshot.nowMs - updatedAt > thresholds.heartbeatStaleMs) {
		return recoveryCandidate(
			"heartbeat_stalled",
			`heartbeat_age_ms=${snapshot.nowMs - updatedAt}`,
		);
	}

	if (heartbeat.activeTurn) {
		const startedAt = parseTime(heartbeat.activeTurn.startedAt);
		if (startedAt === null) {
			return decision(
				"uncertain_identity",
				true,
				false,
				"active turn start timestamp is invalid",
			);
		}
		if (snapshot.nowMs - startedAt > thresholds.turnStaleMs) {
			return recoveryCandidate(
				"turn_stalled",
				`turn_age_ms=${snapshot.nowMs - startedAt}`,
			);
		}
	}

	const attemptAt = parseTime(heartbeat.lastGatewayPollAttemptAt);
	if (attemptAt === null) {
		if (processAgeMs <= thresholds.startupGraceMs) {
			return decision(
				"starting",
				false,
				false,
				"no gateway poll attempt inside startup grace",
			);
		}
		return recoveryCandidate(
			"poll_loop_stalled",
			"no valid gateway poll attempt after startup grace",
		);
	}
	const attemptAgeMs = snapshot.nowMs - attemptAt;
	if (attemptAgeMs > thresholds.pollAttemptStaleMs) {
		return recoveryCandidate(
			"poll_loop_stalled",
			`poll_attempt_age_ms=${attemptAgeMs}`,
		);
	}

	if (heartbeat.lastGatewayPollStatus === "failed") {
		return decision(
			"upstream_unavailable",
			true,
			false,
			`fresh failed attempt class=${heartbeat.lastGatewayPollFailureClass ?? "unknown"} status=${heartbeat.lastGatewayPollStatusCode ?? "none"}`,
		);
	}
	return decision(
		"healthy",
		false,
		false,
		`poll_attempt_age_ms=${attemptAgeMs}`,
	);
}

export interface ResidentCodexLeadRecoveryResult {
	ok: boolean;
	detail: string;
}

export interface ResidentCodexLeadAlertEvent {
	phase: "detected" | "recovery";
	decision: ResidentCodexLeadDecision;
	recovery: ResidentCodexLeadRecoveryResult | null;
	identityKey: string;
}

export interface ResidentCodexLeadPatrolDeps {
	readSnapshot(): Promise<ResidentCodexLeadSnapshot>;
	recordObserved(observed: ResidentCodexLeadObservedGeneration): Promise<void>;
	recover(
		snapshot: ResidentCodexLeadSnapshot,
		decision: ResidentCodexLeadDecision,
	): Promise<ResidentCodexLeadRecoveryResult>;
	alert(event: ResidentCodexLeadAlertEvent): Promise<void>;
	thresholds?: ResidentCodexLeadThresholds;
}

function snapshotIdentityKey(snapshot: ResidentCodexLeadSnapshot): string {
	if (snapshot.identity.state !== "exact") {
		return `uncertain:${snapshot.identity.reason.slice(0, 128)}`;
	}
	const generation =
		snapshot.heartbeat.state === "valid"
			? `${snapshot.heartbeat.value.generationId}:${snapshot.heartbeat.value.carrierInstanceId}`
			: snapshot.observed &&
					snapshot.observed.pid === snapshot.identity.pid &&
					snapshot.observed.lstart === snapshot.identity.lstart
				? `${snapshot.observed.generationId}:${snapshot.observed.carrierInstanceId}`
				: "unobserved";
	return `${snapshot.identity.pid}:${snapshot.identity.lstart}:${generation}`;
}

export class ResidentCodexLeadPatrol {
	private inFlight: Promise<void> | null = null;
	private identityKey: string | null = null;
	private consecutiveFailures = 0;
	private detectedAlerted = false;
	private recoveryAttempted = false;
	private recoveryAlerted = false;

	constructor(private readonly deps: ResidentCodexLeadPatrolDeps) {}

	tick(): Promise<void> {
		if (this.inFlight) return this.inFlight;
		const pass = this.runPass().finally(() => {
			if (this.inFlight === pass) this.inFlight = null;
		});
		this.inFlight = pass;
		return pass;
	}

	private resetEpisode(key: string | null): void {
		this.identityKey = key;
		this.consecutiveFailures = 0;
		this.detectedAlerted = false;
		this.recoveryAttempted = false;
		this.recoveryAlerted = false;
	}

	private async runPass(): Promise<void> {
		let snapshot = await this.deps.readSnapshot();
		if (
			snapshot.identity.state === "exact" &&
			snapshot.heartbeat.state === "valid" &&
			heartbeatBelongsToExactProcess(
				snapshot.identity,
				snapshot.heartbeat.value,
			)
		) {
			const observed: ResidentCodexLeadObservedGeneration = {
				pid: snapshot.identity.pid,
				lstart: snapshot.identity.lstart,
				generationId: snapshot.heartbeat.value.generationId,
				carrierInstanceId: snapshot.heartbeat.value.carrierInstanceId,
				observedAt: new Date(snapshot.nowMs).toISOString(),
			};
			if (
				!snapshot.observed ||
				snapshot.observed.pid !== observed.pid ||
				snapshot.observed.lstart !== observed.lstart ||
				snapshot.observed.generationId !== observed.generationId ||
				snapshot.observed.carrierInstanceId !== observed.carrierInstanceId
			) {
				await this.deps.recordObserved(observed);
				snapshot = { ...snapshot, observed };
			}
		}

		const key = snapshotIdentityKey(snapshot);
		if (this.identityKey !== key) this.resetEpisode(key);
		const thresholds =
			this.deps.thresholds ?? DEFAULT_RESIDENT_CODEX_LEAD_THRESHOLDS;
		const verdict = classifyResidentCodexLead(snapshot, thresholds);

		if (verdict.branch === "healthy") {
			this.resetEpisode(key);
			return;
		}
		if (
			verdict.branch === "starting" ||
			verdict.branch === "suppressed_controlled_wave"
		) {
			this.consecutiveFailures = 0;
			return;
		}

		if (verdict.alert && !this.detectedAlerted) {
			await this.deps.alert({
				phase: "detected",
				decision: verdict,
				recovery: null,
				identityKey: key,
			});
			this.detectedAlerted = true;
		}
		if (!verdict.candidate) {
			this.consecutiveFailures = 0;
			return;
		}

		this.consecutiveFailures += 1;
		if (
			this.consecutiveFailures < thresholds.consecutiveFailures ||
			this.recoveryAttempted
		) {
			return;
		}
		this.recoveryAttempted = true;
		const recovery = await this.deps.recover(snapshot, {
			...verdict,
			recover: true,
		});
		if (!this.recoveryAlerted) {
			await this.deps.alert({
				phase: "recovery",
				decision: { ...verdict, recover: true },
				recovery,
				identityKey: key,
			});
			this.recoveryAlerted = true;
		}
	}
}

export interface HostResidentCodexLeadPatrolOptions {
	homeDir: string;
	flywheelRoot: string;
	target: ResidentCodexLeadTarget;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	execFile?: (
		file: string,
		args: readonly string[],
		options: { timeout: number; env: NodeJS.ProcessEnv },
	) => Promise<{ stdout: string }>;
	recover?: ResidentCodexLeadPatrolDeps["recover"];
	alert: ResidentCodexLeadPatrolDeps["alert"];
	thresholds?: ResidentCodexLeadThresholds;
}

function defaultExecFile(
	file: string,
	args: readonly string[],
	options: { timeout: number; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string }> {
	return new Promise((resolve, reject) => {
		execFileCallback(
			file,
			[...args],
			{ timeout: options.timeout, env: options.env, encoding: "utf8" },
			(error, stdout) => {
				if (error) reject(error);
				else resolve({ stdout: String(stdout) });
			},
		);
	});
}

/** Host composition using the fixed helper and bounded, symlink-safe evidence. */
export function createHostResidentCodexLeadPatrol(
	options: HostResidentCodexLeadPatrolOptions,
): ResidentCodexLeadPatrol {
	const env = { ...(options.env ?? process.env), HOME: options.homeDir };
	const execute = options.execFile ?? defaultExecFile;
	const helper = join(
		options.flywheelRoot,
		"scripts",
		"resident-codex-lead-recover.sh",
	);
	const helperTargetArgs = [
		"--project",
		options.target.projectName,
		"--lead",
		options.target.leadId,
	] as const;
	const expectedLabel = `com.flywheel.lead.${options.target.leadKey}`;
	const brainDir = join(
		options.homeDir,
		".flywheel",
		"state",
		"codex-lead",
		options.target.leadId,
		"brain",
	);
	const observedPath = join(brainDir, "patrol-observed-generation.json");
	const controlledWavePath = join(
		options.homeDir,
		".flywheel",
		"state",
		"lead-replacements",
		`${options.target.leadKey}.json`,
	);

	const readSnapshot = async (): Promise<ResidentCodexLeadSnapshot> => {
		let identity: ResidentCodexLeadIdentity;
		try {
			const result = await execute(helper, [...helperTargetArgs, "--probe"], {
				timeout: 10_000,
				env,
			});
			identity = parseResidentCodexLeadProbe(
				result.stdout,
				options.target,
				options.homeDir,
			);
		} catch (error) {
			identity = {
				state: "uncertain",
				reason:
					`probe failed: ${error instanceof Error ? error.message : String(error)}`.slice(
						0,
						512,
					),
			};
		}
		const heartbeatValue = await readSafeJson(
			join(brainDir, "heartbeat.json"),
			options.homeDir,
		);
		return {
			nowMs: (options.now ?? Date.now)(),
			identity,
			heartbeat: isHeartbeat(heartbeatValue)
				? { state: "valid", value: heartbeatValue }
				: { state: heartbeatValue === undefined ? "missing" : "malformed" },
			observed: parseObserved(
				await readSafeJson(observedPath, options.homeDir),
			),
			controlledWave: parseControlledWave(
				await readSafeJson(controlledWavePath, options.homeDir),
				expectedLabel,
			),
		};
	};

	const recover: ResidentCodexLeadPatrolDeps["recover"] =
		options.recover ??
		(async (snapshot, verdict) => {
			if (snapshot.identity.state !== "exact" || !verdict.recover) {
				return { ok: false, detail: "recovery authority was not granted" };
			}
			const heartbeat =
				snapshot.heartbeat.state === "valid" ? snapshot.heartbeat.value : null;
			try {
				const result = await execute(
					helper,
					[
						...helperTargetArgs,
						"--recover",
						"--expected-pid",
						String(snapshot.identity.pid),
						"--expected-lstart",
						snapshot.identity.lstart,
						"--expected-generation",
						heartbeat?.generationId ?? snapshot.observed?.generationId ?? "",
						"--expected-carrier-instance",
						heartbeat?.carrierInstanceId ??
							snapshot.observed?.carrierInstanceId ??
							"",
					],
					{ timeout: 150_000, env },
				);
				if (result.stdout.length > MAX_EVIDENCE_BYTES)
					return { ok: false, detail: "recovery output exceeds size limit" };
				const value = JSON.parse(result.stdout) as Record<string, unknown>;
				return {
					ok: value.ok === true,
					detail: boundedString(value.detail, 4_096)
						? value.detail
						: "recovery returned malformed detail",
				};
			} catch (error) {
				return {
					ok: false,
					detail:
						`recovery helper failed: ${error instanceof Error ? error.message : String(error)}`.slice(
							0,
							4_096,
						),
				};
			}
		});

	return new ResidentCodexLeadPatrol({
		readSnapshot,
		recordObserved: (value) => writeObserved(options.homeDir, brainDir, value),
		recover,
		alert: options.alert,
		thresholds:
			options.thresholds ??
			residentCodexLeadThresholdsFromEnv(options.env ?? process.env),
	});
}
