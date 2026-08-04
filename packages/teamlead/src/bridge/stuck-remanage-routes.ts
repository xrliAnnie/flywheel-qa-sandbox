/**
 * Lead-facing detection acknowledgement and restricted runner recovery routes.
 * Detection acknowledgements are scoped to the owning Lead. Recovery nudges
 * keep their allowlist, live-state gates, and audit trail.
 */

import { createHash } from "node:crypto";
import { type RequestHandler, Router } from "express";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { hasPendingGateFromCommDb } from "./commdb-probes.js";
// FLY-1282 Part D: prepare-time receipt copy (final content is built at the
// disposition route; delivery never reconstructs semantics).
import { formatDispositionReceipt } from "./disposition-receipt.js";
import { matchesLead } from "./lead-scope.js";
// FLY-368: the recovery-nudge gates + audit-before-send now live in a shared,
// audited operation reused by BOTH this route and the auto-repair bot. Gate-4's
// capture/fingerprint/input-box checks moved there too (their imports left this
// file with them).
import {
	attemptRunnerRecoveryNudge,
	NUDGE_ALLOWLIST as SHARED_NUDGE_ALLOWLIST,
} from "./runner-recovery-nudge.js";
import {
	getTmuxTargetFromCommDb,
	sendKeysToWindow,
	type TmuxTarget,
} from "./tmux-lookup.js";
import type { CaptureSessionFn } from "./tools.js";

/** The ONLY phrases the recovery nudge may type (plan §3.5). Re-exported from
 * the shared operation so there is a single source of truth (FLY-368). */
export const NUDGE_ALLOWLIST: readonly string[] = SHARED_NUDGE_ALLOWLIST;

export interface StuckRemanageRouterOptions {
	store: StateStore;
	projects: ProjectEntry[];
	captureSessionFn: CaptureSessionFn;
	/**
	 * Auth middleware applied to BOTH routes (Bridge passes
	 * tokenAuthMiddleware). Per-route on purpose: mounting it prefix-wide on
	 * /api/sessions would leak auth onto unrelated later-mounted layers.
	 */
	auth?: RequestHandler;
	/** Injectable for tests; defaults to the CommDB probe. */
	hasPendingGate?: (executionId: string, projectName: string) => boolean;
	/** Injectable for tests; defaults to tmux send-keys. */
	sendKeys?: (
		tmuxWindow: string,
		text: string,
	) => Promise<{ sent: boolean; error?: string }>;
	/** Injectable for tests; defaults to the CommDB tmux target lookup. */
	getTmuxTarget?: (
		executionId: string,
		projectName: string,
	) => TmuxTarget | undefined;
	now?: () => number;
}

export interface LeadDetectionAckRouterOptions {
	store: StateStore;
	projects: ProjectEntry[];
	auth?: RequestHandler;
	now?: () => number;
}

function resolveDetectionEpisode(
	store: StateStore,
	targetKey: string,
	kind: string,
	episodeReference: string,
) {
	return (
		store.getDetectionEscalation(targetKey, kind, episodeReference) ??
		store.getDetectionEscalationBySourceReceiptId(
			targetKey,
			kind,
			episodeReference,
		)
	);
}

function boundedEpisodeReference(
	fingerprint: string,
	parentId?: string | null,
): string {
	if (parentId) return parentId;
	if (fingerprint.length <= 200) return fingerprint;
	return `sha256:${createHash("sha256").update(fingerprint).digest("hex")}`;
}

/**
 * FLY-1448 E3: lead-keyed detection rows have no Session and therefore cannot
 * use the execution-scoped route below. The target key is always derived from
 * the configured (project, lead) pair; accepting a caller-provided raw key
 * would be a cross-project acknowledgement primitive.
 */
