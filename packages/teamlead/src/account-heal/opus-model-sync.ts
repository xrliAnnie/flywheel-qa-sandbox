import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	constants as fsConstants,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type ModelConfigSnapshot,
	withModelAuthorityLock,
} from "flywheel-config";
import {
	atomicReplace,
	authorityIsSafe,
	readVerifiedSnapshot,
} from "./model-authority-io.js";

/**
 * FLY-2775: the Opus product line follows its latest release.
 *
 * Unlike the Fable sync (FLY-2766), discovery does NOT rank `/v1/models`.
 * The `opus` family alias is resolved by the Claude Code CLI itself, per CLI
 * version (measured: 2.1.278 `--model opus` → claude-opus-5, 2.1.280 →
 * claude-opus-5-5). So the local CLI is the authority on "the latest Opus this
 * host can actually launch", and asking it removes the API-listed-but-CLI-
 * rejects split (2.1.278 pinning claude-opus-5-5 by full id is an API 400).
 *
 * One transaction:
 *   1. discover — `--model opus` and `--model opus[1m]`, read `modelUsage`,
 *      require a coherent pair (base + the same base with `[1m]`);
 *   2. admit    — the dispatcher launches EXACT ids, so a new pair must also
 *      pass `--model <base>` and `--model <base>[1m]` before it is committed;
 *   3. commit   — under the authority lock, reread the preimage, upsert the
 *      registry entries, advance `bindings.opus`/`opus1m` and the managed
 *      tiers, verify through the real registry loader, roll back on failure.
 * Any failure retains the old authority. Version-change alerts are derived
 * from the authority itself on every updater run (`observeAndAlert`), so an
 * undelivered alert is re-derived and retried instead of disappearing.
 */

export const OPUS_BASE_ID =
	/^claude-opus-(0|[1-9][0-9]{0,2})(?:-(0|[1-9][0-9]{0,2}))?$/;
const ONE_MILLION = 1_000_000;
const PROBE_PROMPT = "Reply with exactly: ok";
const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const DEFAULT_VERSION_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 5_000;
const MAX_STREAM_BYTES = 64 * 1024;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type CliFailureReason =
	| "cli_missing"
	| "cli_timeout"
	| "cli_auth_unavailable"
	| "cli_rejected"
	| "cli_output_invalid";

export type OpusSyncReason =
	| CliFailureReason
	| "cli_pair_mismatch"
	| "disabled"
	| "cooldown"
	| "unsafe_authority"
	| "invalid_authority"
	| "write_failed"
	| "verification_failed"
	| "rollback_failed"
	| "state_unwritable"
	| "authority_busy";

// ---------------------------------------------------------------------------
// Bounded child process
// ---------------------------------------------------------------------------

export interface BoundedRunResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	overflowed: boolean;
	spawnErrorCode?: string;
}

export interface BoundedRunOptions {
	timeoutMs: number;
	maxBytes?: number;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	killGraceMs?: number;
}

/**
 * Run a child with no shell, stdin closed, both streams capped, and a hard
 * wall clock. On the deadline the whole process group gets SIGTERM, then
 * SIGKILL after a grace period — a hung CLI must never hold the updater
 * singleton.
 */
