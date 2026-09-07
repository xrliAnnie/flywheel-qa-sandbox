import { timingSafeEqual } from "node:crypto";
import { type RequestHandler, Router } from "express";
import type { ProjectEntry } from "../ProjectConfig.js";
import type {
	AlertMailboxLedgerRow,
	AlertThreadRow,
	StateStore,
} from "../StateStore.js";
import type { AlertChannelHub } from "./AlertChannelHub.js";

export interface AlertDraftReceipt {
	draftId: string;
	book: "runbook" | "contact-book";
	lane: "thread" | "mailbox";
	correlationKey: string;
	eventId: string;
	kind: string;
}

export interface AlertBackfillDebt {
	owed: string[];
	pending: number;
	landed: number;
}

export type AlertHandoffSettlement =
	| {
			kind: "live" | "archived_nonterminal" | "archived_terminal";
			state: "QUEUED" | "LEASED" | "ACKED" | "DEAD";
	  }
	| {
			kind: "absent_identity" | "torn_identity" | "unknown_lead";
	  };

export type AlertDutyState =
	| "unreviewed"
	| "in_duty"
	| "handed_off"
	| "resolved";

export function deriveDutyState(row: {
	resolved_at: string | null;
	ticket_status?: string | null;
	acked_at?: string | null;
}): AlertDutyState {
	if (row.resolved_at !== null) return "resolved";
	if (row.ticket_status === "ESCALATED") return "handed_off";
	return row.acked_at ? "in_duty" : "unreviewed";
}

export function handoffLetterState(
	settlement: AlertHandoffSettlement,
): "QUEUED" | "LEASED" | "ACKED" | "DEAD" | "NOT_QUEUED" | "UNKNOWN" {
	switch (settlement.kind) {
		case "live":
		case "archived_nonterminal":
		case "archived_terminal":
			return settlement.state;
		case "absent_identity":
			return "NOT_QUEUED";
		case "torn_identity":
		case "unknown_lead":
			return "UNKNOWN";
	}
}

export interface AlertDutyRouterDeps {
	store: StateStore;
	projects: ProjectEntry[];
	getAlertHub: () => AlertChannelHub | undefined;
	enqueueAlertHandoff?: (
		toLeadId: string,
		input: {
			deliveryId: string;
			lane: "thread" | "mailbox";
			correlationKey: string;
			eventId: string;
			kind: string;
			reason: "contact_book" | "no_entry";
			note?: string;
			ref: string;
		},
	) => { queued: boolean; deliveryId: string; seq?: number };
	readHandoffSettlement?: (
		toLeadId: string,
		deliveryId: string,
	) => AlertHandoffSettlement;
	readDraftReceipt?: (draftId: string) => AlertDraftReceipt | undefined;
	writeOwedReceipt?: (input: {
		book: "contact-book";
		lane: "thread" | "mailbox";
		correlationKey: string;
		eventId: string;
		kind: string;
	}) => unknown;
	readBackfillDebt?: () => AlertBackfillDebt;
	ledgerWriteErrors?: () => number;
	reroutedCount?: () => number;
}

const DEFAULT_OUTSTANDING_LIMIT = 25;
const MAX_OUTSTANDING_LIMIT = 100;
const DEFAULT_BOARD_LIMIT = 200;
const MAX_BOARD_LIMIT = 500;

type OutstandingCursor = Pick<AlertThreadRow, "opened_at" | "event_id">;

function encodeOutstandingCursor(cursor: OutstandingCursor): string {
	return Buffer.from(
		JSON.stringify({ openedAt: cursor.opened_at, eventId: cursor.event_id }),
	).toString("base64url");
}

function decodeOutstandingCursor(raw: string): OutstandingCursor | undefined {
	if (raw.length > 512) return undefined;
	try {
		const parsed = JSON.parse(
			Buffer.from(raw, "base64url").toString("utf8"),
		) as Record<string, unknown>;
		if (
			typeof parsed.openedAt !== "string" ||
			!parsed.openedAt ||
			typeof parsed.eventId !== "string" ||
			!parsed.eventId
		) {
			return undefined;
		}
		return { opened_at: parsed.openedAt, event_id: parsed.eventId };
	} catch {
		return undefined;
	}
}

