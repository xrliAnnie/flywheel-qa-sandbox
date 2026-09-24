import { describe, expect, it } from "vitest";
import {
	buildAccountQuotaPageSections,
	formatAccountQuotaPageInstant,
	reconcileCodexAccountSubscriptionIdentityKeys,
	renderAccountQuotaPageHtml,
} from "../account-quota-page.js";
import type {
	AccountQuotaRow,
	AccountQuotaView,
	QuotaCell,
} from "../account-quota-view.js";
import type { SubscriptionConfirmation } from "../account-subscription-manual.js";

function cell(display: string, opts: Partial<QuotaCell> = {}): QuotaCell {
	return {
		display,
		source: "machine",
		observedAt: "2026-09-23T12:00:00.000Z",
		stale: false,
		...opts,
	};
}

function row(
	name: string,
	weeklyPct: number | null,
	weeklyResetAt: string | null,
	overrides: Partial<AccountQuotaRow> = {},
): AccountQuotaRow {
	const missing = cell("无", {
		source: "missing",
		observedAt: null,
	});
	return {
		provider: "Claude",
		name,
		identity: name,
		active: false,
		accountMissing: false,
		ageMinutes: 0,
		subscriptionTier: cell("Max 20x"),
		tokenStatus: missing,
		weeklyReset:
			weeklyResetAt === null
				? missing
				: cell("formatted", { rawInstant: weeklyResetAt }),
		fiveHReset: cell("formatted", {
			rawInstant: "2026-09-24T01:00:00.000Z",
		}),
		fableReset: missing,
		fiveHUsage: cell("10%", { rawValue: 10 }),
		weeklyUsage:
			weeklyPct === null
				? missing
				: cell(`${weeklyPct}%`, { rawValue: weeklyPct }),
		fableUsage: cell("20%", { rawValue: 20 }),
		credits: missing,
		expiry: missing,
		exhausted: false,
		unusable: false,
		recovery: null,
		note: null,
		sortAt: null,
		...overrides,
	};
}

