import express, { type RequestHandler } from "express";
import { parseReceiveHealth, type ReceiveHealth } from "flywheel-voice-core";
import type {
	StateStore,
	ResidentVoiceBindingProof,
	VoiceCredentialTier,
	VoiceSessionReservation,
	VoiceSessionRow,
} from "../StateStore.js";

export class VoiceSessionHttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly reason?: string,
	) {
		super(reason ?? code);
	}
}

export interface VoiceSessionRouterDeps {
	store: StateStore;
	leaseTtlMs: number;
	leaseRenewMs: number;
	now?: () => string;
	resolveStart: (
		body: unknown,
		credentialTier: VoiceCredentialTier,
	) => VoiceSessionReservation | Promise<VoiceSessionReservation>;
	resolveResidentStart?: (
		body: unknown,
	) =>
		| {
				projectName: string;
				leadId: string;
				requestId: string;
				inputDigest: string;
				ownerBootId: string;
				sessionGeneration: number;
				bindingProof: ResidentVoiceBindingProof;
				reservation: VoiceSessionReservation;
		  }
		| Promise<{
				projectName: string;
				leadId: string;
				requestId: string;
				inputDigest: string;
				ownerBootId: string;
				sessionGeneration: number;
				bindingProof: ResidentVoiceBindingProof;
				reservation: VoiceSessionReservation;
		  }>;
	provisionSession: (sessionId: string) => void | Promise<void>;
	reportAbandoned?: (
		session: VoiceSessionRow,
		count: number,
	) => void | Promise<void>;
	projectSession: (session: VoiceSessionRow) => Record<string, unknown>;
	validateSession?: (
		session: VoiceSessionRow,
		bindingProof?: ResidentVoiceBindingProof,
	) => void | Promise<void>;
}

const DAEMON_ONLY = "daemon_credential_required";
const LEASE_CONFLICT = { error: "voice_lease_conflict" };

function tier(res: express.Response): VoiceCredentialTier {
	return res.locals.voiceCredentialTier as VoiceCredentialTier;
}

function masterOnly(): RequestHandler {
	return (_req, res, next) => {
		if (tier(res) !== "master") {
			res.status(403).json({ error: DAEMON_ONLY });
			return;
		}
		next();
	};
}

function lease(req: express.Request): string {
	return req.header("X-Voice-Lease") ?? "";
}

function param(value: string | string[] | undefined): string {
	return typeof value === "string" ? value : "";
}

function renewBody(body: unknown): {
	receiveHealth?: ReceiveHealth;
	ownerBootId?: string;
	sessionGeneration?: number;
	bindingProof?: ResidentVoiceBindingProof;
} {
	if (body === undefined) return {};
	if (!body || typeof body !== "object" || Array.isArray(body))
		throw new Error("voice_receive_health_invalid");
	const keys = Object.keys(body);
	if (keys.length === 0) return {};
	if (
		keys.some(
			(key) =>
				!new Set([
					"receiveHealth",
					"ownerBootId",
					"sessionGeneration",
					"bindingProof",
				]).has(
					key,
				),
		)
	)
		throw new Error("voice_receive_health_invalid");
	const input = body as {
		receiveHealth?: unknown;
		ownerBootId?: unknown;
		sessionGeneration?: unknown;
		bindingProof?: unknown;
	};
	const hasOwner = input.ownerBootId !== undefined;
	const hasGeneration = input.sessionGeneration !== undefined;
	if (
		hasOwner !== hasGeneration ||
		(hasOwner &&
			(typeof input.ownerBootId !== "string" ||
				!input.ownerBootId.trim() ||
				!Number.isSafeInteger(input.sessionGeneration) ||
				Number(input.sessionGeneration) < 1))
	)
		throw new Error("voice_resident_identity_invalid");
	return {
		...(input.receiveHealth === undefined
			? {}
			: { receiveHealth: parseReceiveHealth(input.receiveHealth) }),
		...(hasOwner
			? {
					ownerBootId: String(input.ownerBootId).trim(),
					sessionGeneration: Number(input.sessionGeneration),
				}
			: {}),
		...(input.bindingProof &&
		typeof input.bindingProof === "object" &&
		!Array.isArray(input.bindingProof)
			? { bindingProof: input.bindingProof as ResidentVoiceBindingProof }
			: input.bindingProof === undefined
				? {}
				: (() => {
						throw new Error("voice_resident_binding_invalid");
					})()),
	};
}