function encodeBoardCursor(cursor: {
	openedAt: string;
	eventId: string;
	lane: "thread" | "mailbox";
}): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeBoardCursor(raw: string):
	| {
			openedAt: string;
			eventId: string;
			lane: "thread" | "mailbox";
	  }
	| undefined {
	if (raw.length > 768) return undefined;
	try {
		const parsed = JSON.parse(
			Buffer.from(raw, "base64url").toString("utf8"),
		) as Record<string, unknown>;
		if (
			typeof parsed.openedAt !== "string" ||
			!parsed.openedAt ||
			typeof parsed.eventId !== "string" ||
			!parsed.eventId ||
			(parsed.lane !== "thread" && parsed.lane !== "mailbox")
		) {
			return undefined;
		}
		return {
			openedAt: parsed.openedAt,
			eventId: parsed.eventId,
			lane: parsed.lane,
		};
	} catch {
		return undefined;
	}
}

export function dutyAuth(token?: string): RequestHandler {
	return (req, res, next) => {
		if (!token) {
			res.status(503).json({ error: "alert_duty_unconfigured" });
			return;
		}
		const header = req.header("authorization") ?? "";
		const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
		const expectedBytes = Buffer.from(token);
		const suppliedBytes = Buffer.from(supplied);
		if (
			suppliedBytes.length !== expectedBytes.length ||
			!timingSafeEqual(suppliedBytes, expectedBytes)
		) {
			res.status(403).json({ error: "forbidden" });
			return;
		}
		next();
	};
}

function parseLocator(
	body: Record<string, unknown>,
): { ok: true; kind: "messageId" | "eventId"; value: string } | { ok: false } {
	const messageId =
		typeof body.messageId === "string" && body.messageId.trim()
			? body.messageId.trim()
			: undefined;
	const eventId =
		typeof body.eventId === "string" && body.eventId.trim()
			? body.eventId.trim()
			: undefined;
	if (Number(Boolean(messageId)) + Number(Boolean(eventId)) !== 1) {
		return { ok: false };
	}
	return messageId
		? { ok: true, kind: "messageId", value: messageId }
		: { ok: true, kind: "eventId", value: eventId as string };
}

type LocatedTicket =
	| { lane: "thread"; row: AlertThreadRow }
	| { lane: "mailbox"; row: AlertMailboxLedgerRow };

function findTicket(
	store: StateStore,
	locator: { kind: "messageId" | "eventId"; value: string },
): LocatedTicket | undefined {
	if (locator.kind === "messageId") {
		const row = store.getAlertThreadByRootMessageId(locator.value);
		return row ? { lane: "thread", row } : undefined;
	}
	const thread = store.getAlertThreadByEventId(locator.value);
	if (thread) return { lane: "thread", row: thread };
	const mailbox = store.getMailboxLedgerByEventId(locator.value);
	return mailbox ? { lane: "mailbox", row: mailbox } : undefined;
}

function ticketRef(ticket: LocatedTicket): string {
	return ticket.lane === "thread"
		? `https://discord.com/channels/@me/${ticket.row.thread_id}`
		: `alert-ticket lookup --event-id ${ticket.row.event_id}`;
}

function lookupResponse(ticket: LocatedTicket): Record<string, unknown> {
	const { row } = ticket;
	return {
		lane: ticket.lane,
		correlationKey: row.correlation_key,
		eventId: row.event_id,
		kind: row.event_type,
		leadId: row.lead_id,
		projectName: row.project_name,
		ticketStatus: row.ticket_status,
		ackedAt: row.acked_at,
		resolvedAt: row.resolved_at,
		ownerRef: row.owner_ref,
		ref: ticketRef(ticket),
	};
}