export function runBounded(
	bin: string,
	args: readonly string[],
	opts: BoundedRunOptions,
): Promise<BoundedRunResult> {
	const maxBytes = opts.maxBytes ?? MAX_STREAM_BYTES;
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let overflowed = false;
		let settled = false;
		let terminating = false;
		let child: ReturnType<typeof spawn>;
		const groupAlive = (): boolean => {
			if (child.pid === undefined) return false;
			try {
				process.kill(-child.pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		const finish = (result: BoundedRunResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			// The process group must be GONE before we return: the CLI exits
			// right after, so no timer could finish the cleanup later. After a
			// normal exit, anything left in the group is a leftover the probe
			// had no business starting — kill it now; after a deadline or
			// overflow, give SIGTERM its grace first.
			if (!groupAlive()) {
				resolve(result);
				return;
			}
			if (!terminating) killGroup("SIGKILL");
			const graceMs = terminating ? (opts.killGraceMs ?? KILL_GRACE_MS) : 0;
			const started = Date.now();
			const poll = (): void => {
				if (!groupAlive()) {
					resolve(result);
					return;
				}
				if (Date.now() - started >= graceMs) {
					killGroup("SIGKILL");
					resolve(result);
					return;
				}
				setTimeout(poll, 25);
			};
			poll();
		};
		const killGroup = (signal: NodeJS.Signals): void => {
			if (child.pid === undefined) return;
			try {
				process.kill(-child.pid, signal);
			} catch {
				try {
					child.kill(signal);
				} catch {
					// Already gone.
				}
			}
		};
		const terminate = (): void => {
			if (terminating) return;
			terminating = true;
			killGroup("SIGTERM");
			// The direct child may ignore SIGTERM too; escalate while it lives.
			// (Descendants after its exit are handled in finish().)
			const escalate = setTimeout(
				() => killGroup("SIGKILL"),
				opts.killGraceMs ?? KILL_GRACE_MS,
			);
			escalate.unref?.();
		};
		try {
			child = spawn(bin, [...args], {
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
				...(opts.cwd ? { cwd: opts.cwd } : {}),
				...(opts.env ? { env: opts.env } : {}),
			});
		} catch (error) {
			resolve({
				code: null,
				signal: null,
				stdout: "",
				stderr: "",
				timedOut: false,
				overflowed: false,
				spawnErrorCode: (error as NodeJS.ErrnoException).code ?? "SPAWN_FAILED",
			});
			return;
		}
		const deadline = setTimeout(() => {
			timedOut = true;
			terminate();
		}, opts.timeoutMs);
		deadline.unref?.();
		let retained = 0;
		const capture = (which: "stdout" | "stderr") => (chunk: Buffer) => {
			// Past the combined cap nothing more is retained, however long a
			// SIGTERM-ignoring child keeps writing before the SIGKILL lands.
			if (overflowed) return;
			const room = maxBytes - retained;
			const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
			retained += kept.length;
			const text = kept.toString("utf8");
			if (which === "stdout") stdout += text;
			else stderr += text;
			if (chunk.length > room) {
				overflowed = true;
				terminate();
			}
		};
		child.stdout?.on("data", capture("stdout"));
		child.stderr?.on("data", capture("stderr"));
		child.on("error", (error: NodeJS.ErrnoException) => {
			finish({
				code: null,
				signal: null,
				stdout,
				stderr,
				timedOut,
				overflowed,
				spawnErrorCode: error.code ?? "SPAWN_FAILED",
			});
		});
		child.on("close", (code, signal) => {
			finish({ code, signal, stdout, stderr, timedOut, overflowed });
		});
	});
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export type ProbeResult =
	| { ok: true; models: string[] }
	| { ok: false; reason: CliFailureReason };

/** The isolated argv contract (Codex design review R2 #4). */
export function probeArgs(model: string): string[] {
	return [
		"-p",
		PROBE_PROMPT,
		"--model",
		model,
		"--output-format",
		"json",
		"--safe-mode",
		"--setting-sources",
		"",
		"--strict-mcp-config",
		"--disable-slash-commands",
		"--tools",
		"",
		"--permission-prompts",
		"none",
		"--no-session-persistence",
	];
}

const CLI_FAILURES: ReadonlySet<string> = new Set<CliFailureReason>([
	"cli_missing",
	"cli_timeout",
	"cli_auth_unavailable",
	"cli_rejected",
	"cli_output_invalid",
]);

const AUTH_FAILURE =
	/auth|login|credential|unauthori[sz]ed|\b401\b|oauth|expired/i;

/** Classify one probe run into the exact models it reports, or a reason. */
export function classifyProbe(run: BoundedRunResult): ProbeResult {
	if (run.spawnErrorCode === "ENOENT" || run.spawnErrorCode === "EACCES") {
		return { ok: false, reason: "cli_missing" };
	}
	if (run.spawnErrorCode) return { ok: false, reason: "cli_missing" };
	if (run.timedOut) return { ok: false, reason: "cli_timeout" };
	if (run.overflowed) return { ok: false, reason: "cli_output_invalid" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(run.stdout.trim());
	} catch {
		if (AUTH_FAILURE.test(`${run.stdout}\n${run.stderr}`)) {
			return { ok: false, reason: "cli_auth_unavailable" };
		}
		return {
			ok: false,
			reason: run.code === 0 ? "cli_output_invalid" : "cli_rejected",
		};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, reason: "cli_output_invalid" };
	}
	const record = parsed as Record<string, unknown>;
	if (record.is_error === true || run.code !== 0) {
		const text = `${String(record.result ?? "")}\n${run.stderr}`;
		return {
			ok: false,
			reason: AUTH_FAILURE.test(text) ? "cli_auth_unavailable" : "cli_rejected",
		};
	}
	const usage = record.modelUsage;
	if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
		return { ok: false, reason: "cli_output_invalid" };
	}
	const models = Object.keys(usage);
	if (models.length === 0) return { ok: false, reason: "cli_output_invalid" };
	return { ok: true, models };
}

export type Prober = (model: string) => Promise<ProbeResult>;

export function parseOpusVersion(id: string): number[] | null {
	const match = OPUS_BASE_ID.exec(id);
	if (!match) return null;
	return match[2] === undefined
		? [Number(match[1])]
		: [Number(match[1]), Number(match[2])];
}

