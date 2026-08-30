/**
 * FLY-546 B3-2 — `/api/voice/*`: the Bridge face the headphone daemon talks
 * to. StateStore is sql.js (in-memory + full export, FLY-663) so the daemon
 * must never read the db file cross-process — these four endpoints are its
 * only window:
 *
 *   GET  /scope         — the message-scope contract (lead/system bot ids,
 *                         founder-facing channels, roundtable ids, founder
 *                         fingerprint). The daemon derives NOTHING ad hoc.
 *   GET  /context       — channelId → typed issue/lead context for the
 *                         spoken headline (kind:"unknown", never a 404
 *                         overload).
 *   GET  /gate-binding  — messageId → the ONE current ship-gate binding,
 *                         fail-closed (selectCurrentBinding semantics): a
 *                         message can only enter the c-tier approval turn
 *                         via a persisted binding, never author/text guess.
 *   POST /ship-approval — the voice approval write. Guard ladder (response
 *                         priority): 503 apiToken unconfigured (before any
 *                         body use; 401 comes from the mount middleware) →
 *                         403 kill-switches → 400 receipt-first → 409
 *                         binding cross-check → 403 founder identity →
 *                         VoiceSource verdict → approve writes via the ONE
 *                         trusted primitive writeGateResponseAndRunPostWrite.
 *
 * Mounted under `/api/voice` behind tokenAuthMiddleware in plugin.ts. The
 * route is ALWAYS registered; the kill-switch answers 403, never 404
 * (FLY-175 R1 gate-route-404 lesson).
 */
import { randomUUID } from "node:crypto";
import express from "express";
import { deriveCanonicalFounderId } from "./approval-signal/canonical-founder-id.js";
import type { GateAuthorityView } from "./approval-signal/gate-authority-view.js";
import {
	type GateMessageBinding,
	selectCurrentBinding,
} from "./approval-signal/gate-message-binding.js";
import { evaluateVoiceSource } from "./approval-signal/voice-approval-source.js";
import {
	type GateResponseDb,
	type WriteGateResponseArgs,
	writeGateResponseAndRunPostWrite,
} from "./approval-signal/write-gate-response.js";

const BINDING_EVENT_TYPE = "ship_gate_msg_binding";

export interface VoiceSessionLike {
	status?: string;
	review_question_id?: string | null;
	pr_head_sha?: string | null;
	pr_number?: number | null;
	issue_identifier?: string | null;
	issue_title?: string | null;
	session_stage?: string | null;
	agent_name?: string | null;
	project_name?: string;
	issue_id?: string;
}

export interface VoiceStoreLike {
	getSession(executionId: string): VoiceSessionLike | undefined;
	getSessionByIssue(issueId: string): VoiceSessionLike | undefined;
	getChatThreadByThreadId(threadId: string):
		| {
				thread_id: string;
				channel_id: string;
				issue_id: string;
				session_role: string;
		  }
		| undefined;
	getEventsByType(eventType: string): Array<{
		execution_id: string;
		payload?: unknown;
	}>;
	getAllChatThreadIds(): string[];
	insertEvent(event: {
		event_id: string;
		execution_id: string;
		issue_id: string;
		project_name: string;
		event_type: string;
		source: string;
		payload?: unknown;
	}): boolean;
}

export interface VoiceProjectLike {
	projectName: string;
	generalChannel?: string;
	leads: Array<{
		agentId: string;
		chatChannel: string;
		botUserId?: string;
		botToken?: string;
	}>;
}

export interface VoiceRouterDeps {
	store: VoiceStoreLike;
	projects: VoiceProjectLike[];
	/** ship-approval refuses to run tokenless (503) — writes founder authority. */
	apiTokenConfigured: boolean;
	discordOwnerUserId?: string;
	founderConsentUserId?: string;
	/** cross-dept roundtable channel ids (FLY-267 env, split at the mount). */
	roundtableChannelIds?: string[];
	/** the gate-poller's global fallback bot token (system identity). */
	globalBotToken?: string;
	/** server-derived CommDB open (prod: canonical path per project). */
	openCommDb: (projectName: string) => GateResponseDb | null;
	onResponseWritten?: WriteGateResponseArgs["onResponseWritten"];
	writeGateResponseImpl?: typeof writeGateResponseAndRunPostWrite;
	cardAuthority?: WriteGateResponseArgs["cardAuthority"];
	gateAuthorityView?: GateAuthorityView;
	/**
	 * FLY-1041 Chunk 5: shared founder-approval hold guard (plugin injects
	 * `founderApprovalHoldGuard` over the real StateStore). While held, a
	 * voice approve is declined with an explicit `kind:"held"` verdict (the
	 * daemon narrates it) instead of writing an unshippable approval. Absent
	 * → no hold check (byte-compat).
	 */
	isHeld?: (executionId: string) => boolean;
}

