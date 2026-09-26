import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	buildAccountQuotaView,
	formatAccountQuotaTickLines,
	renderAccountsPageHtml,
} from "../account-quota-view.js";

const generatedAt = "2026-09-18T00:45:00.000Z";

function quota() {
	return {
		claude: {
			source: "claude-accounts.json" as const,
			activeAccount: "shopping",
			staleAfterMinutes: 30,
			accounts: [
				{
					name: "shopping",
					active: true,
					subscriptionTier: {
						subscriptionType: "max",
						rateLimitTier: "default_claude_max_20x",
					},
					fiveHPct: 10,
					sevenDPct: 24,
					fableSevenDPct: null,
					observedAt: "2026-09-18T00:40:00.000Z",
					ageMinutes: 5,
					stale: false,
					fiveHResetAt: "2026-09-18T02:00:00.000Z",
					weeklyResetAt: "2026-09-22T16:00:00.000Z",
					fableWeeklyResetAt: null,
					exhaustedUntil: null,
					authUnusable: false,
					subscriptionStatus: "active" as const,
					detailObservedAt: "2026-09-18T00:41:00.000Z",
					prepaid: { known: true, cards: null },
				},
				{
					name: "business",
					active: false,
					subscriptionTier: {
						subscriptionType: "pro",
						rateLimitTier: "default_claude_pro",
					},
					fiveHPct: 2,
					sevenDPct: 7,
					fableSevenDPct: 2,
					observedAt: "2026-09-17T22:00:00.000Z",
					ageMinutes: 165,
					stale: true,
					fiveHResetAt: null,
					weeklyResetAt: "2026-09-19T16:00:00.000Z",
					fableWeeklyResetAt: "2026-09-19T16:00:00.000Z",
					retiresAt: "2026-10-14T07:00:00.000Z",
					exhaustedUntil: null,
					authUnusable: false,
					subscriptionStatus: "active" as const,
					detailObservedAt: "2026-09-18T00:41:00.000Z",
					prepaid: { known: true, cards: null },
					manualPrepaid: {
						account: "business",
						confirmedBy: "founder",
						confirmedAt: "2026-09-18T00:42:00.000Z",
						cards: [{ expiresAt: "2026-10-16T00:00:00.000Z" }],
					},
				},
				{
					name: "personal1",
					active: false,
					fiveHPct: 24,
					sevenDPct: 70,
					observedAt: "2026-09-08T21:33:20.161Z",
					ageMinutes: 13_000,
					stale: true,
					weeklyResetAt: "2026-09-09T00:00:00.000Z",
					exhaustedUntil: null,
					authUnusable: false,
					subscriptionStatus: "canceled" as const,
					detailObservedAt: "2026-09-18T00:41:00.000Z",
					usageStatus: "forbidden:oauth_not_allowed_for_organization",
					prepaid: { known: false, cards: null },
				},
			],
		},
		codex: {
			source: null,
			unavailable: ["structural: codex_no_usage_api"],
		},
	};
}

describe("account quota shared view", () => {
	it("uses machine values first, explicit manual fallbacks second, and preserves missing cells", () => {
		const view = buildAccountQuotaView(
			{ generatedAt, quota: quota() },
			{
				claudeEmails: {
					shopping: "shop<owner>@example.com",
					business: "business@example.com",
				},
			},
		);

		const shopping = view.claude.find((row) => row.name === "shopping")!;
		expect(shopping.weeklyUsage).toMatchObject({
			display: "24%",
			source: "machine",
			stale: false,
			rawValue: 24,
		});
		expect(shopping.fableUsage).toMatchObject({
			display: "79%",
			source: "manual",
			stale: true,
		});
		expect(shopping.fableUsage).not.toHaveProperty("rawValue");
		expect(shopping.weeklyReset).toMatchObject({
			rawInstant: "2026-09-22T16:00:00.000Z",
		});
		expect(shopping.fiveHReset.display).toContain("19:00");
		expect(shopping.subscriptionTier).toMatchObject({
			display: "Max 20x",
			source: "machine",
			// FLY-2830: dated by its own detail reading, not the page time.
			observedAt: "2026-09-18T00:41:00.000Z",
		});
		// FLY-2864: prepaid tranches are no longer shown; without reset-card
		// facts the cell names why it cannot read them.
		expect(shopping.credits).toMatchObject({
			display: "读不到（接口未返回）",
		});
		expect(
			view.claude.find((row) => row.name === "business")?.subscriptionTier,
		).toMatchObject({ display: "Pro", source: "machine" });
		expect(
			view.claude.find((row) => row.name === "business")?.credits,
		).toMatchObject({
			display: "1 张\n#1 到期 10/15 17:00\n确认人 founder",
			source: "manual",
		});
		const canceled = view.claude.find((row) => row.name === "personal1")!;
		expect(canceled.subscriptionTier.display).toBe("已取消");
		expect(canceled.fiveHReset.display).toBe("已取消");
		expect(canceled.fableReset.display).toBe("已取消");
		expect(canceled.weeklyUsage.display).toBe("已取消");
		expect(canceled.fableUsage.display).toBe("已取消");
		expect(canceled.credits.display).toBe("已取消");
		expect(canceled.expiry.display).toBe("已取消");
		expect(canceled.weeklyUsage.display).not.toContain("70%");
		expect(canceled.weeklyReset).toMatchObject({
			display: "已取消",
			rawInstant: "2026-09-09T00:00:00.000Z",
		});

		const school = view.claude.find((row) => row.name === "school")!;
		expect(school.accountMissing).toBe(true);
		expect(school.weeklyReset.source).toBe("missing");
		expect(school.weeklyUsage).toMatchObject({
			display: "0%",
			source: "manual",
		});
		expect(school.weeklyUsage).not.toHaveProperty("rawValue");
		expect(school.subscriptionTier).toMatchObject({
			display: "未知",
			source: "missing",
		});

		expect(view.codex).toEqual([]);
		expect(view.codexSourceLabel).toBe("无数值源");
		expect(view.discrepancies).toEqual(
			expect.arrayContaining([
				expect.stringContaining("shopping 周用量：机器 24% / 手填 80%"),
				expect.stringContaining("business 到期：机器 10/14 / 手填 10/16"),
			]),
		);
	});

	it("keeps aliases private in the simplified page and preserves the patrol tick", () => {
		const view = buildAccountQuotaView(
			{ generatedAt, quota: quota() },
			{ claudeEmails: { shopping: "shop<owner>@example.com" } },
		);
		const html = renderAccountsPageHtml(view);
		const visibleHtml = html.replace(/<style>[\s\S]*?<\/style>/, "");
		const sections = html.match(/<section class=[\s\S]*?<\/section>/g);

		expect(html).toContain("<th>周重置日</th>");
		expect(html).toContain("<th>5h reset</th>");
		expect(html).toContain("<th>Fable 周用量</th>");
		expect(html).toContain("<th>充值卡</th>");
		expect(html).not.toContain("79%");
		expect(html).not.toContain("@example.com");
		expect(html).not.toContain("shop&lt;owner&gt;");
		expect(visibleHtml).not.toContain("*");
		expect(html).not.toContain('<span class="active">');
		expect(html).not.toContain("<th>token 状态</th>");
		expect(sections).toHaveLength(2);
		expect(sections?.[0]?.match(/quota-row active-account/g)).toHaveLength(1);
		expect(sections?.[1]?.match(/quota-row active-account/g)).toBeNull();
		expect(html.match(/quota-row active-account/g)).toHaveLength(1);
		expect(html).toContain(
			".active-account td{background:var(--active-bg)!important}",
		);
		expect(html).toContain(
			".active-account td:first-child{box-shadow:inset 4px 0 0 var(--ok)}",
		);
		expect(html).toContain(".table-wrap{overflow-x:auto}");
		expect(html).toContain("table{width:100%;min-width:990px;");
		expect(html).toContain("@media(max-width:700px)");
		expect(html).not.toContain('class="reading stale"');
		expect(html).not.toContain("来源：");
		expect(html).not.toContain("读取于");
		expect(html).toContain("Max 20x");
		expect(html).toContain("本轮读数不可用");
		expect(html).not.toContain("机器值与手填值差异");

		const tick = formatAccountQuotaTickLines(view).join("\n");
		expect(tick).toContain("额度 Claude");
		expect(tick).toContain("★shopping");
		expect(tick).toMatch(/7d +24% +76%/);
		expect(tick).toMatch(/Fable +n\/a +n\/a/);
		expect(tick).not.toContain("到期 09-20");
		expect(tick).not.toContain("79%");
		expect(tick).toContain("Codex 无数值源");
	});

	it("does not let a stale canceled observation hide a recovered usage probe", () => {
		const value = quota();
		const personal1 = value.claude.accounts.find(
			(account) => account.name === "personal1",
		)!;
		personal1.usageStatus = "ok";
		personal1.detailObservedAt = "2026-09-17T00:00:00.000Z";
		const row = buildAccountQuotaView({
			generatedAt,
			quota: value,
		}).claude.find((account) => account.name === "personal1")!;

		expect(row.weeklyUsage).toMatchObject({
			display: "70%",
			source: "machine",
		});
		expect(row.subscriptionTier.display).not.toBe("已取消");
	});

	it("marks an old canceled observation stale", () => {
		const value = quota();
		const personal1 = value.claude.accounts.find(
			(account) => account.name === "personal1",
		)!;
		personal1.detailObservedAt = "2026-09-17T00:00:00.000Z";
		const row = buildAccountQuotaView({
			generatedAt,
			quota: value,
		}).claude.find((account) => account.name === "personal1")!;

		expect(row.weeklyUsage).toMatchObject({ display: "已取消", stale: true });
	});
});

