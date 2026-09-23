import { createHash } from "node:crypto";
import express, { type RequestHandler } from "express";
import type {
	StateStore,
	VoiceCredentialTier,
	VoiceScheduleRow,
} from "../StateStore.js";
import { VoiceSessionHttpError } from "./voice-session-routes.js";

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** ISO 8601 with an explicit offset. A naive timestamp has no single instant. */
const ABSOLUTE_ISO =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
export const VOICE_PREWARM_LEAD_DEFAULT_MS = 120_000;
const VOICE_PREWARM_LEAD_MIN_MS = 60_000;
const VOICE_PREWARM_LEAD_MAX_MS = 300_000;

/**
 * FLY-2701: the prewarm lead is trusted deployment configuration, never a
 * request field — an API caller must not be able to make the Bridge start the
 * voice process an arbitrary time early. Out-of-band values fail the deployment
 * instead of being silently clamped into something nobody asked for.
 */
export function resolveVoicePrewarmLeadMs(value: number | undefined): number {
	if (value === undefined) return VOICE_PREWARM_LEAD_DEFAULT_MS;
	if (
		!Number.isFinite(value) ||
		!Number.isInteger(value) ||
		value < VOICE_PREWARM_LEAD_MIN_MS ||
		value > VOICE_PREWARM_LEAD_MAX_MS
	) {
		throw new Error(
			`voice_prewarm_lead_invalid: ${VOICE_PREWARM_LEAD_MIN_MS}..${VOICE_PREWARM_LEAD_MAX_MS}`,
		);
	}
	return value;
}

export interface VoiceScheduleBinding {
	projectName: string;
	leadId: string;
	guildId: string;
	voiceChannelId: string;
	voiceBotUserId: string;
	evidenceDir: string;
	topic?: string;
}

export interface VoiceScheduleRouterDeps {
	store: StateStore;
	/** Frozen lead for every schedule this Bridge admits. */
	prewarmLeadMs: number;
	/** How long the bot waits in the room for the founder before giving up. */
	presenceGraceMs: number;
	newScheduleId: () => string;
	now?: () => string;
	/**
	 * Validates project/lead/room identity and the evidence directory exactly as
	 * the instant start path does, and returns the registry-resolved binding.
	 */
	resolveBinding: (input: {
		projectName: string;
		leadId: string;
		evidenceDir: string;
		topic?: string;
		credentialTier: VoiceCredentialTier;
	}) => VoiceScheduleBinding | Promise<VoiceScheduleBinding>;
}

function tier(res: express.Response): VoiceCredentialTier {
	return res.locals.voiceCredentialTier as VoiceCredentialTier;
}

function masterOnly(): RequestHandler {
	return (_req, res, next) => {
		if (tier(res) !== "master") {
			res.status(403).json({ error: "daemon_credential_required" });
			return;
		}
		next();
	};
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new VoiceSessionHttpError(400, "voice_request_invalid");
	}
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): void {
	if (Object.keys(value).some((key) => !allowed.includes(key))) {
		throw new VoiceSessionHttpError(400, "voice_request_invalid");
	}
}

function requiredString(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new VoiceSessionHttpError(400, "voice_request_invalid");
	}
	return value.trim();
}

function requestId(value: unknown): string {
	const id = requiredString(value);
	if (!UUID.test(id)) {
		throw new VoiceSessionHttpError(400, "voice_request_invalid");
	}
	return id;
}

function expectedRevision(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > Number.MAX_SAFE_INTEGER
	) {
		throw new VoiceSessionHttpError(400, "voice_request_invalid");
	}
	return value;
}

/**
 * Normalizes an absolute instant to UTC and refuses anything else. Deliberately
 * free of "now": this is the stable form a request receipt is keyed on, so it
 * must give the same answer to a retry that arrives an hour later.
 */
function normalizeInstant(value: unknown): string {
	const raw = requiredString(value);
	if (!ABSOLUTE_ISO.test(raw)) {
		throw new VoiceSessionHttpError(400, "voice_request_invalid");
	}
	const parsed = Date.parse(raw);
	if (!Number.isFinite(parsed)) {
		throw new VoiceSessionHttpError(400, "voice_request_invalid");
	}
	return new Date(parsed).toISOString();
}

/**
 * The time-variant half, applied only to a request we have never accepted. A
 * replay of an already committed booking must not be re-judged against a clock
 * that has moved on since it was accepted.
 */
function withinBookingHorizon(iso: string, nowMs: number): string {
	const parsed = Date.parse(iso);
	if (parsed < nowMs || parsed > nowMs + MAX_HORIZON_MS) {
		throw new VoiceSessionHttpError(400, "voice_request_invalid");
	}
	return iso;
}

function digest(payload: Record<string, unknown>): string {
	return createHash("sha256")
		.update(
			JSON.stringify(
				Object.fromEntries(
					Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)),
				),
			),
		)
		.digest("hex");
}

