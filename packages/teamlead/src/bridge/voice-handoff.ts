import type {
	StateStore,
	VoiceAttributionRow,
	VoiceHandoffIntentKind,
	VoiceHandoffRow,
	VoiceTranscriptDurabilityReceipt,
	VoiceUtteranceRow,
} from "../StateStore.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import { leadEventEnvelopeFromJournalRow } from "./legacy-lead-event-reconciler.js";
import type { DurableQueueReceipt } from "./runtime-registry.js";

const INTENT_KINDS = new Set<VoiceHandoffIntentKind>([
	"create_issue",
	"approve_ship",
	"change_priority",
	"dispatch_runner",
]);
const SOURCES = new Set(["room_audio", "engine_audio", "engine_text"]);
const ROLES = new Set(["user", "assistant"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 32 * 1024;

export type VoiceMailboxSettlement =
	| { kind: "absent" }
	| { kind: "archived_terminal" }
	| { kind: "archived_nonterminal" }
	| { kind: "torn_identity" }
	| { kind: "live"; state?: string };

export interface VoiceHandoffReceipt {
	handoffId: string;
	state: VoiceHandoffRow["state"];
	idempotencyKey: string;
	requestDigest: string;
	reason?: string;
}

export class VoiceHandoffError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message = code,
	) {
		super(message);
		this.name = "VoiceHandoffError";
	}
}

export interface VoiceHandoffServiceOptions {
	store: StateStore;
	now?: () => string;
	founderUserIds: (sessionId: string) => readonly string[];
	validateAuthorityBinding: (input: {
		sessionId: string;
		leadId: string;
		intentKind: VoiceHandoffIntentKind;
		authorityBinding: Record<string, unknown>;
		utterance: VoiceUtteranceRow;
	}) => boolean;
	enqueueLeadEvent: (
		envelope: LeadEventEnvelope,
	) => DurableQueueReceipt | Promise<DurableQueueReceipt>;
	inspectDeliveryState: (
		deliveryId: string,
		handoff: VoiceHandoffRow,
	) => VoiceMailboxSettlement;
	deliveryCanReconcile?: boolean;
	reconcileLeaseMs?: number;
}

export interface RecordVoiceUtteranceInput {
	sessionId: string;
	leaseToken: string;
	transcriptId: string;
	utteranceId: string;
	sessionGeneration: number;
	sequence: number;
	source: "room_audio" | "engine_audio" | "engine_text";
	role: "user" | "assistant";
	text: string;
	final: boolean;
	attribution: VoiceAttributionRow;
	captureDigest: string;
}

export interface VoiceHandoffInput {
	sessionId: string;
	leaseToken: string;
	intentKind: VoiceHandoffIntentKind;
	payload: Record<string, unknown>;
	transcriptId: string;
	originalText: string;
	idempotencyKey: string;
	authorityBinding: Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
	code: string,
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, i) => key !== wanted[i])
	)
		throw new VoiceHandoffError(400, code);
}

function boundedId(value: unknown, code: string): asserts value is string {
	if (typeof value !== "string" || !ID_PATTERN.test(value))
		throw new VoiceHandoffError(400, code);
}

function boundedText(value: unknown, code: string): asserts value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES
	)
		throw new VoiceHandoffError(400, code);
}

function jsonObject(
	value: unknown,
	code: string,
): asserts value is Record<string, unknown> {
	if (!isObject(value)) throw new VoiceHandoffError(400, code);
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch {
		throw new VoiceHandoffError(400, code);
	}
	if (
		encoded === undefined ||
		Buffer.byteLength(encoded, "utf8") > MAX_JSON_BYTES ||
		JSON.parse(encoded) === null
	)
		throw new VoiceHandoffError(400, code);
}

