import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildAccountQuotaView,
	renderAccountsPageHtml,
} from "../../bridge/account-quota-view.js";
import {
	type GogResult,
	type GogRunner,
	observeClaudeCharges,
} from "../charge-receipt-observer.js";
import {
	readClaudeChargeStore,
	writeClaudeChargeStore,
} from "../charge-receipt-store.js";

/**
 * FLY-2897 acceptance on constructed mail: gog output → observer → file →
 * view → page. The mailbox shapes mirror the real ones (research §2), with a
 * constructed cancellation for business.
 */
const GENERATED = "2026-09-25T23:40:00.000Z"; // 16:40 PDT
const RECEIPT_FROM = '"Anthropic, PBC" <invoice+statements@mail.anthropic.com>';
const NOTICE_FROM = "Anthropic <no-reply-a1b2c3@mail.anthropic.com>";

interface Mail {
	id: string;
	date: string;
	from: string;
	subject: string;
	body?: string;
}

function receipt(
	id: string,
	date: string,
	amount: string,
	paid: string,
	period: string,
	plan = "Max plan - 20x",
): Mail {
	return {
		id,
		date,
		from: RECEIPT_FROM,
		subject: `Your receipt from Anthropic, PBC #2119-8318-${id.slice(-4)}`,
		body: `Receipt from Anthropic, PBC ${amount} Paid ${paid} (invoice illustration [https://example.invalid/i] Receipt\nReceipt #2119-8318-${id.slice(-4)} ${period} ${plan} Qty 1 ${amount} Total ${amount} Amount paid ${amount} Questions?`,
	};
}

const MAILBOXES: Record<string, Mail[] | GogResult> = {
	"business@example.com": [
		{
			id: "bizcancel0920",
			date: "2026-09-20 18:00",
			from: NOTICE_FROM,
			subject: "Your Claude Max subscription was canceled",
		},
		receipt(
			"bizrcpt00002",
			"2026-09-17 00:05",
			"$100.01",
			"September 16, 2026",
			"Sep 16–Oct 16, 2026",
		),
		receipt(
			"bizrcpt00001",
			"2026-09-17 00:02",
			"$100.00",
			"September 16, 2026",
			"Sep 16–Oct 16, 2026",
			"Max plan - 5x",
		),
		{
			id: "bizconfirm0916",
			date: "2026-09-17 00:02",
			from: NOTICE_FROM,
			subject: "Your Max subscription is confirmed",
		},
	],
	"personal@example.com": [
		receipt(
			"prsrcpt00904",
			"2026-09-05 00:06",
			"$200.00",
			"September 4, 2026",
			"Sep 4–Oct 4, 2026",
		),
		{
			id: "prsback0803",
			date: "2026-08-04 02:55",
			from: NOTICE_FROM,
			subject: "Welcome back to Claude Max",
		},
		{
			id: "prscancel0731",
			date: "2026-07-31 15:40",
			from: NOTICE_FROM,
			subject: "Your Claude Max subscription was canceled",
		},
	],
	"school@example.edu": {
		code: 1,
		signal: null,
		stdout: "",
		stderr: 'refresh access token: oauth2: "invalid_grant" "Bad Request"',
	},
};

const fakeGog: GogRunner = async (args) => {
	const mailbox = MAILBOXES[args[0]!.slice("--account=".length)];
	if (mailbox === undefined) {
		return {
			code: 4,
			signal: null,
			stdout: "",
			stderr: "No auth for gmail x.",
		};
	}
	if (!Array.isArray(mailbox)) return mailbox;
	if (args.includes("search")) {
		return {
			code: 0,
			signal: null,
			stdout: JSON.stringify({
				messages: mailbox.map(({ body: _body, ...row }) => ({
					...row,
					threadId: row.id,
					labels: ["INBOX"],
				})),
				nextPageToken: "",
			}),
			stderr: "",
		};
	}
	const mail = mailbox.find((m) => m.id === args[args.length - 1]);
	return {
		code: 0,
		signal: null,
		stdout: JSON.stringify({
			body: mail?.body,
			"headers.from": mail?.from,
			"headers.subject": mail?.subject,
		}),
		stderr: "",
	};
};