function scheduleBody(
	schedule: VoiceScheduleRow,
	activeCleanup: boolean,
): Record<string, unknown> {
	return {
		scheduleId: schedule.scheduleId,
		revision: schedule.revision,
		state: schedule.state,
		projectName: schedule.projectName,
		leadId: schedule.leadId,
		scheduledAt: schedule.scheduledAt,
		prewarmAt: schedule.prewarmAt,
		readyDeadlineAt: schedule.readyDeadlineAt,
		presenceDeadlineAt: schedule.presenceDeadlineAt,
		lateAdmission: schedule.lateAdmission,
		meetingId: schedule.meetingId,
		sessionId: schedule.sessionId,
		terminalReason: schedule.terminalReason,
		createdAt: schedule.createdAt,
		updatedAt: schedule.updatedAt,
		activeCleanup,
	};
}

export function createVoiceScheduleRouter(
	deps: VoiceScheduleRouterDeps,
): express.Router {
	const router = express.Router();
	const now = deps.now ?? (() => new Date().toISOString());
	const prewarmLeadMs = resolveVoicePrewarmLeadMs(deps.prewarmLeadMs);

	/**
	 * A cancel is accepted, not completed: the linked session keeps running until
	 * it reaches its own terminal state, and the status says so rather than
	 * claiming the room is already free.
	 */
	const activeCleanup = (schedule: VoiceScheduleRow): boolean => {
		if (!schedule.sessionId) return false;
		const session = deps.store.getVoiceSession(schedule.sessionId);
		return (
			session !== undefined &&
			!["ended", "cancelled", "failed"].includes(session.state)
		);
	};

	const deadlines = (at: string, nowIso: string) => {
		const atMs = Date.parse(at);
		const nowMs = Date.parse(nowIso);
		const prewarmMs = atMs - prewarmLeadMs;
		const lateAdmission = prewarmMs < nowMs;
		return {
			prewarmAt: new Date(lateAdmission ? nowMs : prewarmMs).toISOString(),
			readyDeadlineAt: at,
			presenceDeadlineAt: new Date(atMs + deps.presenceGraceMs).toISOString(),
			lateAdmission,
		};
	};

	const fail = (res: express.Response, error: unknown): void => {
		if (error instanceof VoiceSessionHttpError) {
			res.status(error.status).json({
				error: error.code,
				...(error.reason ? { reason: error.reason } : {}),
			});
			return;
		}
		res.status(503).json({
			error: "voice_unavailable",
			reason: "voice_schedule_unavailable",
		});
	};

	router.post("/", masterOnly(), async (req, res) => {
		try {
			const request = object(req.body);
			exactKeys(request, [
				"requestId",
				"projectName",
				"leadId",
				"scheduledAt",
				"evidenceDir",
				"topic",
				"meetingId",
			]);
			const credentialTier = tier(res);
			const at = now();
			const id = requestId(request.requestId);
			const scheduled = normalizeInstant(request.scheduledAt);
			const meetingId =
				request.meetingId === undefined
					? undefined
					: requestId(request.meetingId);
			// The receipt is keyed on the caller's own words, normalized — not on
			// anything we resolve or compare against the clock. That is what makes
			// a lost response replayable after T, or while the registry is down.
			const requestKey = `${credentialTier}:${id}`;
			const requestDigest = digest({
				kind: "create",
				scheduledAt: scheduled,
				projectName: requiredString(request.projectName),
				leadId: requiredString(request.leadId),
				evidenceDir: requiredString(request.evidenceDir),
				meetingId: meetingId ?? null,
				topic:
					request.topic === undefined ? null : requiredString(request.topic),
			});
			const receipt = deps.store.readVoiceScheduleReceipt(
				requestKey,
				requestDigest,
			);
			if (receipt.kind === "conflict") {
				res.status(409).json({ error: "voice_request_replay_conflict" });
				return;
			}
			if (receipt.kind === "replay") {
				res
					.status(200)
					.json(
						scheduleBody(receipt.schedule, activeCleanup(receipt.schedule)),
					);
				return;
			}
			withinBookingHorizon(scheduled, Date.parse(at));
			const binding = await deps.resolveBinding({
				projectName: requiredString(request.projectName),
				leadId: requiredString(request.leadId),
				evidenceDir: requiredString(request.evidenceDir),
				...(request.topic === undefined
					? {}
					: { topic: requiredString(request.topic) }),
				credentialTier,
			});
			const frozen = deadlines(scheduled, at);
			const result = deps.store.createVoiceSchedule({
				scheduleId: deps.newScheduleId(),
				requestKey,
				requestDigest,
				projectName: binding.projectName,
				leadId: binding.leadId,
				guildId: binding.guildId,
				voiceChannelId: binding.voiceChannelId,
				voiceBotUserId: binding.voiceBotUserId,
				evidenceDir: binding.evidenceDir,
				...(binding.topic ? { topic: binding.topic } : {}),
				...(meetingId ? { meetingId } : {}),
				scheduledAt: scheduled,
				...frozen,
				requestedBy: credentialTier,
				credentialTier,
				createdAt: at,
			});
			if (result.status === "request_conflict") {
				res.status(409).json({ error: "voice_request_replay_conflict" });
				return;
			}
			if (result.status === "session_conflict") {
				// Plan §5: an instant call already owns this meeting. Booking it now
				// would steal a running call into a schedule, so the conflict is
				// reported with the session the caller should look at.
				res.status(409).json({
					error: "voice_schedule_binding_conflict",
					sessionId: result.session.sessionId,
					state: result.session.state,
				});
				return;
			}
			if (result.status === "meeting_conflict") {
				res.status(409).json({
					error: "voice_schedule_binding_conflict",
					scheduleId: result.schedule.scheduleId,
					revision: result.schedule.revision,
					state: result.schedule.state,
				});
				return;
			}
			res
				.status(result.status === "created" ? 201 : 200)
				.json(scheduleBody(result.schedule, activeCleanup(result.schedule)));
		} catch (error) {
			fail(res, error);
		}
	});

	router.patch("/:scheduleId", masterOnly(), (req, res) => {
		try {
			const request = object(req.body);
			// A reschedule moves time only. Changing who or where needs a cancel and
			// a fresh booking, so identity can never drift under an existing id.
			exactKeys(request, ["requestId", "expectedRevision", "scheduledAt"]);
			const credentialTier = tier(res);
			const at = now();
			const id = requestId(request.requestId);
			const revision = expectedRevision(request.expectedRevision);
			const scheduled = normalizeInstant(request.scheduledAt);
			const requestKey = `${credentialTier}:${id}`;
			const requestDigest = digest({
				kind: "reschedule",
				scheduleId: String(req.params.scheduleId ?? ""),
				expectedRevision: revision,
				scheduledAt: scheduled,
			});
			const receipt = deps.store.readVoiceScheduleReceipt(
				requestKey,
				requestDigest,
			);
			if (receipt.kind === "conflict") {
				res.status(409).json({ error: "voice_request_replay_conflict" });
				return;
			}
			if (receipt.kind === "replay") {
				res
					.status(200)
					.json(
						scheduleBody(receipt.schedule, activeCleanup(receipt.schedule)),
					);
				return;
			}
			withinBookingHorizon(scheduled, Date.parse(at));
			const frozen = deadlines(scheduled, at);
			const result = deps.store.rescheduleVoiceSchedule({
				scheduleId: String(req.params.scheduleId ?? ""),
				requestKey,
				requestDigest,
				expectedRevision: revision,
				scheduledAt: scheduled,
				...frozen,
				updatedAt: at,
			});
			switch (result.status) {
				case "not_found":
					res.status(404).json({ error: "voice_schedule_not_found" });
					return;
				case "request_conflict":
					res.status(409).json({ error: "voice_request_replay_conflict" });
					return;
				case "revision_conflict":
					res.status(409).json({
						error: "voice_schedule_revision_conflict",
						revision: result.schedule.revision,
						state: result.schedule.state,
					});
					return;
				case "terminal":
					res.status(409).json({
						error: "voice_schedule_terminal",
						state: result.schedule.state,
					});
					return;
				default:
					res
						.status(200)
						.json(
							scheduleBody(result.schedule, activeCleanup(result.schedule)),
						);
			}
		} catch (error) {
			fail(res, error);
		}
	});

	router.post("/:scheduleId/cancel", masterOnly(), (req, res) => {
		try {
			const request = object(req.body);
			exactKeys(request, ["requestId", "expectedRevision"]);
			const credentialTier = tier(res);
			const at = now();
			const id = requestId(request.requestId);
			const revision = expectedRevision(request.expectedRevision);
			const scheduleId = String(req.params.scheduleId ?? "");
			const result = deps.store.cancelVoiceSchedule({
				scheduleId,
				requestKey: `${credentialTier}:${id}`,
				requestDigest: digest({
					kind: "cancel",
					scheduleId,
					expectedRevision: revision,
				}),
				expectedRevision: revision,
				updatedAt: at,
			});
			switch (result.status) {
				case "not_found":
					res.status(404).json({ error: "voice_schedule_not_found" });
					return;
				case "request_conflict":
					res.status(409).json({ error: "voice_request_replay_conflict" });
					return;
				case "revision_conflict":
					res.status(409).json({
						error: "voice_schedule_revision_conflict",
						revision: result.schedule.revision,
						state: result.schedule.state,
					});
					return;
				case "terminal":
					res.status(409).json({
						error: "voice_schedule_terminal",
						state: result.schedule.state,
					});
					return;
				default:
					res
						.status(200)
						.json(
							scheduleBody(result.schedule, activeCleanup(result.schedule)),
						);
			}
		} catch (error) {
			fail(res, error);
		}
	});

	router.get("/:scheduleId", masterOnly(), (req, res) => {
		const schedule = deps.store.getVoiceSchedule(
			String(req.params.scheduleId ?? ""),
		);
		if (!schedule) {
			res.status(404).json({ error: "voice_schedule_not_found" });
			return;
		}
		res.status(200).json(scheduleBody(schedule, activeCleanup(schedule)));
	});

	return router;
}