function parseAttribution(value: unknown): VoiceAttributionRow {
	if (!isObject(value))
		throw new VoiceHandoffError(400, "voice_utterance_invalid");
	if (value.kind === "known") {
		exactKeys(value, ["kind", "speakerUserId"], "voice_utterance_invalid");
		boundedId(value.speakerUserId, "voice_utterance_invalid");
		return { kind: "known", speakerUserId: value.speakerUserId };
	}
	if (value.kind === "unknown") {
		exactKeys(value, ["kind", "reason"], "voice_utterance_invalid");
		boundedText(value.reason, "voice_utterance_invalid");
		return { kind: "unknown", reason: value.reason };
	}
	throw new VoiceHandoffError(400, "voice_utterance_invalid");
}

function parseUtterance(input: unknown): RecordVoiceUtteranceInput {
	if (!isObject(input))
		throw new VoiceHandoffError(400, "voice_utterance_invalid");
	exactKeys(
		input,
		[
			"sessionId",
			"leaseToken",
			"transcriptId",
			"utteranceId",
			"sessionGeneration",
			"sequence",
			"source",
			"role",
			"text",
			"final",
			"attribution",
			"captureDigest",
		],
		"voice_utterance_invalid",
	);
	boundedId(input.sessionId, "voice_utterance_invalid");
	boundedId(input.leaseToken, "voice_utterance_invalid");
	boundedId(input.transcriptId, "voice_utterance_invalid");
	boundedId(input.utteranceId, "voice_utterance_invalid");
	if (
		!Number.isSafeInteger(input.sessionGeneration) ||
		Number(input.sessionGeneration) < 1
	)
		throw new VoiceHandoffError(400, "voice_utterance_invalid");
	if (!Number.isSafeInteger(input.sequence) || Number(input.sequence) < 1)
		throw new VoiceHandoffError(400, "voice_utterance_invalid");
	if (typeof input.source !== "string" || !SOURCES.has(input.source))
		throw new VoiceHandoffError(400, "voice_utterance_invalid");
	if (typeof input.role !== "string" || !ROLES.has(input.role))
		throw new VoiceHandoffError(400, "voice_utterance_invalid");
	boundedText(input.text, "voice_utterance_invalid");
	if (typeof input.final !== "boolean")
		throw new VoiceHandoffError(400, "voice_utterance_invalid");
	if (
		typeof input.captureDigest !== "string" ||
		!SHA256_PATTERN.test(input.captureDigest)
	)
		throw new VoiceHandoffError(400, "voice_utterance_invalid");
	return {
		sessionId: input.sessionId,
		leaseToken: input.leaseToken,
		transcriptId: input.transcriptId,
		utteranceId: input.utteranceId,
		sessionGeneration: Number(input.sessionGeneration),
		sequence: Number(input.sequence),
		source: input.source as RecordVoiceUtteranceInput["source"],
		role: input.role as RecordVoiceUtteranceInput["role"],
		text: input.text,
		final: input.final,
		attribution: parseAttribution(input.attribution),
		captureDigest: input.captureDigest,
	};
}

function parseHandoff(input: unknown): VoiceHandoffInput {
	if (!isObject(input))
		throw new VoiceHandoffError(400, "voice_handoff_invalid");
	exactKeys(
		input,
		[
			"sessionId",
			"leaseToken",
			"intentKind",
			"payload",
			"transcriptId",
			"originalText",
			"idempotencyKey",
			"authorityBinding",
		],
		"voice_handoff_invalid",
	);
	boundedId(input.sessionId, "voice_handoff_invalid");
	boundedId(input.leaseToken, "voice_handoff_invalid");
	boundedId(input.transcriptId, "voice_handoff_invalid");
	boundedId(input.idempotencyKey, "voice_handoff_invalid");
	boundedText(input.originalText, "voice_handoff_invalid");
	if (
		typeof input.intentKind !== "string" ||
		!INTENT_KINDS.has(input.intentKind as VoiceHandoffIntentKind)
	)
		throw new VoiceHandoffError(400, "voice_handoff_invalid");
	jsonObject(input.payload, "voice_handoff_invalid");
	jsonObject(input.authorityBinding, "voice_handoff_invalid");
	return input as unknown as VoiceHandoffInput;
}

