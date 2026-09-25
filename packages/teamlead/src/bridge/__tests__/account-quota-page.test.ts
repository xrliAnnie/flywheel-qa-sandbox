import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { VercelAccountStore } from "../../vercel-quota/vercel-account-store.js";
import {
	buildAccountQuotaPageSections,
	formatAccountQuotaPageCalendarDate,
	formatAccountQuotaPageDate,
	formatAccountQuotaPageInstant,
	reconcileCodexAccountSubscriptionIdentityKeys,
	renderAccountQuotaPageHtml,
} from "../account-quota-page.js";
import { buildVercelQuotaSection } from "../account-quota-vercel.js";
import type {
	AccountQuotaRow,
	AccountQuotaView,
	QuotaCell,
} from "../account-quota-view.js";

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
		nextCharge: cell("读不到（接口未返回）", {
			source: "missing",
			observedAt: null,
		}),
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
		expect(html).not.toContain("token 状态");
		expect(html).toContain("<th>充值卡</th>");
		expect(html.match(/<th>下次扣费日<\/th>/g)).toHaveLength(2);
		expect(html).not.toContain("订阅到期");
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

	it("drops the token column but keeps the Codex card lines", () => {
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
						note: "token 已吊销，需重新登录",
					}),
				],
			),
		);

		expect(html).not.toContain("token-status");
		expect(html).not.toContain(">正常<");
		expect(html).toContain("#1 到期 2026/10/28");
		expect(html).toContain("#2 到期未知");
		// The row's own failure note still says why the token is unusable.
		expect(html).toContain("token 已吊销，需重新登录");
		expect(html).not.toContain("余额 ");
	});

	it("shows the business tier as read, without any confirmation wording", () => {
		const html = renderAccountQuotaPageHtml(
			view([
				row("business", 20, "2026-09-28T16:00:00.000Z", {
					subscriptionTier: cell("Max 20x"),
				}),
			]),
		);

		expect(html).toContain('<div class="account-tier">Max 20x</div>');
		expect(html).not.toContain("待你确认");
		expect(html).not.toContain("你说 20x");
		expect(html).not.toContain("机器读数");
		expect(html).toContain('data-group="available"');
	});

	it("renders the next charge cell, escaped, as the last column", () => {
		const html = renderAccountQuotaPageHtml(
			view(
				[
					row("business", 20, "2026-09-28T16:00:00.000Z", {
						nextCharge: cell("读不到（Anthropic 接口不给）", {
							source: "missing",
						}),
					}),
				],
				[
					row("codex", 20, "2026-09-28T16:00:00.000Z", {
						provider: "Codex",
						nextCharge: cell("10/22 周四"),
					}),
					row("odd", 20, "2026-09-29T16:00:00.000Z", {
						provider: "Codex",
						nextCharge: cell("<b>x</b>"),
					}),
				],
			),
		);
		expect(html).toContain(
			'<td><span class="next-charge">读不到（Anthropic 接口不给）</span></td></tr>',
		);
		expect(html).toContain(
			'<td><span class="next-charge">10/22 周四</span></td></tr>',
		);
		expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
		expect(html).not.toContain("<b>x</b>");
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

describe("FLY-2864 — page shape after the four changes", () => {
	const tds = (html: string, name: string) => {
		const tr = html
			.split("</tr>")
			.find((chunk) => chunk.includes(`${name}</div>`));
		return tr?.match(/<td[ >]/g)?.length ?? 0;
	};

	it("renders 7 cells per Claude row and 6 per Codex row, with matching colspans", () => {
		const html = renderAccountQuotaPageHtml(
			view(
				[row("claude-row", 23, "2026-09-28T16:00:00.000Z")],
				[
					row("codex-row", 40, "2026-09-29T16:00:00.000Z", {
						provider: "Codex",
					}),
					row("codex-unknown", null, null, { provider: "Codex" }),
				],
				{
					claudeUnavailable: ["claude down"],
					codexUnavailable: ["codex down"],
				},
			),
		);
		expect(tds(html, "claude-row")).toBe(7);
		expect(tds(html, "codex-row")).toBe(6);
		const [claudeTable, codexTable] = html.match(
			/<section class=[\s\S]*?<\/section>/g,
		)!;
		expect(claudeTable?.match(/<th>/g)).toHaveLength(7);
		expect(codexTable?.match(/<th>/g)).toHaveLength(6);
		expect(claudeTable).toContain('<td colspan="7">');
		expect(claudeTable).not.toContain('colspan="6"');
		expect(codexTable).toContain('<td colspan="6">');
		expect(codexTable).not.toContain('colspan="7"');
	});

	it("keeps every other element of the previous page", () => {
		const html = renderAccountQuotaPageHtml(
			view(
				[
					row("claude-active", 23, "2026-09-28T16:00:00.000Z", {
						active: true,
						credits: cell("1 张\n#1 到期 2026/10/22"),
					}),
				],
				[
					row("codex-note", 40, "2026-09-29T16:00:00.000Z", {
						provider: "Codex",
						credits: cell("兑换卡未暴露", { source: "missing" }),
						note: "使用中，本次未读",
					}),
				],
			),
		);
		for (const kept of [
			"<h1>账号额度一览</h1>",
			"<h2>Claude</h2>",
			"<h2>Codex</h2>",
			"<th>账号</th>",
			"<th>周重置日</th>",
			"<th>5h reset</th>",
			"<th>周用量</th>",
			"<th>Fable 周用量</th>",
			"<th>充值卡</th>",
			"<th>兑换卡</th>",
			"claude-active</div>",
			'<span class="active-chip">在用</span>',
			'class="quota-row active-account"',
			'aria-label="周用量"',
			'aria-label="Fable用量"',
			'<span class="reset-time">09/28 周一 09:00</span>',
			'<span class="reset-time">09/23 周三 18:00</span>',
			'<span class="card-line">#1 到期 2026/10/22</span>',
			"兑换卡未暴露",
			'<span class="account-note">使用中，本次未读</span>',
			'<div class="account-tier">Max 20x</div>',
		]) {
			expect(html).toContain(kept);
		}
	});

	it("never lets tier or next charge move a row between groups or positions", () => {
		const order = (tier: string, next: string, flip: boolean) =>
			buildAccountQuotaPageSections([
				row("later", 96, "2026-09-28T16:00:00.000Z", {
					subscriptionTier: cell(flip ? next : tier),
					nextCharge: cell(flip ? tier : next),
				}),
				row("earlier", 23, "2026-09-23T16:00:00.000Z", {
					subscriptionTier: cell(tier),
					nextCharge: cell(next),
				}),
				row("full", 100, "2026-09-24T16:00:00.000Z", {
					subscriptionTier: cell(tier === "Max 5x" ? "Max 20x" : "Max 5x"),
				}),
				row("unread", null, null),
			]).flatMap((section) =>
				section.rows.map((item) => `${section.group}:${item.row.name}`),
			);
		const expected = [
			"available:earlier",
			"available:later",
			"full:full",
			"unavailable:unread",
		];
		for (const tier of ["Max 5x", "Max 20x", "未知"]) {
			for (const next of ["09/25 周五", "12/31 周四", "读不到（接口未返回）"]) {
				expect(order(tier, next, false)).toEqual(expected);
				expect(order(tier, next, true)).toEqual(expected);
			}
		}
	});
});

describe("FLY-2864 — next-charge date format", () => {
	it("formats an instant as a Pacific calendar day with a Chinese weekday", () => {
		expect(formatAccountQuotaPageDate("2026-10-23T03:59:39.000Z")).toBe(
			"10/22 周四",
		);
		expect(formatAccountQuotaPageDate("2026-10-03T23:37:58.000Z")).toBe(
			"10/03 周六",
		);
		// DST ends 2026-11-01 02:00 PDT: 08:30Z is still 01:30 PDT on Nov 1.
		expect(formatAccountQuotaPageDate("2026-11-01T08:30:00.000Z")).toBe(
			"11/01 周日",
		);
		expect(formatAccountQuotaPageDate("2026-11-02T07:59:00.000Z")).toBe(
			"11/01 周日",
		);
		// Year boundary: 2027-01-01T07:59Z is still New Year's Eve in PT.
		expect(formatAccountQuotaPageDate("2027-01-01T07:59:00.000Z")).toBe(
			"12/31 周四",
		);
		expect(formatAccountQuotaPageDate("2027-01-01T08:00:00.000Z")).toBe(
			"01/01 周五",
		);
		expect(() => formatAccountQuotaPageDate("2026-10-23")).toThrow();
	});

	it("keeps a founder-entered calendar day as that day", () => {
		expect(formatAccountQuotaPageCalendarDate("2026-10-05")).toBe("10/05 周一");
		expect(formatAccountQuotaPageCalendarDate("2026-12-31")).toBe("12/31 周四");
		expect(formatAccountQuotaPageCalendarDate("2028-02-29")).toBe("02/29 周二");
		for (const bad of ["2026-02-30", "2026-10-5", "10/05", ""]) {
			expect(() => formatAccountQuotaPageCalendarDate(bad)).toThrow();
		}
	});
});

describe("FLY-2875 — Vercel section markup", () => {
	const emailDigest = createHash("sha256")
		.update("owner.person@example.test")
		.digest("hex");
	const reading: VercelAccountStore = {
		version: 1,
		observedAt: "2026-09-25T08:00:00.000Z",
		account: {
			emailSha256: emailDigest,
			username: "xrliannie",
			teamSlug: "xrliannies-projects",
			plan: "pro",
			billingStatus: "active",
			periodEnd: "2026-10-24T07:00:00.000Z",
			canceled: false,
		},
		accountNote: null,
		blob: {
			status: "available",
			sizeBytes: 1_051_925,
			count: 23,
			usageQuotaExceeded: false,
		},
		blobNote: null,
	};
	const section = (store: VercelAccountStore | null) =>
		buildVercelQuotaSection(store, {
			generatedAt: "2026-09-25T08:30:00.000Z",
			claudeEmails: { personal: "Owner.Person@example.test" },
		});
	const vercelHtml = (html: string) => {
		const start = html.indexOf(
			'<section class="provider-table provider-vercel">',
		);
		expect(start).toBeGreaterThan(-1);
		return html.slice(start, html.indexOf("</section>", start) + 10);
	};

	it("renders no Vercel table without a section", () => {
		const html = renderAccountQuotaPageHtml(view([row("personal", 20, null)]));
		expect(html).not.toContain("provider-vercel");
		expect(html).not.toContain("<h2>Vercel</h2>");
	});

	it("renders the in-use Pro account and the retired account after Codex", () => {
		const html = renderAccountQuotaPageHtml(
			view(
				[row("personal", 20, null)],
				[row("personal2", 10, null, { provider: "Codex" })],
			),
			section(reading),
		);
		expect(html.indexOf("<h2>Codex</h2>")).toBeLessThan(
			html.indexOf("<h2>Vercel</h2>"),
		);
		const vercel = vercelHtml(html);
		expect(vercel).toContain(
			"<thead><tr><th>账号</th><th>下次扣费日</th><th>报告托管 Blob</th></tr></thead>",
		);
		expect(vercel).toContain(
			'<div class="section-caption">读于 09/25 周五 01:00</div>',
		);
		expect(vercel.match(/<tr class="quota-row active-account">/g)).toHaveLength(
			1,
		);
		expect(vercel).toContain(
			'<tr class="quota-row active-account"><td class="account-cell"><div class="account-name"><span class="active-dot"></span><span class="active-chip">在用</span>personal</div><div class="account-tier">Pro</div><span class="account-note">team xrliannies-projects</span></td><td><span class="next-charge">10/24 周六</span></td><td><div class="card-lines"><span class="card-line">正常</span><span class="card-line">已存 1.1 MB · 23 个对象</span><span class="card-line">本期占比：读不到（接口不给额度上限）</span></div></td></tr>',
		);
		expect(vercel).toContain(
			'<tr class="quota-row retired-account"><td class="account-cell"><div class="account-name">personal2</div><div class="account-tier">Hobby</div><span class="account-note">已停用，不再使用</span></td><td><span class="next-charge">已停用</span></td><td><div class="card-lines"><span class="card-line">不再使用</span></div></td></tr>',
		);
		expect(html).not.toContain("owner.person@example.test");
		expect(html).not.toContain("Owner.Person@example.test");
	});

	it("shows 读不到 without an in-use row while other tables keep theirs", () => {
		const failure: VercelAccountStore = {
			...reading,
			account: null,
			accountNote: "unauthorized",
			blob: null,
			blobNote: "unauthorized",
		};
		for (const store of [failure, null]) {
			const html = renderAccountQuotaPageHtml(
				view([row("personal", 20, null, { active: true })]),
				section(store),
			);
			const vercel = vercelHtml(html);
			expect(vercel).not.toContain('class="quota-row active-account"');
			expect(vercel).toContain(
				store === null ? "读不到（尚未读取）" : "读不到（token 已失效）",
			);
			expect(vercel).toContain("personal2");
			expect(html).toContain('<tr class="quota-row active-account">');
			if (store === null) expect(vercel).not.toContain("section-caption");
		}
	});

	it("escapes every Vercel cell", () => {
		const html = renderAccountQuotaPageHtml(view([]), {
			observedAt: null,
			rows: [
				{
					name: "a<b",
					planDisplay: 'P&"',
					team: "team x<y",
					active: true,
					retired: false,
					note: "n'>",
					nextCharge: "<i>",
					blobLines: ["<s>", "ok"],
				},
			],
		});
		const vercel = vercelHtml(html);
		expect(vercel).toContain("a&lt;b");
		expect(vercel).toContain("P&amp;&quot;");
		expect(vercel).toContain("team x&lt;y");
		expect(vercel).toContain("n&#39;&gt;");
		expect(vercel).toContain("&lt;i&gt;");
		expect(vercel).toContain("&lt;s&gt;");
		expect(vercel).not.toMatch(/<(b|i|s|y)>/);
	});
});
