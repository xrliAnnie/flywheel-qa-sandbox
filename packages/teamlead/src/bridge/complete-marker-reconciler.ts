/**
 * FLY-172: Reconcile orphaned `flywheel-comm complete` fail-close markers.
 *
 * ## Why this exists
 * `flywheel-comm complete` (packages/flywheel-comm/src/commands/complete.ts) is
 * the Runner-driven `session_completed` emitter that `/spin` MUST call before
 * exiting (`.claude/commands/spin.md`). It POSTs to the STABLE Bridge `/events`
 * endpoint with 4 retries; if all fail (typically because a Flywheel restart had
 * the Bridge down for the ~tens-of-seconds completion window), it fail-closes by
 * writing a marker at `~/.flywheel/state/complete-failed/<execId>.json` carrying
 * the full `session_completed` body (route + evidence + PR number + summary).
 *
 * Nothing consumed that marker (complete.ts even has a comment lamenting the
 * missing "stale patrol"). So a Runner that genuinely finished — with its result
 * captured in the marker — would sit at `status=running` until its tmux window
 * died, then get force-failed by orphan reaping. False `failed`.
 *
 * ## What this does
 * Replays the marker's `session_completed` event back through the canonical
 * `/events` route via a loopback HTTP self-POST (Plan A — maximum parity with
 * the production ingest path: strict route guard, WorkflowFSM, post-ship
 * finalization, Lead notification, and `insertEvent` idempotency).
 *
 * Crucially, marker deletion is NOT based on HTTP 2xx: `/events` returns
 * `200 {ok,warning}` on invalid-route / FSM-reject, and inserts `event_id`
 * before the session update (so a same-id retry is a perpetual no-op). After
 * replay we re-read `store.getSession()` and verify it reached the status the
 * marker's payload PROVES (computed with the same mapping as `event-route.ts`),
 * and only then delete the marker. Anything ambiguous is quarantined.
 *
 * This module owns marker files + replay + verification ONLY. It does NOT probe
 * tmux and does NOT decide a session's fallback status — that is the caller's
 * job (HeartbeatService owns tmux liveness; see Codex design-review guidance #1),
 * so we never split-brain liveness decisions across the heartbeat loop.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "../applyTransition.js";
import type { StateStore } from "../StateStore.js";

/** Default marker directory — mirrors `flywheel-comm/complete.ts` writeMarker(). */
export function defaultMarkerDir(): string {
	return join(
		process.env.HOME ?? homedir(),
		".flywheel",
		"state",
		"complete-failed",
	);
}

/** Default quarantine directory for un-replayable markers. */
export function defaultQuarantineDir(): string {
	return join(
		process.env.HOME ?? homedir(),
		".flywheel",
		"state",
		"complete-failed-quarantine",
	);
}

const VALID_ROUTES = new Set(["auto_approve", "needs_review", "blocked"]);
const TERMINAL_STATUSES = new Set([
	"completed",
	"awaiting_review",
	"blocked",
	"failed",
]);

/**
 * Discriminated reconcile outcome (Codex R1 #4 / R2 #2). The caller force-fails
 * ONLY on `absent`; `transient_failed` blocks force-fail and retries later;
 * `reconciled`/`duplicate_terminal` mean the session reached its true terminal
 * status (caller deletes nothing else); `quarantined` means the marker file was
 * moved aside and the caller must choose a definite fallback status so no
 * "dead + stuck-in-running" session is left behind.
 */
export type ReconcileOutcome =
	| { kind: "absent" }
	| { kind: "reconciled"; status: string }
	| { kind: "duplicate_terminal"; status: string }
	| { kind: "transient_failed"; error: string }
	| {
			kind: "quarantined";
			reason: "duplicate_nonterminal" | "invalid" | "rejected";
			/** Status the marker payload INTENDED, for the caller's fallback. */
			routeStatus?: string;
			/** Where the marker was moved, for last_error breadcrumbs. */
			quarantinePath: string;
	  };

export interface MarkerReconcilerDeps {
	store: StateStore;
	/** Already-built loopback base URL, e.g. `http://127.0.0.1:9876` or `http://[::1]:9876`. */
	bridgeBaseUrl: string;
	ingestToken?: string;
	/** Injectable for tests; defaults to global fetch. */
	fetchFn?: typeof fetch;
	markerDir?: string;
	quarantineDir?: string;
	log?: (msg: string) => void;
}

/**
 * Build a loopback base URL from the Bridge's configured host + port, handling
 * IPv6 (`::1`) bracketing (Codex R1 #5). The replay MUST target the actual
 * listener, not a hardcoded `127.0.0.1`.
 */
export function buildLoopbackBaseUrl(host: string, port: number): string {
	const h = host.includes(":") ? `[${host}]` : host;
	return `http://${h}:${port}`;
}

