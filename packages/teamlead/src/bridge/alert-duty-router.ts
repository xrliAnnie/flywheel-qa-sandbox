import { timingSafeEqual } from "node:crypto";
import { type RequestHandler, Router } from "express";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { AlertThreadRow, StateStore } from "../StateStore.js";
import type { AlertChannelHub } from "./AlertChannelHub.js";

export interface AlertDutyRouterDeps {
	store: StateStore;
	projects: ProjectEntry[];
	getAlertHub: () => AlertChannelHub | undefined;
}

const DEFAULT_OUTSTANDING_LIMIT = 25;
const MAX_OUTSTANDING_LIMIT = 100;

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

function findTicket(
	store: StateStore,
	locator: { kind: "messageId" | "eventId"; value: string },
): AlertThreadRow | undefined {
	return locator.kind === "messageId"
		? store.getAlertThreadByRootMessageId(locator.value)
		: store.getAlertThreadByEventId(locator.value);
}

export function createAlertDutyRouter(deps: AlertDutyRouterDeps): Router {
	const router = Router();
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
		const tickets = deps.store.listDutyOutstanding(limit, since);
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
		const row = findTicket(deps.store, locator);
		if (!row || !row.ticket_status) {
			res.status(404).json({ error: "ticket_not_found" });
			return;
		}
		if (body.action === "resolve") {
			const hub = deps.getAlertHub();
			if (!hub) {
				res.status(503).json({ error: "alert_hub_unavailable" });
				return;
			}
			try {
				await hub.resolve(row.correlation_key, row.event_id);
				res.status(200).json({
					action: "resolve",
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
			if (!deps.store.stampDutyAck(row.correlation_key, row.event_id)) {
				res.status(409).json({ error: "stale_episode" });
				return;
			}
			res.status(200).json({
				action: "ack",
				eventId: row.event_id,
				correlationKey: row.correlation_key,
			});
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
		if (
			!deps.store.handoffTicket(
				row.correlation_key,
				row.event_id,
				`lead:${lead.agentId}`,
			)
		) {
			const current = deps.store.getAlertThreadByEventId(row.event_id);
			res.status(409).json({
				error: current?.resolved_at ? "already_resolved" : "stale_episode",
			});
			return;
		}
		const updated = deps.store.getAlertThreadByEventId(row.event_id);
		if (updated) {
			await deps
				.getAlertHub()
				?.renderTicketLine(updated, `<@${lead.botUserId}>`);
		}
		res.status(200).json({
			action: "handoff",
			eventId: row.event_id,
			correlationKey: row.correlation_key,
			to: lead.agentId,
		});
	});
	return router;
}