/**
 * A Discord bot token's first dot-segment is the base64 bot user id — a
 * deterministic derivation (no Discord API round-trip) the scope endpoint
 * uses to name the per-Lead bot identities.
 */
export function botUserIdFromToken(token: string | undefined): string | null {
	const first = token?.split(".")[0];
	if (!first) return null;
	try {
		const decoded = Buffer.from(first, "base64").toString("utf8");
		return /^\d{15,21}$/.test(decoded) ? decoded : null;
	} catch {
		return null;
	}
}

type ResolvedBinding = GateMessageBinding & { session: VoiceSessionLike };

/**
 * Reverse-lookup a gate message id against every persisted binding row,
 * fail-closed: the binding must belong to a session that is STILL
 * awaiting_review on exactly this (question, head), and must be the ONE
 * current binding for that pair (selectCurrentBinding). Zero or ambiguous →
 * null — a message never becomes approvable by accident.
 */
function resolveBindingByMessageId(
	store: VoiceStoreLike,
	gateMessageId: string,
	gateAuthorityView?: GateAuthorityView,
): ResolvedBinding | null {
	const events = store.getEventsByType(BINDING_EVENT_TYPE);
	const all = events
		.map((e) => e.payload as GateMessageBinding)
		.filter((b): b is GateMessageBinding => !!b && typeof b === "object");
	const candidates = all.filter((b) => b.gateMessageId === gateMessageId);
	const current: ResolvedBinding[] = [];
	for (const b of candidates) {
		const session = store.getSession(b.executionId);
		const engineAuthority = gateAuthorityView?.resolve(
			b.questionId,
			b.executionId,
		);
		if (engineAuthority) {
			if (
				engineAuthority.state !== "awaiting_review" ||
				engineAuthority.cardMessageId !== gateMessageId ||
				engineAuthority.headSha !== b.prHeadSha
			) {
				continue;
			}
			current.push({
				...b,
				session: {
					...session,
					status: "awaiting_review",
					review_question_id: engineAuthority.questionId,
					pr_head_sha: engineAuthority.headSha,
					pr_number: engineAuthority.prNumber,
					project_name: engineAuthority.projectName,
					issue_id: engineAuthority.issueId,
					issue_identifier: engineAuthority.issueIdentifier,
				},
			});
			continue;
		}
		if (session?.status !== "awaiting_review") continue;
		if (session.review_question_id !== b.questionId) continue;
		if (session.pr_head_sha !== b.prHeadSha) continue;
		const execBindings = all.filter((x) => x.executionId === b.executionId);
		if (
			selectCurrentBinding(execBindings, b.questionId, b.prHeadSha)
				?.gateMessageId !== gateMessageId
		) {
			continue;
		}
		current.push({ ...b, session });
	}
	return current.length === 1 ? (current[0] as ResolvedBinding) : null;
}

