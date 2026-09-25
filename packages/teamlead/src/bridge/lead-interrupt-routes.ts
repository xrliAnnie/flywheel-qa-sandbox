/**
 * FLY-2883 — controlled Lead interrupt HTTP surface.
 *
 * Voice side (mounted under /api/voice/sessions, daemon tier + live lease):
 *   POST /:sessionId/lead-interrupts                 — initiate
 *   GET  /:sessionId/lead-interrupts/:interruptId    — read back the reply
 *
 * Write order is fixed (plan §4.1): segment 1 = record + audit in one
 * transaction (failure → 503, nothing sent); segment 2 = one urgent CommDB
 * letter; segment 3 = requested → queued. Only segment 1 success can ever be
 * followed by a side effect.
 */

import type { RequestHandler } from "express";
import { CommDB } from "flywheel-comm/db";
import { parseChatDeliveryEnvelope } from "flywheel-comm/discord-chat-ingest";
import type {
	EnqueueMailboxInput,
	EnqueueMailboxResult,
	MailboxSettlement,
} from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { z } from "zod";
import { effectiveLeadBackend } from "../lead-backends/lead-backend.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore, VoiceSessionRow } from "../StateStore.js";
import {
	LEAD_INTERRUPT_BODY_MAX_CODE_POINTS,
	LEAD_INTERRUPT_FROM_PREFIX,
	LEAD_INTERRUPT_MESSAGE_TYPE,
	LEAD_INTERRUPT_SOURCE_KIND,
	type LeadInterruptBackend,
	leadInterruptRequestDigest,
	newLeadInterruptId,
	normalizeInterruptText,
	renderLeadInterruptLetter,
	sha256Hex,
} from "./lead-interrupt-contract.js";
import type { LeadInterruptRow } from "./lead-interrupt-store.js";

/** The subset of MailboxQueue the controlled route needs (one per project). */
export interface LeadInterruptMailbox {
	enqueue(input: EnqueueMailboxInput): EnqueueMailboxResult;
	inspectDeliveryState(idOrDeliveryId: string): MailboxSettlement;
	ack(idOrDeliveryId: string, now: string): boolean;
}

export interface LeadInterruptVoiceDeps {
	store: StateStore;
	/** Registered Lead identity only; runners and unknown ids resolve undefined. */
	resolveTarget: (
		projectName: string,
		leadId: string,
	) => { backend: LeadInterruptBackend } | undefined;
	verifyFounderQuote: (input: {
		session: VoiceSessionRow;
		founderMessageId: string;
	}) => boolean;
	mailboxForProject: (projectName: string) => LeadInterruptMailbox | undefined;
	/** Best-effort latency hint; CommDB stays the authority. */
	nudgeLead?: (projectName: string, leadId: string) => void;
	now?: () => string;
	newInterruptId?: () => string;
	logger?: { warn: (message: string) => void };
}

export interface LeadInterruptVoiceHandlers {
	create: RequestHandler;
	get: RequestHandler;
}

const OPEN_WINDOW_MS = 30 * 60_000;
const BURST_WINDOW_MS = 10 * 60_000;
const BURST_LIMIT = 3;
const LIVE_SESSION_STATES = new Set(["claimed", "warming", "live"]);

const createRequestSchema = z
	.object({
		targetProject: z.string().min(1).max(64),
		targetLeadId: z.string().min(1).max(64),
		founderMessageId: z.string().regex(/^\d{17,20}$/),
		body: z.string(),
		idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/),
	})
	.strict();

class RouteRefusal extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
	) {
		super(code);
	}
}

