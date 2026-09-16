import { createHash } from "node:crypto";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { ATTENTION_V1, buildAttention } from "../attention.js";
import { generateEpicPage } from "../generate.js";
import type { EpicPageV2 } from "../model.js";
import { renderEpicPageHtml } from "../render-html.js";
import { renderEpicPageMarkdown } from "../render-markdown.js";
import {
	attentionFixture,
	candidate,
	sourceCell,
} from "./fixtures/attention.js";
import { emptyItemFacts, epicShapeSnapshot } from "./fixtures/epic-shape.js";

const now = new Date("2026-09-09T12:00:00Z");
function page(): EpicPageV2 {
	const snapshot = epicShapeSnapshot();
	const base = generateEpicPage({
		snapshot,
		itemFacts: snapshot.items.map(() => emptyItemFacts()),
		now,
		projectName: "example",
		trigger: "manual",
	});
	const input = attentionFixture();
	input.candidates[0]!.sources[0]!.since.value = "2026-09-09T10:00:00Z";
	return {
		...base,
		...buildAttention(input, now.toISOString()),
		schema_version: 2,
		generator: { ...base.generator, version: "epic-page/2" },
		epic_scope: sourceCell({ available: true as const }),
	};
}
function attentionHtml(html: string): string {
	return (
		html.match(
			/<section\b[^>]*data-attention-section[^>]*>[\s\S]*?<\/section>/,
		)?.[0] ?? ""
	);
}
function rows(html: string): string[] {
	return [
		...attentionHtml(html).matchAll(
			/<article\b[^>]*data-attention-key[^>]*>[\s\S]*?<\/article>/g,
		),
	].map((match) => match[0]);
}