describe("FLY-2803 account quota page projection", () => {
	it("groups only by machine weekly percentage and sorts every group by weekly reset", () => {
		const sections = buildAccountQuotaPageSections([
			row("full-late", 100, "2026-09-30T16:00:00.000Z"),
			row("available-late", 96, "2026-09-28T16:00:00.000Z"),
			row("unknown-no-reset", null, null),
			row("available-past", 23, "2026-09-09T16:00:00.000Z"),
			row("full-early", 100, "2026-09-23T16:00:00.000Z"),
			row("unknown-with-reset", null, "2026-09-25T16:00:00.000Z"),
		]);

		expect(sections.map((section) => section.group)).toEqual([
			"available",
			"full",
			"unavailable",
		]);
		expect(sections.map((section) => section.label)).toEqual([
			null,
			null,
			"本轮读数不可用",
		]);
		expect(
			sections.map((section) => section.rows.map((item) => item.row.name)),
		).toEqual([
			["available-past", "available-late"],
			["full-early", "full-late"],
			["unknown-with-reset", "unknown-no-reset"],
		]);
	});

	it("uses canceled reset instants only for unavailable-row ordering", () => {
		const late = row("canceled-late", null, null, {
			weeklyReset: cell("已取消", {
				rawInstant: "2026-10-08T16:00:00.000Z",
			}),
			fiveHReset: cell("已取消", {
				rawInstant: "2026-10-08T01:00:00.000Z",
			}),
		});
		const early = row("canceled-early", null, null, {
			weeklyReset: cell("已取消", {
				rawInstant: "2026-10-01T16:00:00.000Z",
			}),
			fiveHReset: cell("已取消", {
				rawInstant: "2026-10-01T01:00:00.000Z",
			}),
		});

		const sections = buildAccountQuotaPageSections([late, early]);
		expect(sections[0]?.rows.map((item) => item.row.name)).toEqual([
			"canceled-early",
			"canceled-late",
		]);

		const html = renderAccountQuotaPageHtml(view([late, early]));
		expect(html.match(/<span class="reset-time">已取消<\/span>/g)).toHaveLength(
			4,
		);
		expect(html).not.toContain("10/01 周四");
		expect(html).not.toContain("10/08 周四");
	});

	it("omits empty groups without placeholder text", () => {
		const sections = buildAccountQuotaPageSections([
			row("only", 40, "2026-09-28T16:00:00.000Z"),
		]);

		expect(sections).toHaveLength(1);
		expect(sections[0]).toMatchObject({ group: "available", label: null });
	});

	it("does not let active, tier, 5h, Fable, stale, or old sortAt affect order", () => {
		const variants = ["Max 5x", "Max 20x", "未知"].map((tier, index) =>
			buildAccountQuotaPageSections([
				row("later", 96, "2026-09-28T16:00:00.000Z", {
					active: index === 0,
					subscriptionTier: cell(tier),
					fiveHUsage: cell(`${100 - index}%`, { rawValue: 100 - index }),
					fableUsage: cell(`${index}%`, { rawValue: index, stale: true }),
					sortAt: "2026-09-01T00:00:00.000Z",
				}),
				row("earlier", 23, "2026-09-23T16:00:00.000Z", {
					active: index === 2,
					subscriptionTier: cell(tier),
					fiveHUsage: cell(`${index}%`, { rawValue: index }),
					fableUsage: cell(`${100 - index}%`, {
						rawValue: 100 - index,
					}),
					sortAt: "2026-10-01T00:00:00.000Z",
				}),
			]),
		);

		expect(
			variants.map((sections) =>
				sections.flatMap((section) =>
					section.rows.map((item) => `${section.group}:${item.row.name}`),
				),
			),
		).toEqual([
			["available:earlier", "available:later"],
			["available:earlier", "available:later"],
			["available:earlier", "available:later"],
		]);
	});

	it("ignores legacy manual percentages instead of turning them into page values", () => {
		const manualWeekly = cell("80%", {
			source: "manual",
			rawValue: 80,
		});
		const sections = buildAccountQuotaPageSections([
			row("shopping", null, "2026-09-28T16:00:00.000Z", {
				weeklyUsage: manualWeekly,
			}),
		]);

		expect(sections[0]?.group).toBe("unavailable");
		expect(sections[0]?.rows[0]).toMatchObject({ weeklyPct: null });
	});

	it("formats weekly and 5h instants in fixed Pacific time with Chinese weekdays", () => {
		expect(formatAccountQuotaPageInstant("2026-09-28T16:00:00.000Z")).toBe(
			"09/28 周一 09:00",
		);
		expect(formatAccountQuotaPageInstant("2027-01-01T08:05:00.000Z")).toBe(
			"01/01 周五 00:05",
		);
		expect(formatAccountQuotaPageInstant("2026-11-01T09:30:00.000Z")).toBe(
			"11/01 周日 01:30",
		);
	});

	it("rejects invalid machine page values instead of coercing them", () => {
		expect(() =>
			buildAccountQuotaPageSections([
				row("bad-pct", 20, "2026-09-28T16:00:00.000Z", {
					weeklyUsage: cell("101%", { rawValue: 101 }),
				}),
			]),
		).toThrow("invalid page quota percentage");
		expect(() =>
			buildAccountQuotaPageSections([
				row("bad-time", 20, "2026-09-28T16:00:00.000Z", {
					weeklyReset: cell("bad", { rawInstant: "not-a-time" }),
				}),
			]),
		).toThrow("invalid page quota instant");
	});
});

function view(
	claude: AccountQuotaRow[],
	codex: AccountQuotaRow[] = [],
	overrides: Partial<AccountQuotaView> = {},
): AccountQuotaView {
	return {
		generatedAt: "2026-09-23T20:00:00.000Z",
		staleAfterMinutes: 30,
		claude,
		codex,
		codexSourceLabel: "机器读数 · account/rateLimits/read",
		discrepancies: ["must not render"],
		warnings: ["must not render"],
		claudeUnavailable: [],
		codexUnavailable: [],
		...overrides,
	};
}

function manual(
	profile: string,
	status: "active" | "canceled" | "unknown",
	overrides: Partial<SubscriptionConfirmation> = {},
): SubscriptionConfirmation {
	return {
		provider: "Claude",
		profile,
		identityKey: "a".repeat(64),
		status,
		expiresOn: status === "canceled" ? "2026-10-14" : null,
		confirmedBy: "founder",
		confirmedAt: "2026-09-23T18:00:00.000Z",
		sourceRef: "FLY-2792#founder-confirmation",
		...overrides,
	};
}