function compareVersions(left: number[], right: number[]): number {
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const delta = (left[index] ?? 0) - (right[index] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}

export interface OpusPair {
	base: string;
	oneM: string;
}

function singleModel(result: ProbeResult): string | CliFailureReason | null {
	if (!result.ok) return result.reason;
	return result.models.length === 1 ? (result.models[0] ?? null) : null;
}

/** Discovery: ask the CLI what its family aliases currently mean. */
export async function discoverOpusPair(
	probe: Prober,
): Promise<
	{ ok: true; pair: OpusPair } | { ok: false; reason: OpusSyncReason }
> {
	const [baseRun, oneMRun] = await Promise.all([
		probe("opus"),
		probe("opus[1m]"),
	]);
	const base = singleModel(baseRun);
	const oneM = singleModel(oneMRun);
	for (const value of [base, oneM]) {
		if (value !== null && !value.startsWith("claude-")) {
			return { ok: false, reason: value as CliFailureReason };
		}
	}
	if (
		base === null ||
		oneM === null ||
		parseOpusVersion(base) === null ||
		oneM !== `${base}[1m]`
	) {
		return { ok: false, reason: "cli_pair_mismatch" };
	}
	return { ok: true, pair: { base, oneM } };
}

/**
 * Admission: the dispatcher launches `--model <exact id>`, which is a
 * different CLI path from the alias. Both exact spellings must launch.
 */
export async function admitOpusPair(
	probe: Prober,
	pair: OpusPair,
): Promise<{ ok: true } | { ok: false; reason: OpusSyncReason }> {
	const [baseRun, oneMRun] = await Promise.all([
		probe(pair.base),
		probe(pair.oneM),
	]);
	for (const [run, expected] of [
		[baseRun, pair.base],
		[oneMRun, pair.oneM],
	] as const) {
		const model = singleModel(run);
		if (model !== null && !model.startsWith("claude-")) {
			return { ok: false, reason: model as CliFailureReason };
		}
		if (model !== expected) return { ok: false, reason: "cli_pair_mismatch" };
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Durable sync state (cooldown, admission cache, alert watermark)
// ---------------------------------------------------------------------------

/**
 * One Lead alert. FLY-2775 (Codex code review R2): version-change alerts are
 * DERIVED from the authority as observed, not queued. A queued success notice
 * needed a prepared/committed state machine that could be erased by a
 * concurrent run, promoted to "success" over a broken authority, or stranded
 * while the kill switch was on. Deriving it from what models.json actually
 * says removes all three: the file is the only source of truth, and delivery
 * is idempotent through the deterministic signature (lead-alert dedups on it).
 */
export interface OpusAlert {
	signature: string;
	/** lead-alert.sh kinds; `model_config` is non-informational (renders a ticket). */
	kind: "model_family_updated" | "model_config";
	/** lead-alert.sh accepts info|warning|severe only. */
	severity: "info" | "severe";
	title: string;
	body: string;
}

export interface OpusSyncState {
	version: 1;
	lastDiscovery?: {
		binary: string;
		cliVersion: string;
		base: string;
		oneM: string;
		at: number;
	};
	admitted: Array<{
		binary: string;
		cliVersion: string;
		base: string;
		oneM: string;
		at: number;
	}>;
	/** The Opus binding the last delivered version-change alert announced. */
	notifiedOpus?: string;
	/** Delivered version changes, newest last (bounded): the durable record. */
	history?: OpusTransition[];
	/**
	 * A transaction whose rollback also failed. Persisted so the severe alert
	 * is retried until delivered, and so no success alert is derived from the
	 * unverified authority until a later sync verifies it (`resolvedAt`). It
	 * is dropped only once it is both delivered and resolved.
	 */
	rollbackFailure?: {
		alert: OpusAlert;
		at: number;
		deliveredAt?: number;
		resolvedAt?: number;
	};
}

export interface OpusTransition {
	from: string;
	to: string;
	deliveredAt: number;
}

const HISTORY_LIMIT = 20;

export function emptySyncState(): OpusSyncState {
	return { version: 1, admitted: [] };
}

/**
 * A missing or corrupt state file is an empty state: re-probe (cost only) and
 * re-baseline, never crash. (A state file lost between a move and its alert
 * re-baselines at the new binding; `history` is the record of what WAS
 * announced, not a guarantee against deletion of the file itself.)
 */
export function readSyncState(path: string): OpusSyncState {
	try {
		const parsed = JSON.parse(
			readFileSync(path, "utf8"),
		) as Partial<OpusSyncState>;
		if (parsed?.version !== 1) return emptySyncState();
		return {
			version: 1,
			...(parsed.lastDiscovery ? { lastDiscovery: parsed.lastDiscovery } : {}),
			admitted: Array.isArray(parsed.admitted) ? parsed.admitted : [],
			...(typeof parsed.notifiedOpus === "string"
				? { notifiedOpus: parsed.notifiedOpus }
				: {}),
			...(Array.isArray(parsed.history) ? { history: parsed.history } : {}),
			...(parsed.rollbackFailure?.alert
				? { rollbackFailure: parsed.rollbackFailure }
				: {}),
		};
	} catch {
		return emptySyncState();
	}
}

export function writeSyncState(path: string, state: OpusSyncState): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	atomicReplace(path, `${JSON.stringify(state, null, 2)}\n`);
}

export type OpusAuthorityObservation =
	| {
			/** Readable; `bindings.opus` is a registry-known, dispatchable id. */
			state: "consistent" | "legacy";
			opus: string;
			oneM: string;
	  }
	| { state: "broken"; reason: string; fingerprint: string };

/**
 * Classify the authority exactly as a run would see it.
 *   consistent — opus + opus[1m] form the pair the sync writes (both
 *                registry-known and dispatchable by id);
 *   legacy     — readable and dispatchable, but not a managed pair (e.g. the
 *                2026-09-22 production shape before the first sync);
 *   broken     — unreadable / unparseable, or a binding that no run could
 *                dispatch. Only this state pages.
 */
export function observeOpusAuthority(path: string): OpusAuthorityObservation {
	let bytes: string | null = null;
	try {
		bytes = readFileSync(path, "utf8");
	} catch (error) {
		// No file at all is the documented "built-ins only" configuration.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return {
				state: "broken",
				reason: "unreadable",
				fingerprint: "unreadable",
			};
		}
	}
	let rawTiers: Record<string, unknown> | undefined;
	if (bytes !== null) {
		// The loader silently falls back to built-ins on an invalid file, so a
		// run would not fail — but the operator's configuration is ignored.
		let valid = false;
		try {
			const doc = JSON.parse(bytes) as { version?: unknown; tiers?: unknown };
			valid = doc?.version === 1;
			if (doc?.tiers && typeof doc.tiers === "object") {
				rawTiers = doc.tiers as Record<string, unknown>;
			}
		} catch {
			valid = false;
		}
		if (!valid) {
			return {
				state: "broken",
				reason: "not a version-1 JSON document (runs fall back to built-ins)",
				fingerprint: fingerprintOf(bytes),
			};
		}
	}
	let snapshot: ModelConfigSnapshot;
	try {
		snapshot = readVerifiedSnapshot(path);
	} catch {
		return {
			state: "broken",
			reason: "registry load failed",
			fingerprint: fingerprintOf(bytes ?? ""),
		};
	}
	const observed = classifySnapshot(snapshot, rawTiers);
	return observed.state === "broken"
		? { ...observed, fingerprint: fingerprintOf(bytes ?? "") }
		: observed;
}

