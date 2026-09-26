/**
 * FLY-1018 — POST /api/ship-approval-request (plan §2.8).
 *
 * The request-shaped ship surface for gemini-agent: it files a
 * `ship_approval_request` lead event so a human can decide. It is the
 * agent's ONLY ship-adjacent action and carries ZERO ship authority:
 *
 *   - NO CommDB write, NO approve_to_ship gate/binding, NO
 *     verify-approval involvement — the real ship still goes through the
 *     owning runner's verified approve_to_ship + verify-approval chain.
 *   - Target Lead comes EXPLICITLY from the request's `leadId`, validated
 *     against `ProjectEntry(projectName).leads` — never invented, never
 *     leads[0] fallback, never a fabricated session identity (Codex R2-1
 *     + R3-1).
 *   - Outbox semantics (Codex R2-2 + R3-2): the lead event and the
 *     `ship_approval_requests` row commit in ONE StateStore transaction;
 *     runtime delivery starts only post-commit; a queued-but-undelivered
 *     event is redelivered by HeartbeatService (RETRYABLE_LEAD_EVENT_TYPES).
 *   - Idempotent per prUrl over 24h: row existence ⟺ durably queued, so
 *     a duplicate request answers 200 + already_pending instead of
 *     re-paging the founder; a failed transaction leaves no row, so a
 *     retry after 502 is never swallowed.
 *   - Tokenless deployments fail closed (Codex R1-4): apiToken not
 *     configured → 503 BEFORE the body is even parsed (plugin.ts
 *     founder-consent precedent).
 */

import { randomUUID } from "node:crypto";
import type express from "express";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import type { HookPayload } from "./hook-payload.js";
import type { LeadEventEnvelope, LeadRuntime } from "./lead-runtime.js";

const REQUESTER = "gemini-agent";
const SUMMARY_MAX = 2000;
const CONTEXT_MAX = 500;
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const GITHUB_PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;

export const SHIP_REQUEST_NOTE =
	"Ship approval requested. Nothing has been merged; founder approval and the owning runner's verified ship flow are still required.";

/** Minimal registry slice — resolves the runtime for an explicit leadId. */
export interface ShipApprovalRuntimeResolver {
	getForLead(agentId: string): LeadRuntime | undefined;
}

export interface ShipApprovalRouteDeps {
	store: StateStore;
	projects: ProjectEntry[];
	registry: ShipApprovalRuntimeResolver;
	/** Mirrors config.apiToken presence — tokenless deployments get 503. */
	apiTokenConfigured: boolean;
	now?: () => Date;
}

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

