/**
 * FLY-2897 — read each Claude account's next charge from its own mailbox.
 *
 * Per mailbox: one metadata-only gog search for Anthropic receipt and
 * subscription notices, an exact sender + subject filter, and then bodies for
 * only the receipts that decide the current period (at most six). Bodies and
 * gog's stderr live in local variables only: the result is dates, cents and
 * enum codes. Founder approval (2026-09-25): sender, subject, date, amount and
 * billing period of Anthropic receipt mail only.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { AccountStore } from "../account-heal/account-store.js";
import {
	type ChargeEventInput,
	type ChargeReceiptInput,
	classifyAnthropicMail,
	decideCharge,
	hasPlanLine,
	parseGogDate,
	parseReceiptBody,
} from "./charge-receipt-parse.js";
import {
	type ClaudeChargeFacts,
	type ClaudeChargeReading,
	type ClaudeChargeReason,
	type ClaudeChargeStatus,
	type ClaudeChargeStore,
	claudeChargeMailboxKey,
	MAX_RECEIPTS_PER_PERIOD,
	normalizeClaudeChargeMailbox,
} from "./charge-receipt-store.js";

export const CLAUDE_CHARGE_SEARCH_QUERY =
	'from:mail.anthropic.com {subject:"Your receipt from Anthropic" subject:"subscription was canceled" subject:"subscription is confirmed" subject:"Welcome to the" subject:"Welcome back to Claude"} newer_than:400d';
const SEARCH_PAGE_SIZE = 40;
/** Pages followed by nextPageToken before the search counts as truncated. */
const MAX_SEARCH_PAGES = 3;
const PAGE_TOKEN = /^[A-Za-z0-9_.~][A-Za-z0-9_.~-]{0,511}$/;
const CONCURRENCY = 4;
const DAY_MS = 86_400_000;
const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MESSAGE_ID = /^[A-Za-z0-9]{6,64}$/;
const GOG_CANDIDATES = ["/opt/homebrew/bin/gog", "/usr/local/bin/gog"];

export interface ClaudeChargeTarget {
	name: string;
	email: string | null;
}

export interface GogResult {
	code: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
	/** Set when the process could not run to completion on its own. */
	error?: "enoent" | "timeout" | "output_too_large" | "spawn";
}

export type GogRunner = (
	args: readonly string[],
	signal: AbortSignal | undefined,
) => Promise<GogResult>;

export interface ClaudeChargeSummary {
	accounts: number;
	ok: number;
	canceled: number;
	/** `name:status` or `name:status/reason` — names and enum codes only. */
	failed: string[];
}

export function resolveGogBin(
	exists: (path: string) => boolean = existsSync,
): string {
	return GOG_CANDIDATES.find((path) => exists(path)) ?? "gog";
}

/** execFile (no shell) with a timeout, an output cap and the round's signal. */
export function createGogRunner(
	options: { bin?: string; timeoutMs?: number; maxBytes?: number } = {},
): GogRunner {
	const bin = options.bin ?? resolveGogBin();
	const timeout = options.timeoutMs ?? 30_000;
	const maxBuffer = options.maxBytes ?? 1024 * 1024;
	return (args, signal) =>
		new Promise((resolve) => {
			execFile(
				bin,
				[...args],
				{
					encoding: "utf8",
					timeout,
					maxBuffer,
					killSignal: "SIGTERM",
					windowsHide: true,
					...(signal ? { signal } : {}),
				},
				(error, stdout, stderr) => {
					const out = typeof stdout === "string" ? stdout : "";
					const err = typeof stderr === "string" ? stderr : "";
					if (!error) {
						resolve({ code: 0, signal: null, stdout: out, stderr: err });
						return;
					}
					const failure = error as NodeJS.ErrnoException & {
						code?: string | number;
						killed?: boolean;
						signal?: NodeJS.Signals | null;
					};
					const base = {
						code: typeof failure.code === "number" ? failure.code : null,
						signal: failure.signal ?? null,
						stdout: out,
						stderr: err,
					};
					if (failure.code === "ENOENT") {
						resolve({ ...base, error: "enoent" });
					} else if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
						resolve({ ...base, error: "output_too_large" });
					} else if (
						failure.name === "AbortError" ||
						failure.code === "ABORT_ERR" ||
						failure.killed === true
					) {
						resolve({ ...base, error: "timeout" });
					} else if (typeof failure.code === "number" || failure.signal) {
						resolve(base);
					} else {
						resolve({ ...base, error: "spawn" });
					}
				},
			);
		});
}