function receipt(row: VoiceHandoffRow): VoiceHandoffReceipt {
	return {
		handoffId: row.handoffId,
		state: row.state,
		idempotencyKey: row.idempotencyKey,
		requestDigest: row.requestDigest,
		...(row.terminalReason ? { reason: row.terminalReason } : {}),
	};
}

function mapStoreFailure(status: string): never {
	switch (status) {
		case "lease_conflict":
			throw new VoiceHandoffError(409, "voice_lease_conflict");
		case "utterance_missing":
			throw new VoiceHandoffError(409, "voice_utterance_missing");
		case "utterance_not_authorized":
			throw new VoiceHandoffError(403, "voice_utterance_not_authorized");
		case "conflict":
			throw new VoiceHandoffError(409, "voice_handoff_idempotency_conflict");
		default:
			throw new VoiceHandoffError(500, "voice_handoff_state_invalid");
	}
}

export class VoiceHandoffService {
	private readonly now: () => string;
	private readonly reconcileLeaseMs: number;
	private reconcileTimer?: ReturnType<typeof setInterval>;

	constructor(private readonly options: VoiceHandoffServiceOptions) {
		this.now = options.now ?? (() => new Date().toISOString());
		this.reconcileLeaseMs = options.reconcileLeaseMs ?? 30_000;
		// Composition creates this service during Bridge boot. A row left in
		// dispatching therefore means the process died across external I/O; it is
		// never safe to infer "not sent" and replay it.
		this.options.store.recoverVoiceHandoffDispatching(this.now());
	}

	startReconciler(owner: string, intervalMs = 1_000): void {
		boundedId(owner, "voice_handoff_reconciler_invalid");
		if (!Number.isSafeInteger(intervalMs) || intervalMs < 100)
			throw new VoiceHandoffError(400, "voice_handoff_reconciler_invalid");
		if (this.reconcileTimer) return;
		const tick = () => {
			try {
				for (let count = 0; count < 32; count += 1) {
					if (!this.reconcileNext(owner)) break;
				}
			} catch {
				// The claimed row has a durable lease and will be retried after expiry.
				// One malformed/external settlement must not stop later timer ticks.
			}
		};
		tick();
		this.reconcileTimer = setInterval(tick, intervalMs);
		this.reconcileTimer.unref?.();
	}

	stopReconciler(): void {
		if (this.reconcileTimer) clearInterval(this.reconcileTimer);
		this.reconcileTimer = undefined;
	}

	recordUtterance(input: RecordVoiceUtteranceInput): {
		status: "inserted" | "replayed";
		receipt: VoiceTranscriptDurabilityReceipt;
	} {
		const parsed = parseUtterance(input);
		const result = this.options.store.recordVoiceUtterance({
			...parsed,
			now: this.now(),
		});
		if ("receipt" in result) return result;
		throw new VoiceHandoffError(
			409,
			result.status === "lease_conflict"
				? "voice_lease_conflict"
				: "voice_transcript_conflict",
		);
	}

