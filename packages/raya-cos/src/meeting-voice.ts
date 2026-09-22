import { createHash } from "node:crypto";
import type { BusinessRoundView } from "./business-round.js";
import { sanitizeDiscordText } from "./formatting/discord-text.js";
import { projectMeetingStart } from "./meeting-artifact.js";
import { meetingView } from "./meeting-round.js";
import type {
	JsonValue,
	OperationStore,
	StoredOperation,
} from "./operation-store.js";

type Obj = { [key: string]: JsonValue };
const obj = (v: unknown): Obj => {
	if (!v || typeof v !== "object" || Array.isArray(v))
		throw new Error("invalid voice receipt object");
	return v as Obj;
};
const iso = (v: unknown) =>
	typeof v === "string" && Number.isFinite(Date.parse(v));
const sessionId = (v: unknown) =>
	typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v);
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
function command(current: StoredOperation, action: string) {
	return {
		tool: "current_turn",
		arguments: {
			action: "run_voice_command",
			command: [
				"voice-session",
				action,
				"--meeting-id",
				obj(obj(current.material).record).id,
				"--json",
			],
			meetingRevision: obj(current.material).meetingRevision,
			instructions:
				"Run the platform flywheel-comm CLI with its injected credentials. Record voice_result with command, meetingRevision, exitCode and actual JSON body. Do not construct a result from prose.",
		},
	} as BusinessRoundView["next"];
}
export function meetingVoiceNext(
	current: StoredOperation,
): BusinessRoundView["next"] | undefined {
	const material = obj(current.material);
	if (["ended", "cancelled", "missed"].includes(current.stage))
		return material.archive ||
			(material.notification && obj(material.notification).status === "pending")
			? undefined
			: {
					tool: "current_turn",
					arguments: {
						action: "archive_terminal",
						meetingRevision: material.meetingRevision,
					},
				};

	if (material.voiceCall || material.voice) return command(current, "status");
	if (
		current.stage === "starting" &&
		obj(material.startProjection).projected === true
	)
		return {
			tool: "current_turn",
			arguments: {
				action: "begin_voice_start",
				meetingRevision: material.meetingRevision,
			},
		};
	return undefined;
}
export function recordMeetingVoice(
	store: OperationStore,
	workspace: string,
	current: StoredOperation,
	input: Obj,
	now: number,
): BusinessRoundView {
	const result = obj(input.result),
		material = obj(current.material);
	if (
		input.tool !== "current_turn" ||
		typeof input.callId !== "string" ||
		!input.callId.trim() ||
		result.meetingRevision !== material.meetingRevision
	)
		throw new Error("voice call revision mismatch");
	if (material.archive)
		throw new Error("archived meeting rejects voice changes");
	let next: Obj = { ...material },
		stage = current.stage,
		send: string | undefined;
	if (
		result.action === "begin_voice_start" ||
		result.action === "begin_voice_stop"
	) {
		if (
			Object.keys(result).some(
				(k) => !["action", "meetingRevision", "source"].includes(k),
			)
		)
			throw new Error("invalid voice intent fields");
		if (result.action === "begin_voice_start") {
			if (stage !== "starting" || material.voiceCall || material.voice)
				throw new Error("voice start already attempted; reconcile status");
			projectMeetingStart(store, workspace, current);
			next.voiceStartedAt = material.voiceStartedAt ?? now;
			send = "start";
		} else {
			if (
				!["starting", "live", "interrupted"].includes(stage) ||
				!material.voice ||
				!sessionId(obj(material.voice).sessionId)
			)
				throw new Error("voice stop requires a known session");
			const source = obj(result.source);
			if (
				source.authorId !== material.founderUserId ||
				![source.messageId, source.channelId].every(
					(v) => typeof v === "string" && /^\d{17,20}$/.test(v),
				) ||
				typeof source.body !== "string" ||
				!source.body.trim() ||
				source.body.length > 4096 ||
				!Number.isSafeInteger(source.observedAt)
			)
				throw new Error("voice stop founder source required");
			const key = `${source.channelId}:${source.messageId}`,
				digest = hash(JSON.stringify(source)),
				old = obj(material.stopSources ?? {});
			if (old[key] !== undefined) {
				if (old[key] !== digest)
					throw new Error("voice stop source binding changed");
				return meetingView(current);
			}
			next.stopSources = { ...old, [key]: digest };
			next.stopSource = { ...source, body: sanitizeDiscordText(source.body) };
			send = "stop";
		}
		next.voiceCall = {
			command: send,
			attemptedAt: now,
			meetingRevision: material.meetingRevision,
			inFlight: true,
		};
	} else if (result.action === "voice_result") {
		if (
			Object.keys(result).some(
				(k) =>
					![
						"action",
						"meetingRevision",
						"command",
						"exitCode",
						"body",
					].includes(k),
			) ||
			!Number.isInteger(result.exitCode)
		)
			throw new Error("invalid voice result fields");
		const body = obj(result.body ?? {}),
			call = material.voiceCall ? obj(material.voiceCall) : undefined;
		if (
			result.command !== "status" &&
			(!call || call.command !== result.command || call.inFlight !== true)
		)
			throw new Error("voice result command mismatch");
		if (result.command === "status" && !call && !material.voice)
			throw new Error("voice status has no request binding");
		if (result.exitCode !== 0) {
			if (
				result.command === "status" &&
				body.error === "voice_session_not_found" &&
				!material.voice
			) {
				next.voiceCall = null;
				next.voiceFailure = "session_not_found";
			} else {
				next.voiceFailure = sanitizeDiscordText(
					String(body.reason ?? body.error ?? "voice_command_outcome_unknown"),
				);
				if (call)
					next.voiceCall = { ...call, inFlight: false, outcome: "unknown" };
			}
		} else if (result.command === "start") {
			if (
				!["accepted", "already_exists"].includes(String(body.status)) ||
				!sessionId(body.sessionId)
			)
				throw new Error("invalid voice start acceptance");
			next.voice = {
				sessionId: body.sessionId,
				meetingRevision: material.meetingRevision,
				status: "accepted",
			};
			next.voiceCall = { ...call, inFlight: false }; // Acceptance never establishes live.
		} else if (result.command === "stop") {
			if (
				!["ending", "ended", "cancelled", "failed"].includes(String(body.state))
			)
				throw new Error("invalid voice stop receipt");
			next.voiceCall = { ...call, inFlight: false };
		} else if (result.command === "status") {
			const record = obj(material.record),
				target = obj((obj(material.meeting).participants as JsonValue[])[0]);
			if (
				body.meetingId !== record.id ||
				body.mode !== "meeting" ||
				body.projectName !== target.project ||
				body.leadId !== record.leadId ||
				!sessionId(body.sessionId) ||
				(material.voice && obj(material.voice).sessionId !== body.sessionId)
			)
				throw new Error("voice session binding mismatch");
			const states = [
				"provisioning",
				"desired",
				"claimed",
				"warming",
				"live",
				"ending",
				"ended",
				"cancelled",
				"failed",
			];
			if (
				!states.includes(String(body.state)) ||
				!iso(body.createdAt) ||
				!iso(body.updatedAt) ||
				Date.parse(String(body.updatedAt)) < Date.parse(String(body.createdAt))
			)
				throw new Error("invalid voice status observation");
			const previous = material.voice ? obj(material.voice) : undefined;
			if (
				previous?.updatedAt &&
				Date.parse(String(body.updatedAt)) <
					Date.parse(String(previous.updatedAt))
			)
				throw new Error("stale voice status");
			if (
				previous?.updatedAt === body.updatedAt &&
				previous.state !== body.state
			)
				throw new Error("conflicting voice status timestamp");
			const terminal = ["ended", "cancelled", "failed"].includes(
				String(body.state),
			);
			if (
				["ended", "cancelled", "missed"].includes(stage) &&
				(!terminal || previous?.state !== body.state)
			)
				throw new Error("terminal voice state cannot reopen");
			if (
				terminal &&
				(!iso(body.endedAt) ||
					Date.parse(String(body.endedAt)) <
						Date.parse(String(body.createdAt)) ||
					Date.parse(String(body.endedAt)) > Date.parse(String(body.updatedAt)))
			)
				throw new Error("terminal voice status requires endedAt");
			stage =
				body.state === "live"
					? "live"
					: body.state === "ended"
						? "ended"
						: body.state === "cancelled"
							? "cancelled"
							: body.state === "failed"
								? "missed"
								: stage;
			const voice = {
				sessionId: body.sessionId,
				state: body.state,
				meetingRevision: material.meetingRevision,
				updatedAt: body.updatedAt,
				...(body.reason
					? { reason: sanitizeDiscordText(String(body.reason)) }
					: {}),
			};
			const updatedRecord = {
				...record,
				status: stage,
				voice: { sessionId: body.sessionId, state: body.state },
				...(terminal
					? {
							endedAt: body.endedAt,
							endReason: sanitizeDiscordText(String(body.reason ?? body.state)),
						}
					: {}),
			};
			const document = `${JSON.stringify(updatedRecord, null, 2)}\n`;
			next = {
				...next,
				voice,
				voiceFailure: null,
				voiceCall: call
					? { ...call, inFlight: false, outcome: "confirmed" }
					: null,
				record: updatedRecord,
				startProjection: {
					previousHash: obj(material.startProjection).bodyHash,
					document,
					bodyHash: hash(document),
					meetingRevision: material.meetingRevision,
					projected: false,
				},
			};
		} else throw new Error("invalid voice command");
	} else throw new Error("unsupported voice action");
	next.receipts = [
		...(material.receipts as JsonValue[]),
		{
			tool: input.tool,
			callId: input.callId,
			action: result.action,
			meetingRevision: material.meetingRevision,
			recordedAt: now,
			voice: next.voice ?? null,
			voiceFailure: next.voiceFailure ?? null,
		},
	];
	const stored = store.commit(
		{ ...current, stage, material: next },
		current.revision,
	);
	const projected = projectMeetingStart(store, workspace, stored),
		view = meetingView(projected);
	return send ? { ...view, next: command(projected, send) } : view;
}