type MarkerBody = {
	event_id: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	event_type: string;
	source?: string;
	payload?: {
		decision?: { route?: string };
		evidence?: { landingStatus?: { status?: string } };
		sessionRole?: string;
		[k: string]: unknown;
	};
};

/**
 * Compute the terminal status the marker's payload PROVES, using the EXACT same
 * mapping as `event-route.ts` `session_completed` branch (Codex R2 #6). Returns
 * `null` when the marker would be rejected by the strict route guard (invalid /
 * missing route with no post-approve-ship context), i.e. it cannot be replayed
 * into a known terminal state.
 */
export function expectedStatusFromMarker(
	body: MarkerBody,
	currentStatus: string | undefined,
): string | null {
	const route = body.payload?.decision?.route;
	const landing = body.payload?.evidence?.landingStatus?.status;
	const isPostApproveShip = currentStatus === "approved_to_ship";

	// Strict route guard parity: invalid/missing route is only allowed for the
	// natural-completion (post-approve-ship) path.
	if (!isPostApproveShip && (!route || !VALID_ROUTES.has(route))) {
		return null;
	}

	if (route === "needs_review" || route === "auto_approve") {
		if (landing === "merged") return "completed";
		// FLY-208 5a (Codex PR-2 R1 HIGH): /events now maps
		// approved_to_ship + needs_review/auto_approve WITHOUT merged landing
		// to "completed" (evidence-gap unstick) instead of the FSM-invalid
		// awaiting_review. This expectation copy MUST mirror it — the stale
		// "awaiting_review" expectation made tryReconcileComplete() quarantine
		// a correctly-reconciled marker, and applyQuarantineFallback() could
		// then force the successfully-unstuck session to "failed" on boot
		// drain (a false failure on the exact Bridge-down recovery path the
		// markers exist to protect).
		return isPostApproveShip ? "completed" : "awaiting_review";
	}
	if (route === "blocked") {
		return "blocked";
	}
	// route undefined here only reachable when isPostApproveShip — natural completion.
	return "completed";
}

function parseMarker(raw: string): MarkerBody | null {
	let obj: unknown;
	try {
		obj = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!obj || typeof obj !== "object") return null;
	const m = obj as Partial<MarkerBody>;
	if (
		typeof m.event_id !== "string" ||
		typeof m.execution_id !== "string" ||
		typeof m.issue_id !== "string" ||
		typeof m.project_name !== "string" ||
		m.event_type !== "session_completed"
	) {
		return null;
	}
	return m as MarkerBody;
}

/** Path-traversal guard for execId-derived filenames. */
function safeExecId(execId: string): boolean {
	return !/[/\\]|\.\./.test(execId) && execId.length > 0;
}

function moveToQuarantine(
	markerPath: string,
	quarantineDir: string,
	fileName: string,
	log: (m: string) => void,
): string {
	mkdirSync(quarantineDir, { recursive: true });
	const dest = join(quarantineDir, fileName);
	try {
		renameSync(markerPath, dest);
	} catch (err) {
		log(
			`[complete-reconciler] quarantine move failed ${markerPath} → ${dest}: ${(err as Error).message}`,
		);
	}
	return dest;
}

/**
 * Reconcile a single marker by execution id. Reads `<markerDir>/<execId>.json`,
 * replays it through `/events`, and verifies the session reached the marker's
 * proven terminal status before deleting. Does NOT touch session status on the
 * quarantine paths — returns the outcome so the caller applies a fallback with
 * its own tmux-liveness knowledge.
 */