describe("attention rendering", () => {
	it.each(["guild", "thread", "thread_url"] as const)(
		"marks a valid founder item without %s incomplete instead of empty",
		(field) => {
			const document = page();
			if (field === "guild") document.discord.guild_id.value = null;
			else document.attention[0]![field].value = null;
			const section = attentionHtml(renderEpicPageHtml(document, now));
			expect(rows(section)).toHaveLength(0);
			expect(section).toContain("清单不完整");
			expect(section).toContain("1 条记录缺少讨论串链接");
			expect(section).not.toContain("现在没有等你的事");
		},
	);

	it("keeps real attention expanded before collapsed Epic cards", () => {
		const document = page();
		const dom = new Window().document;
		dom.write(renderEpicPageHtml(document, now));
		const section = dom.querySelector("[data-attention-section]")!;
		expect(dom.querySelector("main > .mock")?.children[2]).toBe(section);
		expect(section.closest("details")).toBeNull();
		const items = section.querySelectorAll("[data-attention-key]");
		expect(items).toHaveLength(1);
		for (const item of items) {
			for (const part of item.querySelectorAll("[data-attention-part]"))
				expect(part.closest("details")).toBeNull();
			expect(item.querySelectorAll("[data-attention-part]")).toHaveLength(4);
			expect(item.querySelector("a")?.getAttribute("href")).toMatch(
				/^https:\/\/discord.com\/channels\//,
			);
		}
		expect(dom.querySelectorAll("details.epic").length).toBeGreaterThan(0);
		expect(dom.querySelectorAll("details.epic[open]")).toHaveLength(0);
	});

	it("distinguishes a successful unresolved identity lookup from a complete deduplicated count", () => {
		const document = page();
		document.attention_sources.identity.value = { resolved: 2, unresolved: 1 };
		for (const render of [renderEpicPageHtml, renderEpicPageMarkdown]) {
			const output = render(document, now);
			expect(
				output.includes(
					`已知 ${render === renderEpicPageHtml ? 1 : 3} 条记录，清单不完整`,
				),
			).toBe(true);
			expect(output).toContain("身份尚未核齐，同一件事可能暂列多条");
			expect(output).not.toContain("有 3 件等你处理的事");
		}
	});
	it.each([
		["kind", "what"],
		["identifier", "what"],
		["title", "what"],
		["action", "action"],
		["since", "wait"],
		["thread", "where"],
		["thread_url", "where"],
	] as const)("keeps all four parts when %s is missing", (field, part) => {
		const document = page();
		document.attention[0]![field].value = null;
		if (field === "thread" || field === "thread_url") {
			expect(rows(renderEpicPageHtml(document, now))).toHaveLength(0);
			expect(renderEpicPageMarkdown(document, now)).toContain("不知道");
			return;
		}
		const row = rows(renderEpicPageHtml(document, now))[0]!;
		expect([...row.matchAll(/data-attention-part=/g)]).toHaveLength(4);
		expect(
			row.match(
				new RegExp(`data-attention-part="${part}">([\\s\\S]*?)</div>`),
			)?.[1],
		).toContain(part === "where" ? "这张单还没有 thread" : "不知道");
		const markdown = renderEpicPageMarkdown(document, now).split("- **①")[1]!;
		expect(markdown).toContain("不知道");
		for (const title of ["这是什么", "需要你做什么", "等了多久", "去哪儿做"])
			expect(markdown).toContain(title);
	});
	it.each([
		["no_thread_binding", "没有该单讨论串绑定"],
		["thread_binding_conflict", "讨论串绑定冲突"],
		["thread_missing", "讨论串已不可用"],
		["issue_identity_unknown", "事项身份不知道"],
	] as const)(
		"disables missing thread with explicit %s reason and no private error",
		(reason, text) => {
			const document = page();
			for (const item of document.attention)
				item.thread = {
					...item.thread,
					value: null,
					missing: { reason, detail: "PRIVATE_ERROR" },
				};
			const section = attentionHtml(renderEpicPageHtml(document, now));
			expect(rows(section)).toHaveLength(0);
			expect(section).not.toContain("href=");
			for (const output of [section, renderEpicPageMarkdown(document, now)]) {
				if (output !== section) expect(output).toContain(text);
				expect(output).not.toContain("PRIVATE_ERROR");
			}
		},
	);
	it("disables absent guild, clears every href, and explains why", () => {
		const document = page();
		document.discord.guild_id = {
			...document.discord.guild_id,
			value: null,
			missing: { reason: "no_guild_configured" },
		};
		const section = attentionHtml(renderEpicPageHtml(document, now));
		expect(section).not.toContain("href=");
		expect(rows(section)).toHaveLength(0);
		for (const output of [section, renderEpicPageMarkdown(document, now)]) {
			if (output !== section)
				expect(output).toContain("未配置 Discord 服务器编号");
			expect(output).not.toContain("https://discord.com/");
		}
	});
	it.each([
		"https://discord.com/channels/123/789",
		"https://discord.com:443/channels/123/456",
		"https://discord.com/channels/123/456?x=1",
		"https://discord.com/channels/123/456#x",
		"https://user@discord.com/channels/123/456",
		"http://discord.com/channels/123/456",
		"https://discord.com.evil/channels/123/456",
		"https://linear.app/example/issue/FLY-1",
		'javascript:alert("x")',
		'https://discord.com/channels/123/456" onclick="alert(1)',
	])(
		"rejects a URL that is not exactly the bound Discord thread: %s",
		(url) => {
			const document = page();
			for (const item of document.attention) item.thread_url.value = url;
			const section = attentionHtml(renderEpicPageHtml(document, now));
			expect(section).not.toContain("href=");
			expect(renderEpicPageMarkdown(document, now)).not.toContain(
				"[打开该单讨论串]",
			);
		},
	);
	it.each([
		"2026-09-09 10:00:00",
		"2026-09-09T10:00:00",
		"2026-02-30T10:00:00Z",
		"2026-09-09T12:00:01Z",
		"not-a-date",
	])(
		"shows invalid start time rather than a zero-clamped age for %s",
		(since) => {
			const document = page();
			document.attention[0]!.since.value = since;
			for (const render of [renderEpicPageHtml, renderEpicPageMarkdown]) {
				const output = render(document, now);
				expect(output).toContain("自 不知道 起,已等 不知道 小时（起点无效）");
			}
		},
	);
	it("shows UTC dates across days and explicitly says less than an hour", () => {
		const document = page();
		document.attention[0]!.since.value = "2026-09-08T10:00:00Z";
		document.attention[1]!.since.value = "2026-09-09T11:59:59Z";
		for (const render of [renderEpicPageHtml, renderEpicPageMarkdown]) {
			const output = render(document, now);
			expect(output).toContain("自 10:00 起,已等 26 小时（2026-09-08 UTC）");
			expect(output).toContain(
				"自 11:59 起,已等 0 小时（2026-09-09 UTC）（未满一小时）",
			);
		}
	});
	it("escapes external title and unknown kind while retaining fixed unknown action", () => {
		const document = page();
		const item = document.attention[0]!;
		item.title.value = '<img src=x onerror="alert(1)">';
		item.kind.value = "<script>raw-kind</script>";
		item.action.value = ATTENTION_V1.unknownAction;
		item.sources[0]!.fact.value!.kind = item.kind.value;
		for (const render of [renderEpicPageHtml, renderEpicPageMarkdown]) {
			const output = render(document, now);
			expect(output).toContain("&lt;img");
			expect(output).toContain("&lt;script&gt;raw-kind&lt;/script&gt;");
			expect(output).toContain("不确定,去看一眼");
			expect(output).not.toContain("<img");
			expect(output).not.toContain("<script>raw-kind");
		}
	});
	it("never renders internal identity sentinels anywhere in the public bytes", () => {
		const document = page();
		const sentinels = [
			"c440f001-1111-4111-8111-000000000001",
			"c440f002-2222-4222-8222-000000000002",
			"c440f003-3333-4333-8333-000000000003",
		];
		for (const [index, item] of document.attention.entries()) {
			const sentinel = sentinels[index]!;
			item.key = `question:${sentinel}`;
			item.issue_id.value = sentinel;
			for (const source of item.sources) {
				source.fact.value!.id = sentinel;
				source.fact.provenance = {
					kind: "statestore",
					table: "workflow_gate_holder",
					key: {
						question_id: sentinel,
						execution_id: sentinel,
						run_id: sentinel,
						node_id: sentinel,
						attempt_id: sentinel,
					},
				};
			}
		}
		for (const render of [renderEpicPageHtml, renderEpicPageMarkdown]) {
			const output = render(document, now);
			for (const sentinel of sentinels)
				expect(output.includes(sentinel)).toBe(false);
		}
		for (const sentinel of sentinels)
			expect(JSON.stringify(document)).toContain(sentinel);
	});
	it("preserves every existing successful Epic card byte when attention is added", () => {
		const document = page();
		const legacy = {
			...document,
			schema_version: 1 as const,
			generator: { ...document.generator, version: "epic-page/1" as const },
		};
		const cards = (html: string) => {
			const dom = new Window().document;
			dom.write(html);
			return [...dom.querySelectorAll(".epic,.unattached")].map(
				(card) => card.outerHTML,
			);
		};
		const prior = cards(renderEpicPageHtml(legacy, now));
		expect(prior.length).toBeGreaterThan(0);
		expect(cards(renderEpicPageHtml(document, now))).toEqual(prior);
	});
	it("keeps independent questions and secondary actions without exposing source identities", () => {
		const document = page();
		const item = document.attention[0]!;
		const question = structuredClone(document.attention[1]!.sources[0]!);
		const second = structuredClone(question);
		second.fact.value!.id = "second-private-question";
		item.sources.push(question, second);
		for (const render of [renderEpicPageHtml, renderEpicPageMarkdown]) {
			const output = render(document, now);
			expect(output).toContain("另有 1 条较早问题");
			expect(output).toContain("去 thread 里回答它的问题。");
			expect(output).toContain("全部 1 条来源");
			expect(output).not.toContain("second-private-question");
		}
	});
	it("keeps attention when Epic scope is absent and omits all old Epic content", () => {
		const document = page();
		document.epic_scope = {
			...document.epic_scope,
			value: null,
			missing: { reason: "epic_scope_unavailable" },
		};
		for (const render of [renderEpicPageHtml, renderEpicPageMarkdown]) {
			const output = render(document, now);
			expect(output.includes("Epic 范围不可用")).toBe(true);
			expect(output).toContain("现在要你看");
			for (const absent of [
				"现在可以开始的",
				"执行范围总览",
				"要做的事",
				"EPX-1",
				"个 active 父单",
			])
				expect(output.includes(absent)).toBe(false);
		}
		expect(rows(renderEpicPageHtml(document, now))).toHaveLength(1);
	});
	it("distinguishes confirmed empty, incomplete reads, identity and budget failures, and legacy unknown", () => {
		const document = page();
		document.attention = [];
		for (const render of [renderEpicPageHtml, renderEpicPageMarkdown]) {
			expect(render(document, now)).toContain("现在没有等你的事");
			for (const source of [
				"gates",
				"questions",
				"founder_review",
				"identity",
				"budget",
			] as const) {
				const missing = structuredClone(document);
				missing.attention_sources[source].value = null;
				missing.attention_sources[source].missing = {
					reason:
						source === "budget" ? "source_truncated" : "source_unavailable",
				};
				const result = render(missing, now);
				expect(result).toContain("已知 0 条记录，清单不完整");
				expect(result).not.toContain("现在没有等你的事");
				if (source === "budget")
					expect(result).toContain("体积上限，部分事项未显示");
				if (source === "identity")
					expect(result).toContain("身份尚未核齐，同一件事可能暂列多条");
			}
			const legacy = {
				...document,
				schema_version: 1 as const,
				generator: { ...document.generator, version: "epic-page/1" as const },
			};
			expect(render(legacy, now)).toContain("不知道（旧版尚未采集）");
			expect(render(legacy, now)).not.toContain("现在没有等你的事");
		}
	});
	it("puts actionable source rows first with compact parts and shared actions", () => {
		const document = page();
		const html = renderEpicPageHtml(document, now);
		const markdown = renderEpicPageMarkdown(document, now);
		expect(rows(html)).toHaveLength(1);
		expect(html.indexOf("现在要你看")).toBeLessThan(
			html.indexOf("在跑的 Epic"),
		);
		for (const [index, row] of rows(html).entries()) {
			expect(
				[...row.matchAll(/data-attention-part="([^"]+)"/g)].map(
					(match) => match[1],
				),
			).toEqual(["what", "action", "wait", "where"]);
			for (const title of ["这是什么", "需要你做什么", "等了多久", "去哪儿做"])
				expect(row).not.toContain(title);
			const item = document.attention[index]!;
			expect(row).toContain(item.action.value);
			expect(row).toContain(`href="${item.thread_url.value}"`);
			const hash = createHash("sha256")
				.update(`attention.v1\0example\0${item.key}`)
				.digest("hex");
			expect(row).toContain(`data-attention-key="a-${hash}"`);
			expect(markdown).toContain(item.action.value);
		}
		expect(rows(html)[0]).toContain("自 10:00 起,已等 2 小时");
		expect(rows(html)[0]).toContain("2026-09-09 UTC");
		expect(markdown).toContain("自 09:00 起,已等 3 小时");
		expect(markdown).toContain("记录收件方：Lead；当前在等 Lead 回复");
		expect(html).toContain("自 不知道 起,已等 不知道 小时");
		expect(attentionHtml(html)).not.toContain("<table");
		expect(markdown.indexOf("现在要你看")).toBeLessThan(
			markdown.indexOf("现在可以开始的"),
		);
	});
});

