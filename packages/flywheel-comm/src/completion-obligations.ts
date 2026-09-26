/**
 * FLY-2373: semantic completion drain.
 *
 * A phase-wake doorbell is a transport signal ("something is waiting for
 * you"), not the message itself. Completion therefore settles on *content
 * consumption*: every body that this execution is obliged to read must carry
 * a server-derived consumption receipt (or an equivalent turn-input delivery)
 * before `complete` commits. Wake run-state (`started`/`finished`) and
 * admission (`deferred_midturn`) are transport audit only.
 *
 * This module owns the vocabulary, the canonical digests and the carrier-safe
 * pagination. CommDB (db.ts) owns the reads and the transactional writes.
 */

import { createHash, randomBytes } from "node:crypto";
import { canonicalJsonString } from "flywheel-config";

export const COMPLETION_DRAIN_PROTOCOL_VERSION = 2 as const;

/**
 * Carrier-visible page budget. Codex exec shows at most ~10 KiB / 256 lines of
 * one tool output to the model and truncates the middle beyond that; a page
 * must stay well below both so a long Lead instruction is never silently cut.
 */
export const DRAIN_PAGE_MAX_BYTES = 6 * 1024;
export const DRAIN_PAGE_MAX_LINES = 120;

export type ConsumptionSubjectKind = "mailbox" | "inline_wake";
export type ConsumptionSourceKind = "inbox" | "check" | "drain_ack";
export type WakeSettlementReason =
	| "content_consumed"
	| "signal_satisfied"
	| "authorized_disposal";

export interface ObligationSubject {
	subjectKind: ConsumptionSubjectKind;
	/** mailbox: canonical `delivery_id`; inline_wake: stable wake identity. */
	subjectId: string;
	contentSha256: string;
}

export interface CompletionObligation extends ObligationSubject {
	type: "instruction" | "response" | "wake";
	sender: string;
	/** Exact body bytes the model must read. Never trimmed or translated. */
	body: string;
	createdAt: string | null;
	/** Mailbox message id; DONE reports quote `[lead-instruction <id>]`. */
	leadInstructionId?: string;
	questionId?: string;
	/** Pending wakes whose settlement depends on this subject. */
	wakeMessageIds: string[];
	/**
	 * The body was transport-acknowledged before this protocol could record a
	 * consumption receipt; it may already have been handled.
	 */
	historical: boolean;
	/**
	 * `in_flight`: the daemon has claimed this wake for a turn and has not yet
	 * recorded its delivery; it can be neither acknowledged nor settled.
	 */
	sourceStatus: "ok" | "source_missing" | "content_unavailable" | "in_flight";
}

export interface CompletionWakeResolution {
	messageId: string;
	queueSeq: number;
	obligationDigest: string;
	subjects: ObligationSubject[];
	satisfied: boolean;
	evidence: {
		receiptIds: string[];
		/** Byte-identical copies of the same wake delivered as a turn input. */
		turnInputWakeIds: string[];
	};
}

export interface CompletionObligationResolution {
	protocolVersion: typeof COMPLETION_DRAIN_PROTOCOL_VERSION;
	executionId: string;
	activationId: string;
	/** Every subject still owed, deduplicated by identity + digest, sorted. */
	unread: CompletionObligation[];
	/** Pending wakes and whether each one is settled by the evidence. */
	wakes: CompletionWakeResolution[];
	/** v1 compatibility projection: unread mailbox message ids. */
	mailboxIds: string[];
	/** v1 compatibility projection: pending wakes that are not yet settled. */
	phaseWakeIds: string[];
	readSetDigest: string;
}

export interface DrainPage {
	index: number;
	count: number;
	text: string;
	sha256: string;
}

