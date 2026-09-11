import { createHash } from "node:crypto";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { ATTENTION_V1, buildAttention } from "../attention.js";
import { generateEpicPage } from "../generate.js";
import type { EpicPageV2 } from "../model.js";
import { renderEpicPageHtml } from "../render-html.js";
import { renderEpicPageMarkdown } from "../render-markdown.js";
import { attentionFixture, sourceCell } from "./fixtures/attention.js";
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
	it("keeps real attention expanded before collapsed Epic cards", () => {
		const document = page();
		const dom = new Window().document;
		dom.write(renderEpicPageHtml(document, now));
		const section = dom.querySelector("[data-attention-section]")!;
		expect(dom.querySelector("main")?.firstElementChild).toBe(section);
		expect(section.closest("details")).toBeNull();
		const items = section.querySelectorAll("[data-attention-key]");
		expect(items).toHaveLength(3);
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
			expect(output.includes("已知 3 条记录，清单不完整")).toBe(true);
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
		const row = rows(renderEpicPageHtml(document, now))[0]!;
		expect([...row.matchAll(/data-attention-part=/g)]).toHaveLength(4);
		expect(
			row.match(
				new RegExp(`data-attention-part="${part}">([\\s\\S]*?)</div>`),
			)?.[1],
		).toContain("不知道");
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
			expect([...section.matchAll(/aria-disabled="true"/g)]).toHaveLength(3);
			expect(section).not.toContain("href=");
			for (const output of [section, renderEpicPageMarkdown(document, now)]) {
				expect(output).toContain(text);
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
		expect([...section.matchAll(/aria-disabled="true"/g)]).toHaveLength(3);
		for (const output of [section, renderEpicPageMarkdown(document, now)]) {
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
			expect(output.includes("另有 2 条待回答记录")).toBe(true);
			expect(output).toContain("去 thread 里回答它的问题。");
			expect(output).toContain("全部 3 条来源");
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
		expect(rows(renderEpicPageHtml(document, now))).toHaveLength(3);
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
	it("puts exactly three source rows first with all four parts and shared actions in both outputs", () => {
		const document = page();
		const html = renderEpicPageHtml(document, now);
		const markdown = renderEpicPageMarkdown(document, now);
		expect(rows(html)).toHaveLength(3);
		expect(html.indexOf("现在要你看")).toBeLessThan(
			html.indexOf("执行范围总览"),
		);
		for (const [index, row] of rows(html).entries()) {
			expect(
				[...row.matchAll(/data-attention-part="([^"]+)"/g)].map(
					(match) => match[1],
				),
			).toEqual(["what", "action", "wait", "where"]);
			for (const title of ["这是什么", "需要你做什么", "等了多久", "去哪儿做"])
				expect(row).toContain(title);
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
		expect(rows(html)[1]).toContain("自 09:00 起,已等 3 小时");
		expect(rows(html)[1]).toContain("记录收件方：Lead；当前在等 Lead 回复");
		expect(rows(html)[2]).toContain("自 不知道 起,已等 不知道 小时");
		expect(attentionHtml(html)).not.toContain("<table");
		expect(markdown.indexOf("现在要你看")).toBeLessThan(
			markdown.indexOf("现在可以开始的"),
		);
	});
});