function leaseIdentity(body: unknown): {
	ownerBootId?: string;
	sessionGeneration?: number;
} {
	if (!body || typeof body !== "object" || Array.isArray(body)) return {};
	const input = body as { ownerBootId?: unknown; sessionGeneration?: unknown };
	if (input.ownerBootId === undefined && input.sessionGeneration === undefined)
		return {};
	if (
		typeof input.ownerBootId !== "string" ||
		!input.ownerBootId.trim() ||
		!Number.isSafeInteger(input.sessionGeneration) ||
		Number(input.sessionGeneration) < 1
	)
		throw new Error("voice_resident_identity_invalid");
	return {
		ownerBootId: input.ownerBootId.trim(),
		sessionGeneration: Number(input.sessionGeneration),
	};
}

function sessionBody(
	session: VoiceSessionRow,
	now: string,
	leaseRenewMs: number,
): Record<string, unknown> {
	const observedAt = session.receiveHealthObservedAt;
	const observedAgeMs = observedAt
		? Date.parse(now) - Date.parse(observedAt)
		: Number.POSITIVE_INFINITY;
	const healthFresh =
		new Set(["claimed", "warming", "live", "ending"]).has(session.state) &&
		Boolean(
			session.leaseExpiresAt &&
				Date.parse(session.leaseExpiresAt) > Date.parse(now),
		) &&
		observedAgeMs >= 0 &&
		observedAgeMs <= 3 * leaseRenewMs;
	return {
		sessionId: session.sessionId,
		mode: session.mode,
		projectName: session.projectName,
		leadId: session.leadId,
		guildId: session.guildId,
		voiceChannelId: session.voiceChannelId,
		voiceBotUserId: session.voiceBotUserId,
		carrierKind: session.carrierKind,
		ownerBootId: session.ownerBootId,
		sessionGeneration: session.sessionGeneration,
		state: session.state,
		reason: session.reason,
		meetingId: session.meetingId,
		threadId: session.threadId,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		endedAt: session.endedAt,
		receiveHealth:
			session.receiveHealth && observedAt
				? {
						...session.receiveHealth,
						observedAt,
						fresh: healthFresh,
					}
				: null,
	};
}