const codexQuota = () => ({
	source: "codex-accounts.json" as const,
	activeAccount: "personal",
	staleAfterMinutes: 30,
	accounts: [
		{
			name: "personal",
			active: true,
			registeredProfile: "personal",
			planType: "pro",
			fiveHPct: 100,
			weeklyPct: 100,
			fiveHResetAt: "2026-09-18T02:00:00.000Z",
			weeklyResetAt: "2026-09-24T02:00:00.000Z",
			credits: {
				known: true,
				hasCredits: false,
				unlimited: false,
				balance: "0",
			},
			resetCredits: {
				known: true,
				value: null,
				availableCount: 0,
				credits: [],
			},
			observedAt: "2026-09-18T00:40:00.000Z",
			ageMinutes: 5,
			stale: false,
			exhausted: true,
			recoveryAt: "2026-09-24T02:00:00.000Z",
			authUnusable: false,
			note: null,
			unclassifiedWindows: 0,
			tokenState: "打满" as const,
		},
		{
			name: "personal1",
			active: false,
			registeredProfile: null,
			planType: "free",
			fiveHPct: 3,
			weeklyPct: 11,
			fiveHResetAt: "2026-09-18T01:00:00.000Z",
			weeklyResetAt: "2026-09-21T01:00:00.000Z",
			credits: {
				known: false,
				hasCredits: null,
				unlimited: null,
				balance: null,
			},
			resetCredits: {
				known: false,
				value: null,
				availableCount: null,
				credits: null,
			},
			observedAt: "2026-09-18T00:40:00.000Z",
			ageMinutes: 5,
			stale: false,
			exhausted: false,
			recoveryAt: null,
			authUnusable: false,
			note: null,
			unclassifiedWindows: 0,
			tokenState: "正常" as const,
		},
		{
			name: "shopping",
			active: false,
			registeredProfile: null,
			planType: "plus",
			fiveHPct: 8,
			weeklyPct: 12,
			fiveHResetAt: "2026-09-18T04:00:00.000Z",
			weeklyResetAt: "2026-09-23T04:00:00.000Z",
			credits: {
				known: true,
				hasCredits: true,
				unlimited: false,
				balance: "12.5",
			},
			resetCredits: {
				known: true,
				value: "2",
				availableCount: 2,
				credits: [
					{
						id: "shopping-card-1",
						status: "available",
						expiresAt: "2026-10-01T00:00:00.000Z",
					},
				],
			},
			observedAt: "2026-09-17T20:00:00.000Z",
			ageMinutes: 285,
			stale: true,
			exhausted: false,
			recoveryAt: null,
			authUnusable: false,
			note: "in_use_unshared",
			unclassifiedWindows: 0,
			tokenState: "在用未探" as const,
		},
	],
	unavailable: [] as string[],
});

