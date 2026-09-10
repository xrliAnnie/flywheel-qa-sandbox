import { createHash, randomUUID } from "node:crypto";
import {
	AUTO_NARROW_CONTROL_MODES,
	AUTO_NARROW_FLAG_NAME,
	type AutoNarrowControlMode,
} from "flywheel-comm/auto-narrow-contract";
import {
	authorizeLeadWrite,
	forwardedLeadAuthorizationEnv,
	type LeadWriteAuthorizationDeps,
	type MessageProvenance,
} from "flywheel-comm/lead-lease";
import type { StateStore } from "../StateStore.js";
import {
	type FetchDiscordMessageResult,
	fetchDiscordMessageFromChannel,
} from "./discord-utils.js";
import type { ConfirmTokenStore } from "./fleet-admin.js";
import { newBatchId } from "./fleet-admin.js";
import type { FleetAdminAudit } from "./fleet-admin-audit.js";

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const OPEN_MAX_AGE_MS = 10 * 60_000;
const FUTURE_SKEW_MS = 5_000;
const EDGE_PUNCTUATION = /^[，。！,.!；;、]+|[，。！,.!；;、]+$/g;
const CONTROL_INPUT_KEYS = new Set([
	"name",
	"to",
	"project",
	"op",
	"reason",
	"founderMessageRef",
	"leadAuth",
	"carrierClaim",
]);

export interface AutoNarrowLeadAuth {
	leadId: string;
	projectName: string;
	identityDigest: string;
	leaseClaim?: { leaseKey: string; generation: number };
	carrierClaim?: string;
	provenance?: MessageProvenance;
}

export interface AutoNarrowControlCanonical {
	kind: "auto_narrow_control";
	batchId: string;
	eventId: string;
	name: typeof AUTO_NARROW_FLAG_NAME;
	projectName: "flywheel";
	mode: AutoNarrowControlMode;
	expectedChangeSeq: number;
	reason: string;
	commandText: "现在放开" | "现在停止";
	messageRef: { channelId: string; messageId: string };
	messageCreatedAt: string;
	messageDigest: string;
	leadId: "flywheel-eng-lead";
	leadIdentityDigest: string;
}

export interface AutoNarrowControlRouteDeps {
	store: StateStore;
	founderUserId: string;
	engineeringChannelId: string;
	leadId: string;
	botToken: string;
	tokens: Pick<ConfirmTokenStore, "issue" | "verifyAndConsume">;
	audit: Pick<FleetAdminAudit, "record">;
	fetchDiscordMessage?: (
		channelId: string,
		messageId: string,
		botToken: string,
	) => Promise<FetchDiscordMessageResult>;
	authorizeLeadRequest?: (input: AutoNarrowLeadAuth) => boolean;
	leadLeaseEnv?: NodeJS.ProcessEnv;
	leadWriteAuthorizationDeps?: LeadWriteAuthorizationDeps;
	now?: () => number;
	randomId?: () => string;
}

export interface AutoNarrowControlInput {
	name?: unknown;
	to?: unknown;
	project?: unknown;
	op?: unknown;
	reason?: unknown;
	founderMessageRef?: unknown;
	leadAuth?: unknown;
	carrierClaim?: unknown;
}

export interface AutoNarrowControlRouteResult {
	code: number;
	body: unknown;
}

function fail(code: number, error: string): AutoNarrowControlRouteResult {
	return { code, body: { error } };
}

// Never persist forwarded credentials or raw untrusted command bodies.
function denyControl(
	deps: AutoNarrowControlRouteDeps,
	origin: string,
	phase: "stage" | "apply",
	value: unknown,
	code: number,
	error: string,
): AutoNarrowControlRouteResult {
	const object = exactObject(value) ? value : {};
	const messageRef = parseMessageRef(
		object.founderMessageRef ?? object.messageRef,
	);
	const recorded = deps.audit.record({
		batchId: newBatchId(),
		event: "denied",
		attemptId: randomUUID(),
		canonicalRequest: JSON.stringify({
			kind: "auto_narrow_control",
			phase,
			...(messageRef ? { messageRef } : {}),
		}),
		origin,
		reason: error,
	});
	return recorded ? fail(code, error) : fail(500, "control_audit_unavailable");
}

function exactObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseLeadAuth(value: unknown): AutoNarrowLeadAuth | undefined {
	if (!exactObject(value)) return undefined;
	if (
		typeof value.leadId !== "string" ||
		typeof value.projectName !== "string" ||
		typeof value.identityDigest !== "string" ||
		!SHA256.test(value.identityDigest)
	) {
		return undefined;
	}
	const lease = value.leaseClaim;
	if (
		lease !== undefined &&
		(!exactObject(lease) ||
			typeof lease.leaseKey !== "string" ||
			!Number.isSafeInteger(lease.generation) ||
			Number(lease.generation) <= 0)
	) {
		return undefined;
	}
	if (
		value.carrierClaim !== undefined &&
		typeof value.carrierClaim !== "string"
	) {
		return undefined;
	}
	return value as unknown as AutoNarrowLeadAuth;
}

function parseMessageRef(
	value: unknown,
): { channelId: string; messageId: string } | undefined {
	if (!exactObject(value)) return undefined;
	if (
		Object.keys(value).length !== 2 ||
		typeof value.channelId !== "string" ||
		typeof value.messageId !== "string" ||
		!DISCORD_SNOWFLAKE.test(value.channelId) ||
		!DISCORD_SNOWFLAKE.test(value.messageId)
	) {
		return undefined;
	}
	return { channelId: value.channelId, messageId: value.messageId };
}

export function normalizeFounderNarrowCommand(
	content: string,
): "现在放开" | "现在停止" | undefined {
	const normalized = content.trim().replace(EDGE_PUNCTUATION, "").trim();
	return normalized === "现在放开" || normalized === "现在停止"
		? normalized
		: undefined;
}

function snowflakeTimestampMs(messageId: string): number {
	return Number((BigInt(messageId) >> 22n) + DISCORD_EPOCH_MS);
}

function digestMessage(input: {
	id: string;
	channelId: string;
	authorId: string;
	timestampMs: number;
	content: string;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				input.id,
				input.channelId,
				input.authorId,
				input.timestampMs,
				input.content,
			]),
		)
		.digest("hex");
}

