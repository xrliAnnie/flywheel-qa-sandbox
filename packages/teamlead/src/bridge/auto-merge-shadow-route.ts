import express from "express";
import type { ProjectEntry } from "../ProjectConfig.js";
import type {
	AutoMergeShadowDeclarationRow,
	AutoMergeShadowDeclaredClass,
	StateStore,
	WorkflowGateHolderRow,
} from "../StateStore.js";
import {
	type FetchDiscordMessageResult,
	fetchDiscordMessageFromChannel,
} from "./discord-utils.js";
import { resolveLeadIdentityForShadowDeclaration } from "./founder-gate-bot-token.js";
import { parseFounderMessageRef } from "./runs-route.js";
import { rejectNonLoopback } from "./workflow-decision-routes.js";

const BODY_KEYS = [
	"declaration_id",
	"question_id",
	"declared_class",
	"message_ref",
] as const;
const DECLARATION_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECLARED_CLASSES = new Set<AutoMergeShadowDeclaredClass>([
	"pure_docs",
	"config_only",
	"single_point_change",
	"other_code",
]);

type FetchDiscordMessage = (
	channelId: string,
	messageId: string,
	botToken: string,
) => Promise<FetchDiscordMessageResult>;

export interface AutoMergeShadowRouterDeps {
	store: StateStore;
	projects: ProjectEntry[];
	fetchDiscordMessage?: FetchDiscordMessage;
	now?: () => string;
}

interface ParsedBody {
	declarationId: string;
	questionId: string;
	declaredClass: AutoMergeShadowDeclaredClass;
	messageRef: { channelId: string; messageId: string };
}

function reject(res: express.Response, status: number, reason: string): void {
	res.status(status).json({ ok: false, reason });
}

function parseBody(
	value: unknown,
): { ok: true; body: ParsedBody } | { ok: false; reason: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { ok: false, reason: "body_shape" };
	}
	const body = value as Record<string, unknown>;
	const keys = Object.keys(body);
	if (
		keys.some((key) => !BODY_KEYS.includes(key as (typeof BODY_KEYS)[number]))
	) {
		return { ok: false, reason: "unexpected_key" };
	}
	if (!BODY_KEYS.every((key) => Object.hasOwn(body, key))) {
		return { ok: false, reason: "body_shape" };
	}
	if (
		typeof body.declaration_id !== "string" ||
		!DECLARATION_ID.test(body.declaration_id)
	) {
		return { ok: false, reason: "declaration_id_invalid" };
	}
	if (
		typeof body.question_id !== "string" ||
		body.question_id.length === 0 ||
		body.question_id.length > 128
	) {
		return { ok: false, reason: "question_id_invalid" };
	}
	if (
		typeof body.declared_class !== "string" ||
		!DECLARED_CLASSES.has(body.declared_class as AutoMergeShadowDeclaredClass)
	) {
		return { ok: false, reason: "declared_class_invalid" };
	}
	const messageRef = parseFounderMessageRef(body.message_ref);
	if (!messageRef) return { ok: false, reason: "message_ref_invalid" };
	return {
		ok: true,
		body: {
			declarationId: body.declaration_id,
			questionId: body.question_id,
			declaredClass: body.declared_class as AutoMergeShadowDeclaredClass,
			messageRef,
		},
	};
}

function isShipGate(holder: WorkflowGateHolderRow): boolean {
	return (
		holder.gate_node_id === "founder_gate" &&
		holder.authority_mode === "land" &&
		holder.subject_kind === "git_head"
	);
}

function canonicalReplay(
	row: AutoMergeShadowDeclarationRow,
	body: ParsedBody,
): boolean {
	return (
		row.question_id === body.questionId &&
		row.declared_class === body.declaredClass &&
		row.discord_channel_id === body.messageRef.channelId &&
		row.discord_message_id === body.messageRef.messageId
	);
}

function sameHolder(
	left: WorkflowGateHolderRow,
	right: WorkflowGateHolderRow,
): boolean {
	return (
		left.run_id === right.run_id &&
		left.gate_node_id === right.gate_node_id &&
		left.source_execution_id === right.source_execution_id &&
		left.question_id === right.question_id &&
		left.authority_mode === right.authority_mode &&
		left.subject_kind === right.subject_kind &&
		left.created_at === right.created_at
	);
}