describe("FLY-2688 — real Codex readings, ordering and exhaustion", () => {
	const snapshot = () => ({
		generatedAt,
		quota: { ...quota(), codex: codexQuota() },
	});

	it("builds Codex rows from machine readings instead of manual fallbacks", () => {
		const view = buildAccountQuotaView(snapshot());

		expect(view.codex.map((row) => row.name)).toEqual([
			"personal1",
			"shopping",
			"personal",
		]);
		const personal = view.codex.find((row) => row.name === "personal")!;
		expect(personal.weeklyUsage).toMatchObject({
			display: "100%",
			source: "machine",
			rawValue: 100,
		});
		expect(personal.weeklyReset).toMatchObject({
			source: "machine",
			rawInstant: "2026-09-24T02:00:00.000Z",
		});
		expect(personal.subscriptionTier).toMatchObject({
			display: "Pro",
			source: "machine",
		});
		expect(personal.credits).toMatchObject({
			display: "0 张",
			source: "machine",
		});
		expect(personal.active).toBe(true);
		expect(personal.exhausted).toBe(true);
		expect(personal.recovery?.display).toContain("09-23 19:00 PT");

		const shopping = view.codex.find((row) => row.name === "shopping")!;
		expect(shopping.credits.display).toBe(
			"2 张\n#1 到期 09/30 17:00\n还有 1 张，明细未给全",
		);
		expect(shopping.note).toBe("使用中，本次未读");
		expect(shopping.weeklyUsage.stale).toBe(true);

		const personal1 = view.codex.find((row) => row.name === "personal1")!;
		expect(personal1.credits).toMatchObject({
			display: "兑换卡未暴露",
			source: "missing",
		});
		expect(view.codexSourceLabel).toBe("机器读数 · account/rateLimits/read");
	});

	it("orders every family by the moment it next gets better, exhausted rows by recovery", () => {
		const view = buildAccountQuotaView(snapshot());

		expect(view.codex.map((row) => row.sortAt)).toEqual([
			"2026-09-18T01:00:00.000Z",
			"2026-09-18T04:00:00.000Z",
			"2026-09-24T02:00:00.000Z",
		]);
		expect(view.claude.map((row) => row.name)).toEqual([
			"shopping",
			"business",
			"personal",
			"personal1",
			"school",
		]);
		expect(view.claude.at(-1)?.sortAt).toBeNull();
	});

	it("marks exhausted rows red with a machine recovery moment", () => {
		const html = renderAccountsPageHtml(buildAccountQuotaView(snapshot()));

		expect(html).toContain("<th>兑换卡</th>");
		expect(html).toContain("<th>Fable 周用量</th>");
		expect(html).toContain('<tr class="quota-row active-account">');
		expect(html).toContain(
			'<span class="card-line">2 张</span><span class="card-line">#1 到期 09/30 17:00</span><span class="card-line">还有 1 张，明细未给全</span>',
		);
		expect(html).toContain(
			'.quota-group[data-group="full"] .quota-row td{background:var(--full-bg)}',
		);
		expect(html).not.toContain("恢复 ");
		expect(html).toContain("使用中，本次未读");
		expect(html).not.toContain("机器读数 · account/rateLimits/read");
		expect(html).toContain("兑换卡未暴露");
		expect(html).not.toContain("余额 12.5");
		expect(html).not.toContain("无数据 weekly;");
		// FLY-2864: the founder dropped the token-status column.
		expect(html).not.toContain("token 状态");
		expect(html).not.toContain('class="token-status"');
	});

	it("does not invent Codex rows while no machine source exists", () => {
		const view = buildAccountQuotaView({ generatedAt, quota: quota() });
		expect(view.codex).toEqual([]);
		expect(view.codexSourceLabel).toBe("无数值源");
	});

	it("projects Codex machine readings into the patrol tick, never manual ones", () => {
		const machine = formatAccountQuotaTickLines(
			buildAccountQuotaView(snapshot()),
		).join("\n");
		expect(machine).toContain("- Codex");
		expect(machine).toContain("personal");
		expect(machine).toMatch(/7d +100% +0%/);

		const manual = formatAccountQuotaTickLines(
			buildAccountQuotaView({ generatedAt, quota: quota() }),
		).join("\n");
		expect(manual).toContain("Codex 无数值源");
		expect(manual).not.toContain("8/3");
	});

	it("never calls an auth-dead Claude account capped", () => {
		const quotaValue = quota();
		const business = quotaValue.claude.accounts.find(
			(account) => account.name === "business",
		)!;
		business.authUnusable = true;
		const view = buildAccountQuotaView({
			generatedAt,
			quota: quotaValue,
		});

		const row = view.claude.find((account) => account.name === "business")!;
		expect(row).toMatchObject({
			exhausted: false,
			unusable: true,
			recovery: null,
			note: "凭据不可用，需人工处理",
			sortAt: null,
		});

		const html = renderAccountsPageHtml(view);
		expect(html).toContain("凭据不可用，需人工处理");
		// The snapshot flag also covers an operator bench mark, so the page must
		// not tell the founder to re-log in.
		expect(html).not.toContain("需重新登录");
		expect(html).not.toContain("打满 · 恢复时刻未知");
		expect(html).not.toContain('class="exhausted-account"');
		expect(html).toContain('data-group="available"');
	});

	it("says an unknown recovery moment once, not twice", () => {
		const quotaValue = quota();
		const business = quotaValue.claude.accounts.find(
			(account) => account.name === "business",
		)!;
		business.sevenDPct = 100;
		business.weeklyResetAt = null;
		const html = renderAccountsPageHtml(
			buildAccountQuotaView({ generatedAt, quota: quotaValue }),
		);

		expect(html).toContain('data-group="full"');
		expect(html).not.toContain("恢复时刻未知");
		expect(html).not.toContain("恢复 ");
	});

	it("keeps a failed Codex credential read visibly unusable", () => {
		const value = codexQuota();
		Object.assign(value.accounts[1], {
			authUnusable: true,
			note: "read_failed",
			tokenState: "未探",
		});
		const view = buildAccountQuotaView({
			generatedAt,
			quota: { ...quota(), codex: value },
		});
		const row = view.codex.find((account) => account.name === "personal1")!;
		expect(row).toMatchObject({
			unusable: true,
			sortAt: null,
			note: "本次读取失败",
			tokenStatus: { display: "未探" },
		});
		expect(renderAccountsPageHtml(view)).toContain("本次读取失败");
	});
});

describe("FLY-2869 — stale Codex readings are unknown in the view and the tick", () => {
	it("uses the Codex threshold for Codex rows, not the Claude one", () => {
		const claudeValue = quota();
		claudeValue.claude.staleAfterMinutes = 120;
		const value = codexQuota();
		value.staleAfterMinutes = 30;
		Object.assign(value.accounts[0], {
			// 35 minutes before generatedAt: stale for Codex, fresh for Claude's 120.
			// Quota and cards read together (FLY-2830: cards older than the quota
			// reading are the in-use carry and render a reason instead).
			observedAt: "2026-09-18T00:10:00.000Z",
			resetCreditsObservedAt: "2026-09-18T00:10:00.000Z",
		});
		const view = buildAccountQuotaView({
			generatedAt,
			quota: { ...claudeValue, codex: value },
		});
		expect(view.staleAfterMinutes).toBe(120);
		expect(
			view.codex.find((row) => row.name === "personal")?.credits.stale,
		).toBe(true);
	});

	it("rejects a Codex block with an invalid threshold", () => {
		for (const staleAfterMinutes of [0, -1, Number.NaN]) {
			const value = codexQuota();
			value.staleAfterMinutes = staleAfterMinutes;
			expect(() =>
				buildAccountQuotaView({
					generatedAt,
					quota: { ...quota(), codex: value },
				}),
			).toThrow("invalid Codex quota snapshot");
		}
	});

	it("labels stale and reset-elapsed rows instead of calling them exhausted", () => {
		const value = codexQuota();
		Object.assign(value.accounts[0], {
			fiveHPct: null,
			weeklyPct: null,
			fiveHResetAt: null,
			weeklyResetAt: "2026-09-24T02:00:00.000Z",
			ageMinutes: 360,
			stale: true,
			freshness: "stale",
			exhausted: false,
			recoveryAt: null,
			tokenState: "读数过期",
		});
		Object.assign(value.accounts[1], {
			weeklyPct: null,
			weeklyResetAt: null,
			freshness: "reset_elapsed",
			exhausted: false,
			recoveryAt: null,
			tokenState: "已过重置待探",
		});
		const view = buildAccountQuotaView({
			generatedAt,
			quota: { ...quota(), codex: value },
		});
		const tick = formatAccountQuotaTickLines(view).join("\n");
		expect(tick).toContain(
			"**★personal** · 读数过期\n```text\nwindow  used   left   reset (PT)\n5h      n/a    n/a    n/a\n7d      n/a    n/a    09-23 Wed 19:00\n```\n观测：360m 前 (stale)",
		);
		expect(tick).toContain("**personal1** · 已过重置待探\n");
		expect(tick).not.toContain("· 打满");
		expect(view.warnings).toEqual(
			expect.arrayContaining([
				"Codex personal：读数过期（360 分钟前），不作打满/可用判断",
				"Codex personal1：已过重置、待真探，不作打满判断",
			]),
		);
	});
});

// ---------------------------------------------------------------------------
// FLY-2864 — reset cards, live tier, next charge date
// ---------------------------------------------------------------------------

describe("FLY-2864 — patrol tick is untouched", () => {
	it("prints exactly what the pre-2864 view printed for the same snapshot", () => {
		const value = quota();
		const view = buildAccountQuotaView({
			generatedAt,
			quota: { ...value, codex: codexQuota() },
		});
		// Captured from the main-branch build before this change.
		expect(formatAccountQuotaTickLines(view)).toEqual([
			"- 额度 Claude",
			"**★shopping**\n```text\nwindow  used   left   reset (PT)\n5h      10%    90%    09-17 Thu 19:00\n7d      24%    76%    09-22 Tue 09:00\nFable   n/a    n/a    n/a\n```\n观测：5m 前\n\n**business** · 到期 10-14\n```text\nwindow  used   left   reset (PT)\n5h      2%     98%    n/a\n7d      7%     93%    09-19 Sat 09:00\nFable   2%     98%    09-19 Sat 09:00\n```\n观测：165m 前 (stale)\n\n**personal1** · 到期 已取消\n```text\nwindow  used   left   reset (PT)\n5h      n/a    n/a    已取消\n7d      n/a    n/a    已取消\nFable   n/a    n/a    已取消\n```\n观测：13000m 前",
			"- Codex 机器读数 · account/rateLimits/read",
			"**personal1**\n```text\nwindow  used   left   reset (PT)\n5h      3%     97%    09-17 Thu 18:00\n7d      11%    89%    09-20 Sun 18:00\n```\n观测：5m 前\n\n**shopping**\n```text\nwindow  used   left   reset (PT)\n5h      8%     92%    09-17 Thu 21:00\n7d      12%    88%    09-22 Tue 21:00\n```\n观测：285m 前 (stale)\n\n**★personal** · 打满\n```text\nwindow  used   left   reset (PT)\n5h      100%   0%     09-17 Thu 19:00\n7d      100%   0%     09-23 Wed 19:00\n```\n观测：5m 前",
		]);
	});
});