export function createVoiceSessionRouter(
	deps: VoiceSessionRouterDeps,
): express.Router {
	const router = express.Router();
	const now = deps.now ?? (() => new Date().toISOString());

	router.post("/", async (req, res) => {
		try {
			const reservation = await deps.resolveStart(req.body, tier(res));
			const result = deps.store.reserveVoiceSession(reservation);
			if (result.status === "meeting_intent_conflict") {
				res.status(409).json({ error: result.status });
				return;
			}
			if (result.status === "session_active") {
				res.status(409).json({ error: result.status });
				return;
			}
			if (result.status === "schedule_bound") {
				// Plan §5: the same binding already has a booking, so this is
				// successful deduplication, not a conflict — the caller is handed
				// what already exists. Starting a second session here would carry no
				// live floor and open the microphone before the meeting time.
				res.status(200).json({
					status: "schedule_bound",
					scheduleId: result.schedule.scheduleId,
					revision: result.schedule.revision,
					state: result.schedule.state,
					sessionId: result.schedule.sessionId,
					scheduledAt: result.schedule.scheduledAt,
				});
				return;
			}
			if (result.status === "schedule_binding_conflict") {
				// A different Lead, room or bot for a meeting that is already
				// booked. Never overwrite a booking; report it.
				res.status(409).json({
					error: "voice_schedule_binding_conflict",
					scheduleId: result.schedule.scheduleId,
					revision: result.schedule.revision,
					state: result.schedule.state,
					sessionId: result.schedule.sessionId,
				});
				return;
			}
			if (result.status === "already_exists") {
				res.status(200).json({
					status: "already_exists",
					sessionId: result.session.sessionId,
					state: result.session.state,
				});
				return;
			}
			if (!("session" in result)) {
				res.status(409).json({ error: result.status });
				return;
			}
			await deps.provisionSession(result.session.sessionId);
			const session = deps.store.getVoiceSession(result.session.sessionId)!;
			if (session.state === "failed") {
				res.status(503).json({
					error: "voice_unavailable",
					reason: session.reason ?? "provisioning_failed",
					sessionId: session.sessionId,
				});
				return;
			}
			res.status(201).json({
				status: "accepted",
				sessionId: session.sessionId,
				state: session.state,
			});
		} catch (error) {
			if (error instanceof VoiceSessionHttpError) {
				res.status(error.status).json({
					error: error.code,
					...(error.reason ? { reason: error.reason } : {}),
				});
				return;
			}
			res.status(503).json({
				error: "voice_unavailable",
				reason: "provisioning_failed",
			});
		}
	});

	router.post("/resident/claim", masterOnly(), async (req, res) => {
		if (!deps.resolveResidentStart) {
			res.status(503).json({
				error: "voice_unavailable",
				reason: "resident_registry_unavailable",
			});
			return;
		}
		try {
			const input = await deps.resolveResidentStart(req.body);
			const result = deps.store.reserveAndClaimResidentVoiceSession({
				...input,
				leaseTtlMs: deps.leaseTtlMs,
			});
			if (!("session" in result)) {
				res.status(409).json({ error: result.status });
				return;
			}
			res.status(result.status === "inserted" ? 201 : 200).json({
				status: result.status,
				sessionId: result.session.sessionId,
				state: result.session.state,
				carrierKind: result.session.carrierKind,
				ownerBootId: result.session.ownerBootId,
				sessionGeneration: result.session.sessionGeneration,
				leaseToken: result.leaseToken,
				leaseTtlMs: deps.leaseTtlMs,
				leaseExpiresAt: result.leaseExpiresAt,
			});
		} catch (error) {
			if (error instanceof VoiceSessionHttpError) {
				res.status(error.status).json({
					error: error.code,
					...(error.reason ? { reason: error.reason } : {}),
				});
				return;
			}
			res.status(503).json({
				error: "voice_unavailable",
				reason: "resident_binding_invalid",
			});
		}
	});

	router.get("/desired", masterOnly(), (_req, res) => {
		const session = deps.store.getDesiredVoiceSession();
		const at = now();
		res.json({
			session: session ? sessionBody(session, at, deps.leaseRenewMs) : null,
		});
	});

	router.get("/by-meeting/:meetingId", (req, res) => {
		const session = deps.store.getVoiceSessionByMeeting(
			param(req.params.meetingId),
		);
		if (!session) {
			res.status(404).json({ error: "voice_session_not_found" });
			return;
		}
		res.json(sessionBody(session, now(), deps.leaseRenewMs));
	});

	router.get("/:sessionId", (req, res) => {
		const session = deps.store.getVoiceSession(param(req.params.sessionId));
		if (!session) {
			res.status(404).json({ error: "voice_session_not_found" });
			return;
		}
		res.json(sessionBody(session, now(), deps.leaseRenewMs));
	});

	router.post("/:sessionId/stop", (req, res) => {
		const state = deps.store.stopVoiceSession(
			param(req.params.sessionId),
			now(),
		);
		if (!state) {
			res.status(404).json({ error: "voice_session_not_found" });
			return;
		}
		res.json({ state });
	});

	router.post("/:sessionId/claim", masterOnly(), async (req, res) => {
		const daemonBootId =
			typeof req.body?.daemonBootId === "string"
				? req.body.daemonBootId.trim()
				: "";
		if (!daemonBootId) {
			res.status(400).json({ error: "daemon_boot_id_required" });
			return;
		}
		const candidate = deps.store.getVoiceSession(param(req.params.sessionId));
		if (!candidate || candidate.state !== "desired") {
			res.status(409).json({ error: "voice_claim_conflict" });
			return;
		}
		let projection: Record<string, unknown>;
		try {
			await deps.validateSession?.(candidate);
			projection = deps.projectSession(candidate);
		} catch {
			res.status(503).json({
				error: "voice_unavailable",
				reason: "voice_session_admission_failed",
			});
			return;
		}
		const claimed = deps.store.claimVoiceSession({
			sessionId: param(req.params.sessionId),
			daemonBootId,
			now: now(),
			leaseTtlMs: deps.leaseTtlMs,
		});
		if (!claimed) {
			res.status(409).json({ error: "voice_claim_conflict" });
			return;
		}
		res.json({
			state: claimed.session.state,
			leaseToken: claimed.leaseToken,
			leaseTtlMs: deps.leaseTtlMs,
			leaseExpiresAt: claimed.leaseExpiresAt,
			projection,
		});
	});

	router.post("/:sessionId/renew", masterOnly(), async (req, res) => {
		let payload: ReturnType<typeof renewBody>;
		try {
			payload = renewBody(req.body);
		} catch {
			res.status(400).json({ error: "voice_receive_health_invalid" });
			return;
		}
		const candidate = deps.store.getActiveVoiceLease(
			param(req.params.sessionId),
			lease(req),
			now(),
			payload,
		);
		if (!candidate) {
			res.status(409).json(LEASE_CONFLICT);
			return;
		}
		if (
			candidate.carrierKind === "resident" &&
			payload.bindingProof === undefined
		) {
			res.status(400).json({ error: "voice_resident_binding_required" });
			return;
		}
		try {
			await deps.validateSession?.(candidate, payload.bindingProof);
		} catch {
			res.status(503).json({
				error: "voice_unavailable",
				reason: "voice_session_admission_failed",
			});
			return;
		}
		const renewed = deps.store.renewVoiceSession({
			sessionId: param(req.params.sessionId),
			leaseToken: lease(req),
			now: now(),
			leaseTtlMs: deps.leaseTtlMs,
			...payload,
		});
		if (!renewed) {
			res.status(409).json(LEASE_CONFLICT);
			return;
		}
		if (renewed.healthSequenceConflict) {
			res.status(400).json({ error: "health_sequence_conflict" });
			return;
		}
		res.json({ ...renewed, leaseTtlMs: deps.leaseTtlMs });
	});

	// FLY-2701: a prewarmed meeting reports "in the room, model up" before its
	// time. Ready is not live — the session stays warming and the Bridge alone
	// decides when the meeting starts.
	router.post("/:sessionId/ready", masterOnly(), (req, res) => {
		const scheduleRevision = req.body?.scheduleRevision ?? null;
		if (
			scheduleRevision !== null &&
			(!Number.isSafeInteger(scheduleRevision) || scheduleRevision < 1)
		) {
			res.status(400).json({ error: "voice_schedule_revision_invalid" });
			return;
		}
		const session = deps.store.getActiveVoiceLease(
			param(req.params.sessionId),
			lease(req),
			now(),
		);
		if (!session) {
			res.status(409).json(LEASE_CONFLICT);
			return;
		}
		const result = deps.store.markVoiceSessionReady({
			sessionId: param(req.params.sessionId),
			scheduleRevision,
			readyAt: now(),
		});
		if (result === "not_found") {
			res.status(404).json({ error: "voice_session_not_found" });
			return;
		}
		if (result !== "ready") {
			res.status(409).json({ error: `voice_${result}` });
			return;
		}
		const updated = deps.store.getVoiceSession(param(req.params.sessionId))!;
		res.json({
			status: "ready",
			state: updated.state,
			readyAt: updated.readyAt,
			notBeforeLiveAt: updated.notBeforeLiveAt,
			presenceDeadlineAt: updated.presenceDeadlineAt,
		});
	});

	router.post("/:sessionId/state", masterOnly(), async (req, res) => {
		const requestedState = req.body?.state;
		const abandonedCount = req.body?.abandonedCount;
		if (!new Set(["warming", "live", "ended", "failed"]).has(requestedState)) {
			res.status(400).json({ error: "voice_state_invalid" });
			return;
		}
		if (
			abandonedCount !== undefined &&
			(!Number.isSafeInteger(abandonedCount) || abandonedCount < 0)
		) {
			res.status(400).json({ error: "voice_abandoned_count_invalid" });
			return;
		}
		let identity: ReturnType<typeof leaseIdentity>;
		try {
			identity = leaseIdentity(req.body);
		} catch {
			res.status(400).json({ error: "voice_resident_identity_invalid" });
			return;
		}
		const changed = deps.store.setVoiceSessionState({
			sessionId: param(req.params.sessionId),
			leaseToken: lease(req),
			state: requestedState,
			reason:
				typeof req.body?.reason === "string" ? req.body.reason : undefined,
			abandonedCount,
			now: now(),
			...identity,
		});
		if (!changed) {
			res.status(409).json(LEASE_CONFLICT);
			return;
		}
		if (abandonedCount > 0 && deps.reportAbandoned) {
			const session = deps.store.getVoiceSession(param(req.params.sessionId));
			if (session) {
				try {
					await deps.reportAbandoned(session, abandonedCount);
				} catch (error) {
					console.warn(
						`[voice-session] abandoned status failed: ${(error as Error).message}`,
					);
				}
			}
		}
		res.json({ state: requestedState });
	});

	router.get("/:sessionId/outbound", masterOnly(), (req, res) => {
		const leaseToken = lease(req);
		const at = now();
		const sessionId = param(req.params.sessionId);
		if (!deps.store.getActiveVoiceLease(sessionId, leaseToken, at)) {
			res.status(409).json(LEASE_CONFLICT);
			return;
		}
		res.json({
			items: deps.store.listVoiceOutbound(sessionId, leaseToken, at),
		});
	});

	router.post("/:sessionId/outbound/:seq/claim", masterOnly(), (req, res) => {
		const seq = Number(req.params.seq);
		if (!Number.isSafeInteger(seq) || seq <= 0) {
			res.status(400).json({ error: "voice_outbound_seq_invalid" });
			return;
		}
		const attemptToken = deps.store.claimVoiceOutbound({
			sessionId: param(req.params.sessionId),
			seq,
			leaseToken: lease(req),
			now: now(),
		});
		if (!attemptToken) {
			res.status(409).json(LEASE_CONFLICT);
			return;
		}
		res.json({ attemptToken });
	});

	router.post("/:sessionId/outbound/:seq/receipt", masterOnly(), (req, res) => {
		const seq = Number(req.params.seq);
		const attemptToken = req.body?.attemptToken;
		const status = req.body?.status;
		if (
			!Number.isSafeInteger(seq) ||
			seq <= 0 ||
			typeof attemptToken !== "string" ||
			!new Set(["confirmed", "unconfirmed", "failed", "dropped"]).has(status)
		) {
			res.status(400).json({ error: "voice_outbound_receipt_invalid" });
			return;
		}
		const result = deps.store.finishVoiceOutbound({
			sessionId: param(req.params.sessionId),
			seq,
			leaseToken: lease(req),
			attemptToken,
			status,
			now: now(),
		});
		if (result === "conflict") {
			res.status(409).json(LEASE_CONFLICT);
			return;
		}
		res.json({ status, replayed: result === "replayed" });
	});

	return router;
}