it("shows only founder work at the top and only the latest Lead question per issue below", () => {
	const document = page();
	const input = attentionFixture();
	input.candidates[1]!.sources[0]!.fact.value!.kind = "lead_question";
	const old = structuredClone(input.candidates[1]!);
	old.sources[0]!.fact.value!.id = "old-lead";
	old.sources[0]!.since.value = "2026-09-09T08:00:00Z";
	input.candidates[1]!.sources.push(old.sources[0]!);
	Object.assign(document, buildAttention(input, now.toISOString()));
	const window = new Window();
	try {
		window.document.write(renderEpicPageHtml(document, now));
		const top = window.document.querySelector("[data-attention-section]")!;
		expect(top.querySelectorAll("[data-attention-key]")).toHaveLength(1);
		expect(top.textContent).not.toContain("FLY-2");
		expect(top.querySelector(".attention-status")?.textContent).toContain("1");
		const lead = window.document.querySelector("details[data-lead-attention]")!;
		expect(lead).not.toBeNull();
		expect(lead.hasAttribute("open")).toBe(false);
		expect(lead.textContent).toContain("在等 Lead 的");
		expect(lead.querySelectorAll("[data-lead-question]")).toHaveLength(2);
		expect(lead.textContent).toContain("另有 1 条较早问题");
		expect(lead.textContent).toContain("09:00");
		expect(lead.textContent).not.toContain("08:00");
	} finally {
		window.close();
	}
});