const NOW_2864 = "2026-09-24T23:30:00.000Z";

type ClaudeFixture = ReturnType<typeof quota>["claude"]["accounts"][number] &
	Record<string, unknown>;

function claudeAccount(
	name: string,
	extra: Record<string, unknown> = {},
): ClaudeFixture {
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
		observedAt: "2026-09-24T23:20:00.000Z",
		ageMinutes: 10,
		stale: false,
		fiveHResetAt: "2026-09-25T02:00:00.000Z",
		weeklyResetAt: "2026-09-29T16:00:00.000Z",
		fableWeeklyResetAt: "2026-09-29T16:00:00.000Z",
		exhaustedUntil: null,
		authUnusable: false,
		subscriptionStatus: "active",
		detailObservedAt: "2026-09-24T23:25:00.000Z",
		usageStatus: "ok",
		prepaid: { known: true, cards: null },
		...extra,
	} as ClaudeFixture;
}

function claudeView(
	accounts: ClaudeFixture[],
	subscriptionManual?: Parameters<
		typeof buildAccountQuotaView
	>[1] extends infer O
		? O extends { subscriptionManual?: infer M }
			? M
			: never
		: never,
) {
	return buildAccountQuotaView(
		{
			generatedAt: NOW_2864,
			quota: {
				claude: {
					source: "claude-accounts.json" as const,
					activeAccount: null,
					staleAfterMinutes: 30,
					accounts: accounts as never,
				},
				codex: {
					source: null,
					unavailable: ["structural: codex_no_usage_api"],
				},
			},
		},
		subscriptionManual ? { subscriptionManual } : {},
	);
}

const grants = (...list: Array<[number, number, string | null]>) => ({
	known: true,
	reason: null,
	grants: list.map(([resetsLeft, resetsTotal, endsAt]) => ({
		resetsLeft,
		resetsTotal,
		endsAt,
	})),
});

describe("FLY-2864 — Claude reset-card cell", () => {
	const cardsOf = (extra: Record<string, unknown>) =>
		claudeView([claudeAccount("business", extra)]).claude.find(
			(row) => row.name === "business",
		)!.credits;

	it("lists each usable card with its own expiry", () => {
		expect(
			cardsOf({
				resetGrants: grants([1, 1, "2026-10-22T16:00:00.000Z"]),
			}),
		).toMatchObject({
			display: "1 张\n#1 到期 10/22 09:00",
			source: "machine",
			observedAt: "2026-09-24T23:25:00.000Z",
		});
		expect(
			cardsOf({
				resetGrants: grants([2, 2, "2026-10-22T16:00:00.000Z"], [1, 1, null]),
			}).display,
		).toBe("2 张\n#1 到期 10/22 09:00 · 剩 2 次\n#2 到期未知");
	});

	it("does not count spent or expired cards and says 0 only when known", () => {
		expect(
			cardsOf({
				resetGrants: grants(
					[0, 1, "2026-10-22T16:00:00.000Z"],
					[1, 1, "2026-09-20T00:00:00.000Z"],
					[1, 1, "2026-11-02T16:00:00.000Z"],
				),
			}).display,
		).toBe("1 张\n#1 到期 11/02 08:00");
		expect(cardsOf({ resetGrants: grants() }).display).toBe("0 张");
		expect(
			cardsOf({
				resetGrants: { known: true, reason: "no_grant", grants: [] },
			}).display,
		).toBe("0 张");
	});

	it("names why cards cannot be read instead of guessing", () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[
				{
					resetGrants: { known: false, reason: "surface", grants: null },
				},
				"读不到（Claude Code 版本未识别）",
			],
			[
				{
					resetGrants: { known: false, reason: "cli_version", grants: null },
				},
				"读不到（Claude Code 版本未识别）",
			],
			[
				{
					resetGrants: {
						known: false,
						reason: "cli_version_unknown",
						grants: null,
					},
				},
				"读不到（Claude Code 版本未识别）",
			],
			[
				{
					resetGrants: { known: false, reason: "deadline", grants: null },
				},
				"读不到（本轮超时）",
			],
			[
				{
					resetGrants: { known: false, reason: "forbidden", grants: null },
				},
				"读不到（接口拒绝）",
			],
			[
				{
					resetGrants: { known: false, reason: "network", grants: null },
				},
				"读不到（接口未返回）",
			],
			[
				{
					resetGrants: { known: false, reason: "absent", grants: null },
				},
				"读不到（接口未返回）",
			],
			[
				{
					resetGrants: { known: false, reason: "tier", grants: null },
				},
				"读不到（接口未返回）",
			],
			// No resetGrants at all: the usage status is the reason.
			[{ usageStatus: "deadline" }, "读不到（本轮超时）"],
			[{ usageStatus: "ok" }, "读不到（接口未返回）"],
			[
				{
					subscriptionStatus: undefined,
					detailObservedAt: undefined,
					usageStatus: undefined,
					prepaid: undefined,
				},
				"读不到（接口未返回）",
			],
		];
		for (const [extra, display] of cases) {
			expect(cardsOf(extra).display).toBe(display);
			expect(cardsOf(extra).display).not.toContain("明细未提供");
		}
	});

	it("does not vouch for carried cards once the token is dead or refused", () => {
		const history = grants([1, 1, "2026-10-22T16:00:00.000Z"]);
		expect(
			cardsOf({ usageStatus: "unauthorized", resetGrants: history }).display,
		).toBe("读不到（token 已失效，需重登）");
		expect(cardsOf({ usageStatus: "unauthorized" }).display).toBe(
			"读不到（token 已失效，需重登）",
		);
		expect(
			cardsOf({
				usageStatus: "forbidden:oauth_not_allowed_for_organization",
				resetGrants: history,
			}).display,
		).toBe("读不到（接口拒绝）");
		// A deadline or network blip keeps showing the carried cards.
		expect(
			cardsOf({ usageStatus: "deadline", resetGrants: history }).display,
		).toBe("1 张\n#1 到期 10/22 09:00");
	});

	it("keeps the manual card fallback and the canceled row as before", () => {
		expect(
			cardsOf({
				resetGrants: { known: false, reason: "absent", grants: null },
				manualPrepaid: {
					account: "business",
					confirmedBy: "founder",
					confirmedAt: "2026-09-24T00:00:00.000Z",
					cards: [{ expiresAt: "2026-10-16T00:00:00.000Z" }],
				},
			}).display,
		).toBe("1 张\n#1 到期 10/15 17:00\n确认人 founder");
		const canceled = claudeView([
			claudeAccount("personal1", {
				subscriptionStatus: "canceled",
				usageStatus: "forbidden:oauth_not_allowed_for_organization",
				resetGrants: grants([1, 1, "2026-10-22T16:00:00.000Z"]),
			}),
		]).claude.find((row) => row.name === "personal1")!;
		expect(canceled.credits.display).toBe("已取消");
	});

	it("shows the live tier as the tier, with no confirmation wording", () => {
		const row = claudeView([claudeAccount("business")]).claude.find(
			(r) => r.name === "business",
		)!;
		expect(row.subscriptionTier.display).toBe("Max 20x");
	});
});