/**
 * Accounts with their mailbox; null when the account list cannot be read.
 * Free or paid is not decided here: the page takes it from the current
 * account detail, so a parallel detail refresh can never be overtaken.
 */
export function claudeChargeTargets(
	accountStore: AccountStore | null,
): ClaudeChargeTarget[] | null {
	if (accountStore === null) return null;
	return accountStore.accounts
		.filter((account) => ACCOUNT_NAME.test(account.name))
		.map((account) => ({
			name: account.name,
			email: account.identity?.email ?? null,
		}));
}

type Outcome =
	| { status: "ok" | "canceled"; reason: null; facts: ClaudeChargeFacts }
	| {
			status: Exclude<ClaudeChargeStatus, "ok" | "canceled">;
			reason: ClaudeChargeReason | null;
			facts: null;
	  };

class GogFailure extends Error {
	constructor(
		readonly status: "auth_missing" | "auth_invalid" | "read_failed",
		readonly reason: ClaudeChargeReason | null,
	) {
		super(status);
	}
}

const EXIT_REASONS: Readonly<Record<number, ClaudeChargeReason>> = {
	5: "not_found",
	6: "permission_denied",
	7: "rate_limited",
	8: "retryable",
	10: "gog_config",
	130: "timeout",
};

function gogFailure(result: GogResult): GogFailure | null {
	if (result.error === "enoent") {
		return new GogFailure("read_failed", "gog_missing");
	}
	if (result.error === "output_too_large") {
		return new GogFailure("read_failed", "output_too_large");
	}
	if (result.error === "timeout")
		return new GogFailure("read_failed", "timeout");
	if (result.error === "spawn") return new GogFailure("read_failed", "error");
	if (result.code === 0) return null;
	if (/^No auth for /m.test(result.stderr)) {
		return new GogFailure("auth_missing", null);
	}
	if (result.stderr.includes("invalid_grant")) {
		return new GogFailure("auth_invalid", "invalid_grant");
	}
	if (result.code === 4) return new GogFailure("auth_invalid", "unauthorized");
	if (result.code === null) return new GogFailure("read_failed", "timeout");
	return new GogFailure("read_failed", EXIT_REASONS[result.code] ?? "error");
}

async function runGogJson(
	runGog: GogRunner,
	args: readonly string[],
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const result = await runGog(args, signal);
	const failure = gogFailure(result);
	if (failure) throw failure;
	try {
		return JSON.parse(result.stdout);
	} catch {
		// The SyntaxError text quotes the input; never let it travel.
		throw new GogFailure("read_failed", "malformed");
	}
}

interface Row {
	id: string;
	at: string;
	kind: "receipt" | "cancel" | "resume";
}

/**
 * Every matching Anthropic mail, following gog's nextPageToken for at most
 * MAX_SEARCH_PAGES pages. A search that is not exhausted by then fails closed:
 * an unseen page may hold this period's other receipt or a cancellation.
 */