export function sha256Utf8(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function sortSubjects(subjects: readonly ObligationSubject[]) {
	return [...subjects]
		.map((subject) => ({
			kind: subject.subjectKind,
			id: subject.subjectId,
			sha256: subject.contentSha256,
		}))
		.sort((left, right) =>
			`${left.kind}\u0000${left.id}\u0000${left.sha256}` <
			`${right.kind}\u0000${right.id}\u0000${right.sha256}`
				? -1
				: 1,
		);
}

export function subjectKey(subject: ObligationSubject): string {
	return `${subject.subjectKind}\u0000${subject.subjectId}\u0000${subject.contentSha256}`;
}

/** Domain-separated digest of one wake's full, ordered obligation set. */
export function wakeObligationDigest(input: {
	executionId: string;
	activationId: string;
	wakeMessageId: string;
	subjects: readonly ObligationSubject[];
}): string {
	return sha256Utf8(
		canonicalJsonString({
			domain: "fly2373.wake-obligation",
			version: COMPLETION_DRAIN_PROTOCOL_VERSION,
			executionId: input.executionId,
			activationId: input.activationId,
			wakeMessageId: input.wakeMessageId,
			subjects: sortSubjects(input.subjects),
		}),
	);
}

/** Digest of the exact unread set a read envelope was issued for. */
export function drainReadSetDigest(input: {
	executionId: string;
	activationId: string;
	subjects: readonly ObligationSubject[];
}): string {
	return sha256Utf8(
		canonicalJsonString({
			domain: "fly2373.read-set",
			version: COMPLETION_DRAIN_PROTOCOL_VERSION,
			executionId: input.executionId,
			activationId: input.activationId,
			subjects: sortSubjects(input.subjects),
		}),
	);
}

export function newDrainReadId(): string {
	return `read_${randomBytes(16).toString("hex")}`;
}

export const DRAIN_READ_ID_PATTERN = /^read_[0-9a-f]{32}$/;

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function lineCount(text: string): number {
	let lines = 0;
	for (const char of text) if (char === "\n") lines += 1;
	return lines;
}

/**
 * Largest code-point-safe prefix within both budgets (always ≥ 1 code point).
 * When the body continues, the cut moves back to the last line break so a
 * line that fits on one page is never split across two.
 */
function takePrefix(
	text: string,
	maxBytes: number,
	maxLines: number,
): [string, string] {
	let bytes = 0;
	let lines = 0;
	let end = 0;
	for (const char of text) {
		const size = byteLength(char);
		const nextLines = lines + (char === "\n" ? 1 : 0);
		if (end > 0 && (bytes + size > maxBytes || nextLines > maxLines)) break;
		bytes += size;
		lines = nextLines;
		end += char.length;
	}
	if (end < text.length) {
		const lastBreak = text.lastIndexOf("\n", end - 1);
		if (lastBreak >= 0) end = lastBreak + 1;
	}
	return [text.slice(0, end), text.slice(end)];
}

function entryLabel(obligation: CompletionObligation): string {
	const sha = obligation.contentSha256.slice(0, 12);
	if (obligation.type === "instruction") {
		return `Lead instruction [lead-instruction ${obligation.leadInstructionId ?? obligation.subjectId}] from ${obligation.sender}${obligation.createdAt ? ` at ${obligation.createdAt}` : ""} (sha256 ${sha})`;
	}
	if (obligation.type === "response") {
		return `Answer to question ${obligation.questionId ?? "(unknown)"} from ${obligation.sender}${obligation.createdAt ? ` at ${obligation.createdAt}` : ""} (sha256 ${sha})`;
	}
	return `Wake ${obligation.subjectId} from ${obligation.sender} (sha256 ${sha})`;
}

function entryNote(obligation: CompletionObligation): string | undefined {
	const notes: string[] = [];
	if (obligation.historical) {
		notes.push(
			"NOTE: this item was transport-acknowledged earlier and may already have been processed; check your own history before acting on it again.",
		);
	}
	if (obligation.sourceStatus === "source_missing") {
		notes.push(
			"NOTE: the source record behind this wake is missing; the text below is only a pointer and cannot be acknowledged. Report it to your Lead.",
		);
	}
	if (obligation.sourceStatus === "in_flight") {
		notes.push(
			"NOTE: this wake is being delivered to you as a turn input right now and cannot be acknowledged; rerun the same complete once its delivery is recorded (usually seconds). Report it to your Lead if it persists.",
		);
	}
	if (obligation.sourceStatus === "content_unavailable") {
		notes.push(
			"NOTE: the stored body is unreadable; this item cannot be acknowledged. Report it to your Lead.",
		);
	}
	return notes.length > 0 ? notes.join("\n") : undefined;
}

/**
 * Render every unread body into carrier-safe pages. Bodies are never
 * truncated: an oversized body continues on the next page with an explicit
 * continuation marker, and each page is bounded by bytes *and* lines.
 */
export function paginateUnreadObligations(
	unread: readonly CompletionObligation[],
	limits: { maxBytes: number; maxLines: number } = {
		maxBytes: DRAIN_PAGE_MAX_BYTES,
		maxLines: DRAIN_PAGE_MAX_LINES,
	},
): DrainPage[] {
	const minBodyBytes = 256;
	const minBodyLines = 4;
	const texts: string[] = [];
	let current = "";
	const flush = () => {
		if (current.length > 0) texts.push(current);
		current = "";
	};
	unread.forEach((obligation, index) => {
		const label = `[${index + 1}/${unread.length}] ${entryLabel(obligation)}`;
		const note = entryNote(obligation);
		let rest = obligation.body;
		let part = 1;
		for (;;) {
			const head = `=== BEGIN ${label}${part > 1 ? ` (continued, part ${part})` : ""}\n${part === 1 && note ? `${note}\n` : ""}`;
			const tailDone = `\n=== END [${index + 1}/${unread.length}]\n`;
			const tailMore = `\n=== CONTINUES ON NEXT PAGE [${index + 1}/${unread.length}]\n`;
			const tail = tailMore.length > tailDone.length ? tailMore : tailDone;
			const byteBudget =
				limits.maxBytes -
				byteLength(current) -
				byteLength(head) -
				byteLength(tail);
			const lineBudget =
				limits.maxLines -
				lineCount(current) -
				lineCount(head) -
				lineCount(tail);
			if (
				current.length > 0 &&
				(byteBudget < Math.min(minBodyBytes, byteLength(rest) + 1) ||
					lineBudget < Math.min(minBodyLines, lineCount(rest) + 1))
			) {
				flush();
				continue;
			}
			if (byteBudget < 1 || lineBudget < 0) {
				throw new Error("drain page limits cannot fit one entry header");
			}
			const [taken, remaining] =
				rest.length === 0 ? ["", ""] : takePrefix(rest, byteBudget, lineBudget);
			current += `${head}${taken}${remaining.length > 0 ? tailMore : tailDone}`;
			rest = remaining;
			if (rest.length === 0) break;
			part += 1;
			flush();
		}
	});
	flush();
	const count = texts.length;
	return texts.map((text, index) => ({
		index: index + 1,
		count,
		text,
		sha256: sha256Utf8(text),
	}));
}
