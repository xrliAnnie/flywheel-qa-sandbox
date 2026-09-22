import { homedir } from "node:os";
import { join } from "node:path";
import express from "express";
import { forwardedLeadAuthorizationEnv } from "flywheel-comm/lead-lease";
import { z } from "zod";
import { leadOperationInputDigest } from "../lead-capabilities/broker.js";
import { getLeadCapability } from "../lead-capabilities/catalog.js";
import type {
	StateStore,
	VoiceCredentialTier,
	VoiceSessionReservation,
	VoiceSessionRow,
} from "../StateStore.js";
import { captureLeadCapabilityScope } from "./lead-capability-scope.js";
import { VoiceSessionHttpError } from "./voice-session-routes.js";

const coordinate = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const operationId = z.enum([
	"voice.session.start",
	"voice.session.status",
	"voice.session.stop",
]);
const requestSchema = z
	.object({
		schemaVersion: z.literal(1),
		operationId,
		requestId: z.string().uuid(),
		projectName: coordinate,
		leadId: coordinate,
		identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
		carrierClaim: z.string().min(1).max(256),
		activationId: coordinate,
		input: z.unknown(),
	})
	.strict();
type Request = z.infer<typeof requestSchema>;

const denied = () => new Error("voice_scope_denied");
const ACTIVE_STATES = new Set(["claimed", "warming", "live", "ending"]);

export interface LeadCapabilityVoiceRouterDeps {
	store: StateStore;
	leaseRenewMs: number;
	resolveStart(
		body: unknown,
		credentialTier: VoiceCredentialTier,
	): Promise<VoiceSessionReservation>;
	provisionSession(sessionId: string): void | Promise<void>;
	projectsPath?: string;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	now?: () => string;
}

function healthProjection(
	session: VoiceSessionRow,
	now: string,
	leaseRenewMs: number,
) {
	if (!session.receiveHealth || !session.receiveHealthObservedAt) return null;
	const age = Date.parse(now) - Date.parse(session.receiveHealthObservedAt);
	const fresh =
		ACTIVE_STATES.has(session.state) &&
		Boolean(
			session.leaseExpiresAt &&
				Date.parse(session.leaseExpiresAt) > Date.parse(now),
		) &&
		age >= 0 &&
		age <= 3 * leaseRenewMs;
	return {
		...session.receiveHealth,
		observedAt: session.receiveHealthObservedAt,
		fresh,
	};
}

function sessionResult(
	session: VoiceSessionRow,
	now: string,
	leaseRenewMs: number,
) {
	return {
		sessionId: session.sessionId,
		mode: session.mode,
		state: session.state,
		threadId: session.threadId,
		receiveHealth: healthProjection(session, now, leaseRenewMs),
	};
}

