/**
 * GEO-151 A5 — `flywheel-comm notify` command.
 *
 * Runner-side POST of an `artifact_emitted` event to Bridge after a
 * ProofShot capture has been Read by the Runner (V1 self-vision). Bridge
 * handler (A6 — `handleArtifactEvent`) picks it up and routes the
 * artifact paths through the Lead → Discord MCP for Annie.
 *
 * Identity resolution order (R6#2 / R7#2):
 *   1. CLI flags (--exec-id, --issue-id, --project-name, --dedup-key,
 *      --attempt)
 *   2. Manifest fields (from `--paths-from <manifest.json>`)
 *   3. FLYWHEEL_* env vars (matches stage / complete pattern)
 *   - Fail-closed if execId / issueId / projectName missing.
 *
 * For `kind='artifact'`, dedup_key + attempt are ALSO required (fail-closed)
 * — handleArtifactEvent uses them to correlate the delivery back to the
 * specific `session_params.proofshot.runs[dedupKey]` so it doesn't mark the
 * wrong run completed on stale artifacts.
 *
 * Wire shape: POST body uses snake_case (`dedup_key`, `attempt`, `issue_id`,
 * `project_name`) per §3.6.1 of the plan; TS-internal types use camelCase.
 *
 * Ordering:
 *   - PRIMARY: POST /events artifact_emitted. Non-2xx → exit code 2 so
 *     the Runner sees the failure and can retry.
 *   - AUDIT: CommDB row via `insertArtifactProgress(fromAgent, execId,
 *     paths)`. Fail-open — failure is stderr warn, exit code 0.
 *
 * Path safety:
 *   - `realpath()` resolves symlinks (rejects symlink escapes)
 *   - `~` expansion via $HOME
 *   - default allowlist: `^/Users/.+/\.flywheel/screens/`,
 *     `^/tmp/flywheel-screens/`
 *   - Caller can override via NotifyArgs.allowlist
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { CommDB } from "../db.js";

/**
 * Default allowlist. On macOS `realpathSync('/tmp/x')` resolves to
 * `/private/tmp/x` because /tmp is a symlink, so we accept both forms;
 * comparing against the resolved path is what catches symlink escapes
 * (a symlink inside `/tmp/flywheel-screens/` pointing at
 * `/Users/x/secrets/` resolves outside both prefixes → rejected).
 */
export const DEFAULT_NOTIFY_PATH_ALLOWLIST: readonly string[] = [
	"^/Users/.+/\\.flywheel/screens/",
	"^/tmp/flywheel-screens/",
	"^/private/tmp/flywheel-screens/",
];

export type NotifyKind = "artifact" | "status";

export interface NotifyArgs {
	kind: NotifyKind;
	/** Explicit paths (mutually exclusive with pathsFrom or additive). */
	paths?: string[];
	/** Read `selected[]` + identity from this manifest. */
	pathsFrom?: string;

	// Identity overrides (CLI > manifest > FLYWHEEL_* env)
	execId?: string;
	issueId?: string;
	projectName?: string;
	dedupKey?: string;
	attempt?: number | string;

	bridgeUrl?: string; // FLYWHEEL_BRIDGE_URL
	ingestToken?: string; // FLYWHEEL_INGEST_TOKEN
	dbPath: string;
	allowlist?: readonly string[];

	/** Test seam: override fetch. */
	fetchFn?: typeof fetch;
	/** Test seam: override realpath (e.g. when fixture files don't exist). */
	realpath?: (p: string) => string;
}

export interface NotifyResult {
	exitCode: 0 | 2;
	posted: boolean;
	auditWritten: boolean;
	resolvedPaths: string[];
}

export interface ResolvedNotifyIdentity {
	execId: string;
	issueId: string;
	projectName: string;
	dedupKey: string | null;
	attempt: number | null;
}

/**
 * Validate `attempt` as a finite positive integer. Accepts numeric strings
 * ("1" → 1). Returns null on anything else so the caller can fail-closed
 * for `kind='artifact'` (R7#5).
 */
export function parseAttempt(raw: unknown): number | null {
	if (typeof raw === "number") {
		if (Number.isFinite(raw) && Number.isInteger(raw) && raw >= 1) return raw;
		return null;
	}
	if (typeof raw === "string" && /^\d+$/.test(raw)) {
		const n = Number(raw);
		return n >= 1 ? n : null;
	}
	return null;
}

/** Resolve identity from CLI > manifest > FLYWHEEL_* env. Fail-closed. */
export function resolveNotifyIdentity(
	args: NotifyArgs,
	manifest: Record<string, unknown> | null,
): ResolvedNotifyIdentity {
	const execId =
		args.execId ??
		(manifest?.execId as string | undefined) ??
		process.env.FLYWHEEL_EXEC_ID;
	const issueId =
		args.issueId ??
		(manifest?.issue_id as string | undefined) ??
		process.env.FLYWHEEL_ISSUE_ID;
	const projectName =
		args.projectName ??
		(manifest?.project_name as string | undefined) ??
		process.env.FLYWHEEL_PROJECT_NAME;

	if (!execId || !issueId || !projectName) {
		throw new Error(
			`notify: missing identity — execId=${execId ?? "(unset)"} issueId=${issueId ?? "(unset)"} projectName=${projectName ?? "(unset)"}. Provide via CLI flag, manifest, or FLYWHEEL_* env.`,
		);
	}

	const dedupKey =
		args.dedupKey ?? (manifest?.dedup_key as string | undefined) ?? null;
	const attemptRaw = args.attempt ?? manifest?.attempt;
	const attempt = parseAttempt(attemptRaw);

	if (args.kind === "artifact") {
		if (!dedupKey) {
			throw new Error(
				"notify: kind=artifact requires --dedup-key (or manifest.dedup_key)",
			);
		}
		if (attempt === null) {
			throw new Error(
				`notify: kind=artifact requires positive integer --attempt (got: ${String(attemptRaw)})`,
			);
		}
	}

	return { execId, issueId, projectName, dedupKey, attempt };
}

