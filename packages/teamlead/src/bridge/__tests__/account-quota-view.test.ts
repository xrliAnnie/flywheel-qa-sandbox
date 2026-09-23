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
		});
		expect(shopping.fableUsage).toMatchObject({
			display: "79%",
			source: "manual",
			stale: true,
		});
		expect(shopping.fiveHReset.display).toContain("19:00");
		expect(shopping.subscriptionTier).toMatchObject({
			display: "Max 20x",
			source: "machine",
			observedAt: generatedAt,
		});
		expect(
			view.claude.find((row) => row.name === "business")?.subscriptionTier,
		).toMatchObject({ display: "Pro", source: "machine" });

		const school = view.claude.find((row) => row.name === "school")!;
		expect(school.accountMissing).toBe(true);
		expect(school.weeklyReset.source).toBe("missing");
		expect(school.weeklyUsage).toMatchObject({
			display: "0%",
			source: "manual",
		});
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

	it("renders only account aliases, timestamps every value, and greys stale readings", () => {
		const view = buildAccountQuotaView(
			{ generatedAt, quota: quota() },
			{ claudeEmails: { shopping: "shop<owner>@example.com" } },
		);
		const html = renderAccountsPageHtml(view);
		const visibleHtml = html.replace(/<style>[\s\S]*?<\/style>/, "");
		const sections = html.match(/<section>[\s\S]*?<\/section>/g);

		expect(html).toContain("<th>周重置日</th>");
		expect(html).toContain("<th>5h reset</th>");
		expect(html).not.toContain("@example.com");
		expect(html).not.toContain("shop&lt;owner&gt;");
		expect(visibleHtml).not.toContain("*");
		expect(html).not.toContain('<span class="active">');
		expect(html).toContain("<th>token 状态</th>");
		expect(sections).toHaveLength(2);
		expect(sections?.[0]?.match(/<tr class="active-account/g)).toHaveLength(1);
		expect(sections?.[1]?.match(/<tr class="active-account/g)).toBeNull();
		expect(
			html.match(/<tr class="active-account(?: account-missing)?">/g),
		).toHaveLength(1);
		expect(html).toContain(".active-account td{background:var(--active-row)}");
		expect(html).toContain(
			".active-account td:first-child{box-shadow:inset 4px 0 0 var(--active-row-border)}",
		);
		expect(html).toContain(".table-wrap{overflow-x:auto;");
		expect(html).toContain("table{width:100%;min-width:990px;");
		expect(html).toContain("@media(max-width:700px)");
		expect(html).toContain('class="reading stale"');
		expect(html).toContain("来源：手填 · 记录于 9/17 16:38 PT");
		expect(html).toContain("来源：机器 · 读取于 9/17 17:40 PT");
		expect(html).toContain("订阅档位：Max 20x");
		expect(html).toContain("订阅档位：未知");
		expect(html).toMatch(/--meta:#9a9a9a/);
		expect(html).toMatch(/\.meta\{[^}]*font-size:9px/);
		expect(html).toContain("无数据");
		expect(html).toContain("无数值源");
		expect(html).toContain("机器值与手填值差异");

		const tick = formatAccountQuotaTickLines(view).join("\n");
		expect(tick).toContain("额度 Claude");
		expect(tick).toContain("★shopping");
		expect(tick).toMatch(/7d +24% +76%/);
		expect(tick).toMatch(/Fable +n\/a +n\/a/);
		expect(tick).not.toContain("到期 09-20");
		expect(tick).not.toContain("79%");
		expect(tick).toContain("Codex 无数值源");
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
			resetCredits: { known: true, value: null },
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
			resetCredits: { known: false, value: null },
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
			resetCredits: { known: true, value: "2" },
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
		});
		expect(personal.weeklyReset.source).toBe("machine");
		expect(personal.subscriptionTier).toMatchObject({
			display: "Pro",
			source: "machine",
		});
		expect(personal.credits).toMatchObject({
			display: "余额 0 · 无可兑重置",
			source: "machine",
		});
		expect(personal.active).toBe(true);
		expect(personal.exhausted).toBe(true);
		expect(personal.recovery?.display).toContain("09-23 19:00 PT");

		const shopping = view.codex.find((row) => row.name === "shopping")!;
		expect(shopping.credits.display).toBe("余额 12.5 · 可兑重置 2");
		expect(shopping.note).toBe("使用中，本次未读");
		expect(shopping.weeklyUsage.stale).toBe(true);

		const personal1 = view.codex.find((row) => row.name === "personal1")!;
		expect(personal1.credits).toMatchObject({
			display: "RPC 未暴露",
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
			"school",
		]);
		expect(view.claude.at(-1)?.sortAt).toBeNull();
	});

	it("marks exhausted rows red with a machine recovery moment", () => {
		const html = renderAccountsPageHtml(buildAccountQuotaView(snapshot()));

		expect(html).toContain("<th>credits / 重置兑换</th>");
		expect(html).toContain("<th>Fable 周用量</th>");
		expect(html).toContain('<tr class="exhausted-account active-account">');
		expect(html).toContain(
			".exhausted-account td{background:var(--exhausted-row)}",
		);
		expect(html).toContain("打满 · 恢复 09-23 19:00 PT");
		expect(html).toContain("使用中，本次未读");
		expect(html).toContain("机器读数 · account/rateLimits/read");
		expect(html).toContain(
			"<span>高亮行：当前在用（Codex：机器判定，凭据与 ~/.codex 一致）</span>",
		);
		expect(html).toContain("RPC 未暴露");
		expect(html).not.toContain("无数据 weekly;");
		expect(html).toContain("token 状态");
		expect(html).toContain("打满");
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
		expect(html).toContain('class="exhausted-account"');
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

		expect(html).toContain("打满 · 恢复时刻未知");
		expect(html).not.toContain("打满 · 恢复 恢复时刻未知");
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
