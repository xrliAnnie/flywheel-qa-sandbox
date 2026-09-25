import { randomBytes } from "node:crypto";
import express from "express";
import { chatDeliveryId } from "flywheel-comm/discord-chat-ingest";
import {
	VOICE_HANDOFF_INTENT_KINDS,
	type VoiceHandoffRequest,
	type VoiceHandoffResultKind,
	voiceHandoffIdempotencyKey,
	voiceHandoffRequestDigest,
} from "flywheel-voice-core";
import type {
	VoiceHandoffAgenda,
	VoiceHandoffRecord,
	VoiceHandoffStore,
} from "./voice-handoff-store.js";
import type { VoiceReplyNotifier } from "./voice-reply-notifier.js";

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const RESULT_KINDS = ["lead_reply", "progress", "completed", "failed"];

export interface VoiceHandoffRouteSession {
	sessionId: string;
	projectName: string;
	sessionGeneration: number;
	leaseToken: string | null;
	leaseExpiresAt: string | null;
	state: string;
}

export interface VoiceHandoffRouterDeps {
	store: VoiceHandoffStore;
	replyNotifier: VoiceReplyNotifier;
	founderUserId: string;
	getSession(sessionId: string): VoiceHandoffRouteSession | undefined;
	isTargetLead(projectName: string, leadId: string): boolean;
	verifyTranscript(
		request: VoiceHandoffRequest,
		session: VoiceHandoffRouteSession,
	): Promise<boolean>;
	dispatch(record: VoiceHandoffRecord): Promise<"committed" | "rejected">;
	verifyResultSource(
		record: VoiceHandoffRecord,
		input: {
			sourceLeadId: string;
			sourceDeliveryId: string;
			requestDigest: string;
			text: string;
		},
	): Promise<boolean>;
	/** FLY-2863 R-T2: the agenda binding of this utterance, looked up by the
	 * server (the client can neither send nor forge it). */
	agendaTurn?(input: {
		sessionId: string;
		generation: number;
		utteranceId: string;
	}):
		| Omit<Extract<VoiceHandoffAgenda, { kind: "turn" }>, "answerKey">
		| undefined;
	now?: () => Date;
}

function exactObject(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !keys.includes(key))) return;
	return record;
}