async function searchRows(
	runGog: GogRunner,
	email: string,
	signal: AbortSignal | undefined,
): Promise<Row[]> {
	const rows: Row[] = [];
	// id → the row's safe fields, to read a message two pages returned once.
	const seen = new Map<string, string>();
	let token = "";
	for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
		const json = await runGogJson(
			runGog,
			[
				`--account=${email}`,
				"--no-input",
				"--json",
				"gmail",
				"messages",
				"search",
				CLAUDE_CHARGE_SEARCH_QUERY,
				"--max",
				String(SEARCH_PAGE_SIZE),
				...(token === "" ? [] : [`--page=${token}`]),
				"--timezone",
				"UTC",
			],
			signal,
		);
		if (typeof json !== "object" || json === null || Array.isArray(json)) {
			throw new GogFailure("read_failed", "malformed");
		}
		const { messages, nextPageToken } = json as Record<string, unknown>;
		// gog always prints the token ("" on the last page): without it the
		// page proves nothing about exhaustion.
		if (
			!Array.isArray(messages) ||
			messages.length > SEARCH_PAGE_SIZE ||
			typeof nextPageToken !== "string" ||
			(nextPageToken !== "" && !PAGE_TOKEN.test(nextPageToken))
		) {
			throw new GogFailure("read_failed", "malformed");
		}
		for (const message of messages) {
			// Every gog row carries its message id; one without is a broken
			// output, not a mail to skip.
			if (typeof message !== "object" || message === null) {
				throw new GogFailure("read_failed", "malformed");
			}
			const { id, date, from, subject } = message as Record<string, unknown>;
			if (typeof id !== "string" || !MESSAGE_ID.test(id)) {
				throw new GogFailure("read_failed", "malformed");
			}
			const fingerprint = JSON.stringify([date, from, subject]);
			const known = seen.get(id);
			if (known !== undefined) {
				if (known !== fingerprint) {
					throw new GogFailure("read_failed", "malformed");
				}
				continue;
			}
			seen.set(id, fingerprint);
			// A real mail that is not an exact Anthropic notice is dropped.
			const at = parseGogDate(date);
			const kind = classifyAnthropicMail({ from, subject });
			if (at === null || kind === null) continue;
			rows.push({ id, at, kind });
		}
		token = nextPageToken;
		if (token === "") return rows;
	}
	throw new GogFailure("read_failed", "search_truncated");
}

/** The body of a message that is still a receipt by its own headers, else null. */
async function receiptBodyOf(
	runGog: GogRunner,
	email: string,
	id: string,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	const json = await runGogJson(
		runGog,
		[
			`--account=${email}`,
			"--no-input",
			"--json",
			"--select=body,headers.from,headers.subject",
			"gmail",
			"get",
			id,
		],
		signal,
	);
	if (typeof json !== "object" || json === null || Array.isArray(json)) {
		throw new GogFailure("read_failed", "malformed");
	}
	const fields = json as Record<string, unknown>;
	const kind = classifyAnthropicMail({
		from: fields["headers.from"],
		subject: fields["headers.subject"],
	});
	return kind === "receipt" && typeof fields.body === "string"
		? fields.body
		: null;
}

async function readMailbox(
	runGog: GogRunner,
	email: string,
	signal: AbortSignal | undefined,
): Promise<Outcome> {
	const rows = await searchRows(runGog, email, signal);
	// Newest first; gog's own order breaks same-minute ties (stable sort).
	const receipts = rows
		.filter((row) => row.kind === "receipt")
		.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
	const events: ChargeEventInput[] = rows.flatMap((row) =>
		row.kind === "receipt" ? [] : [{ at: row.at, kind: row.kind }],
	);
	const chosen: ChargeReceiptInput[] = [];
	let floorMs: number | null = null;
	let fetched = 0;
	let budgetHit = false;
	let passedFloor = false;
	let unreadable = false;
	// A subscription receipt of this period whose period could not be read.
	let siblingUnreadable = false;
	for (const row of receipts) {
		if (floorMs !== null && Date.parse(row.at) < floorMs) {
			passedFloor = true;
			break;
		}
		if (fetched >= MAX_RECEIPTS_PER_PERIOD) {
			budgetHit = true;
			break;
		}
		fetched += 1;
		const body = await receiptBodyOf(runGog, email, row.id, signal);
		if (body === null) continue;
		const parsed = parseReceiptBody(body);
		if (floorMs === null) {
			if (parsed !== null) {
				chosen.push({ at: row.at, parsed });
				// Receipts of this period can only be sent once it has started.
				floorMs = Date.parse(`${parsed.periodStart}T00:00:00.000Z`) - DAY_MS;
			} else if (hasPlanLine(body)) {
				chosen.push({ at: row.at, parsed: null });
				unreadable = true;
				break;
			}
			// Otherwise not a subscription receipt (extra usage, API credits).
		} else if (parsed !== null) {
			chosen.push({ at: row.at, parsed });
		} else if (hasPlanLine(body)) {
			siblingUnreadable = true;
		}
	}
	// A bounded scan that found nothing is not "no receipt".
	if (floorMs === null && !unreadable && budgetHit) {
		throw new GogFailure("read_failed", "candidate_limit");
	}
	const decision = decideCharge({ receipts: chosen, events });
	if (decision.status !== "ok" && decision.status !== "canceled") {
		return { status: decision.status, reason: null, facts: null };
	}
	// The search was exhausted, so the period is complete unless the body
	// budget ran out before the scan passed the period's lower bound.
	const complete = (passedFloor || !budgetHit) && !siblingUnreadable;
	return {
		status: decision.status,
		reason: null,
		facts: complete
			? decision.facts
			: { ...decision.facts, amountCents: null, receiptCount: null },
	};
}