describe("FLY-2864 — Claude next charge date", () => {
	const KEY = "a".repeat(64);
	const confirmation = (
		profile: string,
		status: "active" | "canceled" | "unknown",
		expiresOn: string | null,
	) => ({
		provider: "Claude" as const,
		profile,
		identityKey: KEY,
		status,
		expiresOn,
		confirmedBy: "founder",
		confirmedAt: "2026-09-24T18:00:00.000Z",
		sourceRef: "FLY-2792#founder-confirmation",
	});

	it("without a receipt reading says so, and shows cancellation when known", () => {
		const failures: unknown[] = [];
		const view = claudeView(
			[
				claudeAccount("business"),
				claudeAccount("personal1", {
					subscriptionStatus: "canceled",
					usageStatus: "forbidden:oauth_not_allowed_for_organization",
				}),
				claudeAccount("manual-canceled"),
				claudeAccount("manual-canceled-undated"),
				claudeAccount("manual-active"),
				claudeAccount("manual-mismatch"),
			],
			{
				confirmations: [
					confirmation("manual-canceled", "canceled", "2026-10-05"),
					confirmation("manual-canceled-undated", "canceled", null),
					confirmation("manual-active", "active", null),
					confirmation("manual-mismatch", "canceled", "2026-10-05"),
				],
				identityKeys: {
					"Claude:manual-canceled": KEY,
					"Claude:manual-canceled-undated": KEY,
					"Claude:manual-active": KEY,
					"Claude:manual-mismatch": "b".repeat(64),
				},
				onResolutionError: (failure) => failures.push(failure),
			},
		);
		const next = Object.fromEntries(
			view.claude.map((row) => [row.name, row.nextCharge.display]),
		);
		expect(next).toMatchObject({
			business: "读不到（收据还没读过）",
			personal1: "已取消",
			"manual-canceled": "已取消 · 10/05 周一 到期",
			"manual-canceled-undated": "已取消",
			"manual-active": "读不到（收据还没读过）",
			"manual-mismatch": "读不到（收据还没读过）",
		});
		expect(failures).toEqual([
			{
				provider: "Claude",
				profile: "manual-mismatch",
				error: "identity_mismatch",
			},
		]);
		for (const row of view.claude) {
			expect(row.nextCharge.display.length).toBeGreaterThan(0);
		}
	});
});

describe("FLY-2864 — Codex next charge date", () => {
	function codexView(
		subscriptions: Record<string, unknown>,
		subscriptionManual?: Parameters<typeof buildAccountQuotaView>[1],
	) {
		const value = codexQuota();
		for (const account of value.accounts) {
			const subscription = subscriptions[account.name];
			if (subscription !== undefined) {
				(account as Record<string, unknown>).subscription = subscription;
			}
		}
		return buildAccountQuotaView(
			{ generatedAt: NOW_2864, quota: { ...quota(), codex: value } },
			subscriptionManual,
		);
	}
	const sub = (extra: Record<string, unknown>) => ({
		status: "active",
		renewsAt: null,
		endsAt: null,
		observedAt: "2026-09-24T23:30:00.000Z",
		note: null,
		...extra,
	});
	const nextOf = (view: ReturnType<typeof codexView>) =>
		Object.fromEntries(
			view.codex.map((row) => [row.name, row.nextCharge.display]),
		);

	it("shows the renewal date in Pacific time with the weekday", () => {
		expect(
			nextOf(
				codexView({
					personal: sub({ renewsAt: "2026-10-23T03:59:39.000Z" }),
					personal1: sub({
						renewsAt: "2026-10-19T04:02:27.000Z",
						note: "unauthorized",
					}),
				}),
			),
		).toEqual({
			personal: "10/22 周四",
			personal1: "10/18 周日",
			shopping: "读不到（接口未返回）",
		});
	});

	it("never shows a past date as the next charge", () => {
		expect(
			nextOf(
				codexView({
					personal: sub({ renewsAt: "2026-09-24T06:00:00.000Z" }),
					personal1: sub({ renewsAt: "2026-09-25T06:00:00.000Z" }),
				}),
			),
		).toMatchObject({
			// 09/23 23:00 PT is yesterday; 09/24 23:00 PT is still today.
			personal: "读不到（读数已过期）",
			personal1: "09/24 周四",
		});
	});

	it("never shows a cancellation whose end date has passed", () => {
		expect(
			nextOf(
				codexView({
					// Carried from an older round (this round failed): stale.
					personal: sub({
						status: "canceled",
						endsAt: "2026-09-20T04:00:00.000Z",
						observedAt: "2026-09-10T00:00:00.000Z",
						note: "network",
					}),
					// Carried but still in the future: shown.
					personal1: sub({
						status: "canceled",
						endsAt: "2026-10-19T04:02:27.000Z",
						observedAt: "2026-09-10T00:00:00.000Z",
						note: "blocked",
					}),
					// A kept old store has note:null too (the whole read failed):
					// a past end day is never shown, whatever the note says.
					shopping: sub({
						status: "canceled",
						endsAt: "2026-09-20T04:00:00.000Z",
						observedAt: "2026-09-10T00:00:00.000Z",
					}),
				}),
			),
		).toEqual({
			personal: "读不到（读数已过期）",
			personal1: "已取消 · 10/18 周日 到期",
			shopping: "读不到（读数已过期）",
		});
	});

	it("shows cancellation, no subscription and each read failure distinctly", () => {
		const view = codexView({
			personal: sub({
				status: "canceled",
				endsAt: "2026-10-19T04:02:27.000Z",
			}),
			personal1: sub({ status: "canceled" }),
			shopping: sub({ status: "none" }),
		});
		expect(nextOf(view)).toEqual({
			personal: "已取消 · 10/18 周日 到期",
			personal1: "已取消",
			shopping: "读不到（无有效订阅）",
		});
		const unknown = (note: string) =>
			sub({ status: "unknown", observedAt: null, note });
		expect(
			nextOf(
				codexView({
					personal: unknown("unauthorized"),
					personal1: unknown("blocked"),
					shopping: unknown("identity_mismatch"),
				}),
			),
		).toEqual({
			personal: "读不到（token 已失效）",
			personal1: "读不到（接口被拦）",
			shopping: "读不到（身份不符）",
		});
		expect(
			nextOf(
				codexView({
					personal: unknown("problem:invalid_credential"),
					personal1: unknown("network"),
					shopping: unknown("malformed"),
				}),
			),
		).toEqual({
			personal: "读不到（账号目录异常）",
			personal1: "读不到（接口未返回）",
			shopping: "读不到（接口未返回）",
		});
	});

	it("uses a manual cancellation only when the machine has no reading", () => {
		const KEY = "c".repeat(64);
		const manual = (profile: string, status: "active" | "canceled") => ({
			provider: "Codex" as const,
			profile,
			identityKey: KEY,
			status,
			expiresOn: status === "canceled" ? "2026-10-14" : null,
			confirmedBy: "founder",
			confirmedAt: "2026-09-24T18:00:00.000Z",
			sourceRef: "FLY-2792#founder-confirmation",
		});
		const view = codexView(
			{ personal: sub({ renewsAt: "2026-10-23T03:59:39.000Z" }) },
			{
				subscriptionManual: {
					confirmations: [
						manual("personal", "canceled"),
						manual("personal1", "canceled"),
						manual("shopping", "active"),
					],
					identityKeys: {
						"Codex:personal": KEY,
						"Codex:personal1": KEY,
						"Codex:shopping": KEY,
					},
				},
			},
		);
		expect(nextOf(view)).toEqual({
			personal: "10/22 周四",
			personal1: "已取消 · 10/14 周三 到期",
			shopping: "读不到（接口未返回）",
		});
	});
});