export function createAlertDutyRouter(deps: AlertDutyRouterDeps): Router {
	const router = Router();
	router.get("/alert-tickets/lookup", (req, res) => {
		const locator = parseLocator(req.query as Record<string, unknown>);
		if (!locator.ok) {
			res.status(400).json({ error: "exactly_one_locator_required" });
			return;
		}
		const ticket = findTicket(deps.store, locator);
		if (!ticket || !ticket.row.ticket_status) {
			res.status(404).json({ error: "ticket_not_found" });
			return;
		}
		res.status(200).json(lookupResponse(ticket));
	});
	router.get("/alert-tickets/outstanding", (req, res) => {
		const limitRaw = req.query.limit;
		const limit =
			limitRaw === undefined ? DEFAULT_OUTSTANDING_LIMIT : Number(limitRaw);
		if (
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > MAX_OUTSTANDING_LIMIT
		) {
			res.status(400).json({ error: "limit must be an integer from 1 to 100" });
			return;
		}
		const sinceRaw = req.query.since;
		if (
			sinceRaw !== undefined &&
			(typeof sinceRaw !== "string" || !sinceRaw.trim())
		) {
			res.status(400).json({ error: "invalid_since_cursor" });
			return;
		}
		const since =
			typeof sinceRaw === "string" && sinceRaw.trim()
				? decodeOutstandingCursor(sinceRaw.trim())
				: undefined;
		if (sinceRaw !== undefined && !since) {
			res.status(400).json({ error: "invalid_since_cursor" });
			return;
		}
		const threadTickets = deps.store
			.listDutyOutstanding(limit, since)
			.map((row) => ({
				...row,
				lane: "thread" as const,
				fireCount: null,
				toAgent: null,
			}));
		const mailboxTickets = deps.store
			.listMailboxLedgerOutstanding(limit, since)
			.map((row) => ({
				...row,
				lane: "mailbox" as const,
				fireCount: row.fire_count,
				toAgent: row.to_agent,
				resolved: row.resolved_at !== null,
			}));
		const tickets = [...threadTickets, ...mailboxTickets]
			.sort((left, right) => {
				const opened = right.opened_at.localeCompare(left.opened_at);
				return opened !== 0
					? opened
					: right.event_id.localeCompare(left.event_id);
			})
			.slice(0, limit);
		res.status(200).json({
			tickets,
			cursor: tickets[0]
				? encodeOutstandingCursor(tickets[0])
				: since
					? encodeOutstandingCursor(since)
					: null,
			limit,
		});
	});
	router.get("/alert-board", (req, res) => {
		const limitRaw = req.query.limit;
		const limit =
			limitRaw === undefined ? DEFAULT_BOARD_LIMIT : Number(limitRaw);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BOARD_LIMIT) {
			res.status(400).json({ error: "limit must be an integer from 1 to 500" });
			return;
		}
		const resolvedSinceRaw = req.query.resolvedSince;
		let resolvedSinceIso: string;
		if (resolvedSinceRaw === undefined) {
			resolvedSinceIso = new Date(
				Date.now() - 7 * 24 * 60 * 60_000,
			).toISOString();
		} else if (
			typeof resolvedSinceRaw !== "string" ||
			!resolvedSinceRaw.trim() ||
			!Number.isFinite(Date.parse(resolvedSinceRaw))
		) {
			res.status(400).json({ error: "invalid_resolved_since" });
			return;
		} else {
			resolvedSinceIso = new Date(resolvedSinceRaw).toISOString();
		}
		const cursorRaw = req.query.cursor;
		const cursor =
			typeof cursorRaw === "string" && cursorRaw.trim()
				? decodeBoardCursor(cursorRaw.trim())
				: undefined;
		if (cursorRaw !== undefined && !cursor) {
			res.status(400).json({ error: "invalid_board_cursor" });
			return;
		}
		const page = deps.store.listAlertBoard({
			resolvedSinceIso,
			limit,
			...(cursor ? { cursor } : {}),
		});
		const items = page.items.map((row) => {
			let handoffLetter:
				| "QUEUED"
				| "LEASED"
				| "ACKED"
				| "DEAD"
				| "NOT_QUEUED"
				| "UNKNOWN"
				| null = null;
			if (row.handoff_delivery_id) {
				const ownerLeadId = row.owner_ref?.startsWith("lead:")
					? row.owner_ref.slice("lead:".length)
					: undefined;
				if (!ownerLeadId || !deps.readHandoffSettlement) {
					handoffLetter = "UNKNOWN";
				} else {
					try {
						handoffLetter = handoffLetterState(
							deps.readHandoffSettlement(ownerLeadId, row.handoff_delivery_id),
						);
					} catch {
						handoffLetter = "UNKNOWN";
					}
				}
			}
			return {
				lane: row.lane,
				correlationKey: row.correlation_key,
				eventId: row.event_id,
				kind: row.event_type,
				leadId: row.lead_id,
				projectName: row.project_name,
				project: row.project_name,
				state: deriveDutyState(row),
				ticketStatus: row.ticket_status,
				ownerRef: row.owner_ref,
				handoffReason: row.handoff_reason,
				handoffDeliveryId: row.handoff_delivery_id,
				handoffGeneration: row.handoff_generation,
				handoffLetter,
				routeClass: row.route_class,
				requestedOwner: row.requested_owner,
				toAgent: row.to_agent,
				fireCount: row.fire_count,
				openedAt: row.opened_at,
				ackedAt: row.acked_at,
				resolvedAt: row.resolved_at,
				resolveDraftId: row.resolve_draft_id,
				ref:
					row.lane === "thread"
						? `https://discord.com/channels/@me/${row.thread_id}`
						: `alert-ticket lookup --event-id ${row.event_id}`,
			};
		});
		res.status(200).json({
			generatedAt: new Date().toISOString(),
			dutyWritePath: "configured",
			ledgerWriteErrors: deps.ledgerWriteErrors?.() ?? 0,
			reroutedCount: deps.reroutedCount?.() ?? 0,
			totals: page.totals,
			backfill: deps.readBackfillDebt?.() ?? {
				owed: [],
				pending: 0,
				landed: 0,
			},
			items,
			nextCursor: page.nextCursor ? encodeBoardCursor(page.nextCursor) : null,
			truncated: page.truncated,
		});
	});
	router.post("/alert-tickets/transition", async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		if (
			body.action !== "ack" &&
			body.action !== "handoff" &&
			body.action !== "resolve"
		) {
			res
				.status(400)
				.json({ error: "action must be one of ack|handoff|resolve" });
			return;
		}
		const locator = parseLocator(body);
		if (!locator.ok) {
			res.status(400).json({ error: "exactly_one_locator_required" });
			return;
		}
		const ticket = findTicket(deps.store, locator);
		if (!ticket || !ticket.row.ticket_status) {
			res.status(404).json({ error: "ticket_not_found" });
			return;
		}
		const { row } = ticket;
		if (body.action === "resolve") {
			const draftId =
				typeof body.draftId === "string" ? body.draftId.trim() : "";
			if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(draftId)) {
				res.status(400).json({ error: "runbook_draft_required" });
				return;
			}
			let receipt: AlertDraftReceipt | undefined;
			try {
				receipt = deps.readDraftReceipt?.(draftId);
			} catch {
				res.status(500).json({ error: "draft_receipt_read_failed" });
				return;
			}
			if (!receipt) {
				res.status(404).json({ error: "draft_receipt_missing" });
				return;
			}
			if (
				receipt.draftId !== draftId ||
				receipt.book !== "runbook" ||
				receipt.lane !== ticket.lane ||
				receipt.correlationKey !== row.correlation_key ||
				receipt.eventId !== row.event_id ||
				receipt.kind !== row.event_type
			) {
				res.status(400).json({ error: "draft_receipt_mismatch" });
				return;
			}
			const hub = ticket.lane === "thread" ? deps.getAlertHub() : undefined;
			if (ticket.lane === "thread" && !hub) {
				res.status(503).json({ error: "alert_hub_unavailable" });
				return;
			}
			const bound = deps.store.bindResolveDraft(
				ticket.lane,
				row.correlation_key,
				row.event_id,
				draftId,
			);
			if (!bound.ok) {
				res.status(409).json({ error: bound.reason });
				return;
			}
			try {
				if (ticket.lane === "thread") {
					await hub?.resolve(row.correlation_key, row.event_id);
				} else if (
					!deps.store.resolveMailboxLedger(
						row.correlation_key,
						row.event_id,
						draftId,
					)
				) {
					res.status(409).json({ error: "stale_episode" });
					return;
				}
				res.status(200).json({
					action: "resolve",
					lane: ticket.lane,
					eventId: row.event_id,
					correlationKey: row.correlation_key,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "stale_episode") {
					res.status(409).json({ error: message });
					return;
				}
				res.status(500).json({ error: "resolve_failed" });
			}
			return;
		}
		if (body.action === "ack") {
			const acked =
				ticket.lane === "thread"
					? deps.store.stampDutyAck(row.correlation_key, row.event_id)
					: deps.store.stampMailboxLedgerAck(row.correlation_key, row.event_id);
			if (!acked) {
				res.status(409).json({ error: "stale_episode" });
				return;
			}
			res.status(200).json({
				action: "ack",
				lane: ticket.lane,
				eventId: row.event_id,
				correlationKey: row.correlation_key,
			});
			return;
		}
		if (body.reason !== "contact_book" && body.reason !== "no_entry") {
			res.status(400).json({ error: "handoff_reason_required" });
			return;
		}
		if (row.owner_ref === "infra_bot:codex") {
			res.status(409).json({ error: "codex_owner_ack_only" });
			return;
		}

		const to =
			typeof body.to === "string" && body.to.trim()
				? body.to.trim()
				: undefined;
		// Contact-book handoffs are cross-project by design. Fleet sentinel rows use
		// project_name=machine and the Tadashi fallback lives in flywheel's roster.
		const lead = deps.projects
			.flatMap((project) => project.leads)
			.find((candidate) => candidate.agentId === to);
		if (!to || !lead) {
			res.status(400).json({ error: "handoff target is not in global roster" });
			return;
		}
		if (!lead.botUserId) {
			res.status(400).json({ error: "handoff target has no bot user id" });
			return;
		}
		const note =
			typeof body.note === "string" && body.note.trim()
				? body.note.trim()
				: undefined;
		if (body.note !== undefined && typeof body.note !== "string") {
			res.status(400).json({ error: "handoff_note_invalid" });
			return;
		}
		if (note && note.length > 400) {
			res.status(400).json({ error: "handoff_note_too_long" });
			return;
		}
		const reason = body.reason;
		if (reason === "no_entry") {
			try {
				if (!deps.writeOwedReceipt)
					throw new Error("receipt writer unavailable");
				deps.writeOwedReceipt({
					book: "contact-book",
					lane: ticket.lane,
					correlationKey: row.correlation_key,
					eventId: row.event_id,
					kind: row.event_type,
				});
			} catch {
				res.status(500).json({ error: "owed_receipt_write_failed" });
				return;
			}
		}
		const deliveryIdPrefix = [
			"alert_handoff",
			ticket.lane,
			row.correlation_key,
			row.event_id,
			lead.agentId,
		].join(":");
		const updated = deps.store.handoffLedger(
			ticket.lane,
			row.correlation_key,
			row.event_id,
			{
				ownerRef: `lead:${lead.agentId}`,
				reason,
				deliveryIdPrefix,
			},
		);
		if (!updated) {
			const current = findTicket(deps.store, {
				kind: "eventId",
				value: row.event_id,
			});
			res.status(409).json({
				error: current?.row.resolved_at ? "already_resolved" : "stale_episode",
			});
			return;
		}
		if (ticket.lane === "thread") {
			const updatedThread = deps.store.getAlertThreadByEventId(row.event_id);
			if (updatedThread) {
				await deps
					.getAlertHub()
					?.renderTicketLine(updatedThread, `<@${lead.botUserId}>`);
			}
		}
		const deliveryId = updated.handoff_delivery_id;
		if (!deliveryId) {
			res.status(500).json({ error: "handoff_delivery_id_missing" });
			return;
		}
		let handoffLetter:
			| { queued: boolean; deliveryId: string; seq?: number; error?: string }
			| undefined;
		try {
			if (!deps.enqueueAlertHandoff) {
				throw new Error("handoff delivery unavailable");
			}
			handoffLetter = deps.enqueueAlertHandoff(lead.agentId, {
				deliveryId,
				lane: ticket.lane,
				correlationKey: row.correlation_key,
				eventId: row.event_id,
				kind: row.event_type,
				reason,
				...(note ? { note } : {}),
				ref: ticketRef(ticket),
			});
		} catch (error) {
			handoffLetter = {
				queued: false,
				deliveryId,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		res.status(200).json({
			action: "handoff",
			lane: ticket.lane,
			eventId: row.event_id,
			correlationKey: row.correlation_key,
			to: lead.agentId,
			handoffLetter,
		});
	});
	return router;
}