function requiredString(value: unknown, max = 32_768): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function parseRequest(value: unknown): VoiceHandoffRequest {
	const body = exactObject(value, [
		"handoffId",
		"idempotencyKey",
		"requestDigest",
		"intentKind",
		"payload",
		"sessionId",
		"generation",
		"transcriptId",
		"utteranceId",
		"originalText",
		"authorityBinding",
		"transcriptDurabilityReceipt",
		"delegationBinding",
	]);
	const payload = exactObject(body?.payload, [
		"targetLeadId",
		"text",
		"quotes",
	]);
	const authority = exactObject(body?.authorityBinding, [
		"projectName",
		"founderUserId",
		"targetLeadId",
		"sessionId",
		"generation",
		"transcriptId",
		"transcriptDigest",
	]);
	const receipt = exactObject(body?.transcriptDurabilityReceipt, [
		"version",
		"durable",
		"sessionId",
		"transcriptId",
		"contentDigest",
		"persistedAt",
	]);
	if (
		!body ||
		!payload ||
		!authority ||
		!receipt ||
		!requiredString(body.handoffId, 64) ||
		!UUID.test(body.handoffId) ||
		!requiredString(body.idempotencyKey, 512) ||
		!requiredString(body.requestDigest, 64) ||
		!SHA256.test(body.requestDigest) ||
		!VOICE_HANDOFF_INTENT_KINDS.includes(body.intentKind as never) ||
		!requiredString(body.sessionId, 256) ||
		!Number.isSafeInteger(body.generation) ||
		(body.generation as number) < 1 ||
		!requiredString(body.transcriptId, 256) ||
		!requiredString(body.utteranceId, 256) ||
		!requiredString(body.originalText) ||
		(body.delegationBinding !== undefined &&
			!requiredString(body.delegationBinding, 512)) ||
		!requiredString(payload.targetLeadId, 256) ||
		!requiredString(payload.text) ||
		!Array.isArray(payload.quotes) ||
		payload.quotes.length > 20 ||
		payload.quotes.some(
			(quote) =>
				!requiredString(quote, 2_000) ||
				!(body.originalText as string).includes(quote),
		) ||
		!requiredString(authority.projectName, 256) ||
		!requiredString(authority.founderUserId, 256) ||
		!requiredString(authority.targetLeadId, 256) ||
		!requiredString(authority.sessionId, 256) ||
		!Number.isSafeInteger(authority.generation) ||
		!requiredString(authority.transcriptId, 256) ||
		!requiredString(authority.transcriptDigest, 64) ||
		!SHA256.test(authority.transcriptDigest) ||
		receipt.version !== 1 ||
		receipt.durable !== true ||
		!requiredString(receipt.sessionId, 256) ||
		!requiredString(receipt.transcriptId, 256) ||
		!requiredString(receipt.contentDigest, 64) ||
		!SHA256.test(receipt.contentDigest) ||
		!requiredString(receipt.persistedAt, 64) ||
		!Number.isFinite(Date.parse(receipt.persistedAt))
	)
		throw new Error("voice_handoff_request_invalid");

	const request = body as unknown as VoiceHandoffRequest;
	if (
		request.payload.targetLeadId !== request.authorityBinding.targetLeadId ||
		request.sessionId !== request.authorityBinding.sessionId ||
		request.generation !== request.authorityBinding.generation ||
		request.transcriptId !== request.authorityBinding.transcriptId ||
		request.transcriptId !== request.transcriptDurabilityReceipt.transcriptId ||
		request.sessionId !== request.transcriptDurabilityReceipt.sessionId ||
		request.authorityBinding.transcriptDigest !==
			request.transcriptDurabilityReceipt.contentDigest ||
		request.idempotencyKey !==
			voiceHandoffIdempotencyKey({
				transcriptId: request.transcriptId,
				targetLeadId: request.payload.targetLeadId,
				intentKind: request.intentKind,
			})
	)
		throw new Error("voice_handoff_binding_invalid");
	const { requestDigest: _provided, ...digestInput } = request;
	if (voiceHandoffRequestDigest(digestInput) !== request.requestDigest)
		throw new Error("voice_handoff_digest_invalid");
	return request;
}

function receipt(record: VoiceHandoffRecord) {
	return {
		handoffId: record.handoffId,
		requestDigest: record.requestDigest,
		state: record.state,
		providerOperationId: record.providerOperationId,
	};
}