describe("FLY-2830 — presentation: card minutes, reading times, reasons", () => {
	const base = () => ({
		generatedAt,
		quota: { ...quota(), codex: codexQuota() },
	});
	const withCodex = (name: string, patch: Record<string, unknown>) => {
		const snapshot = base();
		snapshot.quota.codex.accounts = snapshot.quota.codex.accounts.map(
			(account) =>
				account.name === name ? ({ ...account, ...patch } as never) : account,
		);
		return snapshot;
	};
	const codexRow = (snapshot: ReturnType<typeof base>, name: string) =>
		buildAccountQuotaView(snapshot).codex.find((row) => row.name === name)!;

	it("shows every card expiry to the Pacific minute", () => {
		const row = codexRow(
			withCodex("shopping", {
				resetCredits: {
					known: true,
					value: "2",
					availableCount: 2,
					credits: [
						{
							id: "a",
							status: "available",
							expiresAt: "2026-10-22T20:22:00.000Z",
						},
						{
							id: "b",
							status: "available",
							expiresAt: "2026-10-22T20:40:00.000Z",
						},
					],
				},
			}),
			"shopping",
		);
		expect(row.credits.display).toBe(
			"2 张\n#1 到期 10/22 13:22\n#2 到期 10/22 13:40",
		);
	});

	it("names why the occupancy inventory skipped an account", () => {
		expect(
			codexRow(
				withCodex("shopping", {
					note: "inventory_unavailable",
					noteDetail: "canonical_identity_unreadable",
				}),
				"shopping",
			).note,
		).toBe(
			"占用盘点失败（canonical_identity_unreadable），本次未读，沿用 13:00 读数",
		);
		expect(
			codexRow(
				withCodex("shopping", {
					note: "inventory_unavailable",
					observedAt: "2026-09-18T00:30:00.000Z",
				}),
				"shopping",
			).note,
		).toBe("占用盘点失败，本次未读，沿用 17:30 读数");
		expect(
			codexRow(
				withCodex("shopping", {
					note: "inventory_unavailable",
					noteDetail: "guard_failed",
					observedAt: null,
				}),
				"shopping",
			).note,
		).toBe("占用盘点失败（guard_failed），本次未读，从未读到");
	});

	it("says which HTTP refusal stopped a readonly read", () => {
		expect(
			codexRow(
				withCodex("shopping", { note: "readonly_forbidden" }),
				"shopping",
			).note,
		).toBe("被 chatgpt.com 拒绝（HTTP 403）");
		expect(
			codexRow(
				withCodex("shopping", { note: "readonly_unauthorized" }),
				"shopping",
			).note,
		).toBe("只读凭据已过期（HTTP 401）");
	});

	it("escapes a hostile noteDetail on the rendered page", () => {
		const html = renderAccountsPageHtml(
			buildAccountQuotaView(
				withCodex("shopping", {
					note: "inventory_unavailable",
					noteDetail: "<script>x</script>",
				}),
			),
		);
		expect(html).not.toContain("<script>x");
		expect(html).toContain("&lt;script&gt;");
	});

	it("says the Claude receipts were not read yet without a receipt reading", () => {
		const view = buildAccountQuotaView(base());
		expect(
			view.claude.find((row) => row.name === "shopping")!.nextCharge.display,
		).toBe("读不到（收据还没读过）");
		expect(
			view.claude.find((row) => row.name === "personal1")!.nextCharge.display,
		).toBe("已取消");
	});

	it("carries each row's data-source reading times", () => {
		const snapshot = withCodex("shopping", {
			resetCreditsObservedAt: "2026-09-17T19:00:00.000Z",
			subscription: {
				status: "none",
				renewsAt: null,
				endsAt: null,
				observedAt: "2026-09-18T00:44:00.000Z",
				note: null,
			},
		});
		const view = buildAccountQuotaView(snapshot);
		// Cards older than the quota reading = the in-use WHAM carry (rework O2):
		// the cell states the reason, dated like the quota reading.
		expect(view.codex.find((row) => row.name === "shopping")!.sources).toEqual({
			provider: "Codex",
			quota: "2026-09-17T20:00:00.000Z",
			resetCredits: "2026-09-17T20:00:00.000Z",
			subscription: "2026-09-18T00:44:00.000Z",
		});
		expect(view.codex.find((row) => row.name === "personal")!.sources).toEqual({
			provider: "Codex",
			quota: "2026-09-18T00:40:00.000Z",
			resetCredits: "2026-09-18T00:40:00.000Z",
			subscription: null,
		});
		expect(view.claude.find((row) => row.name === "shopping")!.sources).toEqual(
			{
				provider: "Claude",
				usage: "2026-09-18T00:40:00.000Z",
				detail: "2026-09-18T00:41:00.000Z",
				// FLY-2897: no receipt reading, so the detail dates the next charge.
				charge: "2026-09-18T00:41:00.000Z",
			},
		);
		// The Claude tier cell is dated by its own detail reading now.
		expect(
			view.claude.find((row) => row.name === "shopping")!.subscriptionTier
				.observedAt,
		).toBe("2026-09-18T00:41:00.000Z");
	});

	it("exempts a Claude account the operator marked unavailable", () => {
		const snapshot = base();
		(snapshot.quota.claude as { unavailable?: string[] }).unavailable = [
			"structural: account_unavailable:business",
		];
		const view = buildAccountQuotaView(snapshot);
		expect(
			view.claude.find((row) => row.name === "business")!.sources,
		).toBeUndefined();
		expect(
			view.claude.find((row) => row.name === "shopping")!.sources,
		).toBeDefined();
	});
});

describe("FLY-2830 rework — canceled and in-use-carried cells are not 'pending refresh'", () => {
	const base = () => ({
		generatedAt,
		quota: { ...quota(), codex: codexQuota() },
	});

	it("O1: exempts a canceled Claude account whose usage can no longer be read", () => {
		const view = buildAccountQuotaView(base());
		const personal1 = view.claude.find((row) => row.name === "personal1")!;
		expect(personal1.weeklyUsage.display).toBe("已取消");
		expect(personal1.sources).toBeUndefined();
		const html = renderAccountsPageHtml(view, undefined, {
			lastSwitch: { at: "2026-09-18T00:30:00.000Z", vendor: "Codex" },
		});
		const personal1Row =
			html
				.split("</tr>")
				.find(
					(tr) => tr.includes(">personal1</div>") && tr.includes("已取消"),
				) ?? "";
		expect(personal1Row).not.toContain("switch-stale");
	});

	it("O2: says why an in-use account's reset cards were not re-read instead of showing the carried list", () => {
		const snapshot = base();
		snapshot.quota.codex.accounts = snapshot.quota.codex.accounts.map(
			(account) =>
				account.name === "personal"
					? ({
							...account,
							resetCredits: {
								known: true,
								value: "1",
								availableCount: 1,
								credits: [
									{
										id: "old-card",
										status: "available",
										expiresAt: "2026-10-22T20:22:00.000Z",
									},
								],
							},
							// carried from a read before the in-use WHAM reading
							resetCreditsObservedAt: "2026-09-17T05:48:00.000Z",
						} as never)
					: account,
		);
		const row = buildAccountQuotaView(snapshot).codex.find(
			(r) => r.name === "personal",
		)!;
		expect(row.credits.display).toBe(
			"读不到（在用中，只读接口不给兑换卡明细）",
		);
		expect(row.credits.display).not.toContain("10/22");
		expect(row.sources).toMatchObject({
			provider: "Codex",
			resetCredits: "2026-09-18T00:40:00.000Z",
		});
	});
});

