import express, { type RequestHandler } from "express";
import type {
	StateStore,
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
	now?: () => string;
	resolveStart: (
		body: unknown,
		credentialTier: VoiceCredentialTier,
	) => VoiceSessionReservation | Promise<VoiceSessionReservation>;
	provisionSession: (sessionId: string) => void | Promise<void>;
	reportAbandoned?: (
		session: VoiceSessionRow,
		count: number,
	) => void | Promise<void>;
	projectSession: (session: VoiceSessionRow) => Record<string, unknown>;
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

function sessionBody(session: VoiceSessionRow): Record<string, unknown> {
	return {
		sessionId: session.sessionId,
		mode: session.mode,
		projectName: session.projectName,
		leadId: session.leadId,
		state: session.state,
		reason: session.reason,
		meetingId: session.meetingId,
		threadId: session.threadId,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		endedAt: session.endedAt,
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

	router.get("/desired", masterOnly(), (_req, res) => {
		const session = deps.store.getDesiredVoiceSession();
		res.json({ session: session ? sessionBody(session) : null });
	});

	router.get("/by-meeting/:meetingId", (req, res) => {
		const session = deps.store.getVoiceSessionByMeeting(
			param(req.params.meetingId),
		);
		if (!session) {
			res.status(404).json({ error: "voice_session_not_found" });
			return;
		}
		res.json(sessionBody(session));
	});

	router.get("/:sessionId", (req, res) => {
		const session = deps.store.getVoiceSession(param(req.params.sessionId));
		if (!session) {
			res.status(404).json({ error: "voice_session_not_found" });
			return;
		}
		res.json(sessionBody(session));
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

	router.post("/:sessionId/claim", masterOnly(), (req, res) => {
		const daemonBootId =
			typeof req.body?.daemonBootId === "string"
				? req.body.daemonBootId.trim()
				: "";
		if (!daemonBootId) {
			res.status(400).json({ error: "daemon_boot_id_required" });
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
			projection: deps.projectSession(claimed.session),
		});
	});

	router.post("/:sessionId/renew", masterOnly(), (req, res) => {
		const renewed = deps.store.renewVoiceSession({
			sessionId: param(req.params.sessionId),
			leaseToken: lease(req),
			now: now(),
			leaseTtlMs: deps.leaseTtlMs,
		});
		if (!renewed) {
			res.status(409).json(LEASE_CONFLICT);
			return;
		}
		res.json({ ...renewed, leaseTtlMs: deps.leaseTtlMs });
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
		const changed = deps.store.setVoiceSessionState({
			sessionId: param(req.params.sessionId),
			leaseToken: lease(req),
			state: requestedState,
			reason:
				typeof req.body?.reason === "string" ? req.body.reason : undefined,
			abandonedCount,
			now: now(),
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
