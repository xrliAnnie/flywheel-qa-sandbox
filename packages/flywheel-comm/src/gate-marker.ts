/**
 * FLY-123: unanswered-gate markers for Codex (process-boundary) runners.
 *
 * When a Codex runner registers a no-block gate, the gate CLI writes a
 * question-bound marker file. The marker is:
 *
 * 1. The CodexTmuxAdapter's `awaiting_gate` detection signal — process
 *    exited + unanswered marker for this executionId → the runner is paused
 *    at a gate, NOT terminal.
 * 2. The wake-routing data source (Codex design review R4 #1) — `respond`
 *    looks up the marker by questionId to learn the target runner's
 *    backend, so the mailbox wake goes through the right transport
 *    (forBackend), never the process-global env.
 *
 * Question-bound, not execution-bound (R5 note #1): the file is keyed by
 * questionId and `respond` verifies the marker matches the question being
 * answered — a future multi-gate execution can't get a stale-marker wake.
 *
 * Markers are written ONLY when `FLYWHEEL_GATE_MARKER_DIR` is present in the
 * runner env (injected by CodexTmuxAdapter at spawn). Claude runners never
 * see the env → no markers → byte-compatible behavior.
 */

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface GateMarker {
	questionId: string;
	executionId: string;
	/** Executor backend of the runner that registered the gate (e.g. "codex-tmux"). */
	backend: string;
	/** Transport vendor id (e.g. "codex"). */
	vendor: string;
	checkpoint: string;
	createdAt: string;
	/** Set by `respond` after the answer is written (wake may still be in flight). */
	answeredAt?: string;

	// FLY-123 code review R1 HIGH-2: the marker carries the checkpoint's
	// CONFIGURED gate semantics so the adapter-owned awaiting_gate deadline
	// honors them (a 4h project gate must not wait 49h; a fail-open gate
	// must not fail-close).

	/** Configured gate timeout (ms) from `gate --timeout`. */
	timeoutMs?: number;
	/** Configured behavior from `gate --timeout-behavior`. */
	timeoutBehavior?: "fail-open" | "fail-close";
	/** Provenance of timeoutBehavior ("default" | "flag") — FLY-159 payload parity. */
	timeoutBehaviorSource?: string;
	/** Configured cleanup TTL hours. */
	cleanupTtlHours?: number;
	/** Truncated original gate message (gate_timed_out payload parity). */
	message?: string;
}

interface CachedGateMarkerFile {
	mtimeMs: number;
	size: number;
	marker: GateMarker | null;
}

interface CachedGateMarkerDirectory {
	dirMtimeMs: number;
	markers: GateMarker[];
	files: Map<string, CachedGateMarkerFile>;
	retryOnNextList: boolean;
}

const MAX_CACHED_GATE_MARKER_DIRECTORIES = 32;
const RETRYABLE_GATE_MARKER_IO_CODES = new Set([
	"EAGAIN",
	"EBUSY",
	"EINTR",
	"EIO",
	"EMFILE",
	"ENFILE",
	"ENOMEM",
]);
const gateMarkerListCache = new Map<string, CachedGateMarkerDirectory>();

function isRetryableGateMarkerIoError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && RETRYABLE_GATE_MARKER_IO_CODES.has(code);
}

function cacheGateMarkerDirectory(
	dir: string,
	entry: CachedGateMarkerDirectory,
): void {
	gateMarkerListCache.delete(dir);
	gateMarkerListCache.set(dir, entry);
	while (gateMarkerListCache.size > MAX_CACHED_GATE_MARKER_DIRECTORIES) {
		const oldest = gateMarkerListCache.keys().next().value;
		if (oldest === undefined) break;
		gateMarkerListCache.delete(oldest);
	}
}

function markersForExecution(
	entry: CachedGateMarkerDirectory,
	executionId: string,
): GateMarker[] {
	return entry.markers
		.filter((marker) => marker.executionId === executionId)
		.map((marker) => ({ ...marker }));
}

/** Marker filenames use this strict domain — also our path-traversal guard. */
const SAFE_QUESTION_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export function defaultGateMarkerDir(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const fromEnv = env.FLYWHEEL_GATE_MARKER_DIR?.trim();
	if (fromEnv) return fromEnv;
	return join(homedir(), ".flywheel", "state", "codex-gates");
}

