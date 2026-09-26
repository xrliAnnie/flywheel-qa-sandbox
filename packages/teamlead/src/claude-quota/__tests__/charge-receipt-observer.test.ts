import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountStore } from "../../account-heal/account-store.js";
import {
	type ClaudeChargeTarget,
	claudeChargeTargets,
	createGogRunner,
	type GogResult,
	type GogRunner,
	observeClaudeCharges,
	resolveGogBin,
} from "../charge-receipt-observer.js";
import type { ClaudeChargeStore } from "../charge-receipt-store.js";

const SEARCH_QUERY =
	'from:mail.anthropic.com {subject:"Your receipt from Anthropic" subject:"subscription was canceled" subject:"subscription is confirmed" subject:"Welcome to the" subject:"Welcome back to Claude"} newer_than:400d';
const RECEIPT_FROM = '"Anthropic, PBC" <invoice+statements@mail.anthropic.com>';
const NOTICE_FROM = "Anthropic <no-reply-a1b2c3@mail.anthropic.com>";
const NOW = Date.parse("2026-09-25T23:40:00.000Z");

interface Message {
	id: string;
	date: string;
	from: string;
	subject: string;
	body?: string;
	/** What `gmail get` reports, when it differs from the search row. */
	getFrom?: string;
}

function receiptBody(input: {
	amount: string;
	paid: string;
	period: string | null;
	plan?: string;
}): string {
	return [
		"",
		`Receipt from Anthropic, PBC ${input.amount} Paid ${input.paid} (invoice illustration [https://example.invalid/i] Download invoice (https://example.invalid/d) Receipt`,
		"",
		`Receipt #1000-2000-3000 ${input.period ?? ""} ${input.plan ?? "Max plan - 20x"} Qty 1 ${input.amount} Total ${input.amount} Amount paid ${input.amount} Questions?`,
	].join("\n");
}

let receiptSeq = 0;
function receipt(
	id: string,
	date: string,
	body: { amount: string; paid: string; period: string | null; plan?: string },
): Message {
	receiptSeq += 1;
	return {
		id,
		date,
		from: RECEIPT_FROM,
		subject: `Your receipt from Anthropic, PBC #2119-8318-${String(2000 + receiptSeq)}`,
		body: receiptBody(body),
	};
}

function notice(id: string, date: string, subject: string): Message {
	return { id, date, from: NOTICE_FROM, subject };
}

/** The real business timeline (research §2.3), newest first. */
function businessMailbox(): Message[] {
	return [
		receipt("bizrcpt0916b", "2026-09-17 00:05", {
			amount: "$100.01",
			paid: "September 16, 2026",
			period: "Sep 16–Oct 16, 2026",
		}),
		receipt("bizrcpt0916a", "2026-09-17 00:02", {
			amount: "$100.00",
			paid: "September 16, 2026",
			period: "Sep 16–Oct 16, 2026",
			plan: "Max plan - 5x",
		}),
		notice(
			"bizconf0916",
			"2026-09-17 00:02",
			"Your Max subscription is confirmed",
		),
		notice(
			"bizcanc0908",
			"2026-09-08 19:09",
			"Your Claude Max subscription was canceled",
		),
		receipt("bizrcpt0814", "2026-08-15 00:20", {
			amount: "$200.00",
			paid: "August 14, 2026",
			period: "Aug 14–Sep 14, 2026",
		}),
	];
}