	async handoff(input: VoiceHandoffInput): Promise<VoiceHandoffReceipt> {
		const parsed = parseHandoff(input);
		const at = this.now();
		const founderUserIds = this.options.founderUserIds(parsed.sessionId);
		const session = this.options.store.getActiveVoiceLease(
			parsed.sessionId,
			parsed.leaseToken,
			at,
		);
		const utterance = this.options.store.getVoiceUtterance(
			parsed.sessionId,
			parsed.transcriptId,
		);
		const utteranceCanAuthorize =
			utterance?.final === true &&
			utterance.role === "user" &&
			utterance.text === parsed.originalText &&
			utterance.attribution.kind === "known" &&
			founderUserIds.includes(utterance.attribution.speakerUserId);
		if (
			session &&
			utterance &&
			utteranceCanAuthorize &&
			!this.options.validateAuthorityBinding({
				sessionId: parsed.sessionId,
				leadId: session.leadId,
				intentKind: parsed.intentKind,
				authorityBinding: parsed.authorityBinding,
				utterance,
			})
		)
			throw new VoiceHandoffError(403, "voice_authority_binding_invalid");
		const authorized = this.options.store.authorizeVoiceHandoff({
			...parsed,
			founderUserIds,
			deliveryCanReconcile: this.options.deliveryCanReconcile !== false,
			now: at,
		});
		if (!("handoff" in authorized)) mapStoreFailure(authorized.status);
		if (
			authorized.status === "replayed" ||
			authorized.handoff.state !== "dispatching"
		)
			return receipt(authorized.handoff);

		const row = this.options.store.getLeadEventBySeq(
			authorized.handoff.leadEventSeq ?? -1,
		);
		if (!row) {
			const ambiguous = this.options.store.markVoiceHandoffDispatchResult({
				handoffId: authorized.handoff.handoffId,
				attemptToken: authorized.handoff.attemptToken!,
				now: at,
				queued: false,
				reason: "lead_event_missing",
			});
			return receipt(ambiguous ?? authorized.handoff);
		}

		let queued = false;
		let reason = "dispatch_outcome_unknown";
		try {
			const queueReceipt = await this.options.enqueueLeadEvent(
				leadEventEnvelopeFromJournalRow(row, 1),
			);
			queued =
				queueReceipt.queued === true &&
				queueReceipt.seq === authorized.handoff.leadEventSeq &&
				queueReceipt.deliveryId === authorized.handoff.deliveryId;
			if (!queued) reason = "delivery_receipt_mismatch";
		} catch (error) {
			reason = error instanceof Error ? error.message : reason;
		}
		const marked = this.options.store.markVoiceHandoffDispatchResult({
			handoffId: authorized.handoff.handoffId,
			attemptToken: authorized.handoff.attemptToken!,
			now: this.now(),
			queued,
			...(queued ? {} : { reason }),
		});
		return receipt(
			marked ??
				this.options.store.getVoiceHandoff(authorized.handoff.handoffId)!,
		);
	}

	reconcileNext(owner: string): VoiceHandoffRow | undefined {
		boundedId(owner, "voice_handoff_reconciler_invalid");
		const claimed = this.options.store.claimVoiceHandoffReconciliation({
			owner,
			now: this.now(),
			leaseMs: this.reconcileLeaseMs,
		});
		if (!claimed) return;
		let settlement: VoiceMailboxSettlement;
		try {
			settlement = this.options.inspectDeliveryState(
				claimed.deliveryId!,
				claimed,
			);
		} catch {
			settlement = { kind: "torn_identity" };
		}
		if (
			!new Set([
				"absent",
				"archived_terminal",
				"archived_nonterminal",
				"torn_identity",
				"live",
			]).has(settlement.kind)
		)
			settlement = { kind: "torn_identity" };
		return this.options.store.releaseVoiceHandoffReconciliation({
			handoffId: claimed.handoffId,
			claimToken: claimed.claimToken!,
			stateVersion: claimed.stateVersion,
			now: this.now(),
			settlement,
		});
	}

	recordExecution(input: {
		handoffId: string;
		providerOperationId: string;
		finalState: "committed" | "rejected";
		evidence: Record<string, unknown>;
		at: string;
	}): VoiceHandoffRow {
		if (!isObject(input))
			throw new VoiceHandoffError(400, "voice_handoff_execution_invalid");
		exactKeys(
			input,
			["handoffId", "providerOperationId", "finalState", "evidence", "at"],
			"voice_handoff_execution_invalid",
		);
		boundedId(input.handoffId, "voice_handoff_execution_invalid");
		boundedText(input.providerOperationId, "voice_handoff_execution_invalid");
		jsonObject(input.evidence, "voice_handoff_execution_invalid");
		if (
			!new Set(["committed", "rejected"]).has(input.finalState) ||
			!Number.isFinite(Date.parse(input.at))
		)
			throw new VoiceHandoffError(400, "voice_handoff_execution_invalid");
		const row = this.options.store.recordVoiceHandoffExecution(input);
		if (!row)
			throw new VoiceHandoffError(409, "voice_handoff_execution_conflict");
		return row;
	}
}