export function autoNarrowControlCanonicalSha(
	canonical: AutoNarrowControlCanonical,
): string {
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function authorize(
	deps: AutoNarrowControlRouteDeps,
	auth: AutoNarrowLeadAuth,
): boolean {
	if (
		auth.leadId !== "flywheel-eng-lead" ||
		auth.leadId !== deps.leadId ||
		auth.projectName !== "flywheel"
	) {
		return false;
	}
	if (deps.authorizeLeadRequest) return deps.authorizeLeadRequest(auth);
	try {
		authorizeLeadWrite(
			{
				claimedLeadId: auth.leadId,
				env: forwardedLeadAuthorizationEnv(
					{
						claimedLeadId: auth.leadId,
						projectName: auth.projectName,
						identityDigest: auth.identityDigest,
						...(auth.leaseClaim ? { leaseClaim: auth.leaseClaim } : {}),
						...(auth.carrierClaim ? { carrierClaim: auth.carrierClaim } : {}),
					},
					deps.leadLeaseEnv ?? process.env,
				),
			},
			deps.leadWriteAuthorizationDeps,
		);
		return true;
	} catch {
		return false;
	}
}

async function verifyFounderMessage(
	deps: AutoNarrowControlRouteDeps,
	input: {
		mode: AutoNarrowControlMode;
		messageRef: { channelId: string; messageId: string };
		reason: string;
	},
): Promise<
	| {
			ok: true;
			commandText: "现在放开" | "现在停止";
			messageCreatedAt: string;
			messageDigest: string;
	  }
	| { ok: false; result: AutoNarrowControlRouteResult }
> {
	if (input.messageRef.channelId !== deps.engineeringChannelId) {
		return { ok: false, result: fail(403, "channel_not_engineering") };
	}
	if (input.reason !== `founder ${input.messageRef.messageId}`) {
		return { ok: false, result: fail(400, "reason_message_mismatch") };
	}
	if (!deps.botToken) {
		return { ok: false, result: fail(503, "discord_token_unavailable") };
	}
	const fetchMessage =
		deps.fetchDiscordMessage ?? fetchDiscordMessageFromChannel;
	const fetched = await fetchMessage(
		input.messageRef.channelId,
		input.messageRef.messageId,
		deps.botToken,
	);
	if (!fetched.ok) {
		return {
			ok: false,
			result: fail(
				["network", "server", "rate_limited"].includes(fetched.kind)
					? 503
					: 404,
				"founder_message_unavailable",
			),
		};
	}
	const message = fetched.message;
	if (
		message.id !== input.messageRef.messageId ||
		message.channelId !== input.messageRef.channelId
	) {
		return { ok: false, result: fail(422, "message_binding_mismatch") };
	}
	if (message.authorId !== deps.founderUserId) {
		return { ok: false, result: fail(403, "author_not_founder") };
	}
	if (message.authorIsBot === true) {
		return { ok: false, result: fail(403, "author_is_bot") };
	}
	if (message.editedTimestampMs != null) {
		return { ok: false, result: fail(422, "message_edited") };
	}
	const commandText = normalizeFounderNarrowCommand(message.content);
	const expectedCommand = input.mode === "auto" ? "现在放开" : "现在停止";
	if (commandText !== expectedCommand) {
		return { ok: false, result: fail(422, "message_body_mismatch") };
	}
	if (snowflakeTimestampMs(message.id) !== message.timestampMs) {
		return { ok: false, result: fail(422, "message_timestamp_mismatch") };
	}
	const age = (deps.now?.() ?? Date.now()) - message.timestampMs;
	if (input.mode === "auto" && age < -FUTURE_SKEW_MS) {
		return { ok: false, result: fail(422, "control_message_future") };
	}
	if (input.mode === "auto" && age > OPEN_MAX_AGE_MS) {
		return { ok: false, result: fail(422, "control_message_expired") };
	}
	return {
		ok: true,
		commandText,
		messageCreatedAt: new Date(message.timestampMs).toISOString(),
		messageDigest: digestMessage(message),
	};
}

export async function handleAutoNarrowControlStage(
	deps: AutoNarrowControlRouteDeps,
	input: AutoNarrowControlInput,
	origin: string,
): Promise<AutoNarrowControlRouteResult> {
	const deny = (code: number, error: string) =>
		denyControl(deps, origin, "stage", input, code, error);
	if (
		!exactObject(input) ||
		Object.keys(input).some((key) => !CONTROL_INPUT_KEYS.has(key)) ||
		(input.carrierClaim !== undefined &&
			typeof input.carrierClaim !== "string") ||
		input.name !== AUTO_NARROW_FLAG_NAME ||
		input.project !== "flywheel" ||
		input.op !== "set"
	) {
		return deny(400, "invalid_protected_flag_request");
	}
	if (
		typeof input.to !== "string" ||
		!AUTO_NARROW_CONTROL_MODES.includes(input.to as AutoNarrowControlMode)
	) {
		return deny(400, "mode_not_controllable");
	}
	const auth = parseLeadAuth(input.leadAuth);
	if (!auth || !authorize(deps, auth)) return deny(403, "lead_not_authorized");
	const messageRef = parseMessageRef(input.founderMessageRef);
	if (!messageRef || typeof input.reason !== "string") {
		return deny(400, "founder_message_ref_required");
	}
	const mode = input.to as AutoNarrowControlMode;
	const verified = await verifyFounderMessage(deps, {
		mode,
		messageRef,
		reason: input.reason,
	});
	if (!verified.ok)
		return deny(
			verified.result.code,
			(verified.result.body as { error: string }).error,
		);
	const latest = deps.store.getLatestAutoNarrowControlEvent("flywheel");
	const replay = deps.store.getAutoNarrowControlEventByMessageId(
		messageRef.messageId,
	);
	if (replay && replay.mode !== mode) return deny(409, "message_conflict");
	if (
		!replay &&
		latest &&
		BigInt(messageRef.messageId) <= BigInt(latest.founderMessageId)
	) {
		return deny(409, "message_order_conflict");
	}
	const canonical: AutoNarrowControlCanonical = {
		kind: "auto_narrow_control",
		batchId: newBatchId(),
		eventId: deps.randomId?.() ?? randomUUID(),
		name: AUTO_NARROW_FLAG_NAME,
		projectName: "flywheel",
		mode,
		expectedChangeSeq: deps.store.getFlagValueChangeSeq(
			AUTO_NARROW_FLAG_NAME,
			"flywheel",
		),
		reason: input.reason,
		commandText: verified.commandText,
		messageRef,
		messageCreatedAt: verified.messageCreatedAt,
		messageDigest: verified.messageDigest,
		leadId: "flywheel-eng-lead",
		leadIdentityDigest: auth.identityDigest,
	};
	if (
		!deps.audit.record({
			batchId: canonical.batchId,
			event: "staged",
			canonicalRequest: JSON.stringify(canonical),
			origin,
		})
	) {
		return deny(500, "control_audit_unavailable");
	}
	return {
		code: 200,
		body: {
			canonical,
			confirmToken: deps.tokens.issue(autoNarrowControlCanonicalSha(canonical)),
		},
	};
}

function validCanonical(value: unknown): value is AutoNarrowControlCanonical {
	if (!exactObject(value)) return false;
	return (
		value.kind === "auto_narrow_control" &&
		value.name === AUTO_NARROW_FLAG_NAME &&
		value.projectName === "flywheel" &&
		typeof value.batchId === "string" &&
		typeof value.eventId === "string" &&
		AUTO_NARROW_CONTROL_MODES.includes(value.mode as AutoNarrowControlMode) &&
		Number.isSafeInteger(value.expectedChangeSeq) &&
		Number(value.expectedChangeSeq) >= 0 &&
		typeof value.reason === "string" &&
		(value.commandText === "现在放开" || value.commandText === "现在停止") &&
		parseMessageRef(value.messageRef) !== undefined &&
		typeof value.messageCreatedAt === "string" &&
		SHA256.test(String(value.messageDigest)) &&
		value.leadId === "flywheel-eng-lead" &&
		SHA256.test(String(value.leadIdentityDigest))
	);
}

export async function handleAutoNarrowControlApply(
	deps: AutoNarrowControlRouteDeps,
	canonicalValue: unknown,
	confirmToken: string,
	leadAuthValue: unknown,
	origin: string,
): Promise<AutoNarrowControlRouteResult> {
	const deny = (code: number, error: string) =>
		denyControl(deps, origin, "apply", canonicalValue, code, error);
	if (!validCanonical(canonicalValue))
		return deny(400, "invalid_control_canonical");
	const canonical = canonicalValue;
	const verdict = deps.tokens.verifyAndConsume(
		confirmToken,
		autoNarrowControlCanonicalSha(canonical),
	);
	if (!verdict.ok) return deny(401, verdict.reason);
	const auth = parseLeadAuth(leadAuthValue);
	if (
		!auth ||
		auth.leadId !== canonical.leadId ||
		auth.projectName !== canonical.projectName ||
		auth.identityDigest !== canonical.leadIdentityDigest ||
		!authorize(deps, auth)
	) {
		return deny(403, "lead_not_authorized");
	}
	const verified = await verifyFounderMessage(deps, {
		mode: canonical.mode,
		messageRef: canonical.messageRef,
		reason: canonical.reason,
	});
	if (!verified.ok)
		return deny(
			verified.result.code,
			(verified.result.body as { error: string }).error,
		);
	if (
		verified.commandText !== canonical.commandText ||
		verified.messageCreatedAt !== canonical.messageCreatedAt ||
		verified.messageDigest !== canonical.messageDigest
	) {
		return deny(409, "founder_message_changed");
	}
	if (
		!deps.audit.record({
			batchId: canonical.batchId,
			event: "apply-requested",
			canonicalRequest: JSON.stringify(canonical),
			origin,
		})
	) {
		return deny(500, "control_audit_unavailable");
	}
	const result = deps.store.applyAutoNarrowControlChange({
		eventId: canonical.eventId,
		projectName: canonical.projectName,
		mode: canonical.mode,
		expectedChangeSeq: canonical.expectedChangeSeq,
		founderMessageId: canonical.messageRef.messageId,
		founderChannelId: canonical.messageRef.channelId,
		founderAuthorId: deps.founderUserId,
		messageCreatedAt: canonical.messageCreatedAt,
		messageDigest: canonical.messageDigest,
		commandText: canonical.commandText,
		executedBy: canonical.leadId,
		reason: canonical.reason,
		authorizeCurrent: () => authorize(deps, auth),
		now: deps.now ?? Date.now,
	});
	if (!result.ok) {
		const code =
			result.reason === "lead_not_authorized"
				? 403
				: result.reason === "control_message_expired" ||
						result.reason === "control_message_future"
					? 422
					: 409;
		return deny(code, result.reason);
	}
	deps.audit.record({
		batchId: canonical.batchId,
		event: "apply-result",
		result: result.replayed ? "replayed" : "applied",
		origin,
	});
	const effective = deps.store.getLatestAutoNarrowControlEvent(
		canonical.projectName,
	);
	return {
		code: 200,
		body: {
			ok: true,
			mode: effective?.mode ?? result.event.mode,
			replayed: result.replayed,
			controlEventId: result.event.eventId,
		},
	};
}