function classifySnapshot(
	snapshot: ModelConfigSnapshot,
	rawTiers?: Record<string, unknown>,
): OpusAuthorityObservation {
	const opus = snapshot.bindings.opus;
	const oneM = snapshot.bindings.opus1m;
	const dispatchable = (id: string) =>
		snapshot.getModelRegistryEntry(id)?.id === id &&
		snapshot.normalizeDispatchModel(id) === id;
	if (parseOpusVersion(opus) === null || !dispatchable(opus)) {
		return {
			state: "broken",
			reason: `bindings.opus ${opus} is not dispatchable`,
			fingerprint: "",
		};
	}
	if (!dispatchable(oneM)) {
		return {
			state: "broken",
			reason: `bindings.opus1m ${oneM} is not dispatchable`,
			fingerprint: "",
		};
	}
	return {
		state: opusAuthorityIsCoherent(snapshot, rawTiers, opus)
			? "consistent"
			: "legacy",
		opus,
		oneM,
	};
}

/**
 * The ONE definition of "the authority is the verified pair `base`": used by
 * the transaction's post-write verification and by the alert observer, so an
 * alert can never call a shape "moved" that the transaction would reject.
 * `rawTiers` are the tiers as written in models.json (a tier written as the
 * `opus` alias must resolve to `base`).
 */
export function opusAuthorityIsCoherent(
	snapshot: ModelConfigSnapshot,
	rawTiers: Record<string, unknown> | undefined,
	base: string,
): boolean {
	const oneM = `${base}[1m]`;
	return (
		snapshot.bindings.opus === base &&
		snapshot.bindings.opus1m === oneM &&
		snapshot.getDispatchCanonical("opus") === base &&
		snapshot.getDispatchCanonical("opus-1m") === oneM &&
		snapshot.getModelRegistryEntry(oneM)?.contextWindowTokens === ONE_MILLION &&
		MANAGED_TIERS.every(
			(tier) => rawTiers?.[tier] !== "opus" || snapshot.tiers[tier].id === base,
		)
	);
}