export function createLeadCapabilityVoiceRouter(
	deps: LeadCapabilityVoiceRouterDeps,
): { operationRouter: express.Router; receiptRouter: express.Router } {
	const operationRouter = express.Router();
	const receiptRouter = express.Router();
	const env = Object.freeze({ ...(deps.env ?? process.env) });
	const homeDir = deps.homeDir ?? env.HOME ?? homedir();
	const projectsPath =
		deps.projectsPath ??
		env.FLYWHEEL_PROJECTS_FILE ??
		join(homeDir, ".flywheel", "projects.json");
	const now = deps.now ?? (() => new Date().toISOString());

	const parse = (raw: unknown) => {
		const request = requestSchema.parse(raw);
		const definition = getLeadCapability(request.operationId);
		if (!definition) throw denied();
		const input = definition.inputSchema.parse(request.input);
		return { request, input };
	};
	const scope = (request: Request) => {
		const claimEnv = forwardedLeadAuthorizationEnv(
			{
				claimedLeadId: request.leadId,
				projectName: request.projectName,
				identityDigest: request.identityDigest,
				carrierClaim: request.carrierClaim,
			},
			{ ...env, HOME: homeDir, FLYWHEEL_PROJECTS_FILE: projectsPath },
		);
		const captured = captureLeadCapabilityScope({
			projectsPath,
			homeDir,
			projectName: request.projectName,
			leadId: request.leadId,
			identityDigest: request.identityDigest,
			claimEnv,
			denied,
		});
		if (captured.row.lead.codexVoiceActions !== true) throw denied();
		return captured;
	};
	const reply = (
		request: Request,
		status: "succeeded" | "rejected" | "unknown",
		options: {
			session?: VoiceSessionRow;
			data?: unknown;
			errorCode?: string;
		} = {},
	) => ({
		requestId: request.requestId,
		status,
		resourceRefs: options.session
			? [`voice-session:${options.session.sessionId}`]
			: [],
		...(options.data === undefined ? {} : { data: options.data }),
		...(options.errorCode ? { errorCode: options.errorCode } : {}),
	});
	const output = (request: Request, result: unknown) => ({
		result,
		receiptId: request.requestId,
		observedAt: now(),
	});
	const scopedSession = (request: Request, sessionId: string) => {
		const session = deps.store.getVoiceSession(sessionId);
		if (
			!session ||
			session.projectName !== request.projectName ||
			session.leadId !== request.leadId
		)
			throw denied();
		return session;
	};
	const startReply = (request: Request, session: VoiceSessionRow) => {
		if (session.state === "provisioning") {
			return reply(request, "unknown", { session });
		}
		if (session.state === "failed") {
			return reply(request, "rejected", {
				session,
				errorCode: session.reason ?? "voice_session_failed",
			});
		}
		return reply(request, "succeeded", {
			session,
			data: output(request, {
				sessionId: session.sessionId,
				threadId: session.threadId,
				mode: session.mode,
				state: session.state,
				accepted: true,
			}),
		});
	};

	const execute = async (request: Request, input: Record<string, unknown>) => {
		const captured = scope(request);
		captured.assertSourceCurrent();
		if (request.operationId === "voice.session.start") {
			const mode = input.mode as "rg" | "meeting";
			const startBody = input.meetingId
				? { meetingId: input.meetingId, requestedBy: request.leadId }
				: {
						mode,
						projectName: request.projectName,
						leadId: request.leadId,
						...(input.topic ? { topic: input.topic } : {}),
						requestedBy: request.leadId,
					};
			const reservation = await deps.resolveStart(startBody, "master");
			captured.assertSourceCurrent();
			if (
				reservation.projectName !== request.projectName ||
				reservation.leadId !== request.leadId ||
				reservation.mode !== mode
			)
				throw denied();
			const reserved = deps.store.reserveVoiceSessionIntent({
				projectName: request.projectName,
				leadId: request.leadId,
				requestId: request.requestId,
				operationId: request.operationId,
				inputDigest: leadOperationInputDigest(input),
				reservation,
			});
			if (!("session" in reserved)) {
				return reply(request, "rejected", {
					errorCode:
						reserved.status === "intent_conflict"
							? "voice_intent_conflict"
							: "voice_session_active",
				});
			}
			if (reserved.session.state === "provisioning") {
				try {
					captured.assertSourceCurrent();
					await deps.provisionSession(reserved.session.sessionId);
					captured.assertSourceCurrent();
				} catch {
					return startReply(
						request,
						scopedSession(request, reserved.session.sessionId),
					);
				}
			}
			const session = scopedSession(request, reserved.session.sessionId);
			return startReply(request, session);
		}
		const sessionId = input.sessionId as string;
		if (request.operationId === "voice.session.status") {
			const session = scopedSession(request, sessionId);
			captured.assertSourceCurrent();
			return reply(request, "succeeded", {
				session,
				data: output(request, sessionResult(session, now(), deps.leaseRenewMs)),
			});
		}
		captured.assertSourceCurrent();
		const stopped = deps.store.stopVoiceSessionIntent({
			projectName: request.projectName,
			leadId: request.leadId,
			requestId: request.requestId,
			operationId: "voice.session.stop",
			inputDigest: leadOperationInputDigest(input),
			sessionId,
			now: now(),
		});
		if (!("state" in stopped)) {
			return reply(request, "rejected", {
				errorCode:
					stopped.status === "intent_conflict"
						? "voice_intent_conflict"
						: "voice_scope_denied",
			});
		}
		const session = scopedSession(request, sessionId);
		return reply(request, "succeeded", {
			session,
			data: output(request, { sessionId, state: stopped.state }),
		});
	};

	operationRouter.post("/", async (req, res) => {
		let request: Request | undefined;
		try {
			const parsed = parse(req.body);
			request = parsed.request;
			res.json(await execute(parsed.request, parsed.input));
		} catch (error) {
			if (!request) {
				res.status(400).json({ error: "voice_capability_invalid" });
				return;
			}
			if (error instanceof VoiceSessionHttpError) {
				res.json(reply(request, "rejected", { errorCode: error.code }));
				return;
			}
			res
				.status(403)
				.json(reply(request, "rejected", { errorCode: "voice_scope_denied" }));
		}
	});

	receiptRouter.post("/", (req, res) => {
		let request: Request | undefined;
		try {
			const parsed = parse(req.body);
			request = parsed.request;
			const captured = scope(request);
			const intent = deps.store.getVoiceIntent(
				request.projectName,
				request.leadId,
				request.requestId,
			);
			if (
				!intent ||
				intent.operationId !== request.operationId ||
				intent.inputDigest !== leadOperationInputDigest(parsed.input) ||
				!intent.sessionId
			) {
				res.json(reply(request, "unknown"));
				return;
			}
			const session = scopedSession(request, intent.sessionId);
			captured.assertSourceCurrent();
			if (request.operationId === "voice.session.start") {
				res.json(startReply(request, session));
				return;
			}
			const result = {
				sessionId: session.sessionId,
				state: intent.resultState,
			};
			res.json(
				reply(request, "succeeded", {
					session,
					data: output(request, result),
				}),
			);
		} catch {
			if (!request) {
				res.status(400).json({ error: "voice_capability_invalid" });
				return;
			}
			res
				.status(403)
				.json(reply(request, "rejected", { errorCode: "voice_scope_denied" }));
		}
	});

	return { operationRouter, receiptRouter };
}