export async function tryReconcileComplete(
	execId: string,
	deps: MarkerReconcilerDeps,
): Promise<ReconcileOutcome> {
	const log = deps.log ?? ((m: string) => console.log(m));
	const markerDir = deps.markerDir ?? defaultMarkerDir();
	const quarantineDir = deps.quarantineDir ?? defaultQuarantineDir();

	if (!safeExecId(execId)) return { kind: "absent" };

	const fileName = `${execId}.json`;
	const markerPath = join(markerDir, fileName);
	if (!existsSync(markerPath)) return { kind: "absent" };

	let raw: string;
	try {
		raw = readFileSync(markerPath, "utf8");
	} catch (err) {
		log(
			`[complete-reconciler] read failed ${markerPath}: ${(err as Error).message}`,
		);
		return { kind: "transient_failed", error: (err as Error).message };
	}

	const body = parseMarker(raw);
	if (!body) {
		const qp = moveToQuarantine(markerPath, quarantineDir, fileName, log);
		log(`[complete-reconciler] invalid marker quarantined: ${qp}`);
		return { kind: "quarantined", reason: "invalid", quarantinePath: qp };
	}

	// Filename execId must match payload execution_id (Codex R1 #7).
	if (body.execution_id !== execId) {
		const qp = moveToQuarantine(markerPath, quarantineDir, fileName, log);
		log(
			`[complete-reconciler] execId mismatch (file=${execId} payload=${body.execution_id}) quarantined: ${qp}`,
		);
		return { kind: "quarantined", reason: "invalid", quarantinePath: qp };
	}

	const currentStatus = deps.store.getSession(execId)?.status;
	const expectedStatus = expectedStatusFromMarker(body, currentStatus);
	if (expectedStatus === null) {
		// Strict route guard would 200+warning this — not replayable to a known
		// terminal state. Quarantine and let caller fallback.
		const qp = moveToQuarantine(markerPath, quarantineDir, fileName, log);
		log(
			`[complete-reconciler] unreplayable route quarantined ${execId}: ${qp}`,
		);
		return { kind: "quarantined", reason: "rejected", quarantinePath: qp };
	}

	// If already at expected terminal state, nothing to replay — just delete.
	if (currentStatus === expectedStatus) {
		safeUnlink(markerPath, log);
		return { kind: "duplicate_terminal", status: expectedStatus };
	}

	// Replay via loopback self-POST.
	const fetchFn = deps.fetchFn ?? fetch;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (deps.ingestToken) headers.Authorization = `Bearer ${deps.ingestToken}`;
	const replayBody = {
		event_id: body.event_id,
		execution_id: body.execution_id,
		issue_id: body.issue_id,
		project_name: body.project_name,
		event_type: body.event_type,
		source: body.source ?? "flywheel-comm",
		payload: body.payload ?? {},
	};

	let json: { ok?: boolean; duplicate?: boolean; warning?: string } | undefined;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5000);
		const res = await fetchFn(`${deps.bridgeBaseUrl}/events`, {
			method: "POST",
			headers,
			body: JSON.stringify(replayBody),
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (res.status >= 500 || res.status === 429) {
			return {
				kind: "transient_failed",
				error: `Bridge ${res.status}`,
			};
		}
		try {
			json = (await res.json()) as typeof json;
		} catch {
			json = undefined;
		}
		if (!res.ok) {
			// 4xx (non-429) — malformed request, won't succeed on retry.
			const qp = moveToQuarantine(markerPath, quarantineDir, fileName, log);
			log(
				`[complete-reconciler] replay 4xx (${res.status}) quarantined ${execId}: ${qp}`,
			);
			return {
				kind: "quarantined",
				reason: "rejected",
				routeStatus: expectedStatus,
				quarantinePath: qp,
			};
		}
	} catch (err) {
		// Network error / abort — Bridge unreachable. Keep marker, retry later.
		return { kind: "transient_failed", error: (err as Error).message };
	}

	// Re-read session and verify it reached the proven terminal status. Do NOT
	// trust HTTP 2xx (event-route returns 200+warning on FSM/route rejection).
	const afterStatus = deps.store.getSession(execId)?.status;
	if (afterStatus === expectedStatus) {
		safeUnlink(markerPath, log);
		return { kind: "reconciled", status: expectedStatus };
	}

	// Duplicate event_id but session never reached terminal — same-id retry is a
	// perpetual no-op (event-route returns early on duplicate). Quarantine.
	if (json?.duplicate) {
		const qp = moveToQuarantine(markerPath, quarantineDir, fileName, log);
		log(
			`[complete-reconciler] duplicate non-terminal quarantined ${execId} (status=${afterStatus}): ${qp}`,
		);
		return {
			kind: "quarantined",
			reason: "duplicate_nonterminal",
			routeStatus: expectedStatus,
			quarantinePath: qp,
		};
	}

	// 200 + warning (route guard / FSM rejected) — not replayable. Quarantine.
	const qp = moveToQuarantine(markerPath, quarantineDir, fileName, log);
	log(
		`[complete-reconciler] replay did not reach ${expectedStatus} (got ${afterStatus}, warning=${json?.warning}) quarantined ${execId}: ${qp}`,
	);
	return {
		kind: "quarantined",
		reason: "rejected",
		routeStatus: expectedStatus,
		quarantinePath: qp,
	};
}

function safeUnlink(path: string, log: (m: string) => void): void {
	try {
		unlinkSync(path);
	} catch (err) {
		log(
			`[complete-reconciler] delete failed ${path}: ${(err as Error).message}`,
		);
	}
}

/**
 * Apply the fallback terminal status for a quarantined marker (Codex R2 #3).
 * Used by both boot drain and the heartbeat reconcile pass. The caller decides
 * whether tmux is alive: when dead, the session is forced to a definite terminal
 * status (route's intended status, or `failed`) with a breadcrumb to the
 * quarantine path so no dead session is left stuck in `running`. When alive, the
 * session is left running (the Runner is still working; monitor-lost advisory
 * handles it).
 */