export function createLeadDetectionAckRouter(
	opts: LeadDetectionAckRouterOptions,
): Router {
	const router = Router();
	const auth: RequestHandler = opts.auth ?? ((_req, _res, next) => next());
	const now = opts.now ?? Date.now;
	router.post("/:leadId/detection-ack", auth, (req, res) => {
		const leadId = (req.params.leadId as string | undefined)?.trim() ?? "";
		const body = (req.body ?? {}) as {
			projectName?: unknown;
			kind?: unknown;
			episode_fingerprint?: unknown;
			disposition?: unknown;
			target_key?: unknown;
			targetKey?: unknown;
		};
		if (Object.hasOwn(body, "target_key") || Object.hasOwn(body, "targetKey")) {
			res
				.status(400)
				.json({ error: "raw detection target keys are forbidden" });
			return;
		}
		const projectName =
			typeof body.projectName === "string" ? body.projectName.trim() : "";
		const kind = typeof body.kind === "string" ? body.kind.trim() : "";
		const fingerprint =
			typeof body.episode_fingerprint === "string"
				? body.episode_fingerprint.trim()
				: "";
		const disposition = body.disposition;
		if (!leadId || !projectName || !kind || kind.length > 100) {
			res.status(400).json({
				error: "leadId path, projectName, and kind are required",
			});
			return;
		}
		if (!fingerprint) {
			res.status(400).json({ error: "episode_fingerprint is required" });
			return;
		}
		if (
			disposition !== "ack" &&
			disposition !== "resolve" &&
			disposition !== "dismiss"
		) {
			res.status(400).json({
				error: "disposition must be one of: ack, resolve, dismiss",
			});
			return;
		}

		const projectMatches = opts.projects.filter(
			(project) => project.projectName === projectName,
		);
		if (projectMatches.length !== 1) {
			res
				.status(projectMatches.length === 0 ? 404 : 409)
				.json({ error: "project is unknown or ambiguous" });
			return;
		}
		const leadMatches = projectMatches[0]!.leads.filter(
			(lead) => lead.agentId === leadId,
		);
		if (leadMatches.length !== 1) {
			res
				.status(leadMatches.length === 0 ? 404 : 409)
				.json({ error: "lead is unknown or ambiguous in project" });
			return;
		}

		const targetKey = `${projectName}:${leadId}`;
		const row = resolveDetectionEpisode(
			opts.store,
			targetKey,
			kind,
			fingerprint,
		);
		if (!row) {
			res.status(404).json({
				error:
					fingerprint.length > 200
						? "episode_fingerprint is too long and no exact legacy detection episode was found"
						: "detection episode not found",
			});
			return;
		}
		if (!row.owner_lead_id || row.owner_lead_id !== leadId) {
			res.status(403).json({ error: "detection episode owner mismatch" });
			return;
		}

		try {
			const outcome = opts.store.ackDetectionEscalationWithReceipt(
				targetKey,
				kind,
				row.episode_fingerprint,
				{
					atMs: now(),
					disposition,
					receipt: {
						actorLeadId: leadId,
						rawDisposition: disposition,
						content: formatDispositionReceipt({
							actorLeadId: leadId,
							kind,
							rawDisposition: disposition,
						}),
						executionId: targetKey,
						projectName,
					},
				},
			);
			const settled = opts.store.getDetectionEscalation(
				targetKey,
				kind,
				row.episode_fingerprint,
			);
			res.json({
				ok: true,
				status: settled?.status ?? row.status,
				receiptPrepared: outcome.receiptPrepared,
			});
		} catch (error) {
			console.error(
				`[lead-detection-ack] transactional ack failed for ${targetKey}: ${(error as Error).message}`,
			);
			res.status(500).json({ error: "detection ack persist failed" });
		}
	});
	return router;
}