it("uses compact v5 attention rows with a count and real Discord jump", () => {
	const dom = new Window().document;
	dom.write(renderEpicPageHtml(page(), now));
	expect(
		dom.querySelector("[data-attention-section] .sec")?.textContent,
	).toContain("⚡ 现在要你看 · 1 件");
	const row = dom.querySelector("[data-attention-key]")!;
	expect(row.querySelector(".u-l")).not.toBeNull();
	expect(row.querySelector(".u-act")).not.toBeNull();
	expect(row.querySelector(".u-r .jump")?.getAttribute("href")).toBe(
		"https://discord.com/channels/123/456",
	);
	expect(row.querySelector("dl")).toBeNull();
});

it("keeps a nomination label alone out of the founder action list", () => {
	const dom = new Window().document;
	dom.write(renderEpicPageHtml(page(), now));
	const section = dom.querySelector("[data-attention-section]")!;
	expect(section.querySelectorAll("[data-attention-key]")).toHaveLength(1);
	expect(section.textContent).not.toContain("FLY-3");
	expect(dom.querySelector("[data-lead-attention]")?.textContent).toContain(
		"FLY-3",
	);
});

it("FLY-2597: founder attention lists only actionable bound thread links", () => {
	const document = page();
	for (const item of document.attention) item.thread_url.value = null;
	const window = new Window();
	window.document.body.innerHTML = renderEpicPageHtml(document, now);
	const dom = window.document;
	expect(dom.querySelectorAll("[data-attention-section] .u-row")).toHaveLength(
		0,
	);
});