export function createShipApprovalHandler(
	deps: ShipApprovalRouteDeps,
): express.RequestHandler {
	return async (req, res) => {
		// Tokenless fail-closed — BEFORE parsing the body (Codex R1-4).
		if (!deps.apiTokenConfigured) {
			res
				.status(503)
				.json({ ok: false, error: "bridge api token not configured" });
			return;
		}

		const body = (req.body ?? {}) as Record<string, unknown>;
		const { prUrl, summary, projectName, leadId, requesterContext } = body;

		// 400 shapes follow the runs-route convention {success:false, message}.
		if (!isNonEmptyString(prUrl)) {
			res.status(400).json({ success: false, message: "prUrl is required" });
			return;
		}
		if (!GITHUB_PR_URL.test(prUrl)) {
			res.status(400).json({
				success: false,
				message:
					"prUrl must be a GitHub PR URL (https://github.com/<org>/<repo>/pull/<n>)",
			});
			return;
		}
		if (!isNonEmptyString(summary)) {
			res.status(400).json({ success: false, message: "summary is required" });
			return;
		}
		if (summary.length > SUMMARY_MAX) {
			res.status(400).json({
				success: false,
				message: `summary must be ${SUMMARY_MAX} chars or less`,
			});
			return;
		}
		if (!isNonEmptyString(projectName)) {
			res
				.status(400)
				.json({ success: false, message: "projectName is required" });
			return;
		}
		if (!isNonEmptyString(leadId)) {
			res.status(400).json({ success: false, message: "leadId is required" });
			return;
		}
		if (
			requesterContext !== undefined &&
			(typeof requesterContext !== "string" ||
				requesterContext.length > CONTEXT_MAX)
		) {
			res.status(400).json({
				success: false,
				message: `requesterContext must be a string of ${CONTEXT_MAX} chars or less`,
			});
			return;
		}

		// Lead target resolution — fail-closed (Codex R2-1 + R3-1). projectName
		// → Lead is NOT an invariant (one project, many leads): the target MUST
		// be the explicit leadId from the session binding, and it MUST belong
		// to the named project. No default Lead, no leads[0] fallback.
		const project = deps.projects.find((p) => p.projectName === projectName);
		if (!project) {
			res.status(400).json({
				success: false,
				message: `unknown projectName "${projectName}"`,
			});
			return;
		}
		const lead = project.leads.find((l) => l.agentId === leadId);
		if (!lead) {
			res.status(400).json({
				success: false,
				message: `leadId "${leadId}" is not a lead of project "${projectName}"`,
			});
			return;
		}

		// Idempotency (①): a committed row means the founder-visible event is
		// durably queued — don't re-page. Rows only exist when the transaction
		// below committed, so a 502'd attempt never blocks a retry.
		const existing = deps.store.findRecentShipApprovalRequest(
			prUrl,
			IDEMPOTENCY_WINDOW_MS,
		);
		if (existing) {
			res.status(200).json({
				ok: true,
				requestId: existing.requestId,
				already_pending: true,
				note: SHIP_REQUEST_NOTE,
			});
			return;
		}

		const requestId = randomUUID();
		const eventId = randomUUID();
		// Honest identity: this request has NO session and NO issue — the
		// payload never fabricates one (execution_id/issue_id stay empty).
		const payload: HookPayload = {
			event_type: "ship_approval_request",
			execution_id: "",
			issue_id: "",
			project_name: projectName,
			summary,
			pr_url: prUrl,
			requester: REQUESTER,
			...(isNonEmptyString(requesterContext) && {
				requester_context: requesterContext,
			}),
		};

		// Transactional outbox pair (②) — both writes or neither.
		let seq: number;
		try {
			seq = deps.store.recordShipApprovalRequest({
				requestId,
				prUrl,
				projectName,
				leadId,
				requester: REQUESTER,
				summary,
				eventId,
				payload: JSON.stringify(payload),
			});
		} catch (err) {
			console.error(
				`[ship-approval-request] failed to record request for ${prUrl}: ${(err as Error).message}`,
			);
			res.status(502).json({ ok: false, error: "failed to record request" });
			return;
		}

		// Post-commit runtime delivery — best effort; a failure here is owned
		// by the HeartbeatService redelivery loop (③), the request is already
		// accepted (durably queued).
		const envelope: LeadEventEnvelope = {
			seq,
			event: payload,
			sessionKey: "",
			leadId,
			timestamp: (deps.now?.() ?? new Date()).toISOString(),
		};
		try {
			const runtime = deps.registry.getForLead(leadId);
			if (!runtime) {
				deps.store.recordDeliveryFailure(
					seq,
					`no runtime registered for lead ${leadId}`,
				);
			} else {
				const result = await runtime.deliver(envelope);
				if (result.delivered) {
					deps.store.markLeadEventDelivered(seq);
				} else {
					deps.store.recordDeliveryFailure(
						seq,
						result.error ?? "runtime returned {delivered:false}",
					);
				}
			}
		} catch (err) {
			deps.store.recordDeliveryFailure(
				seq,
				`deliver threw: ${(err as Error).message}`,
			);
		}

		res.status(200).json({ ok: true, requestId, note: SHIP_REQUEST_NOTE });
	};
}