export function createVoiceHandoffRouter(
	deps: VoiceHandoffRouterDeps,
): express.Router {
	const router = express.Router();
	const now = deps.now ?? (() => new Date());
	const writeSse = (
		res: express.Response,
		event: "ready" | "reply",
		payload: Record<string, unknown>,
	) => {
		res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
	};
	const authorizeSession = (
		sessionId: unknown,
		generation: unknown,
		leaseToken: unknown,
	): VoiceHandoffRouteSession | undefined => {
		if (
			typeof sessionId !== "string" ||
			!Number.isSafeInteger(generation) ||
			typeof leaseToken !== "string"
		)
			return;
		const session = deps.getSession(sessionId);
		if (
			!session ||
			session.sessionGeneration !== generation ||
			session.leaseToken !== leaseToken ||
			!session.leaseExpiresAt ||
			Date.parse(session.leaseExpiresAt) <= now().getTime() ||
			!(session.state === "warming" || session.state === "live")
		)
			return;
		return session;
	};

	router.get("/replies", (req, res) => {
		const session = authorizeSession(
			req.query.sessionId,
			Number(req.query.generation),
			req.headers["x-voice-lease"],
		);
		if (!session) {
			res.status(403).json({ error: "voice_reply_subscription_unauthorized" });
			return;
		}
		res.status(200);
		res.setHeader("content-type", "text/event-stream; charset=utf-8");
		res.setHeader("cache-control", "no-cache, no-transform");
		res.setHeader("connection", "keep-alive");
		res.flushHeaders();
		writeSse(res, "ready", {
			sessionId: session.sessionId,
			generation: session.sessionGeneration,
		});
		const unsubscribe = deps.replyNotifier.subscribe(
			session.sessionId,
			session.sessionGeneration,
			(wake) =>
				writeSse(res, "reply", {
					sessionId: wake.sessionId,
					generation: wake.generation,
					handoffId: wake.handoffId,
				}),
		);

		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			unsubscribe();
		};
		req.once("close", close);
		res.once("close", close);
	});

	router.post("/", async (req, res) => {
		let request: VoiceHandoffRequest;
		try {
			request = parseRequest(req.body);
		} catch (error) {
			res.status(400).json({ error: (error as Error).message });
			return;
		}
		const session = authorizeSession(
			request.sessionId,
			request.generation,
			req.headers["x-voice-lease"],
		);
		if (!session) {
			res.status(403).json({ error: "voice_handoff_session_unauthorized" });
			return;
		}
		if (
			request.authorityBinding.projectName !== session.projectName ||
			request.authorityBinding.founderUserId !== deps.founderUserId ||
			!deps.isTargetLead(session.projectName, request.payload.targetLeadId)
		) {
			res.status(403).json({ error: "voice_handoff_scope_unauthorized" });
			return;
		}
		if (!(await deps.verifyTranscript(request, session))) {
			res.status(403).json({ error: "voice_handoff_transcript_unverified" });
			return;
		}
		const turn = deps.agendaTurn?.({
			sessionId: request.sessionId,
			generation: request.generation,
			utteranceId: request.utteranceId,
		});
		// A retry keeps the stored key: authorize() returns the first record.
		const agenda = turn
			? { ...turn, answerKey: randomBytes(18).toString("base64url") }
			: undefined;
		const metadata = {
			version: 1 as const,
			handoffId: request.handoffId,
			intentKind: request.intentKind,
			requestDigest: request.requestDigest,
			targetLeadId: request.payload.targetLeadId,
			transcriptId: request.transcriptId,
			utteranceId: request.utteranceId,
			sessionGeneration: request.generation,
			...(agenda
				? {
						agenda: {
							kind: "turn" as const,
							itemKey: agenda.itemKey,
							turnId: agenda.turnId,
							itemState: agenda.itemState,
						},
					}
				: {}),
		};
		const messageId = `voice-handoff:${request.handoffId}`;
		let record: VoiceHandoffRecord;
		try {
			record = deps.store.authorize({
				request,
				projectName: session.projectName,
				founderUserId: deps.founderUserId,
				targetLeadId: request.payload.targetLeadId,
				messageId,
				...(agenda ? { agenda } : {}),
				providerOperationId: chatDeliveryId(
					request.payload.targetLeadId,
					messageId,
					{
						origin: "voice",
						voiceSessionId: request.sessionId,
						voiceHandoff: metadata,
					},
				),
				now: now().toISOString(),
			});
		} catch (error) {
			res.status(409).json({ error: (error as Error).message });
			return;
		}
		if (record.state !== "authorized") {
			res.json(receipt(record));
			return;
		}
		const dispatching = deps.store.beginDispatch(
			record.handoffId,
			now().toISOString(),
		);
		if (!dispatching?.attemptToken) {
			res.status(409).json({ error: "voice_handoff_dispatch_conflict" });
			return;
		}
		if (
			!authorizeSession(
				request.sessionId,
				request.generation,
				req.headers["x-voice-lease"],
			) ||
			!deps.isTargetLead(session.projectName, request.payload.targetLeadId)
		) {
			record =
				deps.store.finishDispatch({
					handoffId: dispatching.handoffId,
					attemptToken: dispatching.attemptToken,
					state: "rejected",
					reason: "dispatch_binding_expired",
					now: now().toISOString(),
				}) ?? dispatching;
			res.status(403).json(receipt(record));
			return;
		}
		try {
			const outcome = await deps.dispatch(dispatching);
			record =
				deps.store.finishDispatch({
					handoffId: dispatching.handoffId,
					attemptToken: dispatching.attemptToken,
					state: outcome,
					...(outcome === "rejected" ? { reason: "provider_rejected" } : {}),
					now: now().toISOString(),
				}) ?? dispatching;
		} catch {
			record =
				deps.store.finishDispatch({
					handoffId: dispatching.handoffId,
					attemptToken: dispatching.attemptToken,
					state: "ambiguous",
					reason: "provider_outcome_unknown",
					now: now().toISOString(),
				}) ?? dispatching;
		}
		res.status(record.state === "ambiguous" ? 202 : 200).json(receipt(record));
	});

	router.post("/:handoffId/results", async (req, res) => {
		const body = exactObject(req.body, [
			"resultEventId",
			"requestDigest",
			"sourceLeadId",
			"sourceDeliveryId",
			"resultKind",
			"text",
			"createdAt",
		]);
		if (
			!body ||
			!requiredString(body.resultEventId, 512) ||
			!requiredString(body.requestDigest, 64) ||
			!SHA256.test(body.requestDigest) ||
			!requiredString(body.sourceLeadId, 256) ||
			!requiredString(body.sourceDeliveryId, 512) ||
			!RESULT_KINDS.includes(String(body.resultKind)) ||
			!requiredString(body.text) ||
			!requiredString(body.createdAt, 64) ||
			!Number.isFinite(Date.parse(body.createdAt))
		) {
			res.status(400).json({ error: "voice_handoff_result_invalid" });
			return;
		}
		const handoff = deps.store.get(req.params.handoffId ?? "");
		if (
			!handoff ||
			!(await deps.verifyResultSource(handoff, {
				sourceLeadId: body.sourceLeadId,
				sourceDeliveryId: body.sourceDeliveryId,
				requestDigest: body.requestDigest,
				text: body.text,
			}))
		) {
			res.status(403).json({ error: "voice_handoff_result_unauthorized" });
			return;
		}
		try {
			const previousHighWatermark = deps.store.listResults(
				handoff.handoffId,
				0,
				1,
			).highWatermark;
			const event = deps.store.appendResult({
				handoffId: req.params.handoffId ?? "",
				resultEventId: body.resultEventId,
				requestDigest: body.requestDigest,
				sourceLeadId: body.sourceLeadId,
				sourceDeliveryId: body.sourceDeliveryId,
				resultKind: body.resultKind as VoiceHandoffResultKind,
				text: body.text,
				createdAt: body.createdAt,
			});
			if (event.seq > previousHighWatermark) {
				deps.replyNotifier.notify({
					sessionId: handoff.sessionId,
					generation: handoff.generation,
					handoffId: handoff.handoffId,
				});
			}
			res.json(event);
		} catch (error) {
			const message = (error as Error).message;
			res
				.status(message.endsWith("unauthorized") ? 403 : 409)
				.json({ error: message });
		}
	});

	router.get("/:handoffId/results", (req, res) => {
		const session = authorizeSession(
			req.query.sessionId,
			Number(req.query.generation),
			req.headers["x-voice-lease"],
		);
		const handoff = deps.store.get(req.params.handoffId ?? "");
		if (
			!session ||
			!handoff ||
			handoff.projectName !== session.projectName ||
			handoff.founderUserId !== deps.founderUserId
		) {
			res.status(403).json({ error: "voice_handoff_result_unauthorized" });
			return;
		}
		try {
			res.json(
				deps.store.listResults(
					handoff.handoffId,
					req.query.after === undefined ? 0 : Number(req.query.after),
					req.query.limit === undefined ? 100 : Number(req.query.limit),
				),
			);
		} catch (error) {
			res.status(400).json({ error: (error as Error).message });
		}
	});

	return router;
}