function fakeGog(
	mailboxes: Record<string, Message[] | GogResult>,
	options: {
		onGet?: GogResult;
		delayMs?: number;
		pageSize?: number;
		token?: string;
	} = {},
) {
	const calls: string[][] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const runGog: GogRunner = async (args) => {
		calls.push([...args]);
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			if (options.delayMs)
				await new Promise((resolve) => setTimeout(resolve, options.delayMs));
			const account = args[0]!.slice("--account=".length);
			const mailbox = mailboxes[account];
			if (mailbox === undefined) {
				return {
					code: 4,
					signal: null,
					stdout: "",
					stderr: `No auth for gmail ${account}.`,
				};
			}
			if (!Array.isArray(mailbox)) return mailbox;
			if (args.includes("search")) {
				// Envelope with paging, as gog a92bd63 prints it.
				const pageArg = args.find((a) => a.startsWith("--page="));
				const start = pageArg ? Number(pageArg.slice("--page=p".length)) : 0;
				const size = options.pageSize ?? 40;
				const page = mailbox.slice(start, start + size);
				const next = start + size < mailbox.length ? `p${start + size}` : "";
				return {
					code: 0,
					signal: null,
					stdout: JSON.stringify({
						messages: page.map((m) => ({
							id: m.id,
							threadId: m.id,
							date: m.date,
							from: m.from,
							subject: m.subject,
							labels: ["INBOX"],
						})),
						nextPageToken: options.token ?? next,
					}),
					stderr: "",
				};
			}
			if (options.onGet) return options.onGet;
			const id = args[args.length - 1];
			const message = mailbox.find((m) => m.id === id);
			if (!message) return { code: 5, signal: null, stdout: "", stderr: "" };
			return {
				code: 0,
				signal: null,
				stdout: JSON.stringify({
					body: message.body,
					"headers.from": message.getFrom ?? message.from,
					"headers.subject": message.subject,
				}),
				stderr: "",
			};
		} finally {
			inFlight -= 1;
		}
	};
	return {
		runGog,
		calls,
		get maxInFlight() {
			return maxInFlight;
		},
		getIds: () =>
			calls.filter((c) => c.includes("get")).map((c) => c[c.length - 1]),
		searches: () => calls.filter((c) => c.includes("search")),
	};
}

function target(name: string, email: string | null): ClaudeChargeTarget {
	return { name, email };
}

async function observe(
	targets: ClaudeChargeTarget[] | null,
	runGog: GogRunner,
	extra: { previous?: ClaudeChargeStore | null; signal?: AbortSignal } = {},
) {
	return observeClaudeCharges({
		targets,
		previous: extra.previous ?? null,
		runGog,
		now: () => NOW,
		signal: extra.signal,
	});
}