it("keeps 34 Lead-recipient questions outside founder attention in Markdown and HTML", () => {
	const document = page();
	const input = attentionFixture();
	input.candidates = [
		input.candidates[0]!,
		...Array.from({ length: 34 }, (_, n) =>
			candidate(n + 2, "lead_question", "commdb", "mailbox"),
		),
	];
	input.reads.questions.value = { count: 34 };
	input.reads.founder_review.value = { count: 0 };
	Object.assign(document, buildAttention(input, now.toISOString()));
	const markdown = renderEpicPageMarkdown(document, now);
	const founderSection = markdown.split("<details><summary>在等 Lead 的")[0]!;
	expect(founderSection).not.toContain("lead_question");
	expect(founderSection).not.toContain("FLY-2 ·");
	expect(founderSection).toContain("FLY-1");
	expect(markdown).toContain("<details><summary>在等 Lead 的");
	expect(markdown).toContain("FLY-35");
	const html = attentionHtml(renderEpicPageHtml(document, now));
	expect(html).not.toContain("FLY-2");
	expect(html).toContain("FLY-1");
});

it.each([
	[
		"https://discord.com/channels/1485787271192907816/1549550796725690459",
		true,
	],
	["javascript:alert(1)", false],
	["https://discord.com/channels/123/456?untrusted=1", false],
] as const)(
	"renders only validated child thread links in Markdown: %s",
	(url, valid) => {
		const document = page();
		document.items[0]!.thread_url = sourceCell(
			url,
			"statestore",
			"chat_threads",
		);
		const markdown = renderEpicPageMarkdown(document, now);
		if (valid) expect(markdown).toContain(`[跳 Discord ↗](${url})`);
		else expect(markdown).not.toContain(url);
	},
);