function claudeAccount(name: string, extra: Record<string, unknown> = {}) {
	return {
		name,
		active: false,
		subscriptionTier: {
			subscriptionType: "max",
			rateLimitTier: "default_claude_max_20x",
		},
		fiveHPct: 5,
		sevenDPct: 20,
		fableSevenDPct: 3,
		observedAt: "2026-09-25T23:30:00.000Z",
		ageMinutes: 10,
		stale: false,
		fiveHResetAt: "2026-09-26T02:00:00.000Z",
		weeklyResetAt: "2026-09-29T16:00:00.000Z",
		fableWeeklyResetAt: "2026-09-29T16:00:00.000Z",
		exhaustedUntil: null,
		authUnusable: false,
		subscriptionStatus: "active",
		detailObservedAt: "2026-09-25T23:35:00.000Z",
		usageStatus: "ok",
		prepaid: { known: true, cards: null },
		...extra,
	};
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("FLY-2897 receipts to page, on constructed mail", () => {
	it("shows the next charge, a cancellation, a free account and a broken grant", async () => {
		const { store } = await observeClaudeCharges({
			targets: [
				{ name: "business", email: "business@example.com" },
				{ name: "personal", email: "personal@example.com" },
				{ name: "personal1", email: "personal1@example.com" },
				{ name: "school", email: "school@example.edu" },
			],
			previous: null,
			runGog: fakeGog,
			now: () => Date.parse(GENERATED),
		});
		const root = mkdtempSync(join(tmpdir(), "fly2897-e2e-"));
		roots.push(root);
		const path = join(root, "claude-quota", "charge-receipts.json");
		writeClaudeChargeStore(path, store);
		const onDisk = readFileSync(path, "utf8");
		for (const forbidden of ["@", "Anthropic", "PBC", "2119-8318", "Receipt"]) {
			expect(onDisk).not.toContain(forbidden);
		}

		const view = buildAccountQuotaView(
			{
				generatedAt: GENERATED,
				quota: {
					claude: {
						source: "claude-accounts.json" as const,
						activeAccount: null,
						staleAfterMinutes: 30,
						accounts: [
							claudeAccount("business"),
							claudeAccount("personal"),
							claudeAccount("personal1", {
								subscriptionTier: {
									subscriptionType: "free",
									rateLimitTier: "default_claude_ai",
								},
								subscriptionStatus: "canceled",
								usageStatus: "network",
							}),
							claudeAccount("school"),
						] as never,
					},
					codex: {
						source: null,
						unavailable: ["structural: codex_no_usage_api"],
					},
				},
			},
			{
				claudeEmails: {
					business: "business@example.com",
					personal: "personal@example.com",
					personal1: "personal1@example.com",
					school: "school@example.edu",
				},
				claudeCharges: readClaudeChargeStore(path),
			},
		);
		const cell = (name: string) =>
			view.claude.find((row) => row.name === name)!.nextCharge.display;
		expect(cell("business")).toBe("已取消 · 10/16 周五 到期");
		expect(cell("personal")).toBe("10/04 周日\n本期 9/4–10/4 · 已付 $200.00");
		expect(cell("personal1")).toBe("免费号，无扣费");
		expect(cell("school")).toBe(
			"读不到（邮箱授权失效 invalid_grant，需重新授权）",
		);

		const html = renderAccountsPageHtml(view);
		const rowOf = (name: string) =>
			html
				.split("</tr>")
				.find((tr) => tr.includes(`<div class="account-name">${name}</div>`)) ??
			"";
		expect(rowOf("business")).toContain(
			'<span class="next-charge">已取消 · 10/16 周五 到期</span><span class="charge-read-time">收据读于 16:40</span>',
		);
		expect(rowOf("personal")).toContain(
			'<span class="next-charge">10/04 周日</span><span class="charge-note">本期 9/4–10/4 · 已付 $200.00</span><span class="charge-read-time">收据读于 16:40</span>',
		);
		expect(rowOf("personal1")).toContain(
			'<span class="next-charge">免费号，无扣费</span>',
		);
		expect(rowOf("school")).toContain(
			'<span class="next-charge">读不到（邮箱授权失效 invalid_grant，需重新授权）</span>',
		);
	});
});