export function applyQuarantineFallback(args: {
	store: StateStore;
	transitionOpts?: ApplyTransitionOpts;
	executionId: string;
	issueId?: string;
	projectName?: string;
	tmuxAlive: boolean;
	routeStatus?: string;
	quarantinePath: string;
	log?: (m: string) => void;
}): void {
	const log = args.log ?? ((m: string) => console.log(m));
	if (args.tmuxAlive) {
		log(
			`[complete-reconciler] ${args.executionId}: marker quarantined but tmux alive — leaving running, advisory will fire`,
		);
		return;
	}
	const target =
		args.routeStatus && TERMINAL_STATUSES.has(args.routeStatus)
			? args.routeStatus
			: "failed";
	const now = new Date()
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
	const lastError = `complete reconcile failed, evidence quarantined at ${args.quarantinePath}`;

	// Codex R1 MEDIUM: prefer the canonical FSM/audit path when it allows the
	// transition (matches Codex design-review guidance #2). Only fall back to a
	// direct forced write when the FSM rejects — a genuine fail-close where a
	// dead Runner must NOT be left stuck in `running`.
	if (args.transitionOpts) {
		const result = applyTransition(
			args.transitionOpts,
			args.executionId,
			target,
			{
				executionId: args.executionId,
				issueId: args.issueId ?? "",
				projectName: args.projectName ?? "",
				trigger: "complete_marker_quarantine",
			},
			{ last_activity_at: now, last_error: lastError },
		);
		if (result.ok) {
			log(
				`[complete-reconciler] ${args.executionId}: dead + un-replayable marker → applyTransition status=${target}`,
			);
			return;
		}
		log(
			`[complete-reconciler] ${args.executionId}: FSM rejected ${target} (${result.error}) — fail-close forceStatus`,
		);
	}
	args.store.forceStatus(args.executionId, target, now, lastError);
	log(
		`[complete-reconciler] ${args.executionId}: dead + un-replayable marker → forced status=${target}`,
	);
}

/**
 * Boot drain (Codex R1 #2): scan the marker directory once on Bridge startup and
 * reconcile every marker. Markers written just before/around the restart are
 * replayed immediately so a completed Runner's status is corrected without
 * waiting for the heartbeat loop. Event-driven (boot event), no new timer.
 *
 * Quarantine fallback at boot probes tmux per-marker (boot is not the heartbeat
 * loop, so this does not split-brain the loop's single-owner liveness rule).
 */
export async function reconcileCompleteFailedMarkers(
	deps: MarkerReconcilerDeps & {
		transitionOpts?: ApplyTransitionOpts;
		isTmuxWindowAlive?: (tmuxWindow: string) => Promise<boolean>;
		getTmuxTarget?: (
			executionId: string,
			projectName: string,
		) => { tmuxWindow: string } | undefined;
	},
): Promise<{ scanned: number; reconciled: number; quarantined: number }> {
	const log = deps.log ?? ((m: string) => console.log(m));
	const markerDir = deps.markerDir ?? defaultMarkerDir();
	const result = { scanned: 0, reconciled: 0, quarantined: 0 };

	if (!existsSync(markerDir)) return result;

	let files: string[];
	try {
		files = readdirSync(markerDir).filter((f) => f.endsWith(".json"));
	} catch (err) {
		log(
			`[complete-reconciler] boot drain: cannot read ${markerDir}: ${(err as Error).message}`,
		);
		return result;
	}

	for (const file of files) {
		result.scanned += 1;
		const execId = file.replace(/\.json$/, "");
		const outcome = await tryReconcileComplete(execId, deps);
		if (
			outcome.kind === "reconciled" ||
			outcome.kind === "duplicate_terminal"
		) {
			result.reconciled += 1;
		} else if (outcome.kind === "quarantined") {
			result.quarantined += 1;
			// Boot fallback: probe tmux to choose a definite terminal status.
			let tmuxAlive = false;
			const session = deps.store.getSession(execId);
			if (
				session?.project_name &&
				deps.getTmuxTarget &&
				deps.isTmuxWindowAlive
			) {
				const target = deps.getTmuxTarget(execId, session.project_name);
				if (target) {
					try {
						tmuxAlive = await deps.isTmuxWindowAlive(target.tmuxWindow);
					} catch {
						tmuxAlive = false;
					}
				}
			}
			applyQuarantineFallback({
				store: deps.store,
				transitionOpts: deps.transitionOpts,
				executionId: execId,
				issueId: session?.issue_id,
				projectName: session?.project_name,
				tmuxAlive,
				routeStatus: outcome.routeStatus,
				quarantinePath: outcome.quarantinePath,
				log,
			});
		}
		// transient_failed / absent → leave for next boot or heartbeat cycle.
	}

	if (result.scanned > 0) {
		log(
			`[complete-reconciler] boot drain: scanned=${result.scanned} reconciled=${result.reconciled} quarantined=${result.quarantined}`,
		);
	}
	return result;
}