function markerPathIfSafe(dir: string, questionId: string): string | undefined {
	if (!SAFE_QUESTION_ID.test(questionId)) return undefined;
	return join(dir, `${questionId}.json`);
}

function markerPath(dir: string, questionId: string): string {
	const path = markerPathIfSafe(dir, questionId);
	if (!path) {
		throw new Error(`gate-marker: invalid questionId "${questionId}"`);
	}
	return path;
}

export function writeGateMarker(
	dir: string,
	marker: Omit<GateMarker, "createdAt"> & { createdAt?: string },
): void {
	const target = markerPath(dir, marker.questionId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const full: GateMarker = {
		...marker,
		createdAt: marker.createdAt ?? new Date().toISOString(),
	};
	const temp = join(dir, `.${marker.questionId}.${randomUUID()}.tmp`);
	try {
		writeFileSync(temp, JSON.stringify(full, null, 2), {
			encoding: "utf-8",
			mode: 0o600,
		});
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

export function readGateMarker(
	dir: string,
	questionId: string,
): GateMarker | undefined {
	const p = markerPathIfSafe(dir, questionId);
	if (!p || !existsSync(p)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(p, "utf-8")) as GateMarker;
		if (raw.questionId !== questionId) return undefined; // corrupted / mismatched
		return raw;
	} catch {
		return undefined;
	}
}

/** Mark answered (respond writes this after the CommDB response insert). */
export function markGateMarkerAnswered(dir: string, questionId: string): void {
	const marker = readGateMarker(dir, questionId);
	if (!marker) return;
	writeGateMarker(dir, { ...marker, answeredAt: new Date().toISOString() });
}

/**
 * FLY-1257 defect ① × ④ (Codex code review HIGH-1): mark a gate's marker
 * answered when the answer came from something OTHER than the CLI `respond`
 * path — specifically the review coordinator, which writes the CommDB response
 * + a mailbox wake but never touched the marker. A resident codex `/goal` only
 * resumes once its held gate's marker flips answered (the adapter's
 * `isWaiting()` reads `answeredAt`); without this it would wait for the deadline
 * watcher (~72h). Execution-guarded + idempotent: a missing / already-answered /
 * foreign-execution marker is a silent no-op. Returns true iff it marked one.
 */
export function markGateMarkerAnsweredForExecution(
	dir: string,
	questionId: string,
	executionId: string,
): boolean {
	const marker = readGateMarker(dir, questionId);
	if (!marker || marker.answeredAt) return false;
	// A mismatched execution id means a stale/foreign marker — never touch it.
	if (marker.executionId !== executionId) return false;
	markGateMarkerAnswered(dir, questionId);
	return true;
}

export function removeGateMarker(dir: string, questionId: string): void {
	try {
		rmSync(markerPath(dir, questionId), { force: true });
	} catch {
		// best-effort — adapter timeout path re-tries; TTL cleanup is the
		// CodexTmuxAdapter terminal sweep
	}
}

/** All markers for an execution (adapter awaiting_gate detection). */
export function listGateMarkersForExecution(
	dir: string,
	executionId: string,
): GateMarker[] {
	const resolvedDir = resolve(dir);
	let dirMtimeMs: number;
	try {
		const directory = statSync(resolvedDir);
		if (!directory.isDirectory()) {
			gateMarkerListCache.delete(resolvedDir);
			return [];
		}
		dirMtimeMs = directory.mtimeMs;
	} catch {
		gateMarkerListCache.delete(resolvedDir);
		return [];
	}
	const cachedDirectory = gateMarkerListCache.get(resolvedDir);
	if (
		cachedDirectory?.dirMtimeMs === dirMtimeMs &&
		!cachedDirectory.retryOnNextList
	) {
		cacheGateMarkerDirectory(resolvedDir, cachedDirectory);
		return markersForExecution(cachedDirectory, executionId);
	}

	let files: string[];
	try {
		files = readdirSync(resolvedDir);
	} catch {
		gateMarkerListCache.delete(resolvedDir);
		return [];
	}
	const nextFiles = new Map<string, CachedGateMarkerFile>();
	const markers: GateMarker[] = [];
	let retryOnNextList = false;
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const path = join(resolvedDir, file);
		let stats: ReturnType<typeof statSync>;
		try {
			stats = statSync(path);
		} catch (error) {
			// Capacity errors self-heal on the next poll. Structural errors such as
			// a dangling *.json symlink are ignored until the directory changes.
			retryOnNextList ||= isRetryableGateMarkerIoError(error);
			continue;
		}
		const cachedFile = cachedDirectory?.files.get(path);
		let marker: GateMarker | null;
		if (
			cachedFile?.mtimeMs === stats.mtimeMs &&
			cachedFile.size === stats.size
		) {
			marker = cachedFile.marker;
		} else {
			let contents: string;
			try {
				contents = readFileSync(path, "utf-8");
			} catch (error) {
				// Do not turn EMFILE/EIO-style transient failures into a permanent
				// negative cache entry with the same mtime and size. Stable structural
				// failures (EISDIR/ELOOP/EACCES) must not disable the warm path forever.
				if (isRetryableGateMarkerIoError(error)) {
					retryOnNextList = true;
					continue;
				}
				marker = null;
				nextFiles.set(path, {
					mtimeMs: stats.mtimeMs,
					size: stats.size,
					marker,
				});
				continue;
			}
			try {
				marker = JSON.parse(contents) as GateMarker;
			} catch {
				// Stable malformed JSON is safe to cache until the atomic writer
				// replaces the directory entry and advances its mtime.
				marker = null;
			}
		}
		nextFiles.set(path, {
			mtimeMs: stats.mtimeMs,
			size: stats.size,
			marker,
		});
		if (marker) markers.push(marker);
	}
	const nextDirectory = {
		dirMtimeMs,
		markers,
		files: nextFiles,
		retryOnNextList,
	};
	cacheGateMarkerDirectory(resolvedDir, nextDirectory);
	return markersForExecution(nextDirectory, executionId);
}

/**
 * FLY-142 (Option Y): ask-markers mirror the gate-marker mechanism for the
 * non-blocking `flywheel-comm ask`. They carry the asking runner's transport
 * vendor so a Lead `respond` can route the mailbox wake to the RIGHT backend
 * (Codex, not the env default) — the vendor-neutral fix for the GEO-371 wake.
 *
 * They live in an `ask/` SUBDIRECTORY of the marker dir so they are invisible
 * to the gate-marker machinery: `readGateMarker` looks at `<dir>/<id>.json` and
 * the adapter's `listGateMarkersForExecution` reads only `<dir>/*.json`
 * (non-recursive, skipping the `ask` directory entry). An unanswered ask is
 * therefore never misclassified as an awaiting-gate park, and the two wake
 * paths never collide.
 */
export interface AskMarker {
	questionId: string;
	/** The runner that asked — the wake target. */
	executionId: string;
	/** Transport vendor id of the asking runner (e.g. "codex"). */
	vendor: string;
	createdAt: string;
}

function askMarkerDir(dir: string): string {
	return join(dir, "ask");
}

export function writeAskMarker(
	dir: string,
	marker: Omit<AskMarker, "createdAt"> & { createdAt?: string },
): void {
	const adir = askMarkerDir(dir);
	mkdirSync(adir, { recursive: true, mode: 0o700 });
	const full: AskMarker = {
		...marker,
		createdAt: marker.createdAt ?? new Date().toISOString(),
	};
	writeFileSync(
		markerPath(adir, marker.questionId),
		JSON.stringify(full, null, 2),
		{ encoding: "utf-8", mode: 0o600 },
	);
}

export function readAskMarker(
	dir: string,
	questionId: string,
): AskMarker | undefined {
	const p = markerPathIfSafe(askMarkerDir(dir), questionId);
	if (!p || !existsSync(p)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(p, "utf-8")) as AskMarker;
		if (raw.questionId !== questionId) return undefined; // corrupted / mismatched
		return raw;
	} catch {
		return undefined;
	}
}

export function removeAskMarker(dir: string, questionId: string): void {
	try {
		rmSync(markerPath(askMarkerDir(dir), questionId), { force: true });
	} catch {
		// best-effort — orphaned ask-markers (ask never answered) are tiny; a
		// terminal sweep is a follow-up, mirroring gate-marker cleanup.
	}
}