describe("FLY-2803 E1-E19 page markup", () => {
	it("renders only the title, one generated time, and the two tables", () => {
		const html = renderAccountQuotaPageHtml(
			view(
				[row("claude", 23, "2026-09-28T16:00:00.000Z")],
				[
					row("codex", 40, "2026-09-29T16:00:00.000Z", {
						provider: "Codex",
						tokenStatus: cell("正常"),
					}),
				],
			),
		);

		expect(html.match(/<section/g)).toHaveLength(2);
		expect(html).toContain("<h1>账号额度一览</h1>");
		expect(html).toContain("09/23 周三 13:00");
		expect(html).toContain("<th>5h reset</th>");
		expect(html).toContain("<th>token 状态</th>");
		expect(html).toContain("<th>充值卡</th>");
		expect(html).toContain("<th>兑换卡</th>");
		expect(html).not.toContain("按需生成");
		expect(html).not.toContain("来源：");
		expect(html).not.toContain("读取于");
		expect(html).not.toContain("机器值与手填值差异");
		expect(html).not.toContain("数据说明");
		expect(html).not.toContain("<footer");
		expect(html).not.toContain("legend");
		expect(html).not.toContain("恢复 ");
		expect(html.indexOf("</section>", html.indexOf("<h2>Codex"))).toBeLessThan(
			html.indexOf("</main>"),
		);
	});

	it("keeps provider-level read failures visible inside the affected table", () => {
		const html = renderAccountQuotaPageHtml(
			view([], [], {
				claudeUnavailable: [],
				codexUnavailable: ["codex unavailable <reason>"],
			}),
		);

		expect(html).toContain('class="provider-unavailable"');
		expect(html).toContain("codex unavailable &lt;reason&gt;");
		expect(html).not.toContain("codex unavailable <reason>");
	});

	it("uses unlabeled available/full groups and labels only unavailable readings", () => {
		const html = renderAccountQuotaPageHtml(
			view([
				row("available", 96, "2026-09-28T16:00:00.000Z"),
				row("full", 100, "2026-09-29T16:00:00.000Z"),
				row("unknown", null, null),
			]),
		);

		expect(html).toContain('data-group="available"');
		expect(html).toContain('data-group="full"');
		expect(html).toContain('data-group="unavailable"');
		expect(
			html.match(/<tbody class="quota-group-spacer" aria-hidden="true">/g),
		).toHaveLength(2);
		expect(html).toContain(
			".quota-group-spacer td{height:10px;padding:0;border:0;background:var(--paper)}",
		);
		expect(html).toContain("本轮读数不可用");
		expect(html).not.toContain("还有额度");
		expect(html).not.toContain("已打满</");
	});

	it("keeps active full and active unavailable rows green while preserving red dimension bars", () => {
		const html = renderAccountQuotaPageHtml(
			view(
				[
					row("active-full", 100, "2026-09-29T16:00:00.000Z", {
						active: true,
						fableUsage: cell("100%", { rawValue: 100 }),
					}),
				],
				[
					row("active-unknown", null, null, {
						provider: "Codex",
						active: true,
						tokenStatus: cell("在用未探"),
					}),
				],
			),
		);

		expect(html.match(/class="quota-row active-account"/g)).toHaveLength(2);
		expect(html.match(/class="active-dot"/g)).toHaveLength(2);
		expect(html.match(/class="active-chip">在用/g)).toHaveLength(2);
		expect(html).toContain("Fable已满");
		expect(html).toContain('aria-valuenow="100"');
		expect(html).toContain(
			".active-account td{background:var(--active-bg)!important}",
		);
		expect(html).toContain(
			".dimension-is-full progress::-webkit-progress-value{background:var(--full)}",
		);
		expect(html).toContain(
			".dimension-is-full progress::-moz-progress-bar{background:var(--full)}",
		);
		expect(html).not.toContain("unavailable-account td{background");
	});

	it("shows precise weekly/Fable progress and no fake zero bar for unknown values", () => {
		const html = renderAccountQuotaPageHtml(
			view([
				row("precise", 97, "2026-09-28T16:00:00.000Z", {
					fableUsage: cell("23%", { rawValue: 23 }),
				}),
				row("unknown", null, null, {
					fableUsage: cell("无", {
						source: "missing",
						observedAt: null,
					}),
				}),
			]),
		);

		expect(html).toContain('aria-valuenow="97"');
		expect(html).toContain('aria-valuenow="23"');
		expect(html).toContain("97%");
		expect(html).toContain("23%");
		expect(html.match(/<progress/g)).toHaveLength(2);
		expect(html.match(/class="quota-na">无/g)?.length).toBeGreaterThanOrEqual(
			2,
		);
		expect(html).not.toContain('aria-valuenow="0"');
	});

	it("keeps token failures, converts only the obsolete full token label, and shows card lines", () => {
		const html = renderAccountQuotaPageHtml(
			view(
				[],
				[
					row("full-token", 100, "2026-09-28T16:00:00.000Z", {
						provider: "Codex",
						tokenStatus: cell("打满"),
						credits: cell("2 张\n#1 到期 2026/10/28\n#2 到期未知"),
					}),
					row("revoked", 40, "2026-09-29T16:00:00.000Z", {
						provider: "Codex",
						tokenStatus: cell("已吊销"),
					}),
				],
			),
		);

		expect(html).toContain('class="token-status">正常</span>');
		expect(html).toContain('class="token-status">已吊销</span>');
		expect(html).toContain("#1 到期 2026/10/28");
		expect(html).toContain("#2 到期未知");
		expect(html).not.toContain("余额 ");
	});

	it("shows business tier facts side-by-side without using tier as a decision", () => {
		const html = renderAccountQuotaPageHtml(
			view([
				row("business", 20, "2026-09-28T16:00:00.000Z", {
					subscriptionTier: cell("Max 5x"),
				}),
			]),
		);

		expect(html).toContain("机器读数 5x / 你说 20x，待你确认");
		expect(html).toContain('data-group="available"');
	});

	it("renders manual and machine subscription states without exposing provenance", () => {
		const canceled = row("canceled", 20, "2026-09-28T16:00:00.000Z");
		const active = row("active", 20, "2026-09-29T16:00:00.000Z");
		const unknown = row("unknown", 20, "2026-09-30T16:00:00.000Z");
		const machineCanceled = row(
			"machine-canceled",
			20,
			"2026-10-01T16:00:00.000Z",
		);
		const conflict = row("conflict", 20, "2026-10-02T16:00:00.000Z");
		const html = renderAccountQuotaPageHtml(
			view([canceled, active, unknown, machineCanceled, conflict]),
			{
				confirmations: [
					manual("canceled", "canceled"),
					manual("active", "active"),
					manual("unknown", "unknown"),
					manual("conflict", "active"),
				],
				identityKeys: {
					"Claude:canceled": "a".repeat(64),
					"Claude:active": "a".repeat(64),
					"Claude:unknown": "a".repeat(64),
					"Claude:conflict": "a".repeat(64),
				},
				machineSubscriptions: {
					"Claude:machine-canceled": {
						status: "canceled",
						observedAt: "2026-09-23T17:00:00.000Z",
					},
					"Claude:conflict": {
						status: "canceled",
						observedAt: "2026-09-23T19:00:00.000Z",
					},
				},
			},
		);

		expect(html).toContain("已取消 · 10/14");
		expect(html).toContain("已取消 · 日期待确认");
		expect(html).toContain("未知 · 状态待核对");
		expect(html.match(/class="subscription-empty"><\/td>/g)).toHaveLength(1);
		expect(html).toContain('class="subscription-state">未知</span>');
		expect(html).not.toContain("founder");
		expect(html).not.toContain("FLY-2792#founder-confirmation");
		expect(html).not.toContain("aaaaaaaa");
	});

	it("reports identity-bound confirmation failures while keeping the page state unknown", () => {
		const failures: Array<{
			provider: string;
			profile: string;
			error: string;
		}> = [];
		const html = renderAccountQuotaPageHtml(
			view([row("business", 20, "2026-09-28T16:00:00.000Z")]),
			{
				confirmations: [manual("business", "canceled")],
				identityKeys: { "Claude:business": "b".repeat(64) },
				onSubscriptionResolutionError: (failure) => failures.push(failure),
			},
		);

		expect(failures).toEqual([
			{
				provider: "Claude",
				profile: "business",
				error: "identity_mismatch",
			},
		]);
		expect(html).toContain('class="subscription-state">未知</span>');
		expect(html).not.toContain("已取消 · 10/14");
	});

	it("accepts live Codex identity keys only when durable reading identity agrees", () => {
		const live = {
			"Codex:matching": "a".repeat(64),
			"Codex:changed": "b".repeat(64),
			"Codex:legacy": "c".repeat(64),
		};
		const reading = {
			"Codex:matching": "a".repeat(64),
			"Codex:changed": "d".repeat(64),
		};

		expect(
			reconcileCodexAccountSubscriptionIdentityKeys(live, reading),
		).toEqual({
			"Codex:matching": "a".repeat(64),
			"Codex:legacy": "c".repeat(64),
		});
	});
});