function fingerprintOf(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function versionChangeAlert(from: string, to: string): OpusAlert {
	return {
		signature: `model-family-updated-opus-${from}-${to}`,
		kind: "model_family_updated",
		severity: "info",
		title: "Opus model family authority updated",
		body: `Opus authority moved from ${from} to ${to}. New runs and Lead launches resolve \`opus\` / \`opus[1m]\` to ${to} / ${to}[1m]; runs already in flight keep the model pinned in their snapshot. If ${to} has no cost rate in token-usage or ~/.flywheel/token-pricing.json, cost reports estimate it at $0 with a warning until it is configured.`,
	};
}

export function brokenAuthorityAlert(
	path: string,
	reason: string,
	fingerprint: string,
): OpusAlert {
	return {
		signature: `model-authority-broken-opus-${fingerprint}`,
		kind: "model_config",
		severity: "severe",
		title: "Opus model authority is not dispatchable — manual check needed",
		body: `${path}: ${reason}. New Opus runs may fail to dispatch. Inspect the file, and turn on the opus_model_sync_disabled flag (flywheel-comm feature-flags set --name opus_model_sync_disabled --to on --reason <why>) until it is repaired.`,
	};
}

/**
 * Observe the authority and emit whatever alert it warrants. Runs on EVERY
 * updater invocation — including kill-switch-on and CLI-failure runs.
 *   - the state file must be writable (probed every run by rewriting it);
 *     if it is not, `stateWritable` is false and the caller must not move the
 *     authority — an unrecordable move is an unannounceable move;
 *   - first observation: record the baseline, alert nothing;
 *   - a recorded rollback failure: (re)deliver its severe alert until sent,
 *     and derive NO success alert until a verified sync clears it;
 *   - consistent (the shared transaction predicate) and moved since the last
 *     announced binding: announce it; after delivery, append the transition
 *     to `history` and advance the watermark — compare-and-set, so a slower
 *     concurrent run can never rewind it;
 *   - broken: severe alert keyed by the file's fingerprint (re-sent each run,
 *     deduplicated downstream, until someone repairs it).
 * A delivery failure leaves the watermark alone, so the next run retries.
 */
export function observeAndAlert(input: {
	authorityPath: string;
	statePath: string;
	deliver: (alert: OpusAlert) => void;
	log?: (message: string) => void;
	now?: () => number;
	/**
	 * false: deliver pending/broken alerts but derive no success alert (the
	 * caller knows this run left an unverified authority it could not record).
	 */
	announce?: boolean;
}): {
	observation: OpusAuthorityObservation;
	stateWritable: boolean;
	delivered: OpusAlert[];
	failed: OpusAlert[];
} {
	const log = input.log ?? console.warn;
	const now = input.now ?? Date.now;
	const observation = observeOpusAuthority(input.authorityPath);
	const delivered: OpusAlert[] = [];
	const failed: OpusAlert[] = [];
	const send = (alert: OpusAlert): boolean => {
		try {
			input.deliver(alert);
			delivered.push(alert);
			return true;
		} catch {
			failed.push(alert);
			return false;
		}
	};
	const state = readSyncState(input.statePath);
	const baseline =
		state.notifiedOpus === undefined && observation.state !== "broken"
			? { ...state, notifiedOpus: observation.opus }
			: state;
	const failure = state.rollbackFailure;
	try {
		writeSyncState(input.statePath, baseline);
	} catch (error) {
		log(
			`[opus-model-sync] state file not writable: ${error instanceof Error ? error.message : String(error)}`,
		);
		// A persisted, undelivered rollback failure still pages: it cannot be
		// marked delivered now, so the next writable run sends it again
		// (same signature, deduplicated downstream).
		if (failure && failure.deliveredAt === undefined) send(failure.alert);
		return { observation, stateWritable: false, delivered, failed };
	}
	if (failure && failure.deliveredAt === undefined && send(failure.alert)) {
		updateSyncState(
			input.statePath,
			(current) => {
				const recorded = current.rollbackFailure;
				if (recorded?.at !== failure.at) return current;
				if (recorded.resolvedAt !== undefined) {
					const { rollbackFailure: _done, ...rest } = current;
					return rest;
				}
				return {
					...current,
					rollbackFailure: { ...recorded, deliveredAt: now() },
				};
			},
			log,
		);
	}
	if (observation.state === "broken") {
		send(
			brokenAuthorityAlert(
				input.authorityPath,
				observation.reason,
				observation.fingerprint,
			),
		);
		return { observation, stateWritable: true, delivered, failed };
	}
	const from = state.notifiedOpus;
	if (
		input.announce !== false &&
		from !== undefined &&
		// An unresolved rollback failure: the shape on disk is unverified.
		(failure === undefined || failure.resolvedAt !== undefined) &&
		observation.state === "consistent" &&
		observation.opus !== from
	) {
		const to = observation.opus;
		if (send(versionChangeAlert(from, to))) {
			updateSyncState(
				input.statePath,
				(current) => ({
					...current,
					// The watermark only moves forward from what this run read; the
					// delivered transition is recorded either way.
					...(current.notifiedOpus === from ? { notifiedOpus: to } : {}),
					history: [
						...(current.history ?? []),
						{ from, to, deliveredAt: now() },
					].slice(-HISTORY_LIMIT),
				}),
				log,
			);
		}
	}
	return { observation, stateWritable: true, delivered, failed };
}

/** Re-read, transform, write back (best effort): never clobbers other fields. */
function updateSyncState(
	path: string,
	transform: (current: OpusSyncState) => OpusSyncState,
	log: (message: string) => void,
): void {
	const current = readSyncState(path);
	const next = transform(current);
	if (next !== current) writeSyncStateBestEffort(path, next, log);
}

// ---------------------------------------------------------------------------
// Authority plan
// ---------------------------------------------------------------------------

export interface OpusAuthorityDocument extends Record<string, unknown> {
	models: Array<Record<string, unknown>>;
	bindings: Record<string, unknown>;
	tiers: Record<string, unknown>;
}

export interface OpusAuthorityUpdatePlan {
	status: "updated" | "normalized" | "unchanged";
	authority: OpusAuthorityDocument;
}

const MANAGED_TIERS = ["medium", "light", "trivial"] as const;
const FAMILY_ALIASES = new Set(["opus", "opus-1m", "opus[1m]"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableAliases(current: unknown, wanted: string): string[] {
	const values = Array.isArray(current)
		? current.filter((value): value is string => typeof value === "string")
		: [];
	const seen = new Set<string>();
	return [...values, wanted].filter((alias) => {
		const normalized = alias.trim().toLowerCase();
		if (!normalized || FAMILY_ALIASES.has(normalized) || seen.has(normalized)) {
			return false;
		}
		seen.add(normalized);
		return true;
	});
}

export function opusLabel(base: string): string {
	const version = parseOpusVersion(base);
	return version ? `Opus ${version.join(".")}` : base;
}

/** Build a lossless authority update without mutating the caller's object. */
export function planOpusAuthorityUpdate(
	input: unknown,
	currentCanonical: string,
	pair: OpusPair,
): OpusAuthorityUpdatePlan {
	if (
		!isRecord(input) ||
		input.version !== 1 ||
		(input.models !== undefined && !Array.isArray(input.models))
	) {
		throw new Error("invalid model authority document");
	}
	const candidateVersion = parseOpusVersion(pair.base);
	const currentVersion = parseOpusVersion(currentCanonical);
	if (candidateVersion === null) throw new Error("invalid Opus candidate");
	if (currentVersion === null)
		throw new Error("invalid current Opus canonical");
	const comparison = compareVersions(candidateVersion, currentVersion);
	const original = structuredClone(input) as Record<string, unknown>;
	const models = original.models ?? [];
	if (!Array.isArray(models) || models.some((entry) => !isRecord(entry))) {
		throw new Error("invalid model authority entries");
	}
	const authority: OpusAuthorityDocument = {
		...original,
		models: models as Array<Record<string, unknown>>,
		bindings: isRecord(original.bindings) ? original.bindings : {},
		tiers: isRecord(original.tiers) ? original.tiers : {},
	};
	// Never auto-downgrade: a CLI that resolves `opus` lower than the current
	// binding (downgraded binary, or an operator pin to a newer id) is left alone.
	if (comparison < 0) return { status: "unchanged", authority };

	const label = opusLabel(pair.base);
	const slug = (candidateVersion ?? []).join("-");
	const upsert = (
		id: string,
		build: (
			current: Record<string, unknown> | undefined,
		) => Record<string, unknown>,
	): void => {
		const index = authority.models.findIndex((entry) => entry.id === id);
		const next = build(index >= 0 ? authority.models[index] : undefined);
		if (index >= 0) authority.models[index] = next;
		else authority.models.push(next);
	};
	upsert(pair.base, (current) => ({
		...(current ?? {}),
		id: pair.base,
		provider: "anthropic",
		runtimeVendor: "claude",
		label,
		aliases: stableAliases(current?.aliases, `opus-${slug}`),
		dispatch: true,
	}));
	upsert(pair.oneM, (current) => ({
		...(current ?? {}),
		id: pair.oneM,
		provider: "anthropic",
		runtimeVendor: "claude",
		label: `${label} (1M)`,
		aliases: stableAliases(current?.aliases, `opus-${slug}-1m`),
		dispatch: true,
		contextWindowTokens: ONE_MILLION,
	}));
	// FLY-1496: every OTHER Opus generation in the overlay is retired —
	// dispatchable by id (in-flight snapshots) but offered to no new work.
	// Without this, an overlay entry the previous advance wrote (dispatch:
	// true, no selectableSurfaces) would stay selectable in every picker.
	authority.models = authority.models.map((entry) => {
		const id = typeof entry.id === "string" ? entry.id : "";
		const base = id.endsWith("[1m]") ? id.slice(0, -"[1m]".length) : id;
		if (
			id === pair.base ||
			id === pair.oneM ||
			parseOpusVersion(base) === null ||
			(Array.isArray(entry.selectableSurfaces) &&
				entry.selectableSurfaces.length === 0)
		) {
			return entry;
		}
		return { ...entry, selectableSurfaces: [] };
	});
	authority.bindings = {
		...authority.bindings,
		opus: pair.base,
		opus1m: pair.oneM,
	};
	const tiers = { ...authority.tiers };
	for (const tier of MANAGED_TIERS) {
		const configured = tiers[tier];
		if (
			configured === undefined ||
			configured === "opus" ||
			configured === currentCanonical
		) {
			tiers[tier] = "opus";
		}
	}
	authority.tiers = tiers;
	const changed = JSON.stringify(authority) !== JSON.stringify(input);
	return {
		status: comparison > 0 ? "updated" : changed ? "normalized" : "unchanged",
		authority,
	};
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

export interface SyncOpusModelAuthorityOptions {
	authorityPath?: string;
	statePath?: string;
	claudeBin?: string;
	disabled?: boolean;
	now?: () => number;
	/** Test seam: replace the real CLI probe. */
	probe?: Prober;
	/** Test seam: replace `claude --version`. */
	cliVersion?: () => Promise<string | CliFailureReason>;
	log?: (message: string) => void;
	beforeRename?: (tempPath: string) => void;
	afterWrite?: (authorityPath: string) => void;
	/** Test seam: fail the rollback write to exercise `rollback_failed`. */
	rollbackWrite?: (path: string, bytes: string) => void;
	probeTimeoutMs?: number;
}

export interface SyncOpusModelAuthorityResult {
	status: "updated" | "normalized" | "unchanged" | "retained";
	previousCanonical?: string;
	canonical?: string;
	cliVersion?: string;
	reason?: OpusSyncReason;
	/**
	 * A severe alert the caller must deliver right now: a rollback_failed
	 * event that could not be persisted as `rollbackFailure` (when it could,
	 * `observeAndAlert` delivers and retries it instead).
	 */
	alert?: OpusAlert;
}

export function defaultAuthorityPath(): string {
	return (
		process.env.FLYWHEEL_MODELS_CONFIG ??
		join(homedir(), ".flywheel", "models.json")
	);
}

export function defaultStatePath(): string {
	return join(homedir(), ".flywheel", "state", "opus-model-sync.json");
}

/**
 * The executable that will actually run: a bare name is searched on PATH (as
 * spawn does) and then realpath'd, so the cooldown/admission key identifies the
 * real binary rather than the literal `claude`.
 */
export function resolveBinary(
	bin: string,
	pathEnv: string | undefined = process.env.PATH,
): string {
	const candidates = bin.includes("/")
		? [bin]
		: (pathEnv ?? "")
				.split(":")
				.filter((dir) => dir.length > 0)
				.map((dir) => join(dir, bin));
	for (const candidate of candidates) {
		try {
			accessSync(candidate, fsConstants.X_OK);
			return realpathSync(candidate);
		} catch {
			// Not here; keep searching.
		}
	}
	return bin;
}

function realProbe(bin: string, timeoutMs: number): Prober {
	return async (model: string) => {
		const cwd = mkdtempSync(join(tmpdir(), "opus-probe-"));
		try {
			const run = await runBounded(bin, probeArgs(model), { timeoutMs, cwd });
			return classifyProbe(run);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	};
}

async function realCliVersion(bin: string): Promise<string | CliFailureReason> {
	const run = await runBounded(bin, ["--version"], {
		timeoutMs: DEFAULT_VERSION_TIMEOUT_MS,
		maxBytes: 4096,
	});
	if (run.spawnErrorCode) return "cli_missing";
	if (run.timedOut) return "cli_timeout";
	const version = run.stdout.trim();
	return run.code === 0 && version ? version : "cli_output_invalid";
}

function rollbackFailedAlert(
	path: string,
	previous: string,
	attempted: string,
	now: number,
): OpusAlert {
	return {
		signature: `model-family-rollback-failed-opus-${previous}-${attempted}-${now}`,
		kind: "model_config",
		severity: "severe",
		title: "Opus model authority rollback failed — manual check needed",
		body: `The Opus sync wrote ${attempted} to ${path}, the post-write verification failed, and restoring the previous bytes (bindings.opus=${previous}) also failed. The model authority may be in an unverified state; inspect it and turn on the opus_model_sync_disabled flag (flywheel-comm feature-flags set --name opus_model_sync_disabled --to on --reason <why>) until repaired.`,
	};
}

/** One bounded probe/update transaction. Every failure retains the authority. */
export async function syncOpusModelAuthority(
	opts: SyncOpusModelAuthorityOptions = {},
): Promise<SyncOpusModelAuthorityResult> {
	if (opts.disabled) return { status: "retained", reason: "disabled" };
	const now = opts.now?.() ?? Date.now();
	const path = opts.authorityPath ?? defaultAuthorityPath();
	const statePath = opts.statePath ?? defaultStatePath();
	const log = opts.log ?? console.info;
	if (!authorityIsSafe(path))
		return { status: "retained", reason: "unsafe_authority" };
	let before: ModelConfigSnapshot;
	try {
		JSON.parse(readFileSync(path, "utf8"));
		before = readVerifiedSnapshot(path);
	} catch {
		return { status: "retained", reason: "invalid_authority" };
	}
	// The binding itself, not the dispatch alias: when models.json binds `opus`
	// to a retired generation (the 2026-09-22 production shape) the dispatch
	// alias is dark by the FLY-1496 contract, yet that binding is exactly the
	// "current" this sync must advance from.
	const previousCanonical = before.bindings.opus;
	if (
		previousCanonical === null ||
		parseOpusVersion(previousCanonical) === null
	) {
		return { status: "retained", reason: "invalid_authority" };
	}
	const bin = opts.claudeBin ?? process.env.FLYWHEEL_CLAUDE_BIN ?? "claude";
	const binary = resolveBinary(bin);
	const version = await (opts.cliVersion ?? (() => realCliVersion(bin)))();
	const retained = (reason: OpusSyncReason): SyncOpusModelAuthorityResult => ({
		status: "retained",
		reason,
		previousCanonical,
		canonical: previousCanonical,
	});
	if (CLI_FAILURES.has(version)) return retained(version as CliFailureReason);
	let state = readSyncState(statePath);
	const probe =
		opts.probe ??
		realProbe(bin, opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);

	// Cooldown: the alias mapping moves with the CLI version, so an unchanged
	// binary + version discovered within 24h is not probed again (no paid call).
	// It only skips DISCOVERY: the cached pair still goes through admission and
	// the locked plan, so drift in the authority is still normalized.
	let pair: OpusPair;
	const last = state.lastDiscovery;
	const cooled =
		last !== undefined &&
		last.binary === binary &&
		last.cliVersion === version &&
		now - last.at < COOLDOWN_MS;
	if (cooled && last) {
		pair = { base: last.base, oneM: last.oneM };
	} else {
		const discovered = await discoverOpusPair(probe);
		if (!discovered.ok) {
			writeCacheBestEffort(statePath, state, log);
			return { ...retained(discovered.reason), cliVersion: version };
		}
		pair = discovered.pair;
		state = {
			...state,
			lastDiscovery: { binary, cliVersion: version, ...pair, at: now },
		};
	}
	// Every commit — advance OR normalization — needs this exact pair admitted
	// by this binary + version: the dispatcher launches exact ids, not aliases.
	const isAdmitted = (): boolean =>
		state.admitted.some(
			(entry) =>
				entry.binary === binary &&
				entry.cliVersion === version &&
				entry.base === pair.base &&
				entry.oneM === pair.oneM,
		);
	if (!isAdmitted()) {
		const admitted = await admitOpusPair(probe, pair);
		if (!admitted.ok) {
			writeCacheBestEffort(statePath, state, log);
			return { ...retained(admitted.reason), cliVersion: version };
		}
		state = {
			...state,
			admitted: [
				...state.admitted.filter(
					(entry) => !(entry.binary === binary && entry.cliVersion === version),
				),
				{ binary, cliVersion: version, ...pair, at: now },
			],
		};
	}
	writeCacheBestEffort(statePath, state, log);

	try {
		return await withModelAuthorityLock(path, async (path) => {
			// Probing is finished; derive the update from the locked preimage.
			if (!authorityIsSafe(path)) return retained("unsafe_authority");
			let originalBytes: string;
			let original: unknown;
			let locked: string;
			try {
				originalBytes = readFileSync(path, "utf8");
				original = JSON.parse(originalBytes);
				locked = readVerifiedSnapshot(path).bindings.opus;
			} catch {
				return retained("invalid_authority");
			}
			if (parseOpusVersion(locked) === null) {
				return retained("invalid_authority");
			}
			let plan: OpusAuthorityUpdatePlan;
			try {
				plan = planOpusAuthorityUpdate(original, locked, pair);
			} catch {
				return retained("invalid_authority");
			}
			if (plan.status === "unchanged") {
				try {
					if (
						opusAuthorityIsCoherent(
							readVerifiedSnapshot(path),
							plan.authority.tiers,
							pair.base,
						)
					) {
						clearRollbackFailure(statePath, log);
					}
				} catch {
					// Unverifiable: keep any recorded rollback failure.
				}
				return cooled
					? {
							...retained("cooldown"),
							previousCanonical: locked,
							canonical: locked,
							cliVersion: version,
						}
					: {
							status: "unchanged",
							previousCanonical: locked,
							canonical: locked,
							cliVersion: version,
						};
			}
			const nextBytes = `${JSON.stringify(plan.authority, null, 2)}\n`;
			try {
				atomicReplace(path, nextBytes, opts.beforeRename);
			} catch {
				return retained("write_failed");
			}
			let verified = false;
			try {
				opts.afterWrite?.(path);
				const after = readVerifiedSnapshot(path);
				verified =
					after.bindings.opus1m === pair.oneM &&
					opusAuthorityIsCoherent(after, plan.authority.tiers, pair.base);
			} catch {
				verified = false;
			}
			if (!verified) {
				try {
					(opts.rollbackWrite ?? ((p, b) => atomicReplace(p, b)))(
						path,
						originalBytes,
					);
					readVerifiedSnapshot(path);
				} catch {
					const alert = rollbackFailedAlert(path, locked, pair.base, now);
					let persisted = true;
					try {
						writeSyncState(statePath, {
							...readSyncState(statePath),
							rollbackFailure: { alert, at: now },
						});
					} catch {
						persisted = false;
					}
					return {
						status: "retained",
						reason: "rollback_failed",
						previousCanonical: locked,
						cliVersion: version,
						// Persisted ⇒ the observer delivers (and retries) it.
						...(persisted ? {} : { alert }),
					};
				}
				return retained("verification_failed");
			}
			clearRollbackFailure(statePath, log);
			if (plan.status === "normalized") {
				log(
					`[opus-model-sync] normalized authority ${path}: bindings.opus/opus1m, Opus registry entries, and managed tiers`,
				);
			}
			return {
				status: plan.status,
				previousCanonical: locked,
				canonical: pair.base,
				cliVersion: version,
			};
		});
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes("lock acquisition budget exhausted")
		) {
			log(`[opus-model-sync] ${error.message}`);
			return retained("authority_busy");
		}
		return retained("unsafe_authority");
	}
}

/**
 * The sync's own writes carry only the probe cache (cooldown + admissions).
 * Everything else (watermark, history, rollback failure) belongs to other
 * writers that may have run while this sync was probing, so it is re-read
 * rather than overwritten with the copy read at start.
 */
function writeCacheBestEffort(
	path: string,
	state: OpusSyncState,
	log: (message: string) => void,
): void {
	const { lastDiscovery, admitted } = state;
	updateSyncState(
		path,
		(current) => ({
			...current,
			...(lastDiscovery ? { lastDiscovery } : {}),
			admitted,
		}),
		log,
	);
}

/** A verified sync resolves a recorded rollback failure (drop once delivered). */
function clearRollbackFailure(
	path: string,
	log: (message: string) => void,
): void {
	updateSyncState(
		path,
		(current) => {
			const recorded = current.rollbackFailure;
			if (recorded === undefined || recorded.resolvedAt !== undefined) {
				return current;
			}
			if (recorded.deliveredAt !== undefined) {
				const { rollbackFailure: _done, ...rest } = current;
				return rest;
			}
			return {
				...current,
				rollbackFailure: { ...recorded, resolvedAt: Date.now() },
			};
		},
		log,
	);
}

function writeSyncStateBestEffort(
	path: string,
	state: OpusSyncState,
	log: (message: string) => void,
): void {
	try {
		writeSyncState(path, state);
	} catch (error) {
		log(
			`[opus-model-sync] state write failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