function param(value: string | string[] | undefined): string {
	return typeof value === "string" ? value : "";
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Founder-quote check: the voice session's own CommDB must hold the chat-ingest
 * row `chat:<session lead>:<messageId>` (live or archived), ingested from this
 * voice session and authored by the founder.
 */
export function createCommDbFounderQuoteVerifier(input: {
	commDbPathForProject: (projectName: string) => string;
	founderUserId: string | undefined;
}): LeadInterruptVoiceDeps["verifyFounderQuote"] {
	return ({ session, founderMessageId }) => {
		if (!input.founderUserId) return false;
		// chatDeliveryId() in flywheel-comm/chat-delivery-envelope.
		const deliveryId = `chat:${session.leadId}:${founderMessageId}`;
		let db: CommDB | undefined;
		try {
			db = CommDB.openReadonly(input.commDbPathForProject(session.projectName));
			const state = db.inspectMailboxDeliveryState(deliveryId);
			if (state.kind === "absent_identity" || state.kind === "torn_identity")
				return false;
			const content = db.inspectMailboxDeliveryContent(deliveryId);
			if (!content) return false;
			const envelope = parseChatDeliveryEnvelope(content);
			return (
				envelope.origin === "voice" &&
				envelope.voiceSessionId === session.sessionId &&
				envelope.authorId === input.founderUserId &&
				envelope.messageId === founderMessageId
			);
		} catch {
			return false;
		} finally {
			db?.close();
		}
	};
}

/**
 * Targets resolve only from the Bridge's Lead registry, with the same backend
 * precedence the inbox loop uses. Runner ids and unknown ids never resolve.
 */
export function createProjectLeadTargetResolver(
	projects: readonly ProjectEntry[],
	env: Readonly<Record<string, string | undefined>> = process.env,
): LeadInterruptVoiceDeps["resolveTarget"] {
	return (projectName, leadId) => {
		const matches = projects
			.filter((project) => project.projectName === projectName)
			.flatMap((project) =>
				project.leads.filter((lead) => lead.agentId === leadId),
			);
		if (matches.length !== 1) return undefined;
		return {
			backend: effectiveLeadBackend(
				matches[0]!.backend,
				env.FLYWHEEL_LEAD_BACKEND,
			).backend,
		};
	};
}

function letterFor(row: LeadInterruptRow): string {
	return renderLeadInterruptLetter({
		interruptId: row.interruptId,
		voiceSessionId: row.initiatorRef,
		founderMessageId: row.founderMessageId,
		body: row.body,
	});
}

export function leadInterruptEnqueueInput(
	row: LeadInterruptRow,
): EnqueueMailboxInput {
	return {
		id: row.deliveryId,
		deliveryId: row.deliveryId,
		fromAgent: `${LEAD_INTERRUPT_FROM_PREFIX}${row.interruptId}`,
		toAgent: row.targetLeadId,
		recipientKind: "lead",
		sourceKind: LEAD_INTERRUPT_SOURCE_KIND,
		sourceRef: row.interruptId,
		type: LEAD_INTERRUPT_MESSAGE_TYPE,
		msgClass: "model",
		priority: 0,
		content: letterFor(row),
		// Identical on every replay so the mailbox identity hash matches.
		createdAt: row.createdAt,
		senderRef: encodeSenderRef(),
	};
}

export function createLeadInterruptVoiceHandlers(
	deps: LeadInterruptVoiceDeps,
): LeadInterruptVoiceHandlers {
	const now = deps.now ?? (() => new Date().toISOString());
	const newId = deps.newInterruptId ?? newLeadInterruptId;
	const warn = (message: string) =>
		(deps.logger ?? console).warn(`[lead-interrupt] ${message}`);

	const refuse = (input: {
		interruptId: string;
		session: VoiceSessionRow;
		founderMessageId: string;
		targetProject: string;
		targetLeadId: string;
		bodyDigest: string | null;
		code: string;
		at: string;
	}) => {
		try {
			deps.store.leadInterrupts.appendAudit({
				interruptId: input.interruptId,
				event: "refused",
				initiatorKind: "voice_session",
				initiatorRef: input.session.sessionId,
				founderMessageId: input.founderMessageId,
				targetProject: input.targetProject,
				targetLeadId: input.targetLeadId,
				bodyDigest: input.bodyDigest,
				detail: input.code,
				now: input.at,
			});
		} catch (error) {
			// Nothing is sent on a refusal either way.
			warn(`refusal audit failed: ${describe(error)}`);
		}
	};

	/** Segments 2 and 3 for a row in `requested`; returns the row afterwards. */
	const deliver = (row: LeadInterruptRow): LeadInterruptRow => {
		const mailbox = deps.mailboxForProject(row.targetProject);
		let result: EnqueueMailboxResult;
		try {
			if (!mailbox) throw new Error("mailbox_unavailable");
			result = mailbox.enqueue(leadInterruptEnqueueInput(row));
		} catch (error) {
			warn(`enqueue failed for ${row.interruptId}: ${describe(error)}`);
			try {
				deps.store.leadInterrupts.transition({
					interruptId: row.interruptId,
					from: ["requested"],
					to: "failed",
					event: "enqueue_failed",
					detail: "mailbox_threw",
					now: now(),
				});
			} catch (stateError) {
				warn(
					`failed-state commit failed for ${row.interruptId}: ${describe(stateError)}`,
				);
				throw new RouteRefusal(503, "state_commit_failed");
			}
			throw new RouteRefusal(502, "mailbox_unavailable");
		}
		const at = now();
		try {
			if (result.outcome === "archived") {
				// Only reachable on a replay: the letter already reached a terminal
				// state. Reconcile instead of claiming a fresh delivery (R2#2).
				const settled = mailbox!.inspectDeliveryState(row.deliveryId);
				const terminal =
					settled.kind === "archived_terminal" || settled.kind === "live"
						? settled.state
						: undefined;
				if (terminal === "ACKED") {
					deps.store.leadInterrupts.transition({
						interruptId: row.interruptId,
						from: ["requested"],
						to: "delivered",
						event: "mailbox_only",
						detail: "reconciled_acked",
						disposition: "mailbox_only",
						dispositionReason: "reconciled_acked",
						now: at,
					});
				} else if (terminal === "DEAD") {
					deps.store.leadInterrupts.transition({
						interruptId: row.interruptId,
						from: ["requested"],
						to: "failed",
						event: "enqueue_failed",
						detail: "letter_dead",
						now: at,
					});
				} else {
					throw new Error(`archived letter state unknown: ${settled.kind}`);
				}
			} else {
				deps.store.leadInterrupts.transition({
					interruptId: row.interruptId,
					from: ["requested"],
					to: "queued",
					event: "enqueued",
					now: at,
				});
			}
		} catch (error) {
			// The letter is in the mailbox; the delivery loop will not act on it
			// until the row leaves `requested` (it completes that itself).
			warn(`state commit failed for ${row.interruptId}: ${describe(error)}`);
			throw new RouteRefusal(503, "state_commit_failed");
		}
		const updated = deps.store.leadInterrupts.get(row.interruptId);
		if (!updated) throw new RouteRefusal(503, "state_commit_failed");
		return updated;
	};

	const respondWithRow = (
		res: Parameters<RequestHandler>[1],
		row: LeadInterruptRow,
	) => {
		if (row.state === "failed") {
			res.status(502).json({
				error: "lead_interrupt_failed",
				interruptId: row.interruptId,
				state: row.state,
			});
			return;
		}
		if (row.state !== "requested") {
			try {
				deps.nudgeLead?.(row.targetProject, row.targetLeadId);
			} catch (error) {
				warn(`nudge failed: ${describe(error)}`);
			}
		}
		res.status(202).json({ interruptId: row.interruptId, state: row.state });
	};

	const create: RequestHandler = (req, res) => {
		const sessionId = param(req.params.sessionId);
		const at = now();
		const session = deps.store.getActiveVoiceLease(
			sessionId,
			req.header("X-Voice-Lease") ?? "",
			at,
		);
		if (!session || !LIVE_SESSION_STATES.has(session.state)) {
			res.status(409).json({ error: "voice_lease_conflict" });
			return;
		}
		const parsed = createRequestSchema.safeParse(req.body);
		const body = parsed.success
			? normalizeInterruptText(
					parsed.data.body,
					LEAD_INTERRUPT_BODY_MAX_CODE_POINTS,
				)
			: undefined;
		if (!parsed.success || body === undefined) {
			res.status(400).json({ error: "invalid_lead_interrupt_request" });
			return;
		}
		const { targetProject, targetLeadId, founderMessageId, idempotencyKey } =
			parsed.data;
		const bodyDigest = sha256Hex(body);
		const requestDigest = leadInterruptRequestDigest({
			targetProject,
			targetLeadId,
			founderMessageId,
			body,
		});
		const refusal = (code: string, interruptId = newId()) =>
			refuse({
				interruptId,
				session,
				founderMessageId,
				targetProject,
				targetLeadId,
				bodyDigest,
				code,
				at,
			});
		try {
			const target = deps.resolveTarget(targetProject, targetLeadId);
			if (!target) {
				refusal("target_not_lead");
				throw new RouteRefusal(422, "target_not_lead");
			}
			if (!deps.verifyFounderQuote({ session, founderMessageId })) {
				refusal("founder_quote_unverified");
				throw new RouteRefusal(422, "founder_quote_unverified");
			}
			const existing = deps.store.leadInterrupts.getByIdempotencyKey(
				"voice_session",
				sessionId,
				idempotencyKey,
			);
			if (existing) {
				if (existing.requestDigest !== requestDigest) {
					refusal("idempotency_conflict", existing.interruptId);
					throw new RouteRefusal(409, "idempotency_conflict");
				}
				respondWithRow(
					res,
					existing.state === "requested" ? deliver(existing) : existing,
				);
				return;
			}
			if (
				deps.store.leadInterrupts.countOpenForTarget({
					initiatorKind: "voice_session",
					initiatorRef: sessionId,
					targetProject,
					targetLeadId,
					since: new Date(Date.parse(at) - OPEN_WINDOW_MS).toISOString(),
				}) > 0
			) {
				refusal("interrupt_already_open");
				throw new RouteRefusal(409, "interrupt_already_open");
			}
			if (
				deps.store.leadInterrupts.countRecentForInitiator({
					initiatorKind: "voice_session",
					initiatorRef: sessionId,
					since: new Date(Date.parse(at) - BURST_WINDOW_MS).toISOString(),
				}) >= BURST_LIMIT
			) {
				refusal("interrupt_rate_limited");
				throw new RouteRefusal(429, "interrupt_rate_limited");
			}
			let row: LeadInterruptRow;
			try {
				row = deps.store.leadInterrupts.createRequested({
					interruptId: newId(),
					initiatorKind: "voice_session",
					initiatorRef: sessionId,
					idempotencyKey,
					requestDigest,
					founderMessageId,
					targetProject,
					targetLeadId,
					targetBackend: target.backend,
					body,
					bodyDigest,
					now: at,
				});
			} catch (error) {
				warn(`audit/record write failed: ${describe(error)}`);
				throw new RouteRefusal(503, "audit_unavailable");
			}
			respondWithRow(res, deliver(row));
		} catch (error) {
			if (error instanceof RouteRefusal) {
				res.status(error.status).json({ error: error.code });
				return;
			}
			warn(`create failed: ${describe(error)}`);
			res.status(503).json({ error: "lead_interrupt_unavailable" });
		}
	};

	const get: RequestHandler = (req, res) => {
		const sessionId = param(req.params.sessionId);
		if (
			!deps.store.getActiveVoiceLease(
				sessionId,
				req.header("X-Voice-Lease") ?? "",
				now(),
			)
		) {
			res.status(409).json({ error: "voice_lease_conflict" });
			return;
		}
		const row = deps.store.leadInterrupts.get(param(req.params.interruptId));
		if (
			!row ||
			row.initiatorKind !== "voice_session" ||
			row.initiatorRef !== sessionId
		) {
			res.status(404).json({ error: "lead_interrupt_not_found" });
			return;
		}
		res.json({
			interruptId: row.interruptId,
			state: row.state,
			targetProject: row.targetProject,
			targetLeadId: row.targetLeadId,
			disposition: row.disposition,
			dispositionReason: row.dispositionReason,
			reply:
				row.state === "replied" && row.replyText !== null
					? { text: row.replyText, repliedAt: row.repliedAt }
					: null,
			createdAt: row.createdAt,
		});
	};

	return { create, get };
}
