/**
 * FLY-2897 — the pure half of reading a Claude account's next charge date
 * from the Anthropic (Stripe) receipt emails in its own mailbox.
 *
 * The receipt's "period end" is the next charge day while the subscription
 * stays active; a later "subscription was canceled" notice that no later
 * resubscription notice undoes turns it into the day access ends. Nothing
 * here keeps a body, subject or address: callers get dates, cents and enums.
 */

import type { ClaudeChargeFacts } from "./charge-receipt-store.js";

export type AnthropicMailKind = "receipt" | "cancel" | "resume";

export interface ParsedReceipt {
	/** YYYY-MM-DD, a Pacific calendar day as printed on the receipt. */
	periodStart: string;
	periodEnd: string;
	paidOn: string | null;
	amountCents: number | null;
}

export interface ChargeReceiptInput {
	/** Email time (ISO, minute precision). */
	at: string;
	/** null: a subscription receipt whose period could not be read. */
	parsed: ParsedReceipt | null;
}

export interface ChargeEventInput {
	at: string;
	kind: "cancel" | "resume";
}

export type ChargeDecision =
	| { status: "no_receipt" }
	| { status: "parse_failed" }
	| { status: "ok" | "canceled"; facts: ClaudeChargeFacts };

const RECEIPT_SENDER = "invoice+statements@mail.anthropic.com";
const NOTICE_SENDER = /^no-reply[a-z0-9._+-]{0,64}@mail\.anthropic\.com$/;
const RECEIPT_SUBJECT = /^Your receipt from Anthropic, PBC #[0-9-]{4,40}$/;
const CANCEL_SUBJECT =
	/^Your Claude [A-Za-z0-9 ]{1,40} subscription was canceled$/;
const RESUME_SUBJECTS = [
	/^Your [A-Za-z0-9 ]{1,40} subscription is confirmed$/,
	/^Welcome to the [A-Za-z0-9 ]{1,40} plan$/,
	/^Welcome back to Claude [A-Za-z0-9 ]{1,40}$/,
];

// The whole header must be one address, bare or behind one display name; a
// second bracket or trailing text is a spoof shape and yields no address.
const BARE_ADDRESS = /^\s*([^\s<>"]+@[^\s<>"]+)\s*$/;
const NAMED_ADDRESS = /^\s*(?:"[^"]*"|[^"<>]*)\s*<([^<>\s]+)>\s*$/;

function fromAddress(from: unknown): string | null {
	if (typeof from !== "string" || from.length > 512) return null;
	const match = BARE_ADDRESS.exec(from) ?? NAMED_ADDRESS.exec(from);
	return match ? match[1]!.toLowerCase() : null;
}

/** Exact sender address plus anchored subject; anything else is dropped. */
export function classifyAnthropicMail(mail: {
	from: unknown;
	subject: unknown;
}): AnthropicMailKind | null {
	const address = fromAddress(mail.from);
	const subject = mail.subject;
	if (address === null || typeof subject !== "string") return null;
	if (address === RECEIPT_SENDER) {
		return RECEIPT_SUBJECT.test(subject) ? "receipt" : null;
	}
	if (!NOTICE_SENDER.test(address)) return null;
	if (CANCEL_SUBJECT.test(subject)) return "cancel";
	return RESUME_SUBJECTS.some((pattern) => pattern.test(subject))
		? "resume"
		: null;
}

const MAX_BODY_CHARS = 200_000;
const MONTHS = [
	"jan",
	"feb",
	"mar",
	"apr",
	"may",
	"jun",
	"jul",
	"aug",
	"sep",
	"oct",
	"nov",
	"dec",
] as const;
const MONTH = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?";
const PERIOD = new RegExp(
	`\\b${MONTH} (\\d{1,2})(?:, (\\d{4}))? ?[–—-] ?${MONTH} (\\d{1,2}), (\\d{4})\\b`,
);
const PAID =
	/\bPaid (January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})\b/;
const AMOUNT_PAID =
	/\bAmount paid (-?)\$([0-9]{1,3}(?:,[0-9]{3}){0,3}|[0-9]{1,9})\.([0-9]{2})\b/;
const PLAN_LINE = /\b(?:Pro|Max|Team|Enterprise)(?: plan\b| \d{1,2}x\b)/i;
const LOOKS_HTML =
	/<\/?(?:html|head|body|div|table|tbody|tr|td|th|p|br|span|a|img|center)\b/i;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};
const DAY_MS = 86_400_000;
const MAX_PERIOD_DAYS = 400;

function decodeEntity(entity: string): string {
	if (entity.startsWith("#x") || entity.startsWith("#X")) {
		const code = Number.parseInt(entity.slice(2), 16);
		return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
			? String.fromCodePoint(code)
			: " ";
	}
	if (entity.startsWith("#")) {
		const code = Number.parseInt(entity.slice(1), 10);
		return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
			? String.fromCodePoint(code)
			: " ";
	}
	return NAMED_ENTITIES[entity.toLowerCase()] ?? " ";
}

/** One line of plain text: tags become spaces, entities decode, spaces collapse. */
function normalizeBody(body: string): string {
	let text = body.slice(0, MAX_BODY_CHARS);
	if (LOOKS_HTML.test(text)) {
		text = text
			.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
			.replace(/<[^>]*>/g, " ");
	}
	return text
		.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z]{2,8});/g, (_, e) =>
			decodeEntity(e),
		)
		.replace(/\s+/g, " ");
}