describe("FLY-2897 observeClaudeCharges — reading", () => {
	it("searches metadata once, then fetches only the current period's receipts", async () => {
		const gog = fakeGog({ "b@example.com": businessMailbox() });
		const { store } = await observe(
			[target("business", "b@example.com")],
			gog.runGog,
		);
		expect(gog.calls[0]).toEqual([
			"--account=b@example.com",
			"--no-input",
			"--json",
			"gmail",
			"messages",
			"search",
			SEARCH_QUERY,
			"--max",
			"40",
			"--timezone",
			"UTC",
		]);
		expect(gog.calls[1]).toEqual([
			"--account=b@example.com",
			"--no-input",
			"--json",
			"--select=body,headers.from,headers.subject",
			"gmail",
			"get",
			"bizrcpt0916b",
		]);
		expect(gog.getIds()).toEqual(["bizrcpt0916b", "bizrcpt0916a"]);
		expect(gog.calls.flat()).not.toContain("--include-body");
		expect(store.accounts).toEqual([
			{
				name: "business",
				mailboxKey: expect.stringMatching(/^[a-f0-9]{64}$/),
				readAt: new Date(NOW).toISOString(),
				status: "ok",
				reason: null,
				facts: {
					periodStart: "2026-09-16",
					periodEnd: "2026-10-16",
					paidOn: "2026-09-16",
					amountCents: 20001,
					receiptCount: 2,
					receiptAt: "2026-09-17T00:05:00.000Z",
					canceledAt: null,
					resumedAt: null,
				},
				lastGood: {
					readAt: new Date(NOW).toISOString(),
					status: "ok",
					facts: expect.objectContaining({ periodEnd: "2026-10-16" }),
				},
			},
		]);
	});

	it("marks a constructed cancellation after the latest receipt", async () => {
		const gog = fakeGog({
			"b@example.com": [
				notice(
					"bizcanc0920",
					"2026-09-20 18:00",
					"Your Claude Max subscription was canceled",
				),
				...businessMailbox(),
			],
		});
		const { store } = await observe(
			[target("business", "b@example.com")],
			gog.runGog,
		);
		expect(store.accounts[0]).toMatchObject({
			status: "canceled",
			facts: {
				periodEnd: "2026-10-16",
				canceledAt: "2026-09-20T18:00:00.000Z",
			},
		});
	});

	it("keeps the anchor through a constructed cancel-then-resubscribe", async () => {
		const gog = fakeGog({
			"b@example.com": [
				notice("bizback0922", "2026-09-22 18:00", "Welcome back to Claude Max"),
				notice(
					"bizcanc0920",
					"2026-09-20 18:00",
					"Your Claude Max subscription was canceled",
				),
				...businessMailbox(),
			],
		});
		const { store } = await observe(
			[target("business", "b@example.com")],
			gog.runGog,
		);
		expect(store.accounts[0]).toMatchObject({
			status: "ok",
			facts: {
				periodEnd: "2026-10-16",
				canceledAt: null,
				resumedAt: "2026-09-22T18:00:00.000Z",
			},
		});
	});

	it("skips extra-usage receipts to find the subscription receipt", async () => {
		const gog = fakeGog({
			"p@example.com": [
				receipt("extra0920", "2026-09-20 10:00", {
					amount: "$50.00",
					paid: "September 20, 2026",
					period: null,
					plan: "Extra usage credits",
				}),
				receipt("prcpt0904", "2026-09-05 00:06", {
					amount: "$200.00",
					paid: "September 4, 2026",
					period: "Sep 4–Oct 4, 2026",
				}),
				receipt("prcpt0804", "2026-08-05 00:07", {
					amount: "$200.00",
					paid: "August 4, 2026",
					period: "Aug 4–Sep 4, 2026",
				}),
			],
		});
		const { store } = await observe(
			[target("personal", "p@example.com")],
			gog.runGog,
		);
		expect(gog.getIds()).toEqual(["extra0920", "prcpt0904"]);
		expect(store.accounts[0]).toMatchObject({
			status: "ok",
			facts: { periodEnd: "2026-10-04", amountCents: 20000, receiptCount: 1 },
		});
	});

	it("says parse_failed when the newest subscription receipt has no readable period", async () => {
		const gog = fakeGog({
			"p@example.com": [
				receipt("prcpt1004", "2026-10-05 00:06", {
					amount: "$200.00",
					paid: "October 4, 2026",
					period: "4 Oct 2026 to 4 Nov 2026",
				}),
				receipt("prcpt0904", "2026-09-05 00:06", {
					amount: "$200.00",
					paid: "September 4, 2026",
					period: "Sep 4–Oct 4, 2026",
				}),
			],
		});
		const { store } = await observe(
			[target("personal", "p@example.com")],
			gog.runGog,
		);
		expect(gog.getIds()).toEqual(["prcpt1004"]);
		expect(store.accounts[0]).toMatchObject({
			status: "parse_failed",
			reason: null,
			facts: null,
		});
	});

	const extra = (id: string, date: string) =>
		receipt(id, date, {
			amount: "$5.00",
			paid: "September 20, 2026",
			period: null,
			plan: "API credits",
		});
	const subscription = (id: string, date: string) =>
		receipt(id, date, {
			amount: "$100.00",
			paid: "September 16, 2026",
			period: "Sep 16–Oct 16, 2026",
		});

	it("says candidate_limit, not no_receipt, when six bodies were not enough", async () => {
		const mailbox = [
			...Array.from({ length: 6 }, (_, i) =>
				extra(`extra${i}abc`, `2026-09-2${4 - Math.floor(i / 2)} 1${i}:00`),
			),
			subscription("subscription1", "2026-09-17 00:05"),
		];
		const gog = fakeGog({ "p@example.com": mailbox });
		const { store } = await observe(
			[target("personal", "p@example.com")],
			gog.runGog,
		);
		expect(gog.getIds()).toHaveLength(6);
		expect(store.accounts[0]).toMatchObject({
			status: "read_failed",
			reason: "candidate_limit",
			facts: null,
		});
	});

	it("finds the subscription receipt as the sixth body", async () => {
		const mailbox = [
			...Array.from({ length: 5 }, (_, i) =>
				extra(`extra${i}abc`, `2026-09-2${4 - Math.floor(i / 2)} 1${i}:00`),
			),
			subscription("subscription1", "2026-09-17 00:05"),
		];
		const gog = fakeGog({ "p@example.com": mailbox });
		const { store } = await observe(
			[target("personal", "p@example.com")],
			gog.runGog,
		);
		// Every receipt in the mailbox was read, so the period is complete.
		expect(store.accounts[0]).toMatchObject({
			status: "ok",
			facts: { periodEnd: "2026-10-16", amountCents: 10000, receiptCount: 1 },
		});
	});

	it("drops the amount when the budget ends inside the current period", async () => {
		const mailbox = [
			...Array.from({ length: 4 }, (_, i) =>
				extra(`extra${i}abc`, `2026-09-2${4 - i} 10:00`),
			),
			subscription("subscription2", "2026-09-17 00:05"),
			subscription("subscription1", "2026-09-17 00:02"),
			subscription("subscription0", "2026-09-16 23:59"),
		];
		const gog = fakeGog({ "p@example.com": mailbox });
		const { store } = await observe(
			[target("personal", "p@example.com")],
			gog.runGog,
		);
		expect(gog.getIds()).toHaveLength(6);
		expect(store.accounts[0]).toMatchObject({
			status: "ok",
			facts: {
				periodEnd: "2026-10-16",
				amountCents: null,
				receiptCount: null,
			},
		});
	});

	it("drops the totals when an earlier receipt of the period is unreadable", async () => {
		const gog = fakeGog({
			"p@example.com": [
				subscription("subscription2", "2026-09-17 00:05"),
				receipt("garbled0916", "2026-09-17 00:02", {
					amount: "$100.00",
					paid: "September 16, 2026",
					period: "16 Sep 2026 to 16 Oct 2026",
				}),
			],
		});
		const { store } = await observe(
			[target("personal", "p@example.com")],
			gog.runGog,
		);
		expect(store.accounts[0]).toMatchObject({
			status: "ok",
			facts: { periodEnd: "2026-10-16", amountCents: null, receiptCount: null },
		});
	});

	it("keeps the amount once the scan has passed the period's lower bound", async () => {
		const gog = fakeGog({
			"p@example.com": [
				subscription("subscription2", "2026-09-17 00:05"),
				subscription("subscription1", "2026-09-17 00:02"),
				receipt("previous0814", "2026-08-15 00:20", {
					amount: "$200.00",
					paid: "August 14, 2026",
					period: "Aug 14–Sep 14, 2026",
				}),
			],
		});
		const { store } = await observe(
			[target("personal", "p@example.com")],
			gog.runGog,
		);
		expect(gog.getIds()).toEqual(["subscription2", "subscription1"]);
		expect(store.accounts[0]).toMatchObject({
			facts: { amountCents: 20000, receiptCount: 2 },
		});
	});

	it("follows nextPageToken, not the row count, and counts a later page's receipts", async () => {
		const [upgrade, fiveX, confirmed, , previous] = businessMailbox();
		const gog = fakeGog(
			{ "b@example.com": [upgrade!, confirmed!, fiveX!, previous!] },
			{ pageSize: 2 },
		);
		const { store } = await observe(
			[target("business", "b@example.com")],
			gog.runGog,
		);
		expect(
			gog.searches().map((c) => c.find((a) => a.startsWith("--page="))),
		).toEqual([undefined, "--page=p2"]);
		// The 5x receipt of the same period sits on page 2.
		expect(store.accounts[0]).toMatchObject({
			status: "ok",
			facts: { amountCents: 20001, receiptCount: 2 },
		});
	});

	it("fails closed as search_truncated after three pages", async () => {
		const gog = fakeGog(
			{
				"b@example.com": [
					...businessMailbox(),
					notice("olderwelcome", "2026-06-25 15:50", "Welcome to the Max plan"),
					notice(
						"olderwelcome2",
						"2026-06-25 15:49",
						"Welcome to the Max plan",
					),
				],
			},
			{ pageSize: 2 },
		);
		const { store } = await observe(
			[target("business", "b@example.com")],
			gog.runGog,
		);
		expect(gog.searches()).toHaveLength(3);
		expect(gog.getIds()).toEqual([]);
		expect(store.accounts[0]).toMatchObject({
			status: "read_failed",
			reason: "search_truncated",
			facts: null,
		});
	});

	it("treats a broken search envelope as malformed, never as an empty mailbox", async () => {
		const envelope = (value: unknown): GogResult => ({
			code: 0,
			signal: null,
			stdout: JSON.stringify(value),
			stderr: "",
		});
		const row = {
			id: "prcpt0904",
			threadId: "prcpt0904",
			date: "2026-09-05 00:06",
			from: RECEIPT_FROM,
			subject: "Your receipt from Anthropic, PBC #2119-8318-2194",
		};
		for (const shape of [
			{ messages: [] },
			{ messages: [], nextPageToken: null },
			{ messages: [5], nextPageToken: "" },
			{ messages: [{ ...row, id: undefined }], nextPageToken: "" },
			{ messages: [{ ...row, id: "../../etc" }], nextPageToken: "" },
		]) {
			const gog = fakeGog({ "p@example.com": envelope(shape) });
			const { store } = await observe(
				[target("personal", "p@example.com")],
				gog.runGog,
			);
			expect(store.accounts[0]).toMatchObject({
				status: "read_failed",
				reason: "malformed",
			});
		}
	});

	it("reads a message that two pages both returned only once", async () => {
		const [upgrade, fiveX, , , previous] = businessMailbox();
		const gog = fakeGog(
			{ "b@example.com": [upgrade!, fiveX!, fiveX!, previous!] },
			{ pageSize: 2 },
		);
		const { store } = await observe(
			[target("business", "b@example.com")],
			gog.runGog,
		);
		expect(gog.getIds()).toEqual(["bizrcpt0916b", "bizrcpt0916a"]);
		expect(store.accounts[0]).toMatchObject({
			status: "ok",
			facts: { amountCents: 20001, receiptCount: 2 },
		});
		const conflicting = fakeGog(
			{
				"b@example.com": [
					upgrade!,
					fiveX!,
					{ ...fiveX!, date: "2026-09-18 00:00" },
					previous!,
				],
			},
			{ pageSize: 2 },
		);
		const broken = await observe(
			[target("business", "b@example.com")],
			conflicting.runGog,
		);
		expect(broken.store.accounts[0]).toMatchObject({
			status: "read_failed",
			reason: "malformed",
		});
	});

	it("refuses a page token it cannot pass back safely", async () => {
		const gog = fakeGog(
			{ "b@example.com": businessMailbox() },
			{ token: "--evil token" },
		);
		const { store } = await observe(
			[target("business", "b@example.com")],
			gog.runGog,
		);
		expect(gog.searches()).toHaveLength(1);
		expect(store.accounts[0]).toMatchObject({
			status: "read_failed",
			reason: "malformed",
		});
	});

	it("says no_receipt for an empty mailbox", async () => {
		const gog = fakeGog({ "s@example.com": [] });
		const { store } = await observe(
			[target("school", "s@example.com")],
			gog.runGog,
		);
		expect(store.accounts[0]).toMatchObject({
			status: "no_receipt",
			reason: null,
			facts: null,
			lastGood: null,
		});
	});

	it("never fetches spoofed rows or rows without a readable date", async () => {
		const gog = fakeGog({
			"p@example.com": [
				{
					id: "spoof0001",
					date: "2026-09-24 10:00",
					from: '"invoice+statements@mail.anthropic.com" <evil@evil.example>',
					subject: "Your receipt from Anthropic, PBC #2119-8318-9999",
					body: receiptBody({
						amount: "$1.00",
						paid: "September 24, 2026",
						period: "Sep 24–Dec 24, 2026",
					}),
				},
				{
					id: "baddate01",
					date: "Thu, 24 Sep 2026",
					from: RECEIPT_FROM,
					subject: "Your receipt from Anthropic, PBC #2119-8318-9997",
				},
				receipt("prcpt0904", "2026-09-05 00:06", {
					amount: "$200.00",
					paid: "September 4, 2026",
					period: "Sep 4–Oct 4, 2026",
				}),
			],
		});
		const { store } = await observe(
			[target("personal", "p@example.com")],
			gog.runGog,
		);
		expect(gog.getIds()).toEqual(["prcpt0904"]);
		expect(store.accounts[0]).toMatchObject({
			status: "ok",
			facts: { periodEnd: "2026-10-04" },
		});
	});

	it("drops a fetched message whose own headers are not a receipt", async () => {
		const mailbox = businessMailbox();
		mailbox[0] = { ...mailbox[0]!, getFrom: "Evil <evil@evil.example>" };
		const gog = fakeGog({ "b@example.com": mailbox });
		const { store } = await observe(
			[target("business", "b@example.com")],
			gog.runGog,
		);
		expect(store.accounts[0]).toMatchObject({
			status: "ok",
			facts: { amountCents: 10000, receiptCount: 1 },
		});
	});

	it("does not call gog for an account without a usable mailbox", async () => {
		const gog = fakeGog({});
		const { store } = await observe(
			[
				target("orphan", null),
				target("broken", "not-an-address"),
				target("dash", "-x@example.com"),
			],
			gog.runGog,
		);
		expect(gog.calls).toEqual([]);
		expect(store.accounts.map((a) => [a.name, a.status, a.mailboxKey])).toEqual(
			[
				["orphan", "no_mailbox", null],
				["broken", "no_mailbox", null],
				["dash", "no_mailbox", null],
			],
		);
	});

	it("reads a free account's mailbox like any other (the page decides free)", async () => {
		const gog = fakeGog({});
		const { store } = await observe(
			[target("personal1", "p1@example.com")],
			gog.runGog,
		);
		expect(gog.searches()).toHaveLength(1);
		expect(store.accounts[0]).toMatchObject({
			status: "auth_missing",
			mailboxKey: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});

	it("reads at most four mailboxes at once", async () => {
		const mailboxes: Record<string, Message[]> = {};
		const targets = Array.from({ length: 7 }, (_, i) => {
			mailboxes[`m${i}@example.com`] = [];
			return target(`acct${i}`, `m${i}@example.com`);
		});
		const gog = fakeGog(mailboxes, { delayMs: 5 });
		await observe(targets, gog.runGog);
		expect(gog.maxInFlight).toBe(4);
		expect(gog.calls).toHaveLength(7);
	});

	it("gives up the whole round when the account list is unreadable", async () => {
		const gog = fakeGog({});
		await expect(observe(null, gog.runGog)).rejects.toThrow(
			"accounts_unreadable",
		);
		expect(gog.calls).toEqual([]);
	});

	it("does not start queued mailboxes after the round is aborted", async () => {
		const gog = fakeGog({ "b@example.com": businessMailbox() });
		const abort = new AbortController();
		abort.abort();
		const { store } = await observe(
			[target("business", "b@example.com")],
			gog.runGog,
			{ signal: abort.signal },
		);
		expect(gog.calls).toEqual([]);
		expect(store.accounts[0]).toMatchObject({
			status: "read_failed",
			reason: "timeout",
		});
	});
});

describe("FLY-2897 observeClaudeCharges — failures", () => {
	const cases: Array<[string, GogResult, string, string | null]> = [
		[
			"no stored token",
			{
				code: 4,
				signal: null,
				stdout: "",
				stderr:
					"No auth for gmail s@example.com.\n\nOAuth (browser flow):\n  gog auth add s@example.com --services gmail",
			},
			"auth_missing",
			null,
		],
		[
			"no stored token after a warning line",
			{
				code: 4,
				signal: null,
				stdout: "",
				stderr:
					"time=x level=WARN msg=keyring\nNo auth for gmail s@example.com.",
			},
			"auth_missing",
			null,
		],
		[
			"a revoked refresh token",
			{
				code: 1,
				signal: null,
				stdout: "",
				stderr: 'refresh access token: oauth2: "invalid_grant" "Bad Request"',
			},
			"auth_invalid",
			"invalid_grant",
		],
		[
			"an API 401",
			{ code: 4, signal: null, stdout: "", stderr: "googleapi: Error 401" },
			"auth_invalid",
			"unauthorized",
		],
		[
			"not found",
			{ code: 5, signal: null, stdout: "", stderr: "" },
			"read_failed",
			"not_found",
		],
		[
			"scope too narrow",
			{ code: 6, signal: null, stdout: "", stderr: "" },
			"read_failed",
			"permission_denied",
		],
		[
			"rate limited",
			{ code: 7, signal: null, stdout: "", stderr: "" },
			"read_failed",
			"rate_limited",
		],
		[
			"retryable",
			{ code: 8, signal: null, stdout: "", stderr: "" },
			"read_failed",
			"retryable",
		],
		[
			"no client",
			{ code: 10, signal: null, stdout: "", stderr: "" },
			"read_failed",
			"gog_config",
		],
		[
			"cancelled",
			{ code: 130, signal: null, stdout: "", stderr: "" },
			"read_failed",
			"timeout",
		],
		[
			"killed",
			{ code: null, signal: "SIGTERM", stdout: "", stderr: "" },
			"read_failed",
			"timeout",
		],
		[
			"our timeout",
			{
				code: null,
				signal: "SIGTERM",
				stdout: "",
				stderr: "",
				error: "timeout",
			},
			"read_failed",
			"timeout",
		],
		[
			"missing binary",
			{ code: null, signal: null, stdout: "", stderr: "", error: "enoent" },
			"read_failed",
			"gog_missing",
		],
		[
			"huge output",
			{
				code: null,
				signal: "SIGTERM",
				stdout: "",
				stderr: "",
				error: "output_too_large",
			},
			"read_failed",
			"output_too_large",
		],
		[
			"non-JSON output",
			{ code: 0, signal: null, stdout: "Receipt from Anthropic", stderr: "" },
			"read_failed",
			"malformed",
		],
		[
			"JSON of the wrong shape",
			{ code: 0, signal: null, stdout: "[]", stderr: "" },
			"read_failed",
			"malformed",
		],
		[
			"another exit code",
			{ code: 2, signal: null, stdout: "", stderr: "" },
			"read_failed",
			"error",
		],
	];

	for (const [label, result, status, reason] of cases) {
		it(`classifies ${label}`, async () => {
			const gog = fakeGog({ "s@example.com": result });
			const { store, summary } = await observe(
				[target("school", "s@example.com")],
				gog.runGog,
			);
			expect(store.accounts[0]).toMatchObject({ status, reason, facts: null });
			expect(summary.failed).toEqual([
				reason === null ? `school:${status}` : `school:${status}/${reason}`,
			]);
		});
	}

	it("fails the whole account when a body fetch fails", async () => {
		const gog = fakeGog(
			{ "b@example.com": businessMailbox() },
			{
				onGet: {
					code: 1,
					signal: null,
					stdout: "",
					stderr: 'oauth2: "invalid_grant"',
				},
			},
		);
		const { store } = await observe(
			[target("business", "b@example.com")],
			gog.runGog,
		);
		expect(store.accounts[0]).toMatchObject({
			status: "auth_invalid",
			reason: "invalid_grant",
			facts: null,
		});
	});

	it("carries the last good reading of the same mailbox, never another one", async () => {
		const good = await observe(
			[target("business", "b@example.com")],
			fakeGog({ "b@example.com": businessMailbox() }).runGog,
		);
		const failing = fakeGog({
			"b@example.com": {
				code: 1,
				signal: null,
				stdout: "",
				stderr: '"invalid_grant"',
			},
			"new@example.com": {
				code: 1,
				signal: null,
				stdout: "",
				stderr: '"invalid_grant"',
			},
		});
		const same = await observe(
			[target("business", "b@example.com")],
			failing.runGog,
			{ previous: good.store },
		);
		expect(same.store.accounts[0]!.lastGood).toEqual(
			good.store.accounts[0]!.lastGood,
		);
		const moved = await observe(
			[target("business", "new@example.com")],
			failing.runGog,
			{ previous: good.store },
		);
		expect(moved.store.accounts[0]!.lastGood).toBeNull();
	});
});

describe("FLY-2897 observeClaudeCharges — nothing but fields leaves the round", () => {
	it("keeps subjects, senders, receipt numbers, bodies and addresses out of the store and summary", async () => {
		const gog = fakeGog({
			"b@example.com": [
				notice(
					"bizcanc0920",
					"2026-09-20 18:00",
					"Your Claude Max subscription was canceled",
				),
				...businessMailbox(),
			],
			"s@example.com": {
				code: 4,
				signal: null,
				stdout: "",
				stderr: "No auth for gmail s@example.com.",
			},
		});
		const result = await observe(
			[target("business", "b@example.com"), target("school", "s@example.com")],
			gog.runGog,
		);
		const text = JSON.stringify(result);
		for (const forbidden of [
			"@",
			"Anthropic",
			"Your receipt",
			"Receipt from",
			"Receipt #",
			"subscription",
			"2119-8318",
			"Amount paid",
			"example.invalid",
			"Max plan",
			"PBC",
		]) {
			expect(text).not.toContain(forbidden);
		}
		expect(result.summary).toEqual({
			accounts: 2,
			ok: 0,
			canceled: 1,
			failed: ["school:auth_missing"],
		});
	});
});

describe("FLY-2897 claudeChargeTargets", () => {
	const accounts = (
		entries: Array<{ name: string; email?: string }>,
	): AccountStore =>
		({
			generation: 1,
			activeAccount: null,
			accounts: entries.map((entry) => ({
				name: entry.name,
				quotaExhaustedUntil: null,
				weeklyResetAt: null,
				...(entry.email
					? {
							identity: {
								email: entry.email,
								setAt: "2026-09-01T00:00:00.000Z",
							},
						}
					: {}),
			})),
		}) as AccountStore;
	it("pairs each account with its mailbox", () => {
		expect(
			claudeChargeTargets(
				accounts([
					{ name: "business", email: "b@example.com" },
					{ name: "personal1", email: "p1@example.com" },
					{ name: "noid" },
					{ name: "../bad", email: "x@example.com" },
				]),
			),
		).toEqual([
			{ name: "business", email: "b@example.com" },
			{ name: "personal1", email: "p1@example.com" },
			{ name: "noid", email: null },
		]);
	});

	it("refuses an unreadable account list", () => {
		expect(claudeChargeTargets(null)).toBeNull();
	});
});

describe("FLY-2897 createGogRunner (real subprocess)", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function script(body: string): string {
		const root = mkdtempSync(join(tmpdir(), "fly2897-gog-"));
		roots.push(root);
		const path = join(root, "gog");
		writeFileSync(path, `#!/bin/sh\n${body}\n`);
		chmodSync(path, 0o755);
		return path;
	}

	it("passes arguments verbatim, without a shell", async () => {
		const bin = script('for a in "$@"; do printf "%s\\n" "$a"; done');
		const run = createGogRunner({ bin });
		const tricky = ['from:x {subject:"a b"} $(touch /tmp/pwn) `id`', "--max"];
		const result = await run(tricky, undefined);
		expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
		expect(result.stdout).toBe(`${tricky.join("\n")}\n`);
	});

	it("reports exit code and stderr", async () => {
		const bin = script('echo "No auth for gmail x." >&2; exit 4');
		const result = await createGogRunner({ bin })([], undefined);
		expect(result).toMatchObject({
			code: 4,
			stderr: "No auth for gmail x.\n",
		});
		expect(result.error).toBeUndefined();
	});

	it("kills a hung gog at its timeout", async () => {
		// The child sleeps 60 s: only the runner's kill can end it inside the
		// test's own timeout, and the outcome says so.
		const bin = script("exec sleep 60");
		const result = await createGogRunner({ bin, timeoutMs: 150 })(
			[],
			undefined,
		);
		expect(result.error).toBe("timeout");
		expect(result.signal).toBe("SIGTERM");
	});

	it("kills gog when the round aborts", async () => {
		const bin = script("exec sleep 5");
		const abort = new AbortController();
		const pending = createGogRunner({ bin })([], abort.signal);
		setTimeout(() => abort.abort(), 50);
		expect((await pending).error).toBe("timeout");
	});

	it("caps stdout", async () => {
		const bin = script("head -c 5000 /dev/zero");
		const result = await createGogRunner({ bin, maxBytes: 1000 })(
			[],
			undefined,
		);
		expect(result.error).toBe("output_too_large");
	});

	it("reports a missing binary", async () => {
		const result = await createGogRunner({
			bin: join(tmpdir(), "fly2897-no-such-gog"),
		})([], undefined);
		expect(result.error).toBe("enoent");
	});

	it("prefers the Homebrew locations, then PATH", () => {
		expect(resolveGogBin((path) => path === "/usr/local/bin/gog")).toBe(
			"/usr/local/bin/gog",
		);
		expect(resolveGogBin(() => true)).toBe("/opt/homebrew/bin/gog");
		expect(resolveGogBin(() => false)).toBe("gog");
	});
});