export function createVoiceRouter(deps: VoiceRouterDeps): express.Router {
	const router = express.Router();
	const founderId = () =>
		deriveCanonicalFounderId(
			deps.discordOwnerUserId,
			deps.founderConsentUserId,
		);

	const audit = (
		payload: Record<string, unknown>,
		binding?: ResolvedBinding,
	) => {
		try {
			deps.store.insertEvent({
				event_id: `voice-approval-attempt-${randomUUID()}`,
				execution_id: binding?.executionId ?? "voice-unbound",
				issue_id: binding?.issueId ?? "unknown",
				project_name: binding?.session.project_name ?? "unknown",
				event_type: "voice_approval_attempt",
				source: "bridge.fly546-voice",
				payload: { modality: "voice", ...payload },
			});
		} catch (err) {
			console.warn(`[voice] audit write failed: ${(err as Error).message}`);
		}
	};

	router.get("/scope", (_req, res) => {
		const fingerprint = founderId();
		if (!fingerprint) {
			res.status(503).json({
				error:
					"canonical_founder_id_unresolved: discordOwnerUserId / founderConsent.founderUserId missing or split — refusing to hand out a voice scope",
			});
			return;
		}
		const leadBotIds = new Set<string>();
		const scopeChannelIds = new Set<string>();
		for (const project of deps.projects) {
			if (project.generalChannel) scopeChannelIds.add(project.generalChannel);
			for (const lead of project.leads) {
				scopeChannelIds.add(lead.chatChannel);
				if (lead.botUserId) leadBotIds.add(lead.botUserId);
			}
		}
		for (const threadId of deps.store.getAllChatThreadIds()) {
			scopeChannelIds.add(threadId);
		}
		const systemBotIds = new Set<string>();
		const globalId = botUserIdFromToken(deps.globalBotToken);
		if (globalId) systemBotIds.add(globalId);
		res.json({
			leadBotIds: [...leadBotIds],
			systemBotIds: [...systemBotIds],
			scopeChannelIds: [...scopeChannelIds],
			roundtableChannelIds: deps.roundtableChannelIds ?? [],
			founderIdFingerprint: fingerprint,
		});
	});

	router.get("/context", (req, res) => {
		const channelId = req.query.channelId;
		if (typeof channelId !== "string" || channelId.length === 0) {
			res.status(400).json({ error: "channelId query param required" });
			return;
		}
		const thread = deps.store.getChatThreadByThreadId(channelId);
		if (thread) {
			const session = deps.store.getSessionByIssue(thread.issue_id);
			res.json({
				kind: "issue_thread",
				issueId: thread.issue_id,
				issueIdentifier: session?.issue_identifier ?? thread.issue_id,
				issueTitle: session?.issue_title ?? "",
				agentId: session?.agent_name ?? "",
				stage: session?.session_stage ?? undefined,
			});
			return;
		}
		for (const project of deps.projects) {
			const lead = project.leads.find((l) => l.chatChannel === channelId);
			if (lead) {
				res.json({ kind: "lead_channel", agentId: lead.agentId });
				return;
			}
		}
		// typed unknown — deliberately NOT a 404 (the daemon still enqueues
		// with a degraded headline).
		res.json({ kind: "unknown" });
	});

	router.get("/gate-binding", (req, res) => {
		const messageId = req.query.messageId;
		if (typeof messageId !== "string" || messageId.length === 0) {
			res.status(400).json({ error: "messageId query param required" });
			return;
		}
		const binding = resolveBindingByMessageId(
			deps.store,
			messageId,
			deps.gateAuthorityView,
		);
		if (!binding) {
			res.json({ bound: false });
			return;
		}
		res.json({
			bound: true,
			questionId: binding.questionId,
			prHeadSha: binding.prHeadSha,
			issueId: binding.issueId,
			prNumber: binding.session.pr_number ?? undefined,
		});
	});

	router.post("/ship-approval", (req, res) => {
		void (async () => {
			// ⓪ a founder-authority write must never run tokenless — refuse
			// BEFORE any body field is used (tokenAuthMiddleware is a no-op
			// without a configured token). express.json() is a global mount
			// pre-parse; "before body USE" is the contract (Codex R2 #2).
			if (!deps.apiTokenConfigured) {
				res.status(503).json({ error: "api_token_required" });
				return;
			}
			const body = (req.body ?? {}) as {
				gateMessageId?: string;
				questionId?: string;
				prHeadSha?: string;
				transcript?: {
					id?: string;
					text?: string;
					atMs?: number;
					founderUserId?: string;
				};
				receiptMessageId?: string;
			};
			// ⑤ receipt-first: no receipt card, no approval write (§14 c: 文字是收据).
			if (
				typeof body.receiptMessageId !== "string" ||
				body.receiptMessageId.length === 0
			) {
				res.status(400).json({ error: "receipt_required" });
				return;
			}
			const transcript = body.transcript;
			if (
				typeof body.gateMessageId !== "string" ||
				typeof body.questionId !== "string" ||
				typeof body.prHeadSha !== "string" ||
				!transcript ||
				typeof transcript.id !== "string" ||
				typeof transcript.text !== "string" ||
				typeof transcript.founderUserId !== "string"
			) {
				res.status(400).json({ error: "missing_required_fields" });
				return;
			}

			// ③ binding cross-check: gateMessageId ↔ questionId ↔ prHeadSha must
			// mutually verify against the ONE current persisted binding.
			const binding = resolveBindingByMessageId(
				deps.store,
				body.gateMessageId,
				deps.gateAuthorityView,
			);
			if (
				!binding ||
				binding.questionId !== body.questionId ||
				binding.prHeadSha !== body.prHeadSha
			) {
				audit({
					outcome: "rejected",
					reason: "binding_mismatch",
					transcript,
					receiptMessageId: body.receiptMessageId,
				});
				res.status(409).json({ error: "binding_mismatch" });
				return;
			}

			// ④ canonical founder id — fail-closed on missing/split identity.
			const canonicalFounderId = founderId();
			if (!canonicalFounderId) {
				audit(
					{
						outcome: "rejected",
						reason: "canonical_founder_id_unresolved",
						transcript,
						receiptMessageId: body.receiptMessageId,
					},
					binding,
				);
				res.status(403).json({ error: "canonical_founder_id_unresolved" });
				return;
			}

			// ⑥ VoiceSource — exact confirm/deny only, no classifier.
			const signal = evaluateVoiceSource({
				gate: {
					questionId: binding.questionId,
					prHeadSha: binding.prHeadSha,
					canonicalFounderId,
				},
				utterance: {
					transcriptId: transcript.id,
					text: transcript.text,
					founderUserId: transcript.founderUserId,
				},
			});
			if (!signal) {
				audit(
					{
						outcome: "rejected",
						reason: "speaker_not_founder",
						transcript,
						receiptMessageId: body.receiptMessageId,
					},
					binding,
				);
				res.status(403).json({ error: "speaker_not_founder" });
				return;
			}
			if (signal.kind !== "approve") {
				audit(
					{
						outcome: signal.kind,
						transcript,
						receiptMessageId: body.receiptMessageId,
					},
					binding,
				);
				res.json({ written: false, kind: signal.kind });
				return;
			}

			// FLY-1041 Chunk 5: review-hold alignment — a founder voice approve on
			// a HELD session (codex not green / QA running / merge_block) is
			// declined with an explicit verdict the daemon can narrate, never
			// silently written (parity with the text/reaction sources).
			if (deps.isHeld?.(binding.executionId)) {
				audit(
					{
						outcome: "held_declined",
						transcript,
						receiptMessageId: body.receiptMessageId,
					},
					binding,
				);
				res.json({
					written: false,
					kind: "held",
					reason: "review held — code review / QA not green yet",
				});
				return;
			}

			const projectName = binding.session.project_name;
			const db = projectName ? deps.openCommDb(projectName) : null;
			if (!db) {
				audit(
					{
						outcome: "error",
						reason: "commdb_unavailable",
						transcript,
						receiptMessageId: body.receiptMessageId,
					},
					binding,
				);
				res.status(503).json({ error: "commdb_unavailable" });
				return;
			}
			const write =
				deps.writeGateResponseImpl ?? writeGateResponseAndRunPostWrite;
			const result = await write({
				db,
				store: deps.store,
				questionId: binding.questionId,
				executionId: binding.executionId,
				source: "voice",
				cardAuthority: deps.cardAuthority,
				gateAuthorityView: deps.gateAuthorityView,
				actor: canonicalFounderId,
				founderId: canonicalFounderId,
				answer: '{"approved":true}',
				expectedCurrentReviewQuestionId:
					binding.session.review_question_id ?? undefined,
				holdReasonFor: deps.isHeld
					? (executionId) => (deps.isHeld!(executionId) ? "qa_not_green" : null)
					: undefined,
				onResponseWritten: deps.onResponseWritten,
			});
			audit(
				{
					outcome: "approve",
					written: result.written,
					retrySafe: result.retrySafe,
					reason: result.reason,
					transcript,
					receiptMessageId: body.receiptMessageId,
				},
				binding,
			);
			// retrySafe=false means the response reached a durable state but the
			// flip+wake post-write hook did not confirm — surfaced verbatim so
			// the daemon can narrate honestly instead of a clean "已 ship"
			// (Codex R1 HIGH-2: parity with the text/reaction sources, which
			// re-run the idempotent hook on their next pass).
			res.json({
				written: result.written || result.reason === "already_answered",
				kind: "approve",
				reason: result.reason,
				retrySafe: result.retrySafe,
			});
		})().catch((err) => {
			console.error("[voice] ship-approval failed:", err);
			if (!res.headersSent) {
				res.status(500).json({ error: "internal_error" });
			}
		});
	});

	return router;
}