function monthIndex(name: string): number {
	return MONTHS.indexOf(name.slice(0, 3).toLowerCase() as never) + 1;
}

/** A real calendar day as UTC midnight milliseconds, else null. */
function dayMs(year: number, month: number, day: number): number | null {
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	const ms = Date.UTC(year, month - 1, day);
	const date = new Date(ms);
	return date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
		? ms
		: null;
}

function dayKey(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function parsePeriod(
	text: string,
): { periodStart: string; periodEnd: string } | null {
	const match = PERIOD.exec(text);
	if (!match) return null;
	const [, startMonthName, startDay, startYear, endMonthName, endDay, endYear] =
		match;
	const endMonth = monthIndex(endMonthName!);
	const startMonth = monthIndex(startMonthName!);
	const end = dayMs(Number(endYear), endMonth, Number(endDay));
	let year = Number(startYear ?? endYear);
	if (
		startYear === undefined &&
		(startMonth > endMonth ||
			(startMonth === endMonth && Number(startDay) > Number(endDay)))
	) {
		year -= 1;
	}
	const start = dayMs(year, startMonth, Number(startDay));
	if (start === null || end === null || start >= end) return null;
	if ((end - start) / DAY_MS > MAX_PERIOD_DAYS) return null;
	return { periodStart: dayKey(start), periodEnd: dayKey(end) };
}

function parsePaid(text: string): string | null {
	const match = PAID.exec(text);
	if (!match) return null;
	const ms = dayMs(Number(match[3]), monthIndex(match[1]!), Number(match[2]));
	return ms === null ? null : dayKey(ms);
}

function parseAmountPaid(text: string): number | null {
	const match = AMOUNT_PAID.exec(text);
	if (!match) return null;
	const cents = Number(match[2]!.replaceAll(",", "")) * 100 + Number(match[3]);
	if (!Number.isSafeInteger(cents)) return null;
	return match[1] === "-" ? -cents : cents;
}

/** The charge facts of one receipt; null when its period is not readable. */
export function parseReceiptBody(body: unknown): ParsedReceipt | null {
	if (typeof body !== "string") return null;
	const text = normalizeBody(body);
	const period = parsePeriod(text);
	if (period === null) return null;
	return {
		...period,
		paidOn: parsePaid(text),
		amountCents: parseAmountPaid(text),
	};
}

/** A subscription receipt names its plan; extra-usage / API credit ones do not. */
export function hasPlanLine(body: unknown): boolean {
	return typeof body === "string" && PLAN_LINE.test(normalizeBody(body));
}

const GOG_DATE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

/** gog's `--timezone UTC` minute string ("2026-09-17 00:05") as ISO. */
export function parseGogDate(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const match = GOG_DATE.exec(value);
	if (!match) return null;
	const [, year, month, day, hour, minute] = match.map(Number) as number[];
	if (hour! > 23 || minute! > 59) return null;
	const midnight = dayMs(year!, month!, day!);
	if (midnight === null) return null;
	return new Date(midnight + (hour! * 60 + minute!) * 60_000).toISOString();
}

function latestAt(
	events: readonly ChargeEventInput[],
	kind: ChargeEventInput["kind"],
	after: number,
): string | null {
	let latest: number | null = null;
	for (const event of events) {
		const at = Date.parse(event.at);
		if (event.kind !== kind || !(at > after)) continue;
		if (latest === null || at > latest) latest = at;
	}
	return latest === null ? null : new Date(latest).toISOString();
}

/**
 * The newest subscription receipt decides the period; receipts ending on the
 * same day are one period (an upgrade day sends two). A cancellation after it
 * counts unless a resubscription notice arrives after that cancellation.
 */
export function decideCharge(input: {
	receipts: readonly ChargeReceiptInput[];
	events: readonly ChargeEventInput[];
}): ChargeDecision {
	if (input.receipts.length === 0) return { status: "no_receipt" };
	const ordered = [...input.receipts].sort(
		(a, b) =>
			Date.parse(b.at) - Date.parse(a.at) ||
			(b.parsed?.periodEnd ?? "").localeCompare(a.parsed?.periodEnd ?? ""),
	);
	const latest = ordered[0]!;
	if (latest.parsed === null) return { status: "parse_failed" };
	const { periodEnd } = latest.parsed;
	const samePeriod = ordered.filter(
		(receipt) => receipt.parsed?.periodEnd === periodEnd,
	);
	const amountCents = samePeriod.every(
		(receipt) => receipt.parsed!.amountCents !== null,
	)
		? samePeriod.reduce((sum, receipt) => sum + receipt.parsed!.amountCents!, 0)
		: null;
	const receiptMs = Date.parse(latest.at);
	const canceledAt = latestAt(input.events, "cancel", receiptMs);
	const resumedAt = latestAt(input.events, "resume", receiptMs);
	const stillCanceled =
		canceledAt !== null &&
		(resumedAt === null || Date.parse(resumedAt) <= Date.parse(canceledAt));
	return {
		status: stillCanceled ? "canceled" : "ok",
		facts: {
			periodStart: latest.parsed.periodStart,
			periodEnd,
			paidOn: latest.parsed.paidOn,
			amountCents,
			receiptCount: samePeriod.length,
			receiptAt: new Date(receiptMs).toISOString(),
			canceledAt: stillCanceled ? canceledAt : null,
			resumedAt,
		},
	};
}