export function createStuckRemanageRouter(
	opts: StuckRemanageRouterOptions,
): Router {
	const { store, projects, captureSessionFn } = opts;
	const hasPendingGate = opts.hasPendingGate ?? hasPendingGateFromCommDb;
	const sendKeys = opts.sendKeys ?? sendKeysToWindow;
	const getTmuxTarget = opts.getTmuxTarget ?? getTmuxTargetFromCommDb;
	const now = opts.now ?? (() => Date.now());
	const auth: RequestHandler = opts.auth ?? ((_req, _res, next) => next());
	// Audit event_ids carry a monotonic uniquifier: two attempts in the same
	// millisecond must NOT collide on the session_events UNIQUE(event_id)
	// constraint — that would silently drop an audit row (Codex R1 HIGH-2:
	// EVERY nudge attempt is audited).
	let auditSeq = 0;
	const router = Router();

	// ── FLY-1048 PR-C (C3-w): detection-escalation ACK ──
	// The Lead's disposition receipt for a UNIFIED-flow episode:
	// ack → ACKED (grace timer disarmed), resolve/dismiss → RESOLVED.
	// Authorization is enforced by route auth plus the required Lead/session
	// ownership checks below.
	router.post("/:executionId/detection-ack", auth, (req, res) => {
		const executionId = req.params.executionId as string;
		const body = (req.body ?? {}) as {
			leadId?: string;
			kind?: string;
			episode_fingerprint?: string;
			disposition?: string;
		};

		const leadId = typeof body.leadId === "string" ? body.leadId.trim() : "";
		if (!leadId) {
			res.status(400).json({ error: "leadId is required in request body" });
			return;
		}
		const kind = typeof body.kind === "string" ? body.kind.trim() : "";
		if (!kind || kind.length > 100) {
			res.status(400).json({
				error:
					"kind is required (the detection kind from the escalation event)",
			});
			return;
		}
		// Detection fingerprints are kind-specific opaque strings (NOT always the
		// 16-hex pane fingerprint). Legacy receipt chains can exceed 200 chars, so
		// presence is the only request-side bound; Express already caps body size.
		const fingerprint =
			typeof body.episode_fingerprint === "string"
				? body.episode_fingerprint.trim()
				: "";
		if (!fingerprint) {
			res.status(400).json({
				error:
					"episode_fingerprint is required (from the detection_escalation event)",
			});
			return;
		}
		const disposition = body.disposition;
		if (
			disposition !== "ack" &&
			disposition !== "resolve" &&
			disposition !== "dismiss"
		) {
			res.status(400).json({
				error: "disposition must be one of: ack, resolve, dismiss",
			});
			return;
		}

		const session = store.getSession(executionId);
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return;
		}
		try {
			if (!matchesLead(session, leadId, projects)) {
				res.status(403).json({
					error: `Session ${executionId} is outside lead "${leadId}" scope`,
				});
				return;
			}
		} catch (err) {
			res.status(403).json({
				error: `Lead scope check failed: ${(err as Error).message}`,
			});
			return;
		}

		const row = resolveDetectionEpisode(store, executionId, kind, fingerprint);
		if (!row) {
			res.status(404).json({
				error:
					fingerprint.length > 200
						? "episode_fingerprint is too long and no exact legacy detection episode was found"
						: `No detection episode for (${executionId}, ${kind}, ${fingerprint})`,
			});
			return;
		}

		// FLY-1282 Part D: the ack + the disposition-receipt prepare commit in
		// ONE transaction (a committed ack must never be missing its receipt
		// row). changed=false (already RESOLVED — e.g. a recovery beat the
		// Lead) prepares nothing: the first via:'lead' disposition wins.
		let ackOutcome: { changed: boolean; receiptPrepared: boolean };
		try {
			ackOutcome = store.ackDetectionEscalationWithReceipt(
				executionId,
				kind,
				row.episode_fingerprint,
				{
					atMs: now(),
					disposition,
					receipt: {
						actorLeadId: leadId,
						rawDisposition: disposition,
						content: formatDispositionReceipt({
							actorLeadId: leadId,
							kind,
							rawDisposition: disposition,
						}),
						executionId,
						projectName: session.project_name,
					},
				},
			);
		} catch (err) {
			console.error(
				`[detection-ack] transactional ack failed for ${executionId}: ${(err as Error).message}`,
			);
			res.status(500).json({
				error: `detection ack persist failed: ${(err as Error).message}`,
			});
			return;
		}
		const status = disposition === "ack" ? "ACKED" : "RESOLVED";
		// Trace row is secondary — the detection_escalations status above IS the
		// authoritative record; the trace below is secondary.
		try {
			store.insertEvent({
				event_id: `detection-ack-${executionId}-${kind}-${now()}-${++auditSeq}`,
				execution_id: executionId,
				issue_id: session.issue_id,
				project_name: session.project_name,
				event_type: "detection_escalation_disposition",
				source: "bridge.stuck-remanage",
				payload: {
					leadId,
					kind,
					fingerprint: boundedEpisodeReference(
						row.episode_fingerprint,
						row.source_receipt_id,
					),
					disposition,
					status,
				},
			});
		} catch (err) {
			console.error(
				`[detection-ack] trace event write failed for ${executionId}: ${(err as Error).message}`,
			);
		}
		res.json({
			ok: true,
			status,
			// FLY-1282 Part D: surfaced so the Lead can see whether this
			// disposition earned the (first) receipt for the episode generation.
			receiptPrepared: ackOutcome.receiptPrepared,
		});
	});

	// ── Restricted recovery nudge (plan §3.5) ──
	// FLY-368: the gates + audit-before-send now live in the shared, audited
	// `attemptRunnerRecoveryNudge` operation (reused by the auto-repair bot). This
	// route is a thin HTTP adapter over it — behavior is unchanged.
	router.post("/:executionId/recovery-nudge", auth, async (req, res) => {
		const body = (req.body ?? {}) as {
			leadId?: string;
			episode_fingerprint?: string;
			phrase?: string;
		};
		const outcome = await attemptRunnerRecoveryNudge(
			{
				actor: "lead",
				executionId: req.params.executionId as string,
				leadId: typeof body.leadId === "string" ? body.leadId : "",
				fingerprint: body.episode_fingerprint,
				phrase: body.phrase,
			},
			{
				store,
				projects,
				captureSessionFn,
				hasPendingGate,
				sendKeys,
				getTmuxTarget,
				now,
				nextAuditSeq: () => ++auditSeq,
			},
		);
		res.status(outcome.status).json(outcome.body);
	});

	return router;
}