export function createAutoMergeShadowRouter(
	deps: AutoMergeShadowRouterDeps,
): express.Router {
	const router = express.Router();
	const fetchMessage =
		deps.fetchDiscordMessage ??
		((channelId, messageId, botToken) =>
			fetchDiscordMessageFromChannel(channelId, messageId, botToken));
	router.post("/shadow-declaration", async (req, res) => {
		if (rejectNonLoopback(req, res)) return;
		const parsed = parseBody(req.body);
		if (!parsed.ok) {
			reject(res, 400, parsed.reason);
			return;
		}
		const body = parsed.body;
		const holder = deps.store.getWorkflowGateHolderByQuestionId(
			body.questionId,
		);
		if (!holder) {
			reject(res, 404, "question_unknown");
			return;
		}
		if (!isShipGate(holder)) {
			reject(res, 422, "not_a_ship_gate");
			return;
		}
		const existing = deps.store
			.listAutoMergeShadowDeclarations(body.questionId)
			.find((row) => row.declaration_id === body.declarationId);
		if (existing) {
			if (!canonicalReplay(existing, body)) {
				reject(res, 409, "declaration_conflict");
				return;
			}
			res.json({ ok: true, status: "replayed", declaration: existing });
			return;
		}
		const lead = resolveLeadIdentityForShadowDeclaration({
			store: deps.store,
			projects: deps.projects,
			holder,
		});
		if (!lead.ok) {
			reject(res, 503, lead.reason);
			return;
		}
		if (body.messageRef.channelId !== lead.chatChannel) {
			reject(res, 403, "channel_not_lead_channel");
			return;
		}
		const fetched = await fetchMessage(
			body.messageRef.channelId,
			body.messageRef.messageId,
			lead.botToken,
		);
		if (!fetched.ok) {
			const unavailable = ["network", "server", "rate_limited"].includes(
				fetched.kind,
			);
			reject(
				res,
				unavailable ? 503 : 404,
				unavailable ? "discord_unavailable" : "message_not_found",
			);
			return;
		}
		const message = fetched.message;
		if (message.authorId !== lead.botUserId) {
			reject(res, 403, "author_not_lead");
			return;
		}
		if (message.authorIsBot !== true) {
			reject(res, 403, "author_not_bot");
			return;
		}
		if (
			message.content.trim() !==
			`shadow-declare ${body.questionId} ${body.declaredClass}`
		) {
			reject(res, 422, "message_body_mismatch");
			return;
		}
		if (message.editedTimestampMs != null) {
			reject(res, 422, "message_edited");
			return;
		}
		const holderCreatedAtMs = Date.parse(holder.created_at);
		if (
			!Number.isFinite(holderCreatedAtMs) ||
			message.timestampMs < holderCreatedAtMs
		) {
			reject(res, 422, "message_predates_card");
			return;
		}
		const refreshedHolder = deps.store.getWorkflowGateHolderByQuestionId(
			body.questionId,
		);
		if (!refreshedHolder || !sameHolder(holder, refreshedHolder)) {
			reject(res, 409, "holder_changed");
			return;
		}
		const result = deps.store.recordAutoMergeShadowDeclaration({
			declarationId: body.declarationId,
			questionId: body.questionId,
			runId: holder.run_id,
			declaredClass: body.declaredClass,
			declaredBy: lead.agentId,
			discordChannelId: body.messageRef.channelId,
			discordMessageId: body.messageRef.messageId,
			discordAuthorUserId: message.authorId,
			messageTs: new Date(message.timestampMs).toISOString(),
			declaredAt: deps.now?.() ?? new Date().toISOString(),
		});
		if (!result.ok) {
			const status =
				result.reason === "question_unknown"
					? 404
					: result.reason === "invalid_declaration"
						? 400
						: 409;
			reject(res, status, result.reason);
			return;
		}
		res.status(result.status === "created" ? 201 : 200).json({
			ok: true,
			status: result.status,
			declaration: result.row,
		});
	});
	return router;
}