async function readTarget(
	email: string | null,
	runGog: GogRunner,
	signal: AbortSignal | undefined,
): Promise<Outcome> {
	if (email === null)
		return { status: "no_mailbox", reason: null, facts: null };
	if (signal?.aborted) {
		return { status: "read_failed", reason: "timeout", facts: null };
	}
	try {
		return await readMailbox(runGog, email, signal);
	} catch (error) {
		if (error instanceof GogFailure) {
			return { status: error.status, reason: error.reason, facts: null };
		}
		return { status: "read_failed", reason: "error", facts: null };
	}
}

async function mapPool<T, R>(
	items: readonly T[],
	limit: number,
	run: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await run(items[index]!);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	return results;
}

export async function observeClaudeCharges(input: {
	targets: ClaudeChargeTarget[] | null;
	previous: ClaudeChargeStore | null;
	runGog: GogRunner;
	now?: () => number;
	signal?: AbortSignal;
}): Promise<{ store: ClaudeChargeStore; summary: ClaudeChargeSummary }> {
	if (input.targets === null) throw new Error("accounts_unreadable");
	const now = input.now ?? Date.now;
	const previous = new Map(
		(input.previous?.accounts ?? []).map((reading) => [reading.name, reading]),
	);
	const accounts = await mapPool(
		input.targets,
		CONCURRENCY,
		async (target): Promise<ClaudeChargeReading> => {
			const email = normalizeClaudeChargeMailbox(target.email);
			const outcome = await readTarget(email, input.runGog, input.signal);
			const readAt = new Date(now()).toISOString();
			const key = email === null ? null : claudeChargeMailboxKey(email);
			const prior = previous.get(target.name);
			const lastGood =
				outcome.status === "ok" || outcome.status === "canceled"
					? { readAt, status: outcome.status, facts: outcome.facts }
					: key === null
						? null
						: prior?.mailboxKey === key
							? prior.lastGood
							: null;
			return {
				name: target.name,
				mailboxKey: key,
				readAt,
				status: outcome.status,
				reason: outcome.reason,
				facts: outcome.facts,
				lastGood,
			};
		},
	);
	const summary: ClaudeChargeSummary = {
		accounts: accounts.length,
		ok: accounts.filter((a) => a.status === "ok").length,
		canceled: accounts.filter((a) => a.status === "canceled").length,
		failed: accounts
			.filter((a) => a.status !== "ok" && a.status !== "canceled")
			.map((a) =>
				a.reason === null
					? `${a.name}:${a.status}`
					: `${a.name}:${a.status}/${a.reason}`,
			),
	};
	return {
		store: {
			version: 1,
			generatedAt: new Date(now()).toISOString(),
			accounts,
		},
		summary,
	};
}