describe("FLY-2897 — Claude next charge from the receipt mailbox", () => {
	type Reading =
		import("../../claude-quota/charge-receipt-store.js").ClaudeChargeReading;
	type Facts =
		import("../../claude-quota/charge-receipt-store.js").ClaudeChargeFacts;
	const READ_AT = "2026-09-24T23:20:00.000Z";
	const mailbox = (name: string) => `${name}@example.com`;
	const keyOf = (name: string) =>
		createHash("sha256").update(mailbox(name)).digest("hex");
	const FACTS: Facts = {
		periodStart: "2026-09-16",
		periodEnd: "2026-10-16",
		paidOn: "2026-09-16",
		amountCents: 20001,
		receiptCount: 2,
		receiptAt: "2026-09-17T00:05:00.000Z",
		canceledAt: null,
		resumedAt: null,
	};
	const reading = (name: string, extra: Partial<Reading> = {}): Reading => ({
		name,
		mailboxKey: keyOf(name),
		readAt: READ_AT,
		status: "ok",
		reason: null,
		facts: FACTS,
		lastGood: null,
		...extra,
	});
	const failed = (
		name: string,
		status: Reading["status"],
		reason: Reading["reason"] = null,
		extra: Partial<Reading> = {},
	) => reading(name, { status, reason, facts: null, ...extra });

	function chargeView(
		accounts: ClaudeFixture[],
		readings: Reading[] | null,
		extra: Record<string, unknown> = {},
	) {
		return buildAccountQuotaView(
			{
				generatedAt: NOW_2864,
				quota: {
					claude: {
						source: "claude-accounts.json" as const,
						activeAccount: null,
						staleAfterMinutes: 30,
						accounts: accounts as never,
					},
					codex: {
						source: null,
						unavailable: ["structural: codex_no_usage_api"],
					},
				},
			},
			{
				claudeEmails: Object.fromEntries(
					accounts.map((account) => [account.name, mailbox(account.name)]),
				),
				claudeCharges:
					readings === null
						? null
						: { version: 1, generatedAt: READ_AT, accounts: readings },
				...extra,
			},
		);
	}
	const row = (view: ReturnType<typeof chargeView>, name: string) =>
		view.claude.find((r) => r.name === name)!;

	it("shows the receipt's period end as the next charge, with the period and amount", () => {
		const view = chargeView(
			[claudeAccount("business"), claudeAccount("shopping")],
			[
				reading("business"),
				reading("shopping", {
					facts: {
						...FACTS,
						periodStart: "2026-09-20",
						periodEnd: "2026-10-20",
						amountCents: null,
						receiptCount: 1,
					},
				}),
			],
		);
		expect(row(view, "business").nextCharge).toEqual({
			display: "10/16 周五\n本期 9/16–10/16 · 已付 $200.01",
			source: "machine",
			observedAt: READ_AT,
			stale: false,
		});
		expect(row(view, "business").receiptReadAt).toBe(READ_AT);
		expect(row(view, "shopping").nextCharge.display).toBe(
			"10/20 周二\n本期 9/20–10/20",
		);
	});

	it("never shows a charge day that has passed as the next one", () => {
		const past = {
			...FACTS,
			periodStart: "2026-08-23",
			periodEnd: "2026-09-23",
		};
		const view = chargeView(
			[claudeAccount("early"), claudeAccount("late")],
			[
				reading("early", { facts: past, readAt: "2026-09-23T20:00:00.000Z" }),
				reading("late", { facts: past, readAt: "2026-09-24T20:00:00.000Z" }),
			],
		);
		expect(row(view, "early").nextCharge).toMatchObject({
			display: "读不到（读数早于扣费日，待重读）",
			source: "missing",
		});
		expect(row(view, "late").nextCharge).toMatchObject({
			display: "读不到（09/23 周三 应扣费，未见新收据）",
			source: "missing",
		});
	});

	it("shows a cancellation from the mailbox with the day access ends", () => {
		const canceledAt = "2026-09-20T18:00:00.000Z";
		const view = chargeView(
			[claudeAccount("business"), claudeAccount("gone")],
			[
				reading("business", {
					status: "canceled",
					facts: { ...FACTS, canceledAt },
				}),
				reading("gone", {
					status: "canceled",
					facts: {
						...FACTS,
						periodStart: "2026-08-20",
						periodEnd: "2026-09-20",
						canceledAt: "2026-09-01T18:00:00.000Z",
					},
				}),
			],
		);
		expect(row(view, "business").nextCharge).toMatchObject({
			display: "已取消 · 10/16 周五 到期",
			source: "machine",
		});
		expect(row(view, "gone").nextCharge.display).toBe(
			"已取消 · 09/20 周日 已到期",
		);
	});

	it("keeps a cancellation the account detail saw after the latest receipt", () => {
		const view = chargeView(
			[
				claudeAccount("newer", {
					subscriptionStatus: "canceled",
					detailObservedAt: "2026-09-24T23:25:00.000Z",
				}),
				claudeAccount("older", {
					subscriptionStatus: "canceled",
					detailObservedAt: "2026-09-10T00:00:00.000Z",
				}),
				claudeAccount("resumed", {
					subscriptionStatus: "canceled",
					detailObservedAt: "2026-09-20T00:00:00.000Z",
				}),
			],
			[
				reading("newer"),
				reading("older"),
				reading("resumed", {
					facts: { ...FACTS, resumedAt: "2026-09-22T18:00:00.000Z" },
				}),
			],
		);
		expect(row(view, "newer").nextCharge.display).toBe(
			"已取消 · 10/16 周五 到期",
		);
		expect(row(view, "older").nextCharge.display).toBe(
			"10/16 周五\n本期 9/16–10/16 · 已付 $200.01",
		);
		expect(row(view, "resumed").nextCharge.display).toBe(
			"10/16 周五\n本期 9/16–10/16 · 已付 $200.01",
		);
	});

	it("says a free account has no charge", () => {
		const view = chargeView(
			[
				claudeAccount("personal1", {
					subscriptionStatus: "canceled",
					subscriptionTier: {
						subscriptionType: "free",
						rateLimitTier: "default_claude_ai",
					},
				}),
			],
			[failed("personal1", "auth_missing")],
		);
		expect(row(view, "personal1").nextCharge).toMatchObject({
			display: "免费号，无扣费",
			source: "machine",
			observedAt: "2026-09-24T23:25:00.000Z",
		});
		expect(row(view, "personal1").receiptReadAt).toBe(READ_AT);
	});

	it("takes free or paid only from the current account detail", () => {
		const free = { subscriptionType: "free", rateLimitTier: null };
		const view = chargeView(
			[
				// Now free, although the receipts still describe a paid period.
				claudeAccount("downgraded", { subscriptionTier: free }),
				// Free by a detail read before the receipt round finished: still
				// free — the round's finish time says nothing about the plan.
				claudeAccount("raced", {
					subscriptionTier: free,
					detailObservedAt: "2026-09-24T23:00:00.000Z",
				}),
				// Paid: the receipts decide, whatever an older round thought.
				claudeAccount("paid"),
			],
			[reading("downgraded"), reading("raced"), reading("paid")],
		);
		expect(row(view, "raced").nextCharge.display).toBe("免费号，无扣费");
		// Free is a fact of the current detail; an old mailbox's reading is moot.
		const moved = chargeView(
			[claudeAccount("personal1", { subscriptionTier: free })],
			[reading("personal1", { mailboxKey: keyOf("old") })],
		);
		expect(moved.claude[0]!.nextCharge.display).toBe("免费号，无扣费");
		expect(row(view, "downgraded").nextCharge).toMatchObject({
			display: "免费号，无扣费",
			source: "machine",
		});
		expect(row(view, "paid").nextCharge.display).toBe(
			"10/16 周五\n本期 9/16–10/16 · 已付 $200.01",
		);
	});

	it("never shows another mailbox's reading after the account's mailbox changed", () => {
		const view = chargeView(
			[claudeAccount("business"), claudeAccount("personal1")],
			[
				reading("business", {
					mailboxKey: keyOf("old-business"),
					lastGood: { readAt: READ_AT, status: "ok", facts: FACTS },
				}),
				failed("personal1", "auth_missing", null, {
					mailboxKey: keyOf("old"),
				}),
			],
		);
		for (const name of ["business", "personal1"]) {
			expect(row(view, name).nextCharge).toMatchObject({
				display: "读不到（邮箱已变更，待重读）",
				source: "missing",
			});
			expect(row(view, name).receiptReadAt).toBeNull();
			expect(row(view, name).sources).toMatchObject({ charge: null });
		}
	});

	it("keeps a newer detail 'active' from clearing a cancellation mail", () => {
		// Stripe keeps a cancel-at-period-end subscription active until it ends.
		const view = chargeView(
			[
				claudeAccount("business", {
					subscriptionStatus: "active",
					detailObservedAt: "2026-09-24T23:25:00.000Z",
				}),
			],
			[
				reading("business", {
					status: "canceled",
					facts: { ...FACTS, canceledAt: "2026-09-20T18:00:00.000Z" },
				}),
			],
		);
		expect(row(view, "business").nextCharge.display).toBe(
			"已取消 · 10/16 周五 到期",
		);
	});

	it("names the real reason a mailbox could not be read", () => {
		const cases: Array<[Reading["status"], Reading["reason"], string]> = [
			["no_mailbox", null, "读不到（账号没有登记邮箱）"],
			["auth_missing", null, "读不到（邮箱未授权 gog）"],
			[
				"auth_invalid",
				"invalid_grant",
				"读不到（邮箱授权失效 invalid_grant，需重新授权）",
			],
			["auth_invalid", "unauthorized", "读不到（邮箱授权失效，需重新授权）"],
			["no_receipt", null, "读不到（邮箱里没找到 Anthropic 收据）"],
			["parse_failed", null, "读不到（收据格式没认出）"],
			["read_failed", "timeout", "读不到（读邮箱超时）"],
			["read_failed", "gog_missing", "读不到（本机没装 gog）"],
			["read_failed", "rate_limited", "读不到（Gmail 限流）"],
			["read_failed", "retryable", "读不到（Gmail 暂时不可用）"],
			["read_failed", "permission_denied", "读不到（邮箱授权范围不够）"],
			["read_failed", "gog_config", "读不到（gog 凭据未配置）"],
			["read_failed", "output_too_large", "读不到（邮件太大）"],
			["read_failed", "malformed", "读不到（gog 返回格式不对）"],
			["read_failed", "not_found", "读不到（邮件已不存在）"],
			[
				"read_failed",
				"candidate_limit",
				"读不到（非订阅收据太多，没读到订阅收据）",
			],
			[
				"read_failed",
				"search_truncated",
				"读不到（Anthropic 邮件太多，没读完）",
			],
			["read_failed", "error", "读不到（读邮箱失败）"],
			["read_failed", null, "读不到（读邮箱失败）"],
		];
		for (const [status, reason, text] of cases) {
			const view = chargeView(
				[claudeAccount("school")],
				[failed("school", status, reason)],
			);
			expect(row(view, "school").nextCharge).toEqual({
				display: text,
				source: "missing",
				observedAt: READ_AT,
				stale: false,
			});
		}
	});

	it("carries a recent good reading through a failed round, saying so", () => {
		const view = chargeView(
			[claudeAccount("recent"), claudeAccount("old")],
			[
				failed("recent", "auth_invalid", "invalid_grant", {
					lastGood: {
						readAt: "2026-09-24T08:00:00.000Z",
						status: "ok",
						facts: FACTS,
					},
				}),
				failed("old", "read_failed", "timeout", {
					lastGood: {
						readAt: "2026-09-22T23:00:00.000Z",
						status: "ok",
						facts: FACTS,
					},
				}),
			],
		);
		expect(row(view, "recent").nextCharge).toEqual({
			display:
				"10/16 周五\n本期 9/16–10/16 · 已付 $200.01\n沿用 01:00 读数 · 本次读不到：邮箱授权失效 invalid_grant，需重新授权",
			source: "machine",
			observedAt: READ_AT,
			stale: false,
		});
		expect(row(view, "old").nextCharge.display).toBe("读不到（读邮箱超时）");
		const future = chargeView(
			[claudeAccount("future")],
			[
				failed("future", "read_failed", "timeout", {
					lastGood: {
						readAt: "2026-09-25T08:00:00.000Z",
						status: "ok",
						facts: FACTS,
					},
				}),
			],
		);
		expect(row(future, "future").nextCharge.display).toBe(
			"读不到（读邮箱超时）",
		);
	});

	it("falls back to the account detail without a receipt reading", () => {
		const view = chargeView(
			[
				claudeAccount("business"),
				claudeAccount("canceled", { subscriptionStatus: "canceled" }),
			],
			null,
		);
		expect(row(view, "business").nextCharge).toMatchObject({
			display: "读不到（收据还没读过）",
			source: "missing",
		});
		expect(row(view, "business").receiptReadAt).toBeNull();
		expect(row(view, "canceled").nextCharge.display).toBe("已取消");
		const failing = chargeView(
			[claudeAccount("canceled", { subscriptionStatus: "canceled" })],
			[failed("canceled", "auth_missing")],
		);
		expect(row(failing, "canceled").nextCharge.display).toBe("已取消");
	});

	it("keeps a founder-confirmed cancellation first", () => {
		const KEY = "a".repeat(64);
		const view = chargeView(
			[claudeAccount("business")],
			[reading("business")],
			{
				subscriptionManual: {
					confirmations: [
						{
							provider: "Claude" as const,
							profile: "business",
							identityKey: KEY,
							status: "canceled" as const,
							expiresOn: "2026-10-16",
							confirmedBy: "founder",
							confirmedAt: "2026-09-24T18:00:00.000Z",
							sourceRef: "FLY-2792#founder-confirmation",
						},
					],
					identityKeys: { "Claude:business": KEY },
				},
			},
		);
		expect(row(view, "business").nextCharge).toMatchObject({
			display: "已取消 · 10/16 周五 到期",
			source: "manual",
		});
		expect(row(view, "business").receiptReadAt).toBeUndefined();
	});

	it("dates the next-charge switch mark by the receipt reading", () => {
		const view = chargeView(
			[claudeAccount("business"), claudeAccount("unread")],
			[reading("business")],
		);
		expect(row(view, "business").sources).toEqual({
			provider: "Claude",
			usage: "2026-09-24T23:20:00.000Z",
			detail: "2026-09-24T23:25:00.000Z",
			charge: READ_AT,
		});
		// No receipt reading yet: the cell comes from the account detail.
		expect(row(view, "unread").sources).toMatchObject({
			charge: "2026-09-24T23:25:00.000Z",
		});
		expect(row(view, "unread").receiptReadAt).toBeNull();
	});
});