/**
 * Resolve, validate, and POST. Throws on identity/path validation failures
 * (Runner sees the error message). Returns `{exitCode, posted, auditWritten}`
 * so the CLI can `process.exit(result.exitCode)`.
 */
export async function notify(args: NotifyArgs): Promise<NotifyResult> {
	const fetchImpl = args.fetchFn ?? fetch;
	const realpath = args.realpath ?? realpathSync;
	const allowlist = args.allowlist ?? DEFAULT_NOTIFY_PATH_ALLOWLIST;

	// Resolve bridgeUrl (R9#1 — fail-closed if missing).
	const bridgeUrl = args.bridgeUrl ?? process.env.FLYWHEEL_BRIDGE_URL;
	if (!bridgeUrl) {
		throw new Error(
			"notify: FLYWHEEL_BRIDGE_URL missing — set env or pass --bridge-url",
		);
	}

	// Resolve paths from manifest or explicit args.
	let manifest: Record<string, unknown> | null = null;
	let rawPaths: string[] = args.paths ?? [];
	if (args.pathsFrom) {
		if (!existsSync(args.pathsFrom)) {
			throw new Error(`notify: manifest not found at ${args.pathsFrom}`);
		}
		manifest = JSON.parse(readFileSync(args.pathsFrom, "utf-8")) as Record<
			string,
			unknown
		>;
		const selected = manifest.selected;
		if (Array.isArray(selected)) {
			rawPaths = (selected as unknown[]).filter(
				(p): p is string => typeof p === "string",
			);
		}
	}
	if (rawPaths.length === 0) {
		throw new Error("notify: no paths to notify (manifest.selected empty)");
	}

	const identity = resolveNotifyIdentity(args, manifest);

	// Normalize + validate paths.
	const allowlistRe = allowlist.map((p) => new RegExp(p));
	const expanded: string[] = [];
	for (const p of rawPaths) {
		const resolved = realpath(expandTilde(p));
		// Allowlist check on the resolved (post-symlink) path so a symlink
		// inside the allowed dir pointing elsewhere gets rejected.
		if (!allowlistRe.some((rx) => rx.test(resolved))) {
			throw new Error(`notify: path not in allowlist: ${resolved}`);
		}
		expanded.push(resolved);
	}

	// PRIMARY — POST /events.
	const eventBody = {
		event_id: cryptoRandomUuid(),
		execution_id: identity.execId,
		issue_id: identity.issueId,
		project_name: identity.projectName,
		event_type: "artifact_emitted",
		source: "flywheel-comm",
		payload: {
			kind: args.kind,
			paths: expanded,
			dedup_key: identity.dedupKey,
			attempt: identity.attempt,
		},
	};
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	const token = args.ingestToken ?? process.env.FLYWHEEL_INGEST_TOKEN;
	if (token) headers.Authorization = `Bearer ${token}`;

	const url = `${bridgeUrl.replace(/\/+$/, "")}/events`;
	let postedOk = false;
	try {
		const res = await fetchImpl(url, {
			method: "POST",
			headers,
			body: JSON.stringify(eventBody),
		});
		postedOk = res.ok;
		if (!res.ok) {
			console.error(
				`notify: POST ${url} returned ${res.status} ${res.statusText}`,
			);
		}
	} catch (err) {
		console.error(
			`notify: POST ${url} threw: ${err instanceof Error ? err.message : String(err)}`,
		);
		postedOk = false;
	}

	// AUDIT — CommDB row (fail-open). createIfMissing=true (default) so a
	// fresh per-project DB gets initialized on first notify.
	let auditWritten = false;
	try {
		const db = new CommDB(args.dbPath);
		try {
			db.insertArtifactProgress("runner", identity.execId, expanded);
			auditWritten = true;
		} finally {
			db.close();
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[notify] CommDB audit write failed (fail-open): ${msg}`);
	}

	return {
		exitCode: postedOk ? 0 : 2,
		posted: postedOk,
		auditWritten,
		resolvedPaths: expanded,
	};
}

function expandTilde(p: string): string {
	if (p === "~" || p.startsWith("~/")) {
		const home = process.env.HOME ?? "";
		return p.replace(/^~/, home);
	}
	return p;
}

function cryptoRandomUuid(): string {
	// node:crypto.randomUUID via dynamic require to keep this file lightweight
	// at import time. globalThis.crypto.randomUUID is available in Node 22+.
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	// Fallback (very unlikely)
	return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
